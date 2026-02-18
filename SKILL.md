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

## Requirements

- Node.js ≥ 18
- Gmail OAuth2 credentials (token.json + credentials.json)
- Gmail read scope authorized

## Files

- `server.js` — Main triage engine
- `config.json` — All configuration
- `email-triage.log` — JSONL log of all processed emails (created at runtime)
- `processed-emails.json` — Dedup state (created at runtime)
