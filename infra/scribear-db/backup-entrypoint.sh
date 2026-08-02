#!/bin/sh
# db-backup's entire job: on a schedule, pg_dump $DB_NAME (plus a small
# pg_dumpall --globals-only alongside it, for the roles pg_dump does not
# cover), keep BACKUP_RETENTION_DAYS days of both under $BACKUP_DIR, and - if
# configured - push each one off this host over scp or rsync-over-ssh,
# retrying any that failed to push on a prior cycle before creating a new
# one. See deployment/UPGRADING.md.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-14400}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
OFFSITE_METHOD="${BACKUP_OFFSITE_METHOD:-none}"
ENABLED="${BACKUP_ENABLED:-true}"
ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"
SSH_KEY_MOUNT="/keys/backup_key"
SSH_KEY_RUNTIME="/tmp/backup_ssh_key"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

is_positive_int() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    0) return 1 ;;
    *) return 0 ;;
  esac
}

is_positive_int "$INTERVAL" || {
  log "BACKUP_INTERVAL_SECONDS must be a positive integer, got '${INTERVAL}' - refusing to start."
  exit 1
}
is_positive_int "$RETENTION_DAYS" || {
  log "BACKUP_RETENTION_DAYS must be a positive integer, got '${RETENTION_DAYS}' - refusing to start."
  exit 1
}

case "$ENABLED" in
  true) ;;
  false)
    log "BACKUP_ENABLED=false - idling. No backups will be taken until this is unset or set to true."
    # A long sleep loop rather than exiting: an exited container reads as
    # crashed in `docker compose ps`, and `restart: unless-stopped` would just
    # start it again anyway. `scribear-backup-healthcheck.sh` reads this same
    # variable and reports healthy while idling, for the same reason.
    while true; do sleep 3600; done
    ;;
  *)
    log "BACKUP_ENABLED must be true or false, got '${ENABLED}' - refusing to start."
    exit 1
    ;;
esac

case "$OFFSITE_METHOD" in
  none) ;;
  scp | rsync)
    : "${BACKUP_OFFSITE_HOST:?BACKUP_OFFSITE_METHOD=$OFFSITE_METHOD needs BACKUP_OFFSITE_HOST}"
    : "${BACKUP_OFFSITE_USER:?BACKUP_OFFSITE_METHOD=$OFFSITE_METHOD needs BACKUP_OFFSITE_USER}"
    : "${BACKUP_OFFSITE_PATH:?BACKUP_OFFSITE_METHOD=$OFFSITE_METHOD needs BACKUP_OFFSITE_PATH}"
    if [ ! -s "$SSH_KEY_MOUNT" ]; then
      log "BACKUP_SSH_KEY_PATH does not point at a readable private key - refusing to start."
      exit 1
    fi
    # Copied out of the read-only bind mount because ssh/scp/rsync refuse a
    # key with group/other permission bits set, and a `:ro` mount cannot be
    # chmod'd in place.
    cp "$SSH_KEY_MOUNT" "$SSH_KEY_RUNTIME"
    chmod 600 "$SSH_KEY_RUNTIME"
    ;;
  *)
    log "Unknown BACKUP_OFFSITE_METHOD '${OFFSITE_METHOD}' (expected none, scp or rsync) - refusing to start."
    exit 1
    ;;
esac

mkdir -p "$BACKUP_DIR"

# Cleared once each scratch file has been dealt with, so a SIGTERM or crash
# mid-dump/mid-encrypt never leaves an unencrypted or partial file sitting in
# $BACKUP_DIR - only ever whatever `CURRENT_TMP` names at the moment of exit.
CURRENT_TMP=""
cleanup_tmp() {
  [ -n "$CURRENT_TMP" ] && rm -f "$CURRENT_TMP"
}
trap cleanup_tmp EXIT INT TERM

push_offsite() {
  file="$1"
  dest="${BACKUP_OFFSITE_USER}@${BACKUP_OFFSITE_HOST}:${BACKUP_OFFSITE_PATH%/}/"
  case "$OFFSITE_METHOD" in
    scp)
      scp -i "$SSH_KEY_RUNTIME" -P "${BACKUP_OFFSITE_PORT:-22}" \
        -o StrictHostKeyChecking=accept-new \
        "$file" "$dest"
      ;;
    rsync)
      rsync -az -e "ssh -i $SSH_KEY_RUNTIME -p ${BACKUP_OFFSITE_PORT:-22} -o StrictHostKeyChecking=accept-new" \
        "$file" "$dest"
      ;;
  esac
}

# Pushes $1 unless a `.pushed` marker next to it says a prior cycle already
# did, and marks it on success. The marker - not the offsite host - is the
# source of truth for "was this pushed", so retrying costs one stat per file
# per cycle rather than a directory listing on the remote end.
push_if_unpushed() {
  file="$1"
  [ -f "${file}.pushed" ] && return 0
  if push_offsite "$file"; then
    touch "${file}.pushed"
    log "Pushed ${file} to ${BACKUP_OFFSITE_HOST} via ${OFFSITE_METHOD}"
  else
    log "WARNING: offsite push of ${file} failed - local copy retained, will retry next cycle"
    return 1
  fi
}

