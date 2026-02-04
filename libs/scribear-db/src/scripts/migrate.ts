import {
  FileMigrationProvider,
  Kysely,
  Migrator,
  PostgresDialect,
} from 'kysely';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import DatabaseConfig from './config.js';

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

async function migrateToLatest() {
  const config = new DatabaseConfig();

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
      }),
    }),
  });

  const migrator = getMigrator(db);

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(`Migration "${it.migrationName}" was executed successfully`);
    } else if (it.status === 'Error') {
      console.error(`Failed to execute migration "${it.migrationName}"`);
    }
  });

  if (error) {
    console.error('Failed to migrate');
    console.error(error);
    await db.destroy();
    process.exit(1);
  }

  await db.destroy();
  console.log('Migrations completed successfully');
}

async function migrateDown() {
  const config = new DatabaseConfig();

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
      }),
    }),
  });

  const migrator = getMigrator(db);

  const { error, results } = await migrator.migrateDown();

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(
        `Migration "${it.migrationName}" was rolled back successfully`,
      );
    } else if (it.status === 'Error') {
      console.error(`Failed to roll back migration "${it.migrationName}"`);
    }
  });

  if (error) {
    console.error('Failed to migrate down');
    console.error(error);
    await db.destroy();
    return;
  }

  await db.destroy();
  console.log('Migration rolled back successfully');
}

const command = process.argv[2];

if (command === 'down') {
  void migrateDown();
} else {
  void migrateToLatest();
}
