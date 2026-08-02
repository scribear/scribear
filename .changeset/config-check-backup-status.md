---
'@scribear/admin-server': minor
---

Deployment Check's Config Check page reports on `db-backup` (the Postgres
backup service from compose.yml v10): whether an off-host copy is configured,
whether a backup has completed at all yet, and whether the newest one has
gone stale.

`db-backup` has no HTTP surface to probe the way every other dependency on
that page is probed — it is a cron loop, not a service — so admin-server
reads the one channel that exists: a new read-only bind mount of the same
directory `db-backup` writes its dumps to (`deployment/compose.yml`). The
staleness threshold mirrors `infra/scribear-db/backup-healthcheck.sh`
exactly, so this finding and that container's own health status agree.

`COMPOSE_FILE_VERSION` 10 -> 11, `EXPECTED_COMPOSE_FILE_VERSION` follows, the
drift guard's sha256 is re-pinned, and `deployment/UPGRADING.md` carries the
note.
