import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('kiosks')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn('secret_hash', 'char(60)', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('kiosks').execute();
}
