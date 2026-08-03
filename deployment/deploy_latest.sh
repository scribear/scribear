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
# reloads nginx afterward as a belt-and-suspenders step: nginx's upstreams
# resolve backend addresses dynamically (see infra/scribear-nginx/nginx.conf's
# `resolve`/`zone` upstreams), so this isn't load-bearing, but a reload picks
# up any address change immediately instead of waiting out the resolver's TTL.
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
#
# Under this directory rather than /tmp, deliberately: a shared, world-
# writable /tmp lets another user on the same host pre-create or symlink this
# exact path, either to DoS the deploy or redirect the write elsewhere. This
# directory is already only as trusted as whoever can edit .env/compose.yml
# here, which the rest of this script already assumes.
LOCK_FILE="./.deploy.lock"
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
# Reads the raw value rather than just checking for "latest" so both failure
# modes below are refused explicitly rather than silently guessed:
#   - a pinned release tag (IMAGE_TAG=0.3.0) doesn't match "latest" or
#     "staging" and would otherwise fall through to "staging" - deploying
#     staging's images onto a host deliberately pinned to a release.
#   - a trailing comment (IMAGE_TAG=latest # production) doesn't match a bare
#     "latest" and would otherwise be missed entirely, again falling through
#     to "staging".
# Both used to resolve silently; an operator on a tagged release could wake up
# to staging images with no indication anything had been inferred at all.
IMAGE_TAG_VALUE=""
if [[ -f .env ]]; then
  IMAGE_TAG_VALUE="$(grep -E '^IMAGE_TAG=' .env | tail -1 | sed -E 's/^IMAGE_TAG=//; s/[[:space:]]*(#.*)?$//')"
fi

