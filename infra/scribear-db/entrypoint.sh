#!/bin/sh
set -e
exec docker-entrypoint.sh postgres \
  -c shared_preload_libraries=pg_cron \
  -c "cron.database_name=${POSTGRES_DB:-postgres}" \
  "$@"
