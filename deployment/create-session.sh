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
DEVICE_ID="${1:?Usage: $0 <source-device-id>}"

curl -s -X POST "http://${HOST}:${PORT}/api/session-manager/session-management/v1/create-session" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d "{\"sourceDeviceId\": \"${DEVICE_ID}\", \"transcriptionProviderKey\": \"whisper\", \"transcriptionProviderConfig\": {}, \"enableJoinCode\": true, \"joinCodeLength\": 6}"

echo
