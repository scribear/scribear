#!/usr/bin/env bash
set -euo pipefail

if [ -f "$(dirname "$0")/.env" ]; then
  set -a
  source "$(dirname "$0")/.env"
  set +a
fi

HOST="${HOST:-localhost}"
PORT="${NGINX_PORT:-80}"
API_KEY="${SESSION_MANAGER_API_KEY:?SESSION_MANAGER_API_KEY must be set}"
DEVICE_NAME="${1:?Usage: $0 <device-name>}"

curl -s -X POST "http://${HOST}:${PORT}/api/session-manager/device-management/v1/register-device" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d "{\"deviceName\": \"${DEVICE_NAME}\"}"

echo
