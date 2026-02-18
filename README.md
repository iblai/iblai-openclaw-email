<div align="center">

<a href="https://ibl.ai"><img src="https://ibl.ai/images/iblai-logo.png" alt="ibl.ai" width="300"></a>

# OpenClaw Email Triage

Route every incoming email through the cheapest LLM that can handle it.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-compatible-orange.svg)](https://github.com/openclaw/openclaw)

</div>

---

## Local Email Triage Engine for OpenClaw

A zero-dependency Node.js service that polls Gmail on a configurable interval (default: every 60s), classifies incoming emails with a cheap LLM (Haiku at ~$1/1M input tokens), and only escalates to sub-agents when actual work is needed — issue creation, detailed analysis, complex triage.

Sub-agents default to [`iblai-router/auto`](https://github.com/iblai/iblai-openclaw-router), which automatically selects the cheapest model capable of handling each task. Users without the router installed can set `models.action` and `models.escalation` to direct model IDs (e.g., `claude-sonnet-4-6`, `claude-opus-4-6`).

**Everything runs locally on your OpenClaw server.** No data is sent to any third party. The service reads your Gmail via OAuth2, classifies locally via rule matching, and logs results to a local JSONL file.

**Install from your terminal:**

```bash
git clone https://github.com/iblai/iblai-openclaw-email.git iblai-email-triage
cd iblai-email-triage && bash scripts/install.sh
```

**Or just ask your OpenClaw agent:**

> Install email triage from https://github.com/iblai/iblai-openclaw-email

Your agent will clone the repo, run the install script, and start the service.

---

## Cost Savings

### Quick comparison

| Approach | Polling cost/day | Email processing/day | Total/day | Total/month |
|---|---|---|---|---|
| No triage (Opus for everything) | $311.04 | $86.40 | **$397.44** | **$11,923** |
| Triage + polling cron (every 60s) | $12.44 | $23.04 | **$35.48** | **$1,064** |

> **91% savings vs no triage.** Gmail polling is free (Node.js HTTP, no LLM). The only LLM cost is the cron checking the action queue + sub-agents processing actionable emails.

### Assumptions

- **Email volume:** 100 emails/hour, 2,400/day
- **Actionable emails:** ~60% need a sub-agent action, ~10% escalate to Opus
- **Pricing per 1M input tokens:** Haiku $1, Sonnet $3, Opus $15
- **Per polling check (LLM):** ~20K tokens
- **Per email classification (rule matching):** $0 (no LLM — pure code)
- **Per sub-agent action:** ~20K tokens via [`iblai-router/auto`](https://github.com/iblai/iblai-openclaw-router)

### Breakdown

**Polling overhead:**

| Method | How it works | Checks/day | Cost/day |
|---|---|---|---|
| No triage | LLM polls Gmail every 60s | 1,440 × Opus | $311.04 |
| Triage server + cron | LLM polls action-queue every 60s | 1,440 × Haiku | $12.44 |

**Email processing:**

| Step | Volume | Model | Cost/day |
|---|---|---|---|
| Rule classification | 2,400 emails | None (code) | $0.00 |
| Sub-agent actions (~60%) | 1,440 emails | Router (Sonnet avg) | $14.40 |
| Escalations (~10%) | 240 emails | Router (Opus) | $8.64 |
| **Subtotal** | | | **$23.04** |

> Sub-agent costs use [`iblai-router/auto`](https://github.com/iblai/iblai-openclaw-router), which routes each task to the cheapest capable model. The table assumes Sonnet for ~60% of actions and Opus for ~10% of escalations. Without the router, substitute direct model pricing.

---

## How It Works

```
Gmail API (polling)  →  Dedup Check (log file)  →  Rule Matcher  →  Log + Classify
                                                          │
                              ┌────────────────┬──────────┴──────────┐
                              ▼                ▼                     ▼
                         SKIP (already      ROUTE (assign          ESCALATE
                         processed)         + notify via           (spawn Opus
                                            Sonnet sub-agent)      sub-agent for
                                                                   complex triage)
```

1. **Poll** — Fetches unread messages from Gmail REST API using OAuth2
2. **Dedup** — Checks message ID against `processed-emails.json` to skip already-seen emails
3. **Whitelist** — Filters out emails from non-whitelisted domains/addresses
4. **Rule Match** — Matches email against configured rules (from pattern + subject keywords)
5. **Classify & Log** — Logs the email and classification to `email-triage.log` as JSONL
6. **Action** — Based on the matched rule: skip, route to a team, or escalate

---

## Configuration

All configuration lives in `config.json`. The server hot-reloads on changes — no restart needed.

```json
{
  "gmail": {
    "tokenPath": "~/.openclaw/workspace/skills/google-calendar/token.json",
    "credentialsPath": "~/.openclaw/workspace/skills/google-calendar/credentials.json",
    "checkIntervalSeconds": 60,
    "searchQuery": "is:unread",
    "whitelistedDomains": ["yourcompany.com"],
    "whitelistedAddresses": []
  },
  "models": {
    "classifier": "claude-3-5-haiku-20241022",
    "action": "iblai-router/auto",
    "escalation": "iblai-router/auto"
  },
  "costs": {
    "claude-3-5-haiku-20241022": { "input": 1.0, "output": 5.0 },
    "claude-sonnet-4-6": { "input": 3.0, "output": 15.0 },
    "claude-opus-4-6": { "input": 15.0, "output": 75.0 }
  },
  "triage": {
    "logFile": "./email-triage.log",
    "processedFile": "./processed-emails.json",
    "rules": [
      {
        "name": "urgent-ops",
        "match": { "from": "*@yourcompany.com", "subjectContains": ["DOWN", "alert", "critical", "urgent"] },
        "action": "escalate",
        "assignTo": "ops-team",
        "model": "claude-opus-4-6"
      },
      {
        "name": "noisy-alerts",
        "match": { "from": "alerts@yourcompany.com" },
        "action": "skip"
      },
      {
        "name": "bug-report",
        "match": { "from": "*@yourcompany.com", "subjectContains": ["bug", "error", "broken", "500", "404"] },
        "action": "route",
        "assignTo": "engineering",
        "model": "claude-sonnet-4-6"
      },
      {
        "name": "general",
        "match": { "from": "*" },
        "action": "classify",
        "model": "claude-3-5-haiku-20241022"
      }
    ],
    "teams": {
      "ops-team": { "notify": "slack-channel-or-webhook" },
      "engineering": { "notify": "slack-channel-or-webhook" }
    }
  },
  "dedup": {
    "method": "from+subject+haiku",
    "ttlHours": 168
  }
}
```

### Key config fields

| Field | Description | Default |
|---|---|---|
| `gmail.checkIntervalSeconds` | Polling frequency | `60` |
| `gmail.searchQuery` | Gmail search filter | `is:unread` |
| `gmail.whitelistedDomains` | Only process emails from these domains | `[]` (allow all) |
| `gmail.whitelistedAddresses` | Additional individual email addresses to allow | `[]` |
| `models.classifier` | Cheap model for first-pass classification | `claude-3-5-haiku-20241022` |
| `models.action` | Model for routing actions (sub-agents) | `iblai-router/auto` |
| `models.escalation` | Model for complex triage (sub-agents) | `iblai-router/auto` |
| `dedup.ttlHours` | How long to remember processed emails | `168` (7 days) |
### Rule actions

| Action | Behavior |
|---|---|
| `skip` | Silently drop the email — mark as processed, no LLM call, no queue. Use for known noise (Sentry, automated notifications, etc.) |
| `classify` | Send to the classifier model for categorization. Default fallback for unmatched emails |
| `route` | Queue for action by a sub-agent (issue creation, team notification). Uses `models.action` |
| `escalate` | Queue for high-priority action. Uses `models.escalation` for the sub-agent |

Rules are evaluated **top-to-bottom** — first match wins. Place specific rules (exact sender) above broad ones (wildcard domain), and `skip` rules before `route`/`escalate` rules for the same sender to filter out noise before it triggers actions.

> **Note on `iblai-router/auto`:** The default `action` and `escalation` models use the [iblai-router](https://github.com/iblai/iblai-openclaw-router), which automatically picks the cheapest Claude model capable of handling each sub-agent task. If you don't have the router installed, set these to direct model IDs instead:
> ```json
> "action": "claude-sonnet-4-6",
> "escalation": "claude-opus-4-6"
> ```

---

## Setup

The fastest way to configure your triage rules is to let your OpenClaw agent analyze your existing email. Just say:

> Set up email triage for me

By default, your agent will scan your recent inbox, identify patterns, and propose rules based on what's actually landing in your email. No questions needed — it learns from your data.

### Auto-Generate from Email History (Default)

Your agent scans your recent inbox, identifies patterns, and proposes rules — no questions needed:

> Set up email triage for me

Your agent will:

1. **Fetch your last 200 emails** from Gmail (sender + subject only — no body content needed)
2. **Cluster them** by sender domain, subject patterns, and frequency
3. **Identify categories** automatically (e.g., "you get ~30 Sentry alerts/day from ops@, ~5 deployment emails, ~10 client threads")
4. **Propose rules** with match patterns, actions, and team assignments
5. **Show you the rules for approval** before writing to `config.json`

Example output:

```
Based on your last 200 emails, I found these patterns:

  📊 alerts@monitoring.yourcompany.com (47 emails)
     Subjects: "DOWN alert: ...", "UP alert: ...", "Sentry: ..."
     → Proposed rule: "ops-alerts" — escalate to ops-team

  📊 *@yourcompany.com engineers (38 emails)
     Subjects: "Re: bug in ...", "PR #...", "deploy ..."
     → Proposed rule: "engineering" — route to engineering team

  📊 ceo@yourcompany.com (29 emails)
     Mixed subjects — forwarded alerts, task assignments, questions
     → Proposed rule: "vip-ceo" — always escalate (VIP)

  📊 *@partnerdomain.com (18 emails)
     Subjects: "Re: integration setup", "Question about ..."
     → Proposed rule: "partner-support" — route to engineering

  📊 noreply@github.com (68 emails)
     Subjects: "[yourorg/yourrepo] ..."
     → Proposed rule: "github-notifications" — skip (noise)

  Write these rules to config.json? (I can adjust any of them first)
```

The agent writes directly to `config.json` (hot-reloaded, no restart needed). You can always edit the rules manually afterward.

### Interview Mode (Alternative)

If you prefer to describe your email categories yourself — or if you're setting up a brand new email address with no history — your agent can walk you through it instead:

> Interview me about my email patterns and set up triage rules

Your agent will ask:

1. What email address to monitor
2. What domains to accept emails from
3. What kinds of emails you receive (2-5 categories)
4. What should happen for each category
5. Any VIP senders that should always be escalated
6. What teams you have and how to notify them

From your answers, the agent generates rules like:

```json
{
  "rules": [
    {
      "name": "vip-ceo",
      "match": { "from": "ceo@yourcompany.com" },
      "action": "escalate",
      "assignTo": "engineering"
    },
    {
      "name": "ops-alerts",
      "match": { "from": "*@yourcompany.com", "subjectContains": ["DOWN", "UP", "alert", "critical"] },
      "action": "escalate",
      "assignTo": "ops-team"
    },
    {
      "name": "bug-reports",
      "match": { "from": "*@yourcompany.com", "subjectContains": ["bug", "error", "broken", "500", "404", "crash"] },
      "action": "route",
      "assignTo": "engineering"
    },
    {
      "name": "general",
      "match": { "from": "*" },
      "action": "classify"
    }
  ]
}
```

### Plain Language

You can also just describe your setup in one message:

> I get monitoring alerts from Pingdom, bug reports from my team, and client emails.
> Alerts should go to the ops channel, bugs should become GitHub issues
> assigned to engineering, and client emails should be flagged for me to review.

Your agent will translate that into rules and update `config.json`.

---

## Email Log Format

Every email gets logged to `email-triage.log` as JSONL (one JSON object per line):

```json
{"timestamp":"2026-02-18T10:30:00Z","emailId":"abc123...","from":"dev@yourcompany.com","to":"triage@yourcompany.com","subject":"Fix the login bug on staging","receivedAt":"2026-02-18T10:29:45Z","classification":"bug-report","action":"route","assignedTo":"engineering","model":"claude-3-5-haiku-20241022","escalated":false,"processedAt":"2026-02-18T10:30:01Z","tokenCost":0.005}
```

| Field | Description |
|---|---|
| `emailId` | Gmail message ID |
| `classification` | Matched rule name |
| `action` | `skip`, `classify`, `route`, or `escalate` |
| `assignedTo` | Team name from rule |
| `escalated` | Whether this was sent to the expensive model |
| `tokenCost` | Estimated cost in USD |

---

## Dedup Strategy

Two-layer deduplication prevents reprocessing:

### Layer 1: Email ID

Gmail message ID is checked against `processed-emails.json`. If already present, the email is skipped immediately. This catches the most common case — the same unread email appearing in consecutive polls.

### Layer 2: From + Subject Similarity

For more advanced dedup (catching duplicate forwards, re-sends, and Sentry alerts about the same issue), you can use Haiku to compare new emails against recent log entries. Sample prompt:

```
You are an email dedup checker. Given this new email:
From: {from}
Subject: {subject}

And these recent emails from the log:
{recent_entries}

Is this email a duplicate or variant of an already-processed email?
Reply JSON: {"isDuplicate": true/false, "reason": "..."}
```

The dedup TTL is configurable via `dedup.ttlHours` (default: 168 hours / 7 days). Entries older than the TTL are automatically cleaned up.

---

## Reliability Design

The triage engine is designed to never miss an email, never process one twice, and never post alerts out of order — even through restarts, downtime, or crashes.

### Gap-Proof Email Search

The service uses `after:{epoch_timestamp}` in Gmail queries instead of relative time windows like `newer_than:2m`. A checkpoint file stores the epoch of the last successful check. After any downtime — restart, network issue, backoff — the next check automatically picks up every email since the last successful run. No gaps, no missed emails.

### Structured Dedup

Processed email IDs are stored as keys in a JSON object (`processed-emails.json`), not appended to a flat text file. This eliminates an entire class of issues with line concatenation, partial writes, and grep mismatches. The dedup file is the **only** gate — there's no age-based filtering that could discard legitimate emails after downtime.

### Chronological Processing

Gmail returns messages newest-first. The service reverses the list before processing so emails are handled oldest-first. This ensures paired alerts (e.g., DOWN at 19:01, UP at 19:05) are always posted in the correct order.

### Atomic File Writes

All state files (`processed-emails.json`, timestamp checkpoint) are written to a `.tmp` file first, then atomically renamed. If the process crashes mid-write, the file is always valid — either the previous version or the new version, never a half-written state.

### Scoped Verification

If you add external verification checks (e.g., confirming a service is actually UP before posting), scope them to the specific service in the email. Never gate alerts on a global healthcheck — an unrelated firing alert would suppress legitimate notifications.

### Full History Dedup

The processed-emails file stores every email's metadata (from, subject, classification, timestamp) within a configurable TTL window (default: 7 days). This enables both ID-based dedup and from+subject similarity matching — catching duplicate forwards, re-sends, and repeated alerts about the same issue.

### Summary

| Guarantee | How |
|---|---|
| No missed emails after downtime | `after:{epoch}` timestamp checkpoint |
| No duplicate processing | Structured JSON dedup by email ID |
| Correct alert ordering | Process oldest-first (`reverse()`) |
| No corruption on crash | Atomic writes (tmp + rename) |
| No false suppression | Scoped verification, no unrelated gates |
| Catches duplicate forwards | Full metadata history + subject similarity |

### Watchdog & Self-Healing

The service runs under systemd with `Restart=always` and `RestartSec=5`, so it automatically recovers from crashes.

> **Note:** Do not use `WatchdogSec` with the default `Type=simple` service. The `systemd-notify` command spawns a child process whose PID differs from the main PID, causing systemd to reject the notification and kill the service every watchdog interval. If you need watchdog support, use the `sd-notify` npm package for native socket notifications or switch to `Type=notify`.

### Action Queue & Delivery Guarantees

When a rule matches with `route` or `escalate`, the server fetches the full email body and writes a JSON file to the `action-queue/` directory. An OpenClaw cron job polls this directory and processes each file (creating GitHub issues, sending notifications, etc.).

To prevent duplicate deliveries if the cron times out before deleting the queue file:

- **`.done` markers** — After queuing an email, the server writes a `.done` marker file. It won't re-queue the same email even if the queue file is still present.
- **5-minute auto-cleanup** — Queue files older than 5 minutes are automatically removed by the server (the cron runs every 60s, so 5 min means it's either been processed or is stuck).
- **Dedup at queue level** — `enqueueAction()` checks for existing queue files and `.done` markers before writing.

This means even if the cron fails to delete a file, the alert is sent exactly once.

### OAuth2 Token Resilience

OAuth2 access tokens expire hourly. The service auto-refreshes them before each Gmail poll. If the refresh token itself is revoked (password change, admin action), the service logs a clear error and exposes it via the `/health` endpoint:

```json
{"status": "error", "error": "token_refresh_failed", "message": "Re-authorize Gmail access"}
```

Monitor `/health` from your existing infrastructure to catch this early.

### Dedup File Protection

The processed-emails file is the single source of truth for what's been handled. To guard against accidental deletion:

- The service writes a daily backup to `processed-emails.backup.json`
- On startup, if the primary file is missing but the backup exists, it auto-restores from backup
- The atomic write pattern (tmp + rename) prevents corruption, but the backup catches the rare case of manual deletion

### Shadow Mode

Before going live, run the triage server alongside your existing setup in shadow mode. In shadow mode, the server polls, classifies, and logs — but doesn't take action (no sub-agents, no notifications). Compare the logs against your existing pipeline to verify:

- Every email was seen
- Classifications match expectations
- Dedup caught all duplicates

Enable shadow mode in `config.json`:

```json
{
  "shadowMode": true
}
```

When satisfied, set `shadowMode: false` and the server begins taking action.

### Fallback Monitoring

For belt-and-suspenders reliability, pair the triage server with a lightweight OpenClaw cron job that monitors the checkpoint file:

```
Every 10 minutes: read .last-check-ts — if it's more than 5 minutes stale,
alert that the triage server may be down and optionally run a direct Gmail check.
```

This way, if the server dies and systemd can't restart it (disk full, OOM, etc.), you get alerted within 10 minutes and a fallback kicks in.

### Gmail API Limits

Gmail API allows 250 quota units/second for Workspace users. A message list call costs 5 units; a message get costs 5 units. At 60-second polling with up to 50 messages per cycle, peak usage is well under 1% of the quota. The service logs and retries on 429 (rate limit) responses with exponential backoff.

---

## Gmail Setup Prerequisites

### 1. OAuth2 Credentials

You need a Google Cloud project with the Gmail API enabled:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable the **Gmail API**
4. Create OAuth2 credentials (Desktop application type)
5. Download `credentials.json` and place it at the configured `credentialsPath`

### 2. Token Authorization

Generate `token.json` by authorizing with Gmail read scope (`https://www.googleapis.com/auth/gmail.readonly`). If you already have a token from the Google Calendar skill, you can share it — just point `tokenPath` to the same file. Make sure the token includes Gmail scopes.

### 3. Security Recommendation

To prevent external spam from burning API credits:

- **Google Workspace admins:** Set up email routing rules to only accept mail from whitelisted domains/addresses at the organizational level
- **Config-level:** Use `whitelistedDomains` and `whitelistedAddresses` in `config.json` to filter at the application level
- **Dedicated triage address:** Consider creating a dedicated email address (e.g., `triage@yourdomain.com`) that only internal systems and known senders can reach

### Shared credentials

Gmail and Google Calendar can share the same OAuth2 credentials. The default config points to the Google Calendar skill's token path:

```
~/.openclaw/workspace/skills/google-calendar/token.json
```

Just ensure the token has both Calendar and Gmail scopes authorized.

---

## Quick Start

### Option A: Ask your OpenClaw agent (easiest)

> Install email triage from https://github.com/iblai/iblai-openclaw-email

Your agent will clone the repo, run the install script, and start the service.

### Option B: Install script

```bash
cd ~/.openclaw/workspace
git clone https://github.com/iblai/iblai-openclaw-email.git iblai-email-triage
bash iblai-email-triage/scripts/install.sh
```

### Option C: Manual setup

```bash
# 1. Clone into your workspace
cd ~/.openclaw/workspace
git clone https://github.com/iblai/iblai-openclaw-email.git iblai-email-triage

# 2. Create the systemd service
sudo tee /etc/systemd/system/iblai-email-triage.service > /dev/null << EOF
[Unit]
Description=iblai-email-triage - Email triage engine for OpenClaw
After=network.target

[Service]
Type=simple
ExecStart=$(which node) $HOME/.openclaw/workspace/iblai-email-triage/server.js
Environment=EMAIL_TRIAGE_CONFIG=$HOME/.openclaw/workspace/iblai-email-triage/config.json
Environment=EMAIL_TRIAGE_PORT=8403
Restart=always
RestartSec=5
WorkingDirectory=$HOME/.openclaw/workspace/iblai-email-triage

[Install]
WantedBy=multi-user.target
EOF

# 3. Start the service
sudo systemctl daemon-reload
sudo systemctl enable --now iblai-email-triage

# 4. Verify it's running
curl -s http://127.0.0.1:8403/health | python3 -m json.tool
```

---

## Frequency Tuning

### Gmail polling (server → Gmail)

`gmail.checkIntervalSeconds` controls how often the Node.js server checks Gmail. This is **free** — no LLM involved, just an HTTP call to the Gmail API.

| Interval | Checks/day | LLM cost | Latency |
|---|---|---|---|
| 30s | 2,880 | $0.00 | <30s |
| 60s (default) | 1,440 | $0.00 | <60s |
| 120s | 720 | $0.00 | <2min |

### Action processing

An OpenClaw cron job polls the `action-queue/` directory for pending items:

| Interval | Checks/day | Haiku cost/day | Latency |
|---|---|---|---|
| 60s (recommended) | 1,440 | $12.44 | <60s |
| 120s | 720 | $6.22 | <2min |
| 300s | 288 | $2.49 | <5min |

The config hot-reloads, so you can change intervals without restarting.

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `EMAIL_TRIAGE_CONFIG` | Path to config.json | `./config.json` |
| `EMAIL_TRIAGE_PORT` | HTTP server port | `8403` |

---

## Disabling / Uninstalling

### Temporary disable

```bash
sudo systemctl stop iblai-email-triage
```

### Re-enable

```bash
sudo systemctl start iblai-email-triage
```

### Full uninstall

```bash
bash scripts/uninstall.sh
```

Or ask your agent:

> Uninstall email triage

The uninstall script stops and removes the systemd service but leaves config and log files intact.

---

## Troubleshooting

### Service won't start

```bash
journalctl -u iblai-email-triage -n 50
```

Common causes:
- **Missing token.json** — Complete Gmail OAuth2 setup first
- **Expired token** — The service auto-refreshes tokens, but the initial token must be valid
- **Wrong credentials path** — Check paths in `config.json` (supports `~` expansion)

### No emails being processed

- Check `config.json` search query — default is `is:unread`
- Check whitelisted domains — only emails from listed domains are processed
- Check `processed-emails.json` — the email may have been processed already
- Verify Gmail API is enabled in your Google Cloud project

### Health check

```bash
curl http://127.0.0.1:8403/health
```

Returns:
```json
{"status": "ok", "uptime": 3600, "lastCheck": "2026-02-18T10:30:00Z"}
```

### Stats

```bash
curl http://127.0.0.1:8403/stats
```

Returns processing statistics including total processed, skipped, routed, escalated, and error counts.

---

## License

[MIT](LICENSE) — Use it however you want.
