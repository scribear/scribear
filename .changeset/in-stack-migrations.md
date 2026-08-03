---
'@scribear/scribear-db': minor
'@scribear/session-manager': minor
'@scribear/session-manager-schema': minor
'@scribear/session-manager-client': minor
'@scribear/admin-server': minor
---

Database migrations now run as part of `docker compose up -d` instead of a
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
  moment the database had *any* table, so in practice it only ever migrated
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
  applied yet. A database *ahead* of the build — what a rollback looks like —
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
