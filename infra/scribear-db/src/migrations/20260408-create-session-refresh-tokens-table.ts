import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('session_refresh_tokens')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`uuidv7()`),
    )
    .addColumn('session_id', 'uuid', (col) =>
      col
        .references('sessions.id')
        .onDelete('cascade')
        .onUpdate('cascade')
        .notNull(),
    )
    .addColumn('scope', sql`varchar(32)[]`, (col) => col.notNull())
    .addColumn('auth_method', 'varchar(32)', (col) => col.notNull())
    .addColumn('expiry', 'timestamptz')
    .addColumn('secret_hash', 'varchar(128)', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('session_refresh_tokens_session_id_index')
    .on('session_refresh_tokens')
    .column('session_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropIndex('session_refresh_tokens_session_id_index')
    .execute();
  await db.schema.dropTable('session_refresh_tokens').execute();
}
