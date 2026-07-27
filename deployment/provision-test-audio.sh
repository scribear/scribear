#!/usr/bin/env bash
#
# One-time provisioning for the two operator test-audio devices
# (PLAN-TestAudioDevices §5).
#
# Registers and activates one device per synthetic source, creates a dedicated
# room for each with that device as its source device, and prints the two .env
# lines to paste.
#
#   ./provision-test-audio.sh
#
# ---------------------------------------------------------------------------
# THE ROOM ASSIGNMENT IS THE ENTIRE SAFETY BOUNDARY.
#
# A device token reaches only its own device's room. Neither of these devices
# has any way to name another room - the token is exchanged through endpoints
# that are scoped to the device's own room - so the device-to-room assignment
# this script makes decides, permanently and by construction, which room
# synthetic audio can ever reach.
#
# That is the whole of the protection. Putting one of these devices in a
# teaching room would inject fixture speech into that lecture's LIVE CAPTIONS,
# silently, with nothing in the stack to notice it. It is a provisioning
# mistake, not a runtime one, and nothing at runtime can undo it.
#
# So this script will only ever create its own two rooms, and REFUSES to touch a
# room it did not create. If you need these devices in a differently-named room,
# create it and assign the device by hand, having read the paragraph above.
#
# TWO ROOMS, NOT ONE: a room has exactly one source device, and both devices
# must be able to run at once.
# ---------------------------------------------------------------------------

set -euo pipefail

if [ -f "$(dirname "$0")/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$(dirname "$0")/.env"
  set +a
fi

ORIGIN="${ORIGIN:?ORIGIN must be set (e.g. https://localhost:443)}"
API_KEY="${SESSION_MANAGER_API_KEY:?SESSION_MANAGER_API_KEY must be set}"
TIMEZONE="${TEST_AUDIO_ROOM_TIMEZONE:-UTC}"

# The only two rooms this script will ever create or accept. Hardcoded rather
# than taken as an argument: an argument is exactly how "just point it at the
# lecture hall for a second" happens.
GOOD_ROOM="TEST-AUDIO-GOOD"
FAULT_ROOM="TEST-AUDIO-FAULT"

SM="${ORIGIN}/api/session-manager/v1"
CURL=(curl -sS --fail-with-body)

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: $1 is required but not installed." >&2
    exit 1
  }
}
need curl
need jq

say() { printf '%s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Refuse to touch a room this script did not create.
#
# Checked BEFORE anything is registered, so a run that is going to be refused
# leaves no orphaned devices behind.
# ---------------------------------------------------------------------------
assert_room_is_ours_or_absent() {
  local name="$1" existing
  existing=$("${CURL[@]}" -G "${SM}/room-management/list-rooms" \
    --data-urlencode "search=${name}" \
    -H "Authorization: Bearer ${API_KEY}" |
    jq -r --arg name "${name}" '.items[] | select(.name == $name) | .uid' | head -n1)

  if [ -n "${existing}" ]; then
    say ""
    say "A room named ${name} already exists (uid ${existing})."
    say "Refusing to modify it. If it is a previous run of this script, delete"
    say "it and its device first; if it is anything else, do not reuse it - the"
    say "room assignment is the only thing keeping synthetic audio out of a"
    say "live lecture."
    exit 1
  fi
}

# Anything else that already carries one of these names is not ours by
# definition, since we only ever create these two.
say "Checking that neither test room already exists..."
assert_room_is_ours_or_absent "${GOOD_ROOM}"
assert_room_is_ours_or_absent "${FAULT_ROOM}"

# ---------------------------------------------------------------------------
# Register + activate one device, and echo its DEVICE_TOKEN.
#
# The token arrives as a Set-Cookie header on activate-device, which is why this
# reads headers rather than a JSON body.
# ---------------------------------------------------------------------------
provision_device() {
  local label="$1" registered code device_uid headers token

  registered=$("${CURL[@]}" -X POST "${SM}/device-management/register-device" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -d "{\"name\": \"${label}\"}")

  code=$(printf '%s' "${registered}" | jq -r '.activationCode')
  device_uid=$(printf '%s' "${registered}" | jq -r '.deviceUid')
  if [ -z "${code}" ] || [ "${code}" = "null" ]; then
    say "error: register-device did not return an activation code for ${label}."
    say "       response: ${registered}"
    exit 1
  fi

  headers=$("${CURL[@]}" -D - -o /dev/null -X POST \
    "${SM}/device-management/activate-device" \
    -H "Content-Type: application/json" \
    -d "{\"activationCode\": \"${code}\"}")

  # `{deviceUid}:{secret}` out of `Set-Cookie: DEVICE_TOKEN=...; Path=...`.
  token=$(printf '%s' "${headers}" |
    tr -d '\r' |
    sed -n 's/^[Ss]et-[Cc]ookie: *DEVICE_TOKEN=\([^;]*\).*$/\1/p' | head -n1)

  if [ -z "${token}" ]; then
    say "error: activate-device did not set a DEVICE_TOKEN cookie for ${label}."
    exit 1
  fi

  # Both values, on one line, for the caller to split.
  printf '%s %s\n' "${device_uid}" "${token}"
}

create_room() {
  local name="$1" device_uid="$2"
  "${CURL[@]}" -X POST "${SM}/room-management/create-room" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -d "{\"name\": \"${name}\", \"timezone\": \"${TIMEZONE}\", \"autoSessionEnabled\": false, \"sourceDeviceUids\": [\"${device_uid}\"]}" |
    jq -r '.uid'
}

say "Registering the good source device..."
read -r GOOD_UID GOOD_TOKEN <<<"$(provision_device 'test-audio-good')"

say "Registering the fault source device..."
read -r FAULT_UID FAULT_TOKEN <<<"$(provision_device 'test-audio-fault')"

say "Creating ${GOOD_ROOM} with the good device as its source..."
GOOD_ROOM_UID=$(create_room "${GOOD_ROOM}" "${GOOD_UID}")

say "Creating ${FAULT_ROOM} with the fault device as its source..."
FAULT_ROOM_UID=$(create_room "${FAULT_ROOM}" "${FAULT_UID}")

cat <<EOF

Done.

  ${GOOD_ROOM}   ${GOOD_ROOM_UID}   source device ${GOOD_UID}
  ${FAULT_ROOM}  ${FAULT_ROOM_UID}  source device ${FAULT_UID}

Two rooms, because a room has exactly one source device and both of these must
be able to run at once.

Add to deployment/.env:

TEST_AUDIO_SERVICE_KEY=<pick a strong secret, the same value on both sides>
TEST_AUDIO_GOOD_DEVICE_TOKEN=${GOOD_TOKEN}
TEST_AUDIO_FAULT_DEVICE_TOKEN=${FAULT_TOKEN}
TEST_AUDIO_BASE_URL=http://test-audio-generator:80

then restart so the generator picks them up:

docker compose up -d

--------------------------------------------------------------------------
Each token above reaches ONLY the room named beside it. That is the entire
safety boundary for these devices - neither has any way to name another room.
Do not move either device into a room that carries real lectures: fixture
speech would be transcribed into that lecture's live captions, silently.

Neither room has a schedule yet, so there is no session to stream into. Give
each one a standing session (deployment/create-session.sh, or the admin
console) before the devices will do anything.
--------------------------------------------------------------------------
EOF
