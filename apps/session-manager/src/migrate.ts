import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import {
  DatabaseConfig,
  getMigrator,
  readSchemaState,
} from '@scribear/scribear-db';

/**
 * One-shot entry point that brings the shared ScribeAR schema up to what *this
 * image* expects, then exits.
 *
 * This is what `deployment/compose.yml`'s `db-migrate` service runs, and the
 * reason it lives in the session-manager image rather than in a migrator image
 * of its own: session-manager is the service that owns this schema, so running
 * the migrations from the same immutable artifact is what guarantees the schema
 * and the code that queries it agree. Nothing has to be cloned, checked out or
 * installed at deploy time, and a deployment pinned to `IMAGE_TAG=v0.2.0`
 * applies v0.2.0's migrations rather than whatever `staging` has today.
 *
 * Deliberately *not* run from `index.ts` on startup. A schema change has to
 * happen exactly once, in a known order, before anything that queries it starts;
 * compose expresses that with `service_completed_successfully`, whereas an
 * in-process migration on N replicas expresses "whoever wins the lock" and
 * turns a failed migration into a crash-looping app rather than a failed job.
 *
 * Reads only `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD` — none
 * of the app's other secrets, so the job can run in a deployment where they are
 * not set. Exits non-zero on any failure, which is what makes the dependent
 * services refuse to start.
 */
async function main() {
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

  try {
    const before = await readSchemaState(db);
    console.log(
      `Schema before: ${String(before.applied.length)} of ${String(
        before.expected.length,
      )} migrations applied${
        before.initialized ? '' : ' (database has never been migrated)'
      }`,
    );

    // Reported rather than treated as an error: the database being ahead of this
    // image is what a rollback looks like, and there is nothing for a migrator
    // to do about it. The admin console's Config Check raises it as a finding.
    if (before.unknown.length > 0) {
      console.warn(
        `Database has ${String(
          before.unknown.length,
        )} migration(s) this image does not know about: ${before.unknown.join(
          ', ',
        )}. This image is older than the schema.`,
      );
    }

    if (before.upToDate) {
      console.log('Schema is already up to date. Nothing to apply.');
      return;
    }

    console.log(`Applying ${String(before.pending.length)} migration(s)...`);

    const { error, results } = await getMigrator(db).migrateToLatest();

    for (const result of results ?? []) {
      if (result.status === 'Success') {
        console.log(`Applied ${result.migrationName}`);
      } else if (result.status === 'Error') {
        console.error(`FAILED ${result.migrationName}`);
      }
    }

    if (error) {
      throw error instanceof Error
        ? error
        : new Error('Migration failed', { cause: error });
    }

    const after = await readSchemaState(db);
    console.log(
      `Schema is now at ${after.latestApplied} (${String(
        after.applied.length,
      )} migrations applied).`,
    );
  } finally {
    await db.destroy();
  }
}

try {
  await main();
} catch (err) {
  console.error('Database migration failed.');
  console.error(err);
  process.exit(1);
}