if [[ $# -ge 1 ]]; then
  BRANCH="$1"
  log "Branch '${BRANCH}' given explicitly (.env IMAGE_TAG='${IMAGE_TAG_VALUE:-<unset>}')."
elif [[ "$IMAGE_TAG_VALUE" == "latest" ]]; then
  BRANCH="main"
  log "Inferred branch 'main' from .env IMAGE_TAG=latest."
elif [[ "$IMAGE_TAG_VALUE" == "staging" || -z "$IMAGE_TAG_VALUE" ]]; then
  BRANCH="staging"
  log "Inferred branch 'staging' from .env IMAGE_TAG='${IMAGE_TAG_VALUE:-<unset>}'."
else
  echo "ERROR: .env sets IMAGE_TAG='${IMAGE_TAG_VALUE}', which is neither 'latest' nor 'staging' - likely a pinned release tag. Refusing to guess which branch to deploy: pass it explicitly, e.g. './deploy_latest.sh staging'." >&2
  exit 2
fi

if [[ "$BRANCH" != "staging" && "$BRANCH" != "main" ]]; then
  echo "ERROR: branch must be 'staging' or 'main' (got: '$BRANCH')" >&2
  exit 2
fi

# ---- 2. Fetch this branch's files, verified before anything is replaced ---
#
# Prefers the GitHub Contents API (api.github.com) over a bare
# raw.githubusercontent.com download: the API response includes the file's
# git blob sha, recomputed locally and compared before anything is written to
# disk. A plain download plus a regex sanity check (the previous approach)
# only rules out an obvious 404/redirect page - it does nothing against a
# tampered CDN edge or an on-path MITM that still returns something matching
# the pattern, and this script runs unattended, on a timer, as whatever user
# can run `docker compose up -d`. Falls back to the old unverified path only
# if `jq` isn't installed, with a loud warning - this script would rather run
# degraded than refuse to deploy over one missing small dependency.
API_BASE="https://api.github.com/repos/scribear/scribear/contents/deployment"
RAW_BASE="https://raw.githubusercontent.com/scribear/scribear/refs/heads/${BRANCH}/deployment"
HAVE_JQ=0
command -v jq >/dev/null 2>&1 && HAVE_JQ=1

# Retries transient network failures - a 30-minute timer can far more easily
# afford a few seconds' backoff than it can afford a real release being
# delayed a full cycle for one blip - and surfaces curl's actual error
# (DNS/TLS/404/timeout) rather than swallowing it the way `wget -q` did,
# which is a real debugging cost on an unattended timer whose log is the
# first thing an operator reads after a failure.
curl_with_retry() {
  local url="$1" outfile="$2" errfile attempt rc
  errfile="$(mktemp)"
  for attempt in 1 2 3; do
    if curl -fsSL "$url" -o "$outfile" 2>"$errfile"; then
      rm -f "$errfile"
      return 0
    fi
    rc=$?
    if [[ $attempt -lt 3 ]]; then
      log "GET ${url} failed (attempt ${attempt}/3, exit ${rc}): $(cat "$errfile")"
      sleep $((attempt * 2))
    fi
  done
  echo "ERROR: GET ${url} failed after 3 attempts: $(cat "$errfile")" >&2
  rm -f "$errfile"
  return 1
}

# $1 = filename, relative to deployment/ both remotely and here.
# $2 = optional grep pattern the content must match, or it's discarded as a
#      likely 404/redirect page rather than installed.
fetch_file() {
  local name="$1" validate="${2:-}" tmp meta sha content_b64 computed_sha verified_note=""

  tmp="$(mktemp -t "${name//\//_}.XXXXXX")"

  if [[ "$HAVE_JQ" -eq 1 ]]; then
    meta="$(mktemp)"
    if ! curl_with_retry "${API_BASE}/${name}?ref=${BRANCH}" "$meta"; then
      rm -f "$tmp" "$meta"
      return 1
    fi
    sha="$(jq -r '.sha // empty' "$meta")"
    content_b64="$(jq -r '.content // empty' "$meta")"
    rm -f "$meta"
    if [[ -z "$sha" || -z "$content_b64" ]]; then
      echo "ERROR: GitHub API response for ${name} (branch '${BRANCH}') had no sha/content - a rate limit or API error page. Leaving existing ${name} in place." >&2
      rm -f "$tmp"
      return 1
    fi
    echo "$content_b64" | base64 -d > "$tmp"
    computed_sha="$({ printf 'blob %s\0' "$(wc -c < "$tmp")"; cat "$tmp"; } | sha1sum | cut -d' ' -f1)"
    if [[ "$computed_sha" != "$sha" ]]; then
      echo "ERROR: ${name} (branch '${BRANCH}') failed integrity verification - computed blob sha ${computed_sha}, GitHub API reported ${sha}. Refusing to install a file that doesn't match what GitHub says is committed. Leaving existing ${name} in place." >&2
      rm -f "$tmp"
      return 1
    fi
    verified_note=", verified against GitHub's reported blob sha"
  else
    log "WARNING: jq not installed - fetching ${name} from raw.githubusercontent.com with no integrity check beyond a content sanity check. Install jq for a verified fetch."
    if ! curl_with_retry "${RAW_BASE}/${name}" "$tmp"; then
      rm -f "$tmp"
      return 1
    fi
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

    # Keep only the 5 most recent discards - otherwise a host running this
    # every 30 minutes for months accumulates one file per change, forever.
    local discards=()
    mapfile -t discards < <(ls -1t "${name}-discardedat-"* 2>/dev/null || true)
    if [[ ${#discards[@]} -gt 5 ]]; then
      for old in "${discards[@]:5}"; do
        rm -f -- "$old"
      done
    fi
  fi
  mv -- "$tmp" "$name"
  log "Installed new ${name} from branch '${BRANCH}'${verified_note}."
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

# ---- 4. Defensive nginx reload ---------------------------------------------
# Not load-bearing (see the top-of-file comment): nginx already re-resolves
# every backend address on its own within a few seconds. This just forces
# that immediately rather than waiting out the TTL, and - since this script
# never touches nginx.conf itself - a reload is enough; it doesn't drop
# client-facing connections the way a full restart would. Best-effort: this
# step failing (e.g. nginx not running for an unrelated reason) doesn't fail
# a deploy that otherwise succeeded.
if docker compose ps --services | grep -qx nginx; then
  log "Reloading nginx to pick up any backend address changes immediately..."
  docker compose exec -T nginx nginx -s reload \
    || log "WARNING: nginx reload failed (non-fatal - its own resolver will pick up any change within a few seconds regardless)."
fi

log "Done. Current state:"
docker compose ps -a
