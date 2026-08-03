import {
  type Kysely,
  type Migration,
  type MigrationProvider,
  Migrator,
} from 'kysely';

import * as adminAuditLog from './migrations/00000001-admin-audit-log.js';

/**
 * Static, in-code migration list. Unlike `FileMigrationProvider`, this bundles
 * cleanly into the esbuild output (the production image ships only
 * `dist/bundle.mjs`, not loose migration files on disk).
 */
class StaticMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve({
      '00000001-admin-audit-log': adminAuditLog,
    });
  }
}

/**
 * Migrator for admin-server's own tables. Uses dedicated migration-tracking
 * table names so it coexists with the `@scribear/scribear-db` migrator on the
 * same Postgres database without either one seeing the other's migrations.
 */
export function getAdminMigrator(db: Kysely<unknown>): Migrator {
  return new Migrator({
    db,
    provider: new StaticMigrationProvider(),
    migrationTableName: 'admin_kysely_migration',
    migrationLockTableName: 'admin_kysely_migration_lock',
  });
}
