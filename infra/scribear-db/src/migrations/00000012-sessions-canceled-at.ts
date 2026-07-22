import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sessions ADD COLUMN canceled_at TIMESTAMPTZ NULL`.execute(
    db,
  );

  // Narrow the no-overlap constraint to non-canceled rows, so canceling a
  // session frees its slot for a new on-demand session or re-materialized
  // occurrence. Postgres EXCLUDE constraints support a WHERE predicate
  // (implemented as a partial index); ALTER can't add one in place, so this
  // drops and recreates the constraint with the same DEFERRABLE behavior.
  await sql`ALTER TABLE sessions DROP CONSTRAINT sessions_no_overlap`.execute(
    db,
  );
  await sql`
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_no_overlap
      EXCLUDE USING gist (
        room_uid WITH =,
        tstzrange(
          COALESCE(start_override, scheduled_start_time),
          COALESCE(end_override, scheduled_end_time, 'infinity'::timestamptz)
        ) WITH &&
      )
      WHERE (canceled_at IS NULL)
      DEFERRABLE INITIALLY IMMEDIATE
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sessions DROP CONSTRAINT sessions_no_overlap`.execute(
    db,
  );
  await sql`
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_no_overlap
      EXCLUDE USING gist (
        room_uid WITH =,
        tstzrange(
          COALESCE(start_override, scheduled_start_time),
          COALESCE(end_override, scheduled_end_time, 'infinity'::timestamptz)
        ) WITH &&
      ) DEFERRABLE INITIALLY IMMEDIATE
  `.execute(db);
  await sql`ALTER TABLE sessions DROP COLUMN canceled_at`.execute(db);
}
