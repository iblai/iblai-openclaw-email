# Email Triage

Local email triage engine for OpenClaw. Polls Gmail on a configurable interval, classifies emails with a cheap LLM (Haiku), and only escalates to expensive models when action is needed.

## Install

```bash
bash scripts/install.sh
```

## Uninstall

```bash
bash scripts/uninstall.sh
```

## Endpoints

- `GET http://127.0.0.1:8403/health` — Health check
- `GET http://127.0.0.1:8403/stats` — Processing statistics

## Configuration

Edit `config.json` to customize Gmail settings, models, triage rules, and polling frequency. The server hot-reloads on config changes.

## Interactive Rule Setup

When a user asks to set up email triage rules (or says "set up email triage rules for me"), walk them through these questions:

1. **What email address should I monitor?** (e.g., `anne@ibl.ai`)
2. **What domains should I accept emails from?** (comma-separated, e.g., `ibl.ai, ibleducation.com`)
3. **What kinds of emails do you typically receive?** Ask them to describe 2-5 categories in plain language.
4. **For each category, what should happen?** (create an issue, notify a channel, escalate, just log it)
5. **Are there VIP senders whose emails should always get full attention?** (these get `action: "escalate"`)
6. **What teams do you have, and how should they be notified?** (WhatsApp group JIDs, Slack channels, etc.)

Then generate the `triage.rules` array and `triage.teams` object in `config.json` based on their answers. Write the config file directly — it hot-reloads, no restart needed.

If the user instead describes their setup in a single message (e.g., "I get Pingdom alerts and bug reports, alerts should go to the fires channel"), skip the interview and generate rules directly from their description.

## Auto-Generate Rules from Email History

When a user asks to generate rules from their email history (or says "analyze my emails and create rules"):

1. Use the Gmail skill to fetch the last 200 emails (metadata only: From, Subject, Date)
2. Cluster by sender domain and subject patterns
3. Count frequency per cluster
4. For each cluster, propose: rule name, match pattern (from + subjectContains), action (skip/classify/route/escalate), and suggested team
5. Present the proposed rules to the user in a readable format with email counts and example subjects
6. Ask for approval before writing to config.json
7. Flag high-volume noise sources (e.g., GitHub notifications, automated alerts) and suggest "skip" rules for them to save on classification costs

Key: only fetch metadata (From, Subject, Date headers) — don't read email bodies. This keeps the analysis fast and cheap.

## Requirements

- Node.js ≥ 18
- Gmail OAuth2 credentials (token.json + credentials.json)
- Gmail read scope authorized

## Files

- `server.js` — Main triage engine
- `config.json` — All configuration
- `email-triage.log` — JSONL log of all processed emails (created at runtime)
- `processed-emails.json` — Dedup state (created at runtime)
