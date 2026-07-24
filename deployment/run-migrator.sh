#!/usr/bin/env bash
#
# Bring the ScribeAR database schema up to what the deployed images expect.
#
# You do not normally need this: `docker compose up -d` runs the same `db-migrate`
# job as a dependency of session-manager and admin-server, so a normal deploy
# migrates itself. Run this when you want to apply migrations without touching
# the running services, or to see the migration output on its own.
#
# The migrations come from the session-manager image at the tag this deployment
# is pinned to, so the schema always matches the running code. Nothing is cloned
# from GitHub and nothing is installed at run time.
#
# For a native development database (no compose stack), use the workspace script
# against your own DB_* values instead:
#
#   npm run migrate:up --workspace=@scribear/scribear-db
#
set -euo pipefail

cd "$(dirname "$0")"

# No -f flag, deliberately: passing one disables Compose's automatic loading of
# compose.override.yml, so a host relying on an override would migrate a
# different database than the one its stack uses.
exec docker compose run --rm db-migrate
