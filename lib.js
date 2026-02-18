'use strict';

function extractEmail(headerVal) {
  const m = headerVal.match(/<([^>]+)>/);
  return m ? m[1] : headerVal;
}

function extractHeader(msg, name) {
  const h = (msg.payload && msg.payload.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function extractBody(msg) {
  if (!msg.payload) return '';
  function decode(data) {
    if (!data) return '';
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  }
  if (msg.payload.body && msg.payload.body.data) return decode(msg.payload.body.data);
  const parts = msg.payload.parts || [];
  for (const p of parts) {
    if (p.mimeType === 'text/plain' && p.body && p.body.data) return decode(p.body.data);
  }
  for (const p of parts) {
    if (p.mimeType === 'text/html' && p.body && p.body.data) return decode(p.body.data);
  }
  for (const p of parts) {
    if (p.parts) {
      for (const sp of p.parts) {
        if (sp.mimeType === 'text/plain' && sp.body && sp.body.data) return decode(sp.body.data);
      }
    }
  }
  return '';
}

function isWhitelisted(fromEmail, config) {
  const domains = config.gmail.whitelistedDomains || [];
  const addresses = config.gmail.whitelistedAddresses || [];
  if (domains.length === 0 && addresses.length === 0) return true;
  const email = extractEmail(fromEmail).toLowerCase();
  if (addresses.some(a => a.toLowerCase() === email)) return true;
  const domain = email.split('@')[1];
  return domains.some(d => d.toLowerCase() === domain);
}

function matchRule(from, subject, to, rules) {
  const fromEmail = extractEmail(from).toLowerCase();
  const toEmail = to ? extractEmail(to).toLowerCase() : '';
  for (const rule of (rules || [])) {
    const m = rule.match;
    if (m.from && m.from !== '*') {
      if (m.from.startsWith('*@')) {
        const domain = m.from.slice(2).toLowerCase();
        if (!fromEmail.endsWith('@' + domain)) continue;
      } else if (m.from.toLowerCase() !== fromEmail) continue;
    }
    if (m.to) {
      if (m.to.startsWith('*@')) {
        const domain = m.to.slice(2).toLowerCase();
        if (!toEmail.endsWith('@' + domain)) continue;
      } else if (m.to.toLowerCase() !== toEmail) continue;
    }
    if (m.subjectContains && m.subjectContains.length > 0) {
      const subj = subject.toLowerCase();
      if (!m.subjectContains.some(kw => subj.includes(kw.toLowerCase()))) continue;
    }
    return rule;
  }
  return null;
}

/**
 * Extract the Pingdom service identifier from a subject line.
 * e.g. "DOWN alert: ORACLE PROD MENTOR (NOT OPENAI) (asgi.data.iblai.app) is DOWN"
 *    → "ORACLE PROD MENTOR (NOT OPENAI) (asgi.data.iblai.app)"
 * Returns null if the subject doesn't match the Pingdom pattern.
 */
function extractPingdomService(subject) {
  const m = subject.match(/(?:DOWN|UP) alert:\s*(.+?)\s+is\s+(?:DOWN|UP)/i);
  return m ? m[1] : null;
}

/**
 * Given a list of pending queue items (parsed JSON objects with subject & date),
 * return the emailIds of DOWN alerts that should be suppressed because a later
 * UP alert exists for the same Pingdom service.
 */
function findSuppressibleDownAlerts(items) {
  const dominated = [];
  const downs = items.filter(i => i.classification === 'ops-alerts' && /DOWN alert/i.test(i.subject));
  const ups = items.filter(i => i.classification === 'ops-alerts' && /UP alert/i.test(i.subject));

  for (const down of downs) {
    const service = extractPingdomService(down.subject);
    if (!service) continue;
    const downTime = new Date(down.date).getTime();
    const matchingUp = ups.find(up => {
      const upService = extractPingdomService(up.subject);
      return upService === service && new Date(up.date).getTime() > downTime;
    });
    if (matchingUp) dominated.push(down.emailId);
  }
  return dominated;
}

module.exports = { extractEmail, extractHeader, extractBody, isWhitelisted, matchRule, extractPingdomService, findSuppressibleDownAlerts };
