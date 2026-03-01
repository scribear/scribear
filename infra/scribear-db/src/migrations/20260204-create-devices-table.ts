import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('devices')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn('name', 'varchar(256)', (col) => col.notNull())
    .addColumn('is_active', 'boolean', (col) => col.defaultTo(false))
    .addColumn('activation_code', 'char(8)', (col) => col.unique())
    .addColumn('activation_expiry', 'timestamptz')
    .addColumn('secret_hash', 'char(60)')
    .execute();

  await db.schema
    .createIndex('device_activation_code_index')
    .on('devices')
    .column('activation_code')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('device_activation_code_index').execute();
  await db.schema.dropTable('devices').execute();
}
