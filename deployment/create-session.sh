#!/usr/bin/env bash
set -euo pipefail

if [ -f "$(dirname "$0")/.env" ]; then
  set -a
  source "$(dirname "$0")/.env"
  set +a
fi

ORIGIN="${ORIGIN:?ORIGIN must be set (e.g. https://localhost:443)}"
API_KEY="${SESSION_MANAGER_API_KEY:?SESSION_MANAGER_API_KEY must be set}"
DEVICE_ID="${1:?Usage: $0 <source-device-id>}"

curl -s -X POST "${ORIGIN}/api/session-manager/session-management/v1/create-session" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d "{\"sourceDeviceId\": \"${DEVICE_ID}\", \"transcriptionProviderKey\": \"whisper\", \"transcriptionProviderConfig\": {}, \"enableJoinCode\": true, \"joinCodeLength\": 6}"

echo
