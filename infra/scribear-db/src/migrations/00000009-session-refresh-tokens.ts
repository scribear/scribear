import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TYPE auth_method AS ENUM ('JOIN_CODE', 'DEVICE_TOKEN')`.execute(
    db,
  );

  // hash stores a hash of the secret portion of {uid}:{secret}; only the
  // secret is hashed and stored, the uid is not secret on its own.
  await sql`
    CREATE TABLE session_refresh_tokens (
      uid          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_uid  UUID NOT NULL REFERENCES sessions(uid) ON DELETE CASCADE ON UPDATE CASCADE,
      client_id    UUID NOT NULL,
      hash         TEXT NOT NULL,
      scopes       session_scope[] NOT NULL,
      auth_method  auth_method NOT NULL,

      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_session_refresh_tokens_session ON session_refresh_tokens(session_uid)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_session_refresh_tokens_session`.execute(
    db,
  );
  await sql`DROP TABLE IF EXISTS session_refresh_tokens`.execute(db);
  await sql`DROP TYPE IF EXISTS auth_method`.execute(db);
}
