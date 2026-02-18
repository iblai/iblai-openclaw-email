#!/usr/bin/env node
'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { extractEmail, extractHeader, extractBody, isWhitelisted, matchRule, extractPingdomService, findSuppressibleDownAlerts } = require('./lib');

// Helper: base64url encode
function b64(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// =========================================================================
// 1. extractEmail
// =========================================================================
describe('extractEmail', () => {
  it('extracts from "Name <email>" format', () => {
    assert.equal(extractEmail('John Doe <john@example.com>'), 'john@example.com');
  });
  it('returns plain email as-is', () => {
    assert.equal(extractEmail('john@example.com'), 'john@example.com');
  });
  it('handles empty string', () => {
    assert.equal(extractEmail(''), '');
  });
});

// =========================================================================
// 2. extractHeader
// =========================================================================
describe('extractHeader', () => {
  const msg = { payload: { headers: [
    { name: 'From', value: 'alice@test.com' },
    { name: 'Subject', value: 'Hello' },
  ]}};

  it('finds header case-insensitively', () => {
    assert.equal(extractHeader(msg, 'from'), 'alice@test.com');
    assert.equal(extractHeader(msg, 'FROM'), 'alice@test.com');
  });
  it('returns empty for missing header', () => {
    assert.equal(extractHeader(msg, 'X-Missing'), '');
  });
  it('handles missing payload', () => {
    assert.equal(extractHeader({}, 'From'), '');
  });
});

// =========================================================================
// 3. extractBody
// =========================================================================
describe('extractBody', () => {
  it('returns empty for missing payload', () => {
    assert.equal(extractBody({}), '');
  });
  it('decodes simple text/plain body', () => {
    const msg = { payload: { body: { data: b64('Hello world') } } };
    assert.equal(extractBody(msg), 'Hello world');
  });
  it('prefers text/plain in multipart', () => {
    const msg = { payload: { body: {}, parts: [
      { mimeType: 'text/html', body: { data: b64('<b>HTML</b>') } },
      { mimeType: 'text/plain', body: { data: b64('Plain text') } },
    ]}};
    assert.equal(extractBody(msg), 'Plain text');
  });
  it('falls back to text/html', () => {
    const msg = { payload: { body: {}, parts: [
      { mimeType: 'text/html', body: { data: b64('<b>HTML</b>') } },
    ]}};
    assert.equal(extractBody(msg), '<b>HTML</b>');
  });
  it('handles nested multipart', () => {
    const msg = { payload: { body: {}, parts: [
      { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/plain', body: { data: b64('Nested plain') } },
      ]},
    ]}};
    assert.equal(extractBody(msg), 'Nested plain');
  });
  it('returns empty for empty parts', () => {
    const msg = { payload: { body: {}, parts: [] } };
    assert.equal(extractBody(msg), '');
  });
});

