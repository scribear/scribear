#!/usr/bin/env bash
set -euo pipefail

if [ -f "$(dirname "$0")/.env" ]; then
  set -a
  source "$(dirname "$0")/.env"
  set +a
fi

ORIGIN="${ORIGIN:?ORIGIN must be set (e.g. https://localhost:443)}"
API_KEY="${SESSION_MANAGER_API_KEY:?SESSION_MANAGER_API_KEY must be set}"
ROOM_UID="${1:?Usage: $0 <room-uid> <session-name> [transcription-provider-id]}"
SESSION_NAME="${2:?Usage: $0 <room-uid> <session-name> [transcription-provider-id]}"
TRANSCRIPTION_PROVIDER_ID="${3:-whisper}"

# Room must already exist with a source device (see create-room.sh) - a
# session can no longer be created directly from a device id.
curl -s -X POST "${ORIGIN}/api/session-manager/v1/schedule-management/create-on-demand-session" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d "{\"roomUid\": \"${ROOM_UID}\", \"name\": \"${SESSION_NAME}\", \"joinCodeScopes\": [\"RECEIVE_TRANSCRIPTIONS\"], \"transcriptionProviderId\": \"${TRANSCRIPTION_PROVIDER_ID}\", \"transcriptionStreamConfig\": {}}"

echo
