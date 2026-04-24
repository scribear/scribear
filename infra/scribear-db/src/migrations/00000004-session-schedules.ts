import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TYPE schedule_frequency AS ENUM ('ONCE', 'WEEKLY', 'BIWEEKLY')`.execute(
    db,
  );

  await sql`CREATE TYPE day_of_week AS ENUM ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')`.execute(
    db,
  );

  await sql`CREATE TYPE session_scope AS ENUM ('SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS')`.execute(
    db,
  );

  await sql`
    CREATE TABLE session_schedules (
      uid                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      room_uid                     UUID NOT NULL REFERENCES rooms(uid) ON DELETE CASCADE ON UPDATE CASCADE,
      name                         TEXT NOT NULL,

      active_start                 TIMESTAMPTZ NOT NULL,
      active_end                   TIMESTAMPTZ NULL,

      local_start_time             TIME NOT NULL,
      local_end_time               TIME NOT NULL,

      frequency                    schedule_frequency NOT NULL,
      days_of_week                 day_of_week[] NULL,

      join_code_scopes             session_scope[] NOT NULL DEFAULT '{}',
      transcription_provider_id    TEXT NULL,
      transcription_stream_config  JSONB NULL,

      created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT session_schedules_frequency_fields_valid CHECK (
        (frequency = 'ONCE' AND days_of_week IS NULL)
        OR
        (frequency IN ('WEEKLY', 'BIWEEKLY')
          AND days_of_week IS NOT NULL
          AND array_length(days_of_week, 1) >= 1)
      ),

      CONSTRAINT session_schedules_active_end_after_start CHECK (
        active_end IS NULL OR active_end > active_start
      ),

      CONSTRAINT session_schedules_local_times_distinct CHECK (
        local_start_time <> local_end_time
      )
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_session_schedules_room ON session_schedules(room_uid)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_session_schedules_room`.execute(db);
  await sql`DROP TABLE IF EXISTS session_schedules`.execute(db);
  await sql`DROP TYPE IF EXISTS session_scope`.execute(db);
  await sql`DROP TYPE IF EXISTS day_of_week`.execute(db);
  await sql`DROP TYPE IF EXISTS schedule_frequency`.execute(db);
}
