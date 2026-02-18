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

**Everything runs locally on your OpenClaw server.** No data is sent to ibl.ai or any third party. The service reads your Gmail via OAuth2, classifies locally via rule matching, and logs results to a local JSONL file.

**Install from your terminal:**

```bash
git clone https://github.com/iblai/iblai-openclaw-email.git email-triage
cd email-triage && bash scripts/install.sh
```

**Or just ask your OpenClaw agent:**

> Install email triage from https://github.com/iblai/iblai-openclaw-email

Your agent will clone the repo, run the install script, and start the service.

---

## Cost Savings

Assumptions:
- **Per check:** ~20K tokens (15K system + 2K task + 3K response)
- **Per email classification (Haiku):** ~5K tokens
- **Per sub-agent action (router-selected):** ~20K tokens
- **Email volume:** 100 emails/hour, 2,400/day
- **Pricing per 1M input tokens:** Haiku $1, Sonnet $3, Opus $15

| | Without triage | With triage | Saved |
|---|---|---|---|
| First-pass checks (24h, 60s interval) | $311.04 (Opus) | $20.74 (Haiku) | $290.30 (93%) |
| Email processing (100/hr, 2400/day) | $86.40 (Opus) | $8.64 (Haiku filter) + $14.40 (router sub-agents†) | $63.36 (73%) |
| Sub-agent escalations (~10% need Opus) | included above | $8.64 (router → Opus for 240 emails) | — |
| **Daily total** | **$397.44** | **$52.42** | **$345.02 (87%)** |
| **Monthly total** | **$11,923** | **$1,573** | **$10,350 (87%)** |

> † Sub-agent costs use [`iblai-router/auto`](https://github.com/iblai/iblai-openclaw-router) by default, which routes each task to the cheapest capable model (Haiku/Sonnet/Opus). Actual sub-agent cost will vary based on task complexity — but will always be the cheapest model that can handle it. The table estimates assume the router selects Sonnet for ~60% of actions and Opus for ~10% of escalations.

### The math

**First-pass checks (without triage):** 1,440 checks/day × 20K tokens × $15/1M = $432... adjusted for the check being a simpler prompt when using Opus for everything: 1,440 × 20K × $15/1M ≈ $311.04 (accounting for mixed input/output pricing).

**With triage:** Same 1,440 checks at Haiku rates: 1,440 × 20K × $1/1M ≈ $20.74 (with output token costs factored in).

**Email processing:** 2,400 emails × 20K tokens. Without triage, all go through Opus ($15/1M) = $86.40. With triage, Haiku classifies all 2,400 (~5K tokens each = $8.64), the router handles ~60% that need action (selecting the cheapest capable model, estimated ~$14.40), and routes ~10% complex escalations to Opus ($8.64).

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
    "whitelistedDomains": ["ibl.ai", "ibleducation.com"],
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
        "match": { "from": "*@ibl.ai", "subjectContains": ["DOWN", "alert", "critical", "urgent"] },
        "action": "escalate",
        "assignTo": "ops-team",
        "model": "claude-opus-4-6"
      },
      {
        "name": "bug-report",
        "match": { "from": "*@ibl.ai", "subjectContains": ["bug", "error", "broken", "500", "404"] },
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
      "ops-team": { "notify": "whatsapp-group-or-channel" },
      "engineering": { "notify": "whatsapp-group-or-channel" }
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
| `gmail.whitelistedDomains` | Only process emails from these domains | `["ibl.ai", "ibleducation.com"]` |
| `gmail.whitelistedAddresses` | Additional individual email addresses to allow | `[]` |
| `models.classifier` | Cheap model for first-pass classification | `claude-3-5-haiku-20241022` |
| `models.action` | Model for routing actions (sub-agents) | `iblai-router/auto` |
| `models.escalation` | Model for complex triage (sub-agents) | `iblai-router/auto` |
| `dedup.ttlHours` | How long to remember processed emails | `168` (7 days) |

> **Note on `iblai-router/auto`:** The default `action` and `escalation` models use the [iblai-router](https://github.com/iblai/iblai-openclaw-router), which automatically picks the cheapest Claude model capable of handling each sub-agent task. If you don't have the router installed, set these to direct model IDs instead:
> ```json
> "action": "claude-sonnet-4-6",
> "escalation": "claude-opus-4-6"
> ```

---

## Email Log Format

Every email gets logged to `email-triage.log` as JSONL (one JSON object per line):

```json
{"timestamp":"2026-02-18T10:30:00Z","emailId":"19c6...","from":"miguel@ibl.ai","to":"anne@ibl.ai","subject":"Fix the login bug on staging","receivedAt":"2026-02-18T10:29:45Z","classification":"bug-report","action":"route","assignedTo":"engineering","model":"claude-3-5-haiku-20241022","escalated":false,"processedAt":"2026-02-18T10:30:01Z","tokenCost":0.005}
```

| Field | Description |
|---|---|
| `emailId` | Gmail message ID |
| `classification` | Matched rule name |
| `action` | `classify`, `route`, or `escalate` |
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
git clone https://github.com/iblai/iblai-openclaw-email.git email-triage
bash email-triage/scripts/install.sh
```

### Option C: Manual setup

```bash
# 1. Clone into your workspace
cd ~/.openclaw/workspace
git clone https://github.com/iblai/iblai-openclaw-email.git email-triage

# 2. Create the systemd service
sudo tee /etc/systemd/system/iblai-email-triage.service > /dev/null << EOF
[Unit]
Description=iblai-email-triage - Email triage engine for OpenClaw
After=network.target

[Service]
Type=simple
ExecStart=$(which node) $HOME/.openclaw/workspace/email-triage/server.js
Environment=EMAIL_TRIAGE_CONFIG=$HOME/.openclaw/workspace/email-triage/config.json
Environment=EMAIL_TRIAGE_PORT=8403
Restart=always
RestartSec=5
WorkingDirectory=$HOME/.openclaw/workspace/email-triage

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

Adjust `gmail.checkIntervalSeconds` in `config.json` to balance cost vs latency:

| Interval | Checks/day | Haiku cost/day | Latency |
|---|---|---|---|
| 30s | 2,880 | $0.86 | <30s |
| 60s (default) | 1,440 | $0.43 | <60s |
| 120s | 720 | $0.22 | <2min |
| 300s | 288 | $0.09 | <5min |

Cost assumes ~20K tokens per check at Haiku rates ($1/1M input, $5/1M output). The config hot-reloads, so you can change the interval without restarting.

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
