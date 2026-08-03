import { type Kysely, Migrator } from 'kysely';

import { StaticMigrationProvider } from '../migration-registry.js';

/**
 * Migrator for the shared ScribeAR schema.
 *
 * Uses kysely's **default** `kysely_migration` / `kysely_migration_lock` table
 * names, deliberately and permanently: every deployed database already records
 * its applied migrations there. The lock table is also what makes concurrent
 * callers safe, so two migrators racing — the `db-migrate` job and an operator
 * running `npm run migrate:up`, say — serialize instead of double-applying.
 *
 * `apps/admin-server` runs a *separate* migrator over the same database under
 * its own table names, so admin-server's tables and this schema never see each
 * other's migrations.
 */
export function getMigrator(db: Kysely<unknown>): Migrator {
  return new Migrator({
    db,
    provider: new StaticMigrationProvider(),
  });
}
