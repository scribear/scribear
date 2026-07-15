import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // devices_active_has_hash enforces the pending-vs-activated mutual
  // exclusion: a row either has activation_code + expiry (pending) or hash
  // (activated), never both and never neither.
  await sql`
    CREATE TABLE devices (
      uid              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name             TEXT NOT NULL,

      active           BOOLEAN NOT NULL DEFAULT FALSE,
      hash             TEXT NULL,
      activation_code  TEXT NULL UNIQUE,
      expiry           TIMESTAMPTZ NULL,

      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT devices_active_has_hash CHECK (
        (active = FALSE AND hash IS NULL AND activation_code IS NOT NULL AND expiry IS NOT NULL)
        OR
        (active = TRUE AND hash IS NOT NULL AND activation_code IS NULL AND expiry IS NULL)
      )
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_devices_name_trgm ON devices USING gin (name gin_trgm_ops)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_devices_name_trgm`.execute(db);
  await sql`DROP TABLE IF EXISTS devices`.execute(db);
}