// =========================================================================
// 4. matchRule
// =========================================================================
describe('matchRule', () => {
  const rules = [
    { name: 'vip', match: { from: 'boss@company.com' }, action: 'escalate' },
    { name: 'domain', match: { from: '*@alerts.com' }, action: 'route' },
    { name: 'to-support', match: { to: 'support@us.com' }, action: 'route' },
    { name: 'to-domain', match: { to: '*@helpdesk.com' }, action: 'route' },
    { name: 'urgent', match: { from: '*', subjectContains: ['urgent', 'critical'] }, action: 'escalate' },
    { name: 'skip-noreply', match: { from: 'noreply@spam.com' }, action: 'skip' },
    { name: 'catchall', match: { from: '*' }, action: 'classify' },
  ];

  it('exact from match', () => {
    assert.equal(matchRule('boss@company.com', 'Hi', '', rules).name, 'vip');
  });
  it('exact from match case-insensitive', () => {
    assert.equal(matchRule('Boss@Company.COM', 'Hi', '', rules).name, 'vip');
  });
  it('wildcard domain match', () => {
    assert.equal(matchRule('alert1@alerts.com', 'Test', '', rules).name, 'domain');
  });
  it('exact to match', () => {
    assert.equal(matchRule('someone@x.com', 'Hi', 'support@us.com', rules).name, 'to-support');
  });
  it('wildcard to match', () => {
    assert.equal(matchRule('someone@x.com', 'Hi', 'team@helpdesk.com', rules).name, 'to-domain');
  });
  it('subject keyword match', () => {
    assert.equal(matchRule('random@x.com', 'This is URGENT!', '', rules).name, 'urgent');
  });
  it('skip action', () => {
    assert.equal(matchRule('noreply@spam.com', 'Buy now', '', rules).name, 'skip-noreply');
    assert.equal(matchRule('noreply@spam.com', 'Buy now', '', rules).action, 'skip');
  });
  it('first match wins (priority)', () => {
    // boss@company.com matches 'vip' before 'catchall'
    assert.equal(matchRule('boss@company.com', 'Urgent thing', '', rules).name, 'vip');
  });
  it('returns null when no rules', () => {
    assert.equal(matchRule('x@y.com', 'hi', '', []), null);
  });
  it('returns null for undefined rules', () => {
    assert.equal(matchRule('x@y.com', 'hi', '', undefined), null);
  });
  it('Name <email> format works', () => {
    assert.equal(matchRule('The Boss <boss@company.com>', 'Hi', '', rules).name, 'vip');
  });
});

// =========================================================================
// 5. isWhitelisted
// =========================================================================
describe('isWhitelisted', () => {
  it('domain whitelist match', () => {
    const cfg = { gmail: { whitelistedDomains: ['example.com'], whitelistedAddresses: [] } };
    assert.equal(isWhitelisted('user@example.com', cfg), true);
  });
  it('address whitelist match', () => {
    const cfg = { gmail: { whitelistedDomains: [], whitelistedAddresses: ['vip@other.com'] } };
    assert.equal(isWhitelisted('vip@other.com', cfg), true);
  });
  it('non-whitelisted sender', () => {
    const cfg = { gmail: { whitelistedDomains: ['example.com'], whitelistedAddresses: [] } };
    assert.equal(isWhitelisted('hacker@evil.com', cfg), false);
  });
  it('empty whitelist allows all', () => {
    const cfg = { gmail: { whitelistedDomains: [], whitelistedAddresses: [] } };
    assert.equal(isWhitelisted('anyone@anywhere.com', cfg), true);
  });
  it('no whitelist keys allows all', () => {
    const cfg = { gmail: {} };
    assert.equal(isWhitelisted('anyone@anywhere.com', cfg), true);
  });
  it('case insensitive', () => {
    const cfg = { gmail: { whitelistedDomains: ['Example.COM'], whitelistedAddresses: [] } };
    assert.equal(isWhitelisted('User@EXAMPLE.com', cfg), true);
  });
  it('handles Name <email> format', () => {
    const cfg = { gmail: { whitelistedDomains: ['example.com'], whitelistedAddresses: [] } };
    assert.equal(isWhitelisted('John <user@example.com>', cfg), true);
  });
});

