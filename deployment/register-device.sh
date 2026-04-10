#!/usr/bin/env bash
set -euo pipefail

if [ -f "$(dirname "$0")/.env" ]; then
  set -a
  source "$(dirname "$0")/.env"
  set +a
fi

ORIGIN="${ORIGIN:?ORIGIN must be set (e.g. https://localhost:443)}"
API_KEY="${SESSION_MANAGER_API_KEY:?SESSION_MANAGER_API_KEY must be set}"
DEVICE_NAME="${1:?Usage: $0 <device-name>}"

curl -s -X POST "${ORIGIN}/api/session-manager/device-management/v1/register-device" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d "{\"deviceName\": \"${DEVICE_NAME}\"}"

echo