# Retries every unpushed dump/globals file before this cycle creates a new
# one. Without this, a sustained offsite outage created a permanent gap: the
# original version of this script only ever pushed the file it had just
# created, so anything produced while the offsite host was unreachable was
# never pushed once it recovered - it just aged out of local retention
# unpushed. This closes that: every cycle sweeps for leftovers first.
retry_unpushed() {
  [ "$OFFSITE_METHOD" = "none" ] && return 0
  for f in "$BACKUP_DIR/${DB_NAME}"-*.dump "$BACKUP_DIR/${DB_NAME}"-*.dump.gpg \
    "$BACKUP_DIR/${DB_NAME}"-globals-*.sql "$BACKUP_DIR/${DB_NAME}"-globals-*.sql.gpg; do
    [ -e "$f" ] || continue
    push_if_unpushed "$f" || true
  done
}

# Encrypts $1 (a scratch file holding plaintext) to $2 when
# BACKUP_ENCRYPTION_KEY is set, appending `.gpg`; otherwise just moves it to
# $2 unchanged. Callers always produce plaintext first and let this decide
# what actually lands in $BACKUP_DIR, so the integrity check in run_dump
# below runs on plaintext regardless of whether encryption is on.
finalize() {
  src="$1"
  dest="$2"
  if [ -n "$ENCRYPTION_KEY" ]; then
    printf '%s' "$ENCRYPTION_KEY" |
      gpg --batch --yes --pinentry-mode loopback --symmetric --cipher-algo AES256 \
        --passphrase-fd 0 -o "${dest}.gpg" "$src"
    rm -f "$src"
  else
    mv "$src" "$dest"
  fi
}

run_dump() {
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  file="$BACKUP_DIR/${DB_NAME}-${ts}.dump"
  CURRENT_TMP="${file}.tmp"

  log "Starting pg_dump of ${DB_NAME}@${DB_HOST} -> ${file}"
  # --lock-wait-timeout, not because the dump would otherwise deadlock, but so
  # an ACCESS SHARE lock queued behind a db-migrate DDL run during a deploy
  # fails fast and retries next cycle instead of stalling that migration.
  if ! PGPASSWORD="$DB_PASSWORD" pg_dump \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    --lock-wait-timeout=5000 -Fc -f "$CURRENT_TMP"; then
    log "WARNING: pg_dump failed - no backup written this cycle"
    rm -f "$CURRENT_TMP"
    CURRENT_TMP=""
    return
  fi

  # A dump pg_dump exits 0 on can still be an archive nothing can read back -
  # catalog corruption or OOM mid-dump both complete with exit 0. Listing it
  # is the cheapest check that catches that here rather than on restore day.
  if ! pg_restore -l "$CURRENT_TMP" >/dev/null 2>&1; then
    log "WARNING: pg_dump exited 0 but the archive failed pg_restore -l - discarding"
    rm -f "$CURRENT_TMP"
    CURRENT_TMP=""
    return
  fi

  finalize "$CURRENT_TMP" "$file"
  CURRENT_TMP=""
  [ -n "$ENCRYPTION_KEY" ] && file="${file}.gpg"
  log "Backup complete: ${file} ($(du -h "$file" | cut -f1))"

  if [ "$OFFSITE_METHOD" != "none" ]; then
    push_if_unpushed "$file" || true
  fi
}

# Cluster-level objects pg_dump does not cover - roles, in this stack's case,
# since DB_USER is the only one it needs to restore. Small and fast next to
# the main dump, so it runs every cycle rather than on a schedule of its own.
run_globals() {
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  file="$BACKUP_DIR/${DB_NAME}-globals-${ts}.sql"
  CURRENT_TMP="${file}.tmp"

  if ! PGPASSWORD="$DB_PASSWORD" pg_dumpall \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" \
    --globals-only -f "$CURRENT_TMP"; then
    log "WARNING: pg_dumpall --globals-only failed - no globals backup written this cycle"
    rm -f "$CURRENT_TMP"
    CURRENT_TMP=""
    return
  fi

  finalize "$CURRENT_TMP" "$file"
  CURRENT_TMP=""
  [ -n "$ENCRYPTION_KEY" ] && file="${file}.gpg"

  if [ "$OFFSITE_METHOD" != "none" ]; then
    push_if_unpushed "$file" || true
  fi
}

prune_retention() {
  find "$BACKUP_DIR" \
    \( -name "${DB_NAME}-*.dump" -o -name "${DB_NAME}-*.dump.gpg" \
    -o -name "${DB_NAME}-*.dump.pushed" -o -name "${DB_NAME}-*.dump.gpg.pushed" \
    -o -name "${DB_NAME}-globals-*.sql" -o -name "${DB_NAME}-globals-*.sql.gpg" \
    -o -name "${DB_NAME}-globals-*.sql.pushed" -o -name "${DB_NAME}-globals-*.sql.gpg.pushed" \) \
    -mtime "+${RETENTION_DAYS}" -delete
}

run_backup() {
  retry_unpushed
  run_dump
  run_globals
  prune_retention
}

log "db-backup starting: interval=${INTERVAL}s retention=${RETENTION_DAYS}d offsite=${OFFSITE_METHOD} encryption=$([ -n "$ENCRYPTION_KEY" ] && echo on || echo off)"
while true; do
  run_backup
  sleep "$INTERVAL"
done
