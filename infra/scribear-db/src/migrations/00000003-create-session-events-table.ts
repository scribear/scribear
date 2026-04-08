import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createType('session_event_type')
    .asEnum(['START_SESSION', 'END_SESSION'])
    .execute();

  await db.schema
    .createTable('session_events')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('session_id', 'uuid', (col) =>
      col
        .references('sessions.id')
        .onDelete('cascade')
        .onUpdate('cascade')
        .notNull(),
    )
    .addColumn('device_id', 'uuid', (col) =>
      col
        .references('devices.id')
        .onDelete('cascade')
        .onUpdate('cascade')
        .notNull(),
    )
    .addColumn('event_type', sql`session_event_type`, (col) => col.notNull())
    .addColumn('timestamp', 'timestamptz', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('session_events_device_id_timestamp_index')
    .on('session_events')
    .columns(['device_id', 'id', 'timestamp'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropIndex('session_events_device_id_timestamp_index')
    .execute();
  await db.schema.dropTable('session_events').execute();
  await db.schema.dropType('session_event_type').execute();
}
