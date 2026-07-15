import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE admin_audit_log (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_subject   TEXT NOT NULL,
      actor_provider  TEXT NOT NULL,
      action          TEXT NOT NULL,
      target          TEXT NULL,
      params_summary  JSONB NOT NULL DEFAULT '{}'::jsonb,
      result          TEXT NOT NULL,
      status_code     INTEGER NULL,
      request_id      TEXT NULL,

      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_admin_audit_log_created_at
      ON admin_audit_log (created_at DESC)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_admin_audit_log_created_at`.execute(db);
  await sql`DROP TABLE IF EXISTS admin_audit_log`.execute(db);
}
