#!/bin/sh
# Fails if no backup has landed in $BACKUP_DIR within the current interval
# plus an hour of grace, so a stuck or crash-looping db-backup shows as
# unhealthy in `docker compose ps` instead of silently stopping protecting
# anything.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-14400}"
MAX_AGE_MIN=$(( (INTERVAL + 3600) / 60 ))

find "$BACKUP_DIR" -name '*.dump' -mmin "-${MAX_AGE_MIN}" 2>/dev/null | grep -q .
