import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Nullable with no default: NULL means "never seen since this column
  // existed", which is a different and honest state from "seen at the moment
  // of migration". Backfilling with now() would have shown every device in the
  // fleet as freshly online the instant this deployed.
  await sql`
    ALTER TABLE devices ADD COLUMN last_seen_at TIMESTAMPTZ NULL
  `.execute(db);

  // The fleet view sorts and filters by staleness, so the ordering has to come
  // from an index rather than a sort of every device. NULLS LAST matches the
  // query: never-seen devices belong at the bottom of a "least recently seen"
  // listing, not the top.
  await sql`
    CREATE INDEX idx_devices_last_seen_at
      ON devices (last_seen_at DESC NULLS LAST)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_devices_last_seen_at`.execute(db);
  await sql`ALTER TABLE devices DROP COLUMN IF EXISTS last_seen_at`.execute(db);
}
