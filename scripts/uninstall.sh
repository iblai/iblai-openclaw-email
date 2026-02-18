#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="iblai-email-triage"

echo "=== iblai-openclaw-email uninstaller ==="

if systemctl is-active --quiet ${SERVICE_NAME} 2>/dev/null; then
  echo "Stopping ${SERVICE_NAME}..."
  sudo systemctl stop ${SERVICE_NAME}
fi

if systemctl is-enabled --quiet ${SERVICE_NAME} 2>/dev/null; then
  echo "Disabling ${SERVICE_NAME}..."
  sudo systemctl disable ${SERVICE_NAME}
fi

if [ -f /etc/systemd/system/${SERVICE_NAME}.service ]; then
  echo "Removing service file..."
  sudo rm /etc/systemd/system/${SERVICE_NAME}.service
  sudo systemctl daemon-reload
fi

echo ""
echo "✓ Service ${SERVICE_NAME} removed"
echo "  Config and log files were NOT deleted."
echo "  To fully remove: rm -rf $(dirname "$(dirname "$0")")"
echo ""
echo "Done!"
