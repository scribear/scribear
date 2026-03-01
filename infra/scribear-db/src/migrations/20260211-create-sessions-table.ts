import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('sessions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn('source_device_id', 'uuid', (col) =>
      col
        .references('devices.id')
        .onDelete('cascade')
        .onUpdate('cascade')
        .notNull(),
    )
    .addColumn('transcription_provider_key', 'varchar(32)', (col) =>
      col.notNull(),
    )
    .addColumn('transcription_provider_config', 'json', (col) => col.notNull())
    .addColumn('start_time', 'timestamptz', (col) => col.notNull())
    .addColumn('end_time', 'timestamptz')
    .execute();

  await db.schema
    .createIndex('session_source_device_id_index')
    .on('sessions')
    .column('source_device_id')
    .execute();

  await sql`
    SELECT cron.schedule(
      'delete-old-sessions',
      '0 3 * * *',
      $$DELETE FROM sessions WHERE end_time < NOW() - INTERVAL '30 days'$$
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SELECT cron.unschedule('delete-old-sessions')`.execute(db);
  await db.schema.dropIndex('session_source_device_id_index').execute();
  await db.schema.dropTable('sessions').execute();
}
