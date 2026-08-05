# @scribear/scribear-db

## 0.3.0

### Minor Changes

- ff6516c: Database migrations now run as part of `docker compose up -d` instead of a
  separate script someone has to remember to run.
  - **`db-migrate` compose job.** A new one-shot service in `compose.yml`,
    built from the same image and `IMAGE_TAG` as `session-manager`, running a
    second entry point (`dist/migrate.mjs`) that applies whatever migrations
    are pending and exits. `session-manager` and `admin-server` both
    `depends_on: db-migrate: {condition: service_completed_successfully}`, so
    the schema is always current before either service starts, and a failed
    migration means neither starts. `run-migrator.sh` is now a thin wrapper
    around the same job (`docker compose run --rm db-migrate`), for applying
    migrations on their own — and, unlike before, it works against an external
    Postgres, since the job reads only the `DB_*` variables. The old script
    cloned `staging` from GitHub into a throwaway container and exited 0 the
    moment the database had _any_ table, so in practice it only ever migrated
    a virgin database — every upgrade after the first silently applied
    nothing.
  - **Migrations are bundled, not globbed.** `infra/scribear-db` registers its
    migrations in a static list (`src/migration-registry.ts`) rather than
    kysely's `FileMigrationProvider`, so they can ship inside a service image
    instead of requiring a source checkout. It also exports `readSchemaState()`
    for comparing applied migrations against expected ones, plus
    `MIGRATION_NAMES` and `LATEST_MIGRATION`. The migration table is still
    `kysely_migration`, so no existing database needs special handling.
  - **Readiness reports the schema separately.** `GET
/api/session-manager/v1/probes/readiness` now returns 503 with
    `checks: {database: 'ok'|'fail', schema: 'ok'|'fail'}`.
    `schema: 'fail'` means this build ships migrations the database has not
    applied yet. A database _ahead_ of the build — what a rollback looks like —
    is deliberately not a failure. The service goes ready on its own once the
    schema catches up, no restart needed.
  - **New route: `GET /api/session-manager/v1/database/schema`.**
    Admin-API-key protected. Reports `{initialized, applied, expected, pending,
unknown, upToDate, latestApplied, latestExpected}`.
  - **Config Check findings.** The admin console can now raise
    `schema-never-migrated`, `schema-migrations-pending`,
    `schema-ahead-of-containers`, `schema-version-skew` (session-manager and
    admin-server built against different schema versions — mixed `IMAGE_TAG`s),
    and `schema-version-unreadable`.

  No new environment variables and no change to the database schema itself —
  no new migration in this release.

- bca3d13: Periodic Postgres backups ship with the stack, as a `db-backup` service
  reusing the `scribear-db` image rather than a host script and crontab an
  operator has to set up and keep in sync on every box separately.

  `db-backup` pg_dumps `DB_NAME` on a schedule (default every four hours),
  keeps a rolling local retention window, and can optionally push each dump
  off the host over scp or rsync-over-ssh. It reaches Postgres over the
  `backend` network with the same `DB_HOST`/`DB_USER`/`DB_PASSWORD` every other
  service in `deployment/compose.yml` already uses — no `docker exec`, no
  Docker socket. It does not use the `pg_cron` extension already loaded into
  the same image: `pg_cron` schedules SQL run _by_ Postgres, and has no way to
  shell out to the external `pg_dump` client that actually produces a dump.

  A profile-gated `db-restore` service ships alongside it for restore drills
  and the real thing — never started by `up -d`.

  `COMPOSE_FILE_VERSION` 9 -> 10, `EXPECTED_COMPOSE_FILE_VERSION` follows, the
  drift guard's sha256 is re-pinned, and `deployment/UPGRADING.md` carries the
  note.

### Patch Changes

- 82888d1: Hardens the Postgres backup service (`db-backup`) from a code review after it
  shipped:
  - Failed off-host pushes (scp/rsync) now retry every cycle until they
    succeed, instead of silently leaving a permanent gap in the offsite backup
    chain when the destination was unreachable for more than one cycle.
  - Every dump is checked with `pg_restore -l` immediately after `pg_dump`
    exits 0 and discarded if it fails — `pg_dump` can exit 0 on an archive
    nothing can actually read back.
  - `pg_dumpall --globals-only` now runs alongside the main dump, covering
    roles that `pg_dump` alone never backed up.
  - New `BACKUP_ENABLED` (default `true`): set to `false` for a deployment on
    managed Postgres with its own backups — `db-backup` idles instead of
    dumping, and Deployment Check reports the choice explicitly (`backup-disabled`)
    instead of `backup-none-found` forever.
  - New `BACKUP_ENCRYPTION_KEY` (empty/off by default): optional GPG AES256
    symmetric encryption for every dump, at rest and offsite. `db-restore`
    decrypts automatically when given a `.gpg` file and the same key.
  - `db-backup`'s healthcheck `start_period` is 30 minutes now, not 2 — long
    enough for a large database's first `pg_dump` to finish before being read
    as a failed container.
  - `BACKUP_INTERVAL_SECONDS`/`BACKUP_RETENTION_DAYS` are validated as positive
    integers on startup rather than failing confusingly (a busy-loop on `0`, a
    crash-loop on anything non-numeric).
  - Corrected a misleading comment claiming `pg_restore --clean --if-exists`
    "overwrites" the target database — it drops and recreates only what the
    dump itself contains.

  `COMPOSE_FILE_VERSION` 11 -> 12, `EXPECTED_COMPOSE_FILE_VERSION` follows, the
  drift guard's sha256 is re-pinned, and `deployment/UPGRADING.md` carries the
  note — including the RPO/WAL-archiving tradeoff and the offsite host's
  trust-on-first-connection behavior, both previously undocumented.

## 0.2.0

### Minor Changes

- cef5888: Track device `lastSeenAt` and derive online/offline state (B1.6).

  Devices are stamped in the device-token hook, so presence covers every
  device-authenticated route rather than only the schedule long poll. Writes are
  coalesced to at most one per device per `DEVICE_LAST_SEEN_WRITE_INTERVAL_SEC`
  (default 60s) and are fire-and-forget, so a failed write never turns a working
  device request into a 500.

  `Device` gains `lastSeenAt` (nullable) and `online`, derived server-side against
  `DEVICE_ONLINE_TTL_SEC` (default 180s) so every consumer agrees on one cutoff.
  The admin devices list gains a Presence column. Admin-server needs no change —
  its device routes are a generic passthrough.

  New migration `00000011-device-last-seen`. The column is nullable with no
  backfill: NULL means "not heard from since this shipped", which is honest, where
  defaulting to `now()` would have shown the whole fleet as freshly online.

## 0.1.0
