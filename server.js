#!/usr/bin/env node
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG_PATH = process.env.EMAIL_TRIAGE_CONFIG || path.join(__dirname, 'config.json');
let config = loadConfig();

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('[triage] Failed to load config:', e.message);
    process.exit(1);
  }
}

// Hot-reload config on change
fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    console.log('[triage] Config reloaded');
  } catch (e) {
    console.error('[triage] Config reload failed:', e.message);
  }
});

// ---------------------------------------------------------------------------
// Resolve paths with ~ expansion
// ---------------------------------------------------------------------------
function resolvePath(p) {
  if (p.startsWith('~')) p = path.join(process.env.HOME || '/root', p.slice(1));
  return path.resolve(p);
}

// ---------------------------------------------------------------------------
// OAuth2 token management
// ---------------------------------------------------------------------------
let tokenData = null;
let credentials = null;

function loadCredentials() {
  credentials = JSON.parse(fs.readFileSync(resolvePath(config.gmail.credentialsPath), 'utf8'));
  // Handle both "installed" and "web" credential types
  credentials = credentials.installed || credentials.web || credentials;
}

function loadToken() {
  tokenData = JSON.parse(fs.readFileSync(resolvePath(config.gmail.tokenPath), 'utf8'));
}

function saveToken() {
  fs.writeFileSync(resolvePath(config.gmail.tokenPath), JSON.stringify(tokenData, null, 2));
}

function refreshAccessToken() {
  return new Promise((resolve, reject) => {
    if (!credentials) loadCredentials();
    if (!tokenData) loadToken();

    const params = new URLSearchParams({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: tokenData.refresh_token,
      grant_type: 'refresh_token',
    });
    const body = params.toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Token refresh failed: ${res.statusCode} ${data}`));
        const parsed = JSON.parse(data);
        tokenData.access_token = parsed.access_token;
        if (parsed.refresh_token) tokenData.refresh_token = parsed.refresh_token;
        tokenData.expiry_date = Date.now() + (parsed.expires_in * 1000);
        saveToken();
        resolve(tokenData.access_token);
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function getAccessToken() {
  if (!tokenData) loadToken();
  if (tokenData.expiry_date && Date.now() < tokenData.expiry_date - 60000) {
    stats.tokenError = null;
    return tokenData.access_token;
  }
  try {
    const token = await refreshAccessToken();
    stats.tokenError = null;
    return token;
  } catch (e) {
    stats.tokenError = e.message;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Gmail API helpers (raw HTTPS)
// ---------------------------------------------------------------------------
function gmailGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'gmail.googleapis.com',
      path,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Gmail API ${res.statusCode}: ${data}`));
        resolve(JSON.parse(data));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Timestamp checkpoint for gap-proof email search
// ---------------------------------------------------------------------------
function getCheckpointPath() {
  return path.resolve(path.dirname(CONFIG_PATH), '.last-check-ts');
}

function loadCheckpointEpoch() {
  try {
    const ts = fs.readFileSync(getCheckpointPath(), 'utf8').trim();
    return parseInt(ts, 10) || 0;
  } catch {
    return 0; // No checkpoint = fetch everything matching the query
  }
}

function saveCheckpointEpoch() {
  const target = getCheckpointPath();
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, String(Math.floor(Date.now() / 1000)));
  fs.renameSync(tmp, target);
}

async function listUnreadMessages(token) {
  // Use after:{epoch} for gap-proof search — never misses emails after downtime
  const baseQuery = config.gmail.searchQuery || 'is:unread';
  const epoch = loadCheckpointEpoch();
  const q = epoch > 0
    ? encodeURIComponent(`${baseQuery} after:${epoch}`)
    : encodeURIComponent(baseQuery);
  const result = await gmailGet(`/gmail/v1/users/me/messages?q=${q}&maxResults=50`, token);
  return result.messages || [];
}

