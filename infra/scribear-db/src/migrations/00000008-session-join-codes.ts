import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // session_join_codes_format enforces 8-character uppercase alphanumeric
  // codes. At 36^8 possibilities with only a small fraction valid at any
  // moment, collision risk on issuance is negligible.
  await sql`
    CREATE TABLE session_join_codes (
      join_code    TEXT PRIMARY KEY,
      session_uid  UUID NOT NULL REFERENCES sessions(uid) ON DELETE CASCADE ON UPDATE CASCADE,
      valid_start  TIMESTAMPTZ NOT NULL,
      valid_end    TIMESTAMPTZ NOT NULL,

      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT session_join_codes_valid_range CHECK (valid_end > valid_start),
      CONSTRAINT session_join_codes_format CHECK (join_code ~ '^[A-Z0-9]{8}$')
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_session_join_codes_session ON session_join_codes(session_uid)
  `.execute(db);

  await sql`
    CREATE INDEX idx_session_join_codes_valid_end ON session_join_codes(valid_end)
  `.execute(db);

  await sql`
    SELECT cron.schedule(
      'cleanup-expired-join-codes',
      '*/5 * * * *',
      $$
        DELETE FROM session_join_codes
          WHERE valid_end < now();
      $$
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SELECT cron.unschedule('cleanup-expired-join-codes')`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_session_join_codes_valid_end`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_session_join_codes_session`.execute(db);
  await sql`DROP TABLE IF EXISTS session_join_codes`.execute(db);
}
