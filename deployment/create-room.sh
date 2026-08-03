#!/usr/bin/env bash
set -euo pipefail

if [ -f "$(dirname "$0")/.env" ]; then
  set -a
  source "$(dirname "$0")/.env"
  set +a
fi

ORIGIN="${ORIGIN:?ORIGIN must be set (e.g. https://localhost:443)}"
API_KEY="${SESSION_MANAGER_API_KEY:?SESSION_MANAGER_API_KEY must be set}"
ROOM_NAME="${1:?Usage: $0 <room-name> <source-device-uid> [timezone] [auto-session-enabled]}"
SOURCE_DEVICE_UID="${2:?Usage: $0 <room-name> <source-device-uid> [timezone] [auto-session-enabled]}"
TIMEZONE="${3:-UTC}"
AUTO_SESSION_ENABLED="${4:-false}"

curl -s -X POST "${ORIGIN}/api/session-manager/v1/room-management/create-room" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d "{\"name\": \"${ROOM_NAME}\", \"timezone\": \"${TIMEZONE}\", \"autoSessionEnabled\": ${AUTO_SESSION_ENABLED}, \"sourceDeviceUids\": [\"${SOURCE_DEVICE_UID}\"]}"

echo