async function getMessageDetail(token, msgId) {
  return gmailGet(`/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, token);
}

async function getMessageFull(token, msgId) {
  return gmailGet(`/gmail/v1/users/me/messages/${msgId}?format=full`, token);
}

function extractBody(msg) {
  if (!msg.payload) return '';
  function decode(data) {
    if (!data) return '';
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  }
  // Simple message
  if (msg.payload.body && msg.payload.body.data) return decode(msg.payload.body.data);
  // Multipart — prefer text/plain
  const parts = msg.payload.parts || [];
  for (const p of parts) {
    if (p.mimeType === 'text/plain' && p.body && p.body.data) return decode(p.body.data);
  }
  // Fallback to text/html
  for (const p of parts) {
    if (p.mimeType === 'text/html' && p.body && p.body.data) return decode(p.body.data);
  }
  // Nested multipart
  for (const p of parts) {
    if (p.parts) {
      for (const sp of p.parts) {
        if (sp.mimeType === 'text/plain' && sp.body && sp.body.data) return decode(sp.body.data);
      }
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Action queue — writes actionable emails for OpenClaw cron to pick up
// ---------------------------------------------------------------------------
const ACTION_QUEUE_DIR = path.resolve(path.dirname(CONFIG_PATH), 'action-queue');
function ensureQueueDir() {
  if (!fs.existsSync(ACTION_QUEUE_DIR)) fs.mkdirSync(ACTION_QUEUE_DIR, { recursive: true });
}

function enqueueAction(item) {
  ensureQueueDir();
  const file = path.join(ACTION_QUEUE_DIR, `${item.emailId}.json`);
  // Don't re-queue if already queued or already processed (.done marker)
  const doneFile = file + '.done';
  if (fs.existsSync(file) || fs.existsSync(doneFile)) return;
  fs.writeFileSync(file, JSON.stringify(item, null, 2));

  // Notify OpenClaw via webhook if configured
  if (config.openclaw && config.openclaw.enabled) {
    notifyOpenClaw(item).catch(e => {
      console.error('[triage] OpenClaw webhook failed:', e.message);
      stats.webhookErrors = (stats.webhookErrors || 0) + 1;
    });
  }
}

// ---------------------------------------------------------------------------
// OpenClaw webhook notification — event-driven action processing
// ---------------------------------------------------------------------------
function notifyOpenClaw(item) {
  const oc = config.openclaw;
  if (!oc || !oc.enabled) return Promise.resolve();

  const url = new URL(oc.hookUrl || 'http://127.0.0.1:18789/hooks/agent');
  const actionLabel = item.action === 'escalate' ? '🚨 ESCALATION' : '📧 Action needed';

  const payload = JSON.stringify({
    message: `${actionLabel}: New email from ${item.from}\nSubject: ${item.subject}\n\nBody:\n${(item.body || '').slice(0, 4000)}\n\nClassification: ${item.classification}\nAction: ${item.action}\nAssigned to: ${item.assignTo || 'unassigned'}\nQueue file: ${ACTION_QUEUE_DIR}/${item.emailId}.json\n\nProcess this email: take the appropriate action based on the content and classification. After processing, mark it done by writing the current timestamp to ${ACTION_QUEUE_DIR}/${item.emailId}.json.done and deleting the .json file.`,
    name: 'Email Triage',
    sessionKey: `hook:email-triage:${item.emailId}`,
    wakeMode: 'now',
    deliver: true,
    channel: oc.deliverChannel || 'last',
    to: oc.deliverTo || undefined,
    model: oc.model || 'iblai-router/auto',
    timeoutSeconds: oc.timeoutSeconds || 90,
  });

  const mod = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${oc.token}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          stats.webhookSuccess = (stats.webhookSuccess || 0) + 1;
          console.log(`[triage] OpenClaw notified for ${item.emailId} (${res.statusCode})`);
          resolve(data);
        } else {
          reject(new Error(`OpenClaw webhook ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// Mark a queue item as done (called by cleanup, prevents re-queue)
function markActionDone(emailId) {
  const file = path.join(ACTION_QUEUE_DIR, `${emailId}.json`);
  const doneFile = file + '.done';
  try { fs.writeFileSync(doneFile, new Date().toISOString()); } catch {}
  try { fs.unlinkSync(file); } catch {}
}

// Cleanup old .done markers (>24h)
function cleanupDoneMarkers() {
  try {
    const files = fs.readdirSync(ACTION_QUEUE_DIR).filter(f => f.endsWith('.done'));
    const cutoff = Date.now() - 86400000;
    for (const f of files) {
      const fp = path.join(ACTION_QUEUE_DIR, f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    }
  } catch {}
}

function extractHeader(msg, name) {
  const h = (msg.payload && msg.payload.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function extractEmail(headerVal) {
  const m = headerVal.match(/<([^>]+)>/);
  return m ? m[1] : headerVal;
}

// ---------------------------------------------------------------------------
// Processed emails dedup (Layer 1: email ID)
// ---------------------------------------------------------------------------
function getProcessedPath() {
  return path.resolve(path.dirname(CONFIG_PATH), config.triage.processedFile || './processed-emails.json');
}

function loadProcessed() {
  try {
    return JSON.parse(fs.readFileSync(getProcessedPath(), 'utf8'));
  } catch {
    return { emails: {}, lastCleanup: Date.now() };
  }
}

function saveProcessed(processed) {
  // Atomic write: write to tmp file then rename to prevent corruption on crash
  const target = getProcessedPath();
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(processed, null, 2));
  fs.renameSync(tmp, target);
}

// Daily backup of processed-emails file
let lastBackupDate = null;
function maybeBackupProcessed() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastBackupDate === today) return;
  try {
    const target = getProcessedPath();
    const backup = target.replace('.json', '.backup.json');
    if (fs.existsSync(target)) {
      fs.copyFileSync(target, backup);
      lastBackupDate = today;
      console.log('[triage] Daily backup written:', backup);
    }
  } catch (e) {
    console.error('[triage] Backup failed:', e.message);
  }
}

// On startup: restore from backup if primary is missing
function restoreFromBackupIfNeeded() {
  const target = getProcessedPath();
  const backup = target.replace('.json', '.backup.json');
  if (!fs.existsSync(target) && fs.existsSync(backup)) {
    fs.copyFileSync(backup, target);
    console.log('[triage] Restored processed-emails from backup');
  }
}

function isProcessed(emailId) {
  const processed = loadProcessed();
  return !!processed.emails[emailId];
}

function markProcessed(emailId, summary) {
  const processed = loadProcessed();
  processed.emails[emailId] = { ...summary, processedAt: new Date().toISOString() };
  // Cleanup old entries beyond TTL
  const ttl = (config.dedup.ttlHours || 168) * 3600 * 1000;
  const now = Date.now();
  if (now - (processed.lastCleanup || 0) > 3600000) {
    for (const [id, entry] of Object.entries(processed.emails)) {
      if (now - new Date(entry.processedAt).getTime() > ttl) delete processed.emails[id];
    }
    processed.lastCleanup = now;
  }
  saveProcessed(processed);
}

// ---------------------------------------------------------------------------
// Whitelist check
// ---------------------------------------------------------------------------
function isWhitelisted(fromEmail) {
  const domains = config.gmail.whitelistedDomains || [];
  const addresses = config.gmail.whitelistedAddresses || [];
  if (domains.length === 0 && addresses.length === 0) return true; // no whitelist = allow all
  const email = extractEmail(fromEmail).toLowerCase();
  if (addresses.some(a => a.toLowerCase() === email)) return true;
  const domain = email.split('@')[1];
  return domains.some(d => d.toLowerCase() === domain);
}

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------
function matchRule(from, subject) {
  const email = extractEmail(from).toLowerCase();
  for (const rule of (config.triage.rules || [])) {
    const m = rule.match;
    // Check from pattern
    if (m.from && m.from !== '*') {
      if (m.from.startsWith('*@')) {
        const domain = m.from.slice(2).toLowerCase();
        if (!email.endsWith('@' + domain)) continue;
      } else if (m.from.toLowerCase() !== email) continue;
    }
    // Check subject keywords
    if (m.subjectContains && m.subjectContains.length > 0) {
      const subj = subject.toLowerCase();
      if (!m.subjectContains.some(kw => subj.includes(kw.toLowerCase()))) continue;
    }
    return rule;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Log entry
// ---------------------------------------------------------------------------
function logEntry(entry) {
  const logPath = path.resolve(path.dirname(CONFIG_PATH), config.triage.logFile || './email-triage.log');
  // appendFileSync is safe for JSONL — each write is a complete line with trailing newline
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

// ---------------------------------------------------------------------------
// JSONL log reader for dedup Layer 2 (from+subject similarity)
// ---------------------------------------------------------------------------
function getRecentLogEntries(hours) {
  const logPath = path.resolve(path.dirname(CONFIG_PATH), config.triage.logFile || './email-triage.log');
  try {
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    const cutoff = Date.now() - (hours || 24) * 3600 * 1000;
    return lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && new Date(e.timestamp).getTime() > cutoff);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Stats tracking
// ---------------------------------------------------------------------------
const stats = {
  startedAt: new Date().toISOString(),
  totalProcessed: 0,
  totalSkipped: 0,
  totalRouted: 0,
  totalEscalated: 0,
  totalClassified: 0,
  totalNotWhitelisted: 0,
  totalDeduplicated: 0,
  byRule: {},
  errors: 0,
  lastCheck: null,
  lastEmailAt: null,
  tokenError: null,
  shadowMode: false,
};

// ---------------------------------------------------------------------------
// Main triage loop
// ---------------------------------------------------------------------------
let polling = false;

async function triageCycle() {
  if (polling) return;
  polling = true;
  try {
    const shadowMode = config.shadowMode === true;
    stats.shadowMode = shadowMode;

    // Daily backup of dedup file
    maybeBackupProcessed();

    const token = await getAccessToken();
    const messages = await listUnreadMessages(token);
    stats.lastCheck = new Date().toISOString();

    // Process oldest-first to preserve chronological order (DOWN before UP, etc.)
    messages.reverse();

    for (const msg of messages) {
      try {
        // Layer 1: email ID dedup
        if (isProcessed(msg.id)) {
          stats.totalDeduplicated++;
          continue;
        }

        const detail = await getMessageDetail(token, msg.id);
        const from = extractHeader(detail, 'From');
        const to = extractHeader(detail, 'To');
        const subject = extractHeader(detail, 'Subject');
        const date = extractHeader(detail, 'Date');

        // Pre-check rule to decide if we need the body
        const preRule = matchRule(from, subject);
        const needsAction = preRule && (preRule.action === 'escalate' || preRule.action === 'route');
        let body = '';
        if (needsAction && !config.shadowMode) {
          try {
            const full = await getMessageFull(token, msg.id);
            body = extractBody(full).slice(0, 8000); // cap body size
          } catch (e) {
            console.error(`[triage] Failed to fetch body for ${msg.id}:`, e.message);
          }
        }

        // Whitelist check
        if (!isWhitelisted(from)) {
          stats.totalNotWhitelisted++;
          markProcessed(msg.id, { from: extractEmail(from), subject, action: 'skipped-not-whitelisted' });
          continue;
        }

        // Pre-check: skip rule (drop email silently)
        const skipCheck = matchRule(from, subject);
        if (skipCheck && skipCheck.action === 'skip') {
          stats.totalSkipped++;
          markProcessed(msg.id, { from: extractEmail(from), subject, action: 'skipped', classification: skipCheck.name });
          console.log(`[triage] SKIP | ${extractEmail(from)} | ${subject.slice(0, 60)} | rule=${skipCheck.name}`);
          continue;
        }

        // Match rule
        const rule = matchRule(from, subject);
        const action = rule ? rule.action : 'classify';
        const assignTo = rule ? rule.assignTo : null;
        const model = rule ? rule.model : config.models.classifier;

        const entry = {
          timestamp: new Date().toISOString(),
          emailId: msg.id,
          from: extractEmail(from),
          to: extractEmail(to),
          subject,
          receivedAt: date,
          classification: rule ? rule.name : 'general',
          action,
          assignedTo: assignTo || null,
          model,
          escalated: action === 'escalate',
          processedAt: new Date().toISOString(),
          tokenCost: 0,
        };

        logEntry(entry);
        markProcessed(msg.id, { from: entry.from, subject, action, classification: entry.classification });

        // Update stats
        stats.totalProcessed++;
        stats.lastEmailAt = entry.timestamp;
        if (rule) stats.byRule[rule.name] = (stats.byRule[rule.name] || 0) + 1;

        if (action === 'escalate') stats.totalEscalated++;
        else if (action === 'route') stats.totalRouted++;
        else stats.totalClassified++;

        const modeTag = shadowMode ? ' [SHADOW]' : '';
        console.log(`[triage]${modeTag} ${action.toUpperCase()} | ${entry.from} | ${subject.slice(0, 60)} | rule=${entry.classification}`);

        // In shadow mode: log only, don't take action
        if (shadowMode) continue;

        // Enqueue actionable emails for OpenClaw cron to process
        if (action === 'escalate' || action === 'route') {
          enqueueAction({
            emailId: msg.id,
            from: entry.from,
            subject,
            body,
            date,
            action,
            classification: entry.classification,
            assignTo: assignTo || null,
            queuedAt: new Date().toISOString(),
          });
          console.log(`[triage] QUEUED action for ${entry.from}: ${subject.slice(0, 60)}`);
        }
      } catch (e) {
        console.error(`[triage] Error processing message ${msg.id}:`, e.message);
        stats.errors++;
      }
    }

    // Auto-cleanup stale queue items (>5 min old = already processed or stuck)
    try {
      ensureQueueDir();
      const queueFiles = fs.readdirSync(ACTION_QUEUE_DIR);
      for (const f of queueFiles) {
        const fp = path.join(ACTION_QUEUE_DIR, f);
        if (f.endsWith('.done')) {
          // Clean old done markers
          if (Date.now() - fs.statSync(fp).mtimeMs > 86400000) fs.unlinkSync(fp);
        } else if (f.endsWith('.json')) {
          // Auto-delete queue files older than 5 minutes (cron should've processed by then)
          if (Date.now() - fs.statSync(fp).mtimeMs > 300000) {
            console.log(`[triage] AUTO-CLEANUP stale queue file: ${f}`);
            markActionDone(f.replace('.json', ''));
          }
        }
      }
    } catch (e) {
      console.error('[triage] Queue cleanup error:', e.message);
    }

    // Update timestamp checkpoint after successful check (whether or not emails were found)
    saveCheckpointEpoch();

    if (messages.length === 0) {
      stats.totalSkipped++;
    }
  } catch (e) {
    console.error('[triage] Cycle error:', e.message);
    stats.errors++;
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------------------
// HTTP server for /health and /stats
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.EMAIL_TRIAGE_PORT || '8403', 10);

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const health = {
      status: stats.tokenError ? 'error' : 'ok',
      uptime: Math.floor(process.uptime()),
      lastCheck: stats.lastCheck,
      shadowMode: stats.shadowMode,
    };
    if (stats.tokenError) {
      health.error = 'token_refresh_failed';
      health.message = 'Re-authorize Gmail access';
      health.detail = stats.tokenError;
    }
    res.writeHead(stats.tokenError ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
    return;
  }
  if (req.method === 'GET' && req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stats }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  // Restore dedup file from backup if needed
  restoreFromBackupIfNeeded();

  const shadowTag = config.shadowMode ? ' [SHADOW MODE]' : '';
  console.log(`[triage]${shadowTag} Email triage server listening on http://127.0.0.1:${PORT}`);
  console.log(`[triage] Polling Gmail every ${config.gmail.checkIntervalSeconds}s`);
  console.log(`[triage] Config: ${CONFIG_PATH}`);

  // Start polling
  triageCycle();
  setInterval(triageCycle, (config.gmail.checkIntervalSeconds || 60) * 1000);

  // systemd watchdog: notify every 60s if WatchdogSec is configured
  // (requires sd_notify — simplified: touch a file that systemd can watch)
  if (process.env.WATCHDOG_USEC) {
    const watchdogMs = parseInt(process.env.WATCHDOG_USEC, 10) / 1000 / 2; // notify at half interval
    setInterval(() => {
      try { require('child_process').execSync('systemd-notify WATCHDOG=1', { stdio: 'ignore' }); } catch {}
    }, watchdogMs);
  }
});
