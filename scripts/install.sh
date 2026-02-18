#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_NAME="iblai-email-triage"

echo "=== iblai-openclaw-email installer ==="

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is required (>= 18). Install it first."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 required, found v$(node -v)"
  exit 1
fi

echo "✓ Node.js $(node -v)"

# Check credentials exist
TOKEN_PATH=$(node -e "const c=JSON.parse(require('fs').readFileSync('$PROJECT_DIR/config.json','utf8'));const p=c.gmail.tokenPath.replace('~',process.env.HOME);console.log(p)")
CREDS_PATH=$(node -e "const c=JSON.parse(require('fs').readFileSync('$PROJECT_DIR/config.json','utf8'));const p=c.gmail.credentialsPath.replace('~',process.env.HOME);console.log(p)")

if [ ! -f "$TOKEN_PATH" ]; then
  echo "WARNING: Gmail token not found at $TOKEN_PATH"
  echo "  You'll need OAuth2 credentials before the triage engine can poll Gmail."
  echo "  See README.md for setup instructions."
fi

if [ ! -f "$CREDS_PATH" ]; then
  echo "WARNING: Gmail credentials not found at $CREDS_PATH"
fi

# Create systemd service
echo "Creating systemd service..."
sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null << EOF
[Unit]
Description=iblai-email-triage - Email triage engine for OpenClaw
After=network.target

[Service]
Type=simple
ExecStart=$(which node) ${PROJECT_DIR}/server.js
Environment=EMAIL_TRIAGE_CONFIG=${PROJECT_DIR}/config.json
Environment=EMAIL_TRIAGE_PORT=8403
Restart=always
RestartSec=5
WorkingDirectory=${PROJECT_DIR}

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now ${SERVICE_NAME}

echo ""
echo "✓ Service ${SERVICE_NAME} installed and started"
echo "  Health: curl http://127.0.0.1:8403/health"
echo "  Stats:  curl http://127.0.0.1:8403/stats"
echo "  Logs:   journalctl -u ${SERVICE_NAME} -f"
echo ""
echo "Done!"
