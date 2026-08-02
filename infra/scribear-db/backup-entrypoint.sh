#!/bin/sh
# db-backup's entire job: on a schedule, pg_dump $DB_NAME, keep
# BACKUP_RETENTION_DAYS days of it under $BACKUP_DIR, and - if configured -
# push each dump off this host over scp or rsync-over-ssh. See
# deployment/UPGRADING.md.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-14400}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
OFFSITE_METHOD="${BACKUP_OFFSITE_METHOD:-none}"
SSH_KEY_MOUNT="/keys/backup_key"
SSH_KEY_RUNTIME="/tmp/backup_ssh_key"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

case "$OFFSITE_METHOD" in
  none)
    ;;
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
    log "Unknown BACKUP_OFFSITE_METHOD '$OFFSITE_METHOD' (expected none, scp or rsync) - refusing to start."
    exit 1
    ;;
esac

mkdir -p "$BACKUP_DIR"

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

run_backup() {
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  file="$BACKUP_DIR/${DB_NAME}-${ts}.dump"
  tmp="${file}.tmp"

  log "Starting pg_dump of ${DB_NAME}@${DB_HOST} -> ${file}"
  # --lock-wait-timeout, not because the dump would otherwise deadlock, but so
  # an ACCESS SHARE lock queued behind a db-migrate DDL run during a deploy
  # fails fast and retries next cycle instead of stalling that migration.
  if PGPASSWORD="$DB_PASSWORD" pg_dump \
       -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
       --lock-wait-timeout=5000 -Fc -f "$tmp"
  then
    mv "$tmp" "$file"
    log "Backup complete: ${file} ($(du -h "$file" | cut -f1))"
    if [ "$OFFSITE_METHOD" != "none" ]; then
      if push_offsite "$file"; then
        log "Pushed ${file} to ${BACKUP_OFFSITE_HOST} via ${OFFSITE_METHOD}"
      else
        log "WARNING: offsite push of ${file} failed - local copy retained, will retry next cycle with a fresh dump"
      fi
    fi
  else
    log "WARNING: pg_dump failed - no backup written this cycle"
    rm -f "$tmp"
  fi

  find "$BACKUP_DIR" -name "${DB_NAME}-*.dump" -mtime "+${RETENTION_DAYS}" -delete
}

log "db-backup starting: interval=${INTERVAL}s retention=${RETENTION_DAYS}d offsite=${OFFSITE_METHOD}"
while true; do
  run_backup
  sleep "$INTERVAL"
done