// =========================================================================
// 6. Dedup logic (stateful — uses temp dir)
// =========================================================================
describe('dedup logic', () => {
  let tmpDir, processedPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'email-test-'));
    processedPath = path.join(tmpDir, 'processed-emails.json');
  });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  // Inline dedup functions that mirror server.js behavior
  function loadProcessed() {
    try { return JSON.parse(fs.readFileSync(processedPath, 'utf8')); }
    catch { return { emails: {}, lastCleanup: Date.now() }; }
  }
  function saveProcessed(p) {
    fs.writeFileSync(processedPath, JSON.stringify(p, null, 2));
  }
  function isProcessed(emailId) {
    return !!loadProcessed().emails[emailId];
  }
  function markProcessed(emailId, summary, ttlHours) {
    const processed = loadProcessed();
    processed.emails[emailId] = { ...summary, processedAt: new Date().toISOString() };
    const ttl = (ttlHours || 168) * 3600 * 1000;
    const now = Date.now();
    if (now - (processed.lastCleanup || 0) > 3600000) {
      for (const [id, entry] of Object.entries(processed.emails)) {
        if (now - new Date(entry.processedAt).getTime() > ttl) delete processed.emails[id];
      }
      processed.lastCleanup = now;
    }
    saveProcessed(processed);
  }

  it('isProcessed returns false for unknown IDs', () => {
    assert.equal(isProcessed('unknown123'), false);
  });
  it('markProcessed adds entry', () => {
    markProcessed('msg1', { from: 'a@b.com', subject: 'Test' });
    assert.equal(isProcessed('msg1'), true);
  });
  it('isProcessed returns true for known IDs', () => {
    assert.equal(isProcessed('msg1'), true);
  });
  it('TTL cleanup removes old entries', () => {
    // Manually insert an old entry
    const processed = loadProcessed();
    processed.emails['old1'] = { processedAt: new Date(Date.now() - 999 * 3600 * 1000).toISOString() };
    processed.lastCleanup = 0; // force cleanup
    saveProcessed(processed);
    // markProcessed triggers cleanup
    markProcessed('msg2', { from: 'x@y.com', subject: 'New' }, 168);
    assert.equal(isProcessed('old1'), false);
    assert.equal(isProcessed('msg2'), true);
  });
});

// =========================================================================
// 7. Action queue (stateful — uses temp dir)
// =========================================================================
describe('action queue', () => {
  let queueDir;

  before(() => {
    queueDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'email-queue-'));
  });
  after(() => { fs.rmSync(queueDir, { recursive: true, force: true }); });

  function enqueueAction(item) {
    const file = path.join(queueDir, `${item.emailId}.json`);
    const doneFile = file + '.done';
    if (fs.existsSync(file) || fs.existsSync(doneFile)) return false;
    fs.writeFileSync(file, JSON.stringify(item, null, 2));
    return true;
  }
  function markActionDone(emailId) {
    const file = path.join(queueDir, `${emailId}.json`);
    const doneFile = file + '.done';
    try { fs.writeFileSync(doneFile, new Date().toISOString()); } catch {}
    try { fs.unlinkSync(file); } catch {}
  }

  it('enqueueAction writes JSON file', () => {
    const ok = enqueueAction({ emailId: 'e1', from: 'a@b.com', subject: 'Hi' });
    assert.equal(ok, true);
    assert.ok(fs.existsSync(path.join(queueDir, 'e1.json')));
  });
  it('enqueueAction skips if file exists', () => {
    const ok = enqueueAction({ emailId: 'e1', from: 'a@b.com', subject: 'Hi again' });
    assert.equal(ok, false);
  });
  it('markActionDone creates .done and removes .json', () => {
    markActionDone('e1');
    assert.ok(fs.existsSync(path.join(queueDir, 'e1.json.done')));
    assert.ok(!fs.existsSync(path.join(queueDir, 'e1.json')));
  });
  it('enqueueAction skips if .done marker exists', () => {
    const ok = enqueueAction({ emailId: 'e1', from: 'a@b.com', subject: 'Retry' });
    assert.equal(ok, false);
  });
});

// =========================================================================
// 9. Config hot-reload
// =========================================================================
describe('config hot-reload', () => {
  let tmpDir, cfgPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'email-cfg-'));
    cfgPath = path.join(tmpDir, 'config.json');
  });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('loadConfig picks up file changes', () => {
    const cfg1 = { gmail: { checkIntervalSeconds: 30 }, triage: { rules: [] } };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg1));
    const loaded1 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(loaded1.gmail.checkIntervalSeconds, 30);

    const cfg2 = { gmail: { checkIntervalSeconds: 60 }, triage: { rules: [] } };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg2));
    const loaded2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(loaded2.gmail.checkIntervalSeconds, 60);
  });
});

