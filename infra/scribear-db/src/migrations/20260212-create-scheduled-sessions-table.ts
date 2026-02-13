import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('scheduled_sessions')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`uuidv7()`),
    )
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('session_length', 'integer', (col) => col.notNull())
    .addColumn('scheduled_at', 'timestamptz', (col) => col.notNull())
    .addColumn('recurrence_rule', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('scheduled_sessions').execute();
}