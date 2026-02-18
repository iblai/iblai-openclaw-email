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
    return tokenData.access_token;
  }
  return refreshAccessToken();
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

async function listUnreadMessages(token) {
  const q = encodeURIComponent(config.gmail.searchQuery || 'is:unread');
  const result = await gmailGet(`/gmail/v1/users/me/messages?q=${q}&maxResults=20`, token);
  return result.messages || [];
}

async function getMessageDetail(token, msgId) {
  return gmailGet(`/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, token);
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
  fs.writeFileSync(getProcessedPath(), JSON.stringify(processed, null, 2));
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
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
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
};

// ---------------------------------------------------------------------------
// Main triage loop
// ---------------------------------------------------------------------------
let polling = false;

async function triageCycle() {
  if (polling) return;
  polling = true;
  try {
    const token = await getAccessToken();
    const messages = await listUnreadMessages(token);
    stats.lastCheck = new Date().toISOString();

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

        // Whitelist check
        if (!isWhitelisted(from)) {
          stats.totalNotWhitelisted++;
          markProcessed(msg.id, { from: extractEmail(from), subject, action: 'skipped-not-whitelisted' });
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

        console.log(`[triage] ${action.toUpperCase()} | ${entry.from} | ${subject.slice(0, 60)} | rule=${entry.classification}`);
      } catch (e) {
        console.error(`[triage] Error processing message ${msg.id}:`, e.message);
        stats.errors++;
      }
    }

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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), lastCheck: stats.lastCheck }));
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
  console.log(`[triage] Email triage server listening on http://127.0.0.1:${PORT}`);
  console.log(`[triage] Polling Gmail every ${config.gmail.checkIntervalSeconds}s`);
  console.log(`[triage] Config: ${CONFIG_PATH}`);

  // Start polling
  triageCycle();
  setInterval(triageCycle, (config.gmail.checkIntervalSeconds || 60) * 1000);
});