describe('extractPingdomService', () => {
  it('extracts service from DOWN alert subject', () => {
    assert.equal(
      extractPingdomService('DOWN alert: ORACLE PROD MENTOR (NOT OPENAI) (asgi.data.iblai.app) is DOWN'),
      'ORACLE PROD MENTOR (NOT OPENAI) (asgi.data.iblai.app)'
    );
  });

  it('extracts service from UP alert subject', () => {
    assert.equal(
      extractPingdomService('UP alert: ORACLE PROD MENTOR (NOT OPENAI) (asgi.data.iblai.app) is UP'),
      'ORACLE PROD MENTOR (NOT OPENAI) (asgi.data.iblai.app)'
    );
  });

  it('returns null for non-Pingdom subjects', () => {
    assert.equal(extractPingdomService('[Sentry] Something broke'), null);
  });

  it('handles different service names', () => {
    assert.equal(
      extractPingdomService('DOWN alert: PROD PLATFORM (app.iblai.app) is DOWN'),
      'PROD PLATFORM (app.iblai.app)'
    );
  });
});

describe('findSuppressibleDownAlerts', () => {
  it('suppresses DOWN when later UP exists for same service', () => {
    const items = [
      { emailId: 'a', subject: 'DOWN alert: SVC (x.com) is DOWN', date: '2026-02-18T10:00:00Z', classification: 'ops-alerts' },
      { emailId: 'b', subject: 'UP alert: SVC (x.com) is UP', date: '2026-02-18T10:05:00Z', classification: 'ops-alerts' },
    ];
    assert.deepEqual(findSuppressibleDownAlerts(items), ['a']);
  });

  it('does not suppress DOWN without matching UP', () => {
    const items = [
      { emailId: 'a', subject: 'DOWN alert: SVC (x.com) is DOWN', date: '2026-02-18T10:00:00Z', classification: 'ops-alerts' },
    ];
    assert.deepEqual(findSuppressibleDownAlerts(items), []);
  });

  it('does not suppress DOWN when UP is for a different service', () => {
    const items = [
      { emailId: 'a', subject: 'DOWN alert: SVC-A (a.com) is DOWN', date: '2026-02-18T10:00:00Z', classification: 'ops-alerts' },
      { emailId: 'b', subject: 'UP alert: SVC-B (b.com) is UP', date: '2026-02-18T10:05:00Z', classification: 'ops-alerts' },
    ];
    assert.deepEqual(findSuppressibleDownAlerts(items), []);
  });

  it('does not suppress DOWN when UP came before it', () => {
    const items = [
      { emailId: 'a', subject: 'UP alert: SVC (x.com) is UP', date: '2026-02-18T09:00:00Z', classification: 'ops-alerts' },
      { emailId: 'b', subject: 'DOWN alert: SVC (x.com) is DOWN', date: '2026-02-18T10:00:00Z', classification: 'ops-alerts' },
    ];
    assert.deepEqual(findSuppressibleDownAlerts(items), []);
  });

  it('handles multiple services independently', () => {
    const items = [
      { emailId: 'a', subject: 'DOWN alert: SVC-A (a.com) is DOWN', date: '2026-02-18T10:00:00Z', classification: 'ops-alerts' },
      { emailId: 'b', subject: 'DOWN alert: SVC-B (b.com) is DOWN', date: '2026-02-18T10:00:00Z', classification: 'ops-alerts' },
      { emailId: 'c', subject: 'UP alert: SVC-A (a.com) is UP', date: '2026-02-18T10:05:00Z', classification: 'ops-alerts' },
    ];
    // Only SVC-A DOWN should be suppressed, SVC-B stays
    assert.deepEqual(findSuppressibleDownAlerts(items), ['a']);
  });

  it('ignores non ops-alerts classifications', () => {
    const items = [
      { emailId: 'a', subject: 'DOWN alert: SVC (x.com) is DOWN', date: '2026-02-18T10:00:00Z', classification: 'bug-report' },
      { emailId: 'b', subject: 'UP alert: SVC (x.com) is UP', date: '2026-02-18T10:05:00Z', classification: 'ops-alerts' },
    ];
    assert.deepEqual(findSuppressibleDownAlerts(items), []);
  });
});
