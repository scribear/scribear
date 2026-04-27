import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TYPE session_type AS ENUM ('SCHEDULED', 'ON_DEMAND', 'AUTO')`.execute(
    db,
  );

  await sql`
    CREATE TABLE sessions (
      uid                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      room_uid                     UUID NOT NULL REFERENCES rooms(uid) ON DELETE CASCADE ON UPDATE CASCADE,
      name                         TEXT NOT NULL,
      type                         session_type NOT NULL,

      scheduled_session_uid        UUID NULL REFERENCES session_schedules(uid) ON DELETE CASCADE ON UPDATE CASCADE,

      scheduled_start_time         TIMESTAMPTZ NOT NULL,
      scheduled_end_time           TIMESTAMPTZ NULL,
      start_override               TIMESTAMPTZ NULL,
      end_override                 TIMESTAMPTZ NULL,

      join_code_scopes             session_scope[] NOT NULL DEFAULT '{}',
      transcription_provider_id    TEXT NULL,
      transcription_stream_config  JSONB NULL,

      session_config_version       BIGINT NOT NULL DEFAULT 1,

      created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT sessions_type_fields_valid CHECK (
        (type = 'SCHEDULED' AND scheduled_session_uid IS NOT NULL)
        OR
        (type IN ('ON_DEMAND', 'AUTO') AND scheduled_session_uid IS NULL)
      ),

      CONSTRAINT sessions_scheduled_end_after_start CHECK (
        scheduled_end_time IS NULL OR scheduled_end_time > scheduled_start_time
      ),

      CONSTRAINT sessions_start_override_valid CHECK (
        start_override IS NULL OR start_override <= scheduled_start_time
      ),

      CONSTRAINT sessions_end_override_valid CHECK (
        end_override IS NULL
        OR scheduled_end_time IS NULL
        OR end_override <= scheduled_end_time
      ),

      CONSTRAINT sessions_effective_interval_valid CHECK (
        COALESCE(end_override, scheduled_end_time) IS NULL
        OR COALESCE(end_override, scheduled_end_time) > COALESCE(start_override, scheduled_start_time)
      )
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_sessions_room_scheduled_start
      ON sessions(room_uid, scheduled_start_time)
  `.execute(db);

  await sql`
    CREATE INDEX idx_sessions_room_effective_start
      ON sessions(room_uid, COALESCE(start_override, scheduled_start_time))
  `.execute(db);

  await sql`
    CREATE INDEX idx_sessions_schedule
      ON sessions(scheduled_session_uid)
      WHERE scheduled_session_uid IS NOT NULL
  `.execute(db);

  // Partial index supporting the ended-session cleanup cron below.
  await sql`
    CREATE INDEX idx_sessions_effective_end
      ON sessions(COALESCE(end_override, scheduled_end_time))
      WHERE COALESCE(end_override, scheduled_end_time) IS NOT NULL
  `.execute(db);

  // DEFERRABLE INITIALLY IMMEDIATE so writes that need to transiently violate
  // non-overlap (e.g. swapping an auto session for a scheduled one plus a
  // trailing auto session) can opt into SET CONSTRAINTS ... DEFERRED.
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

  await sql`
    SELECT cron.schedule(
      'cleanup-ended-sessions',
      '0 4 * * *',
      $$
        DELETE FROM sessions
          WHERE COALESCE(end_override, scheduled_end_time) IS NOT NULL
            AND COALESCE(end_override, scheduled_end_time) < now() - INTERVAL '30 days';
      $$
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SELECT cron.unschedule('cleanup-ended-sessions')`.execute(db);
  await sql`ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_no_overlap`.execute(
    db,
  );
  await sql`DROP INDEX IF EXISTS idx_sessions_effective_end`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_sessions_schedule`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_sessions_room_effective_start`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_sessions_room_scheduled_start`.execute(db);
  await sql`DROP TABLE IF EXISTS sessions`.execute(db);
  await sql`DROP TYPE IF EXISTS session_type`.execute(db);
}
