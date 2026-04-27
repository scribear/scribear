import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE rooms (
      uid                                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name                                      TEXT NOT NULL,
      timezone                                  TEXT NOT NULL,

      room_schedule_version                     BIGINT NOT NULL DEFAULT 1,
      last_materialized_at                      TIMESTAMPTZ NULL,

      created_at                                TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_rooms_name_trgm ON rooms USING gin (name gin_trgm_ops)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_rooms_name_trgm`.execute(db);
  await sql`DROP TABLE IF EXISTS rooms`.execute(db);
}
