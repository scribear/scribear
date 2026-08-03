import { type Kysely, sql } from 'kysely';

import { LATEST_MIGRATION, MIGRATION_NAMES } from './migration-registry.js';

/**
 * Kysely's default migration bookkeeping table. Named here because
 * {@link readSchemaState} reads it directly rather than through `Migrator`, and
 * because `getMigrator` deliberately keeps the defaults — every existing
 * database already tracks its migrations under this name.
 */
export const MIGRATION_TABLE = 'kysely_migration';

export interface SchemaState {
  /**
   * False when {@link MIGRATION_TABLE} does not exist, i.e. migrations have
   * never been run against this database. Distinguished from "zero applied"
   * because it is a different operator situation: a fresh database that nobody
   * has migrated, rather than a migration run that did nothing.
   */
  initialized: boolean;
  /** Migration names recorded in the database, ascending. */
  applied: readonly string[];
  /** Migration names this build ships. */
  expected: readonly string[];
  /** Shipped but not applied — the database is behind this build. */
  pending: readonly string[];
  /**
   * Applied but not shipped — the database is *ahead* of this build, which
   * means an image older than the schema is running. Normal during a rollback,
   * and deliberately not treated as a failure anywhere: refusing to serve would
   * turn a rollback into an outage.
   */
  unknown: readonly string[];
  /** Nothing pending. May still have `unknown` entries. */
  upToDate: boolean;
  /** Newest migration this build ships; '' when it ships none. */
  latestExpected: string;
  /** Newest migration recorded in the database; '' when there are none. */
  latestApplied: string;
}

/**
 * Reads which migrations a database has applied and compares them with the ones
 * this build ships.
 *
 * **Read-only, by construction.** Callers include readiness probes and the admin
 * console's Config Check, which must be able to ask the question without
 * changing the answer. `Migrator.getMigrations()` would be the obvious route,
 * but it creates the migration tables as a side effect of being asked, so a
 * config check against a fresh database would report it as initialized and
 * leave two tables behind. `to_regclass` returns null instead of raising for a
 * missing table, so the uninitialized case is a clean `false` rather than an
 * exception a caller would have to tell apart from a connection failure.
 *
 * Genuine connection and permission errors are *not* swallowed — they throw, so
 * callers can report "unreachable" separately from "not migrated".
 */
export async function readSchemaState<Schema>(
  db: Kysely<Schema>,
): Promise<SchemaState> {
  const expected = [...MIGRATION_NAMES];

  const existing = await sql<{
    reg: string | null;
  }>`SELECT to_regclass(${`public.${MIGRATION_TABLE}`}) AS reg`.execute(db);

  if (existing.rows[0]?.reg == null) {
    return {
      initialized: false,
      applied: [],
      expected,
      pending: expected,
      unknown: [],
      upToDate: expected.length === 0,
      latestExpected: LATEST_MIGRATION,
      latestApplied: '',
    };
  }

  const rows = await sql<{
    name: string;
  }>`SELECT name FROM kysely_migration ORDER BY name`.execute(db);
  const applied = rows.rows.map((row) => row.name);

  const appliedSet = new Set(applied);
  const expectedSet = new Set(expected);
  const pending = expected.filter((name) => !appliedSet.has(name));
  const unknown = applied.filter((name) => !expectedSet.has(name));

  return {
    initialized: true,
    applied,
    expected,
    pending,
    unknown,
    upToDate: pending.length === 0,
    latestExpected: LATEST_MIGRATION,
    latestApplied: applied[applied.length - 1] ?? '',
  };
}
