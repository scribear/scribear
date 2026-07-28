#!/usr/bin/env bash
#
# Fetch this environment's compose.yml and bring the stack up to match it -
# the sequence an operator runs by hand after a release, packaged so a timer
# or cron entry can run it unattended. Replaces watchtower (see UPGRADING.md,
# "watchtower is gone") and the old fetch-only fetch_compose.sh/get_compose.sh
# scripts.
#
# Unlike watchtower, the last step really is `docker compose up -d`, so it
# runs db-migrate and waits on depends_on/service_healthy exactly as a manual
# upgrade would - the whole reason those exist in compose.yml. It also
# restarts nginx afterward: nginx's upstream blocks resolve a backend
# container's address once at nginx's own startup, so any other service this
# script recreates can leave nginx pointed at a stale address until something
# bounces it.
#
# Usage:
#   ./deploy_latest.sh            # branch inferred from .env's IMAGE_TAG
#   ./deploy_latest.sh staging    # explicit override
#   ./deploy_latest.sh main
#
# Exits non-zero on any failure - fetch, pull, or `up -d` (which itself fails
# if db-migrate or any depends_on chain does) - so a systemd timer or cron
# entry running this sees the failure rather than a silently half-applied
# stack.
set -euo pipefail
cd "$(dirname "$0")"

log() { echo "[$(date -u +%FT%TZ)] $*"; }

# ---- 0. Refuse to overlap a slow or stuck run ------------------------------
# A timer/cron entry firing every 30 minutes must not stack a second `up -d`
# on top of one still waiting on a healthcheck.
LOCK_FILE="/tmp/scribear-deploy-$(basename "$PWD").lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "Another deploy_latest.sh is already running for $PWD (lock: $LOCK_FILE). Exiting."
  exit 1
fi

# On any failure past this point, show the full container picture before
# exiting - the thing an operator would otherwise have to SSH in and run by
# hand to start diagnosing.
on_error() {
  log "FAILED. Current container state:"
  docker compose ps -a || true
}
trap on_error ERR

# ---- 1. Resolve which branch this environment tracks -----------------------
if [[ $# -ge 1 ]]; then
  BRANCH="$1"
elif [[ -f .env ]] && grep -qE '^IMAGE_TAG=latest\s*$' .env; then
  BRANCH="main"
else
  BRANCH="staging"
fi

if [[ "$BRANCH" != "staging" && "$BRANCH" != "main" ]]; then
  echo "ERROR: branch must be 'staging' or 'main' (got: '$BRANCH')" >&2
  exit 2
fi

log "Deploying branch '$BRANCH' in $PWD"

# ---- 2. Fetch this branch's files, each sanity-checked before it replaces --
# ---     anything, and only swapped in if it actually changed. -------------
BASE_URL="https://raw.githubusercontent.com/scribear/scribear/refs/heads/${BRANCH}/deployment"

# $1 = filename, relative to deployment/ both remotely and here.
# $2 = optional grep pattern the download must match, or it's discarded as a
#      likely 404/redirect page rather than installed.
fetch_file() {
  local name="$1" validate="${2:-}" tmp
  tmp="$(mktemp -t "${name//\//_}.XXXXXX")"

  if ! wget -q -O "$tmp" "${BASE_URL}/${name}"; then
    rm -f "$tmp"
    echo "ERROR: download of ${name} from ${BASE_URL} failed; leaving existing ${name} in place." >&2
    return 1
  fi

  if [[ -n "$validate" ]] && ! grep -q "$validate" "$tmp"; then
    rm -f "$tmp"
    echo "ERROR: fetched ${name} from '${BRANCH}' doesn't look right (missing '${validate}' - a 404 page?). Leaving existing ${name} in place." >&2
    return 1
  fi

  if [[ -f "$name" ]] && cmp -s "$tmp" "$name"; then
    rm -f "$tmp"
    log "${name} unchanged."
    return 0
  fi

  if [[ -f "$name" ]]; then
    local stamp
    stamp="$(date -u +%Y%m%d-%H%M%S)"
    mv -- "$name" "${name}-discardedat-${stamp}"
    log "Set aside previous ${name} as ${name}-discardedat-${stamp}"
  fi
  mv -- "$tmp" "$name"
  log "Installed new ${name} from branch '${BRANCH}'."
}

fetch_file "compose.yml" '^services:'

# Keep this script itself current too, the same way compose.yml stays current
# - so a host bootstrapped once keeps picking up fixes to this file without
# anyone re-copying it by hand. A failed fetch here doesn't abort the deploy;
# the currently-running copy already loaded and finishes the job regardless.
fetch_file "deploy_latest.sh" '^#!/usr/bin/env bash' || true
chmod +x deploy_latest.sh 2>/dev/null || true

# ---- 3. Pull images and bring the stack up, in dependency order ------------
log "Pulling images..."
docker compose pull

log "Applying stack..."
docker compose up -d

# ---- 4. Defensive nginx bounce ---------------------------------------------
# See UPGRADING.md "watchtower is gone": nginx resolves its upstreams once at
# its own startup, so any backend `up -d` just recreated can leave nginx
# pointed at a stale address. Cheap and safe to do unconditionally; remove
# once nginx's upstreams resolve dynamically instead (tracked separately).
if docker compose ps --services | grep -qx nginx; then
  log "Restarting nginx to pick up any backend address changes..."
  docker compose restart nginx
fi

log "Done. Current state:"
docker compose ps -a
