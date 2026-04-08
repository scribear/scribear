import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add join code configuration columns to sessions
  await db.schema
    .alterTable('sessions')
    .addColumn('join_code_length', 'integer')
    .execute();

  await db.schema
    .alterTable('sessions')
    .addColumn('join_code_rotation_enabled', 'boolean')
    .execute();

  // Create dedicated join codes table with expiry support
  await db.schema
    .createTable('session_join_codes')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn('session_id', 'uuid', (col) =>
      col
        .references('sessions.id')
        .onDelete('cascade')
        .onUpdate('cascade')
        .notNull(),
    )
    .addColumn('code', 'varchar(16)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull())
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('session_join_codes_code_index')
    .on('session_join_codes')
    .column('code')
    .execute();

  await db.schema
    .createIndex('session_join_codes_session_id_index')
    .on('session_join_codes')
    .column('session_id')
    .execute();

  // Drop old join_code column from sessions
  await db.schema.dropIndex('session_join_code_index').execute();
  await db.schema.alterTable('sessions').dropColumn('join_code').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restore old join_code column
  await db.schema
    .alterTable('sessions')
    .addColumn('join_code', 'varchar(8)')
    .execute();

  await db.schema
    .createIndex('session_join_code_index')
    .on('sessions')
    .column('join_code')
    .unique()
    .execute();

  // Drop join codes table
  await db.schema.dropIndex('session_join_codes_session_id_index').execute();
  await db.schema.dropIndex('session_join_codes_code_index').execute();
  await db.schema.dropTable('session_join_codes').execute();

  // Drop config columns
  await db.schema
    .alterTable('sessions')
    .dropColumn('join_code_rotation_enabled')
    .execute();

  await db.schema
    .alterTable('sessions')
    .dropColumn('join_code_length')
    .execute();
}
