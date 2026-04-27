import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE auto_session_windows (
      uid               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      room_uid          UUID NOT NULL REFERENCES rooms(uid) ON DELETE CASCADE ON UPDATE CASCADE,

      local_start_time                TIME NOT NULL,
      local_end_time                  TIME NOT NULL,
      days_of_week                    day_of_week[] NOT NULL,

      transcription_provider_id       TEXT NULL,
      transcription_stream_config     JSONB NULL,

      active_start      TIMESTAMPTZ NOT NULL DEFAULT now(),
      active_end        TIMESTAMPTZ NULL,

      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT auto_session_windows_days_non_empty CHECK (
        array_length(days_of_week, 1) >= 1
      ),

      CONSTRAINT auto_session_windows_local_times_distinct CHECK (
        local_start_time <> local_end_time
      ),

      CONSTRAINT auto_session_windows_active_end_after_start CHECK (
        active_end IS NULL OR active_end > active_start
      )
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_auto_session_windows_room
      ON auto_session_windows(room_uid)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_auto_session_windows_room`.execute(db);
  await sql`DROP TABLE IF EXISTS auto_session_windows`.execute(db);
}
