import { FileMigrationProvider, type Kysely, Migrator } from 'kysely';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

export function getMigrator(db: Kysely<unknown>): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(dirname, '..', 'migrations'),
    }),
  });
}
