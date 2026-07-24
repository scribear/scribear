import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'vitest';

import {
  LATEST_MIGRATION,
  MIGRATION_NAMES,
  MIGRATIONS,
} from '#src/index.js';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/migrations',
);

/** Every `src/migrations/*.ts` filename, without the extension. */
function migrationFilesOnDisk(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => name.replace(/\.ts$/, ''))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The registry is hand-written, because a static list is what lets the migrations
 * be bundled into a service image (see `migration-registry.ts`). The cost of that
 * is a step someone can forget: add a migration file, never register it, and the
 * migrator quietly skips it — the database looks migrated, the column is absent,
 * and the failure surfaces later as a 500 from an unrelated route.
 *
 * That is the one failure this test exists to prevent, and the only reason it
 * reads the directory rather than trusting the export.
 */
describe('the migration registry', (it) => {
  it('lists exactly the migration files on disk', () => {
    expect([...MIGRATION_NAMES]).toEqual(migrationFilesOnDisk());
  });

  it('gives every entry a runnable up and down', () => {
    for (const [name, migration] of Object.entries(MIGRATIONS)) {
      expect(typeof migration.up, `${name}.up`).toBe('function');
      expect(typeof migration.down, `${name}.down`).toBe('function');
    }
  });

  // The names are the primary key of `kysely_migration` on every deployed
  // database. A key that does not match its file is a migration that will be
  // applied a second time on the next deploy.
  it('keys each entry by its filename', () => {
    expect(Object.keys(MIGRATIONS).sort((a, b) => a.localeCompare(b))).toEqual(
      migrationFilesOnDisk(),
    );
  });

  it('reports the newest migration as the schema version', () => {
    const onDisk = migrationFilesOnDisk();
    expect(LATEST_MIGRATION).toBe(onDisk[onDisk.length - 1]);
  });
});
