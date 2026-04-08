import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
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
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('session_join_code_index').execute();
  await db.schema.alterTable('sessions').dropColumn('join_code').execute();
}
