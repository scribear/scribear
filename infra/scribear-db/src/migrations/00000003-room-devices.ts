import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE room_devices (
      room_uid    UUID NOT NULL REFERENCES rooms(uid) ON DELETE CASCADE ON UPDATE CASCADE,
      device_uid  UUID NOT NULL REFERENCES devices(uid) ON DELETE CASCADE ON UPDATE CASCADE,
      is_source   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

      PRIMARY KEY (room_uid, device_uid)
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX idx_room_devices_device ON room_devices(device_uid)
  `.execute(db);

  await sql`
    CREATE INDEX idx_room_devices_source
      ON room_devices(room_uid)
      WHERE is_source = TRUE
  `.execute(db);

  // Deferred so a source swap (unmark old, mark new) inside one transaction
  // commits successfully; the invariant is checked at commit. Constraint
  // triggers must be row-level, hence picking the affected room from OLD/NEW.
  await sql`
    CREATE OR REPLACE FUNCTION check_room_has_source_device()
    RETURNS TRIGGER AS $$
    DECLARE
      target_room UUID;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        target_room := OLD.room_uid;
        -- Parent room may have been dropped in the same transaction
        -- (cascaded delete); nothing left to validate.
        IF NOT EXISTS (SELECT 1 FROM rooms WHERE uid = target_room) THEN
          RETURN NULL;
        END IF;
      ELSE
        target_room := NEW.room_uid;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM room_devices
        WHERE room_uid = target_room AND is_source = TRUE
      ) THEN
        RAISE EXCEPTION 'Room % must have at least one source device', target_room;
      END IF;

      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE CONSTRAINT TRIGGER room_devices_ensure_source
      AFTER INSERT OR UPDATE OR DELETE ON room_devices
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION check_room_has_source_device()
  `.execute(db);

  // v1 rule: at most one source per room. Dropping this trigger is how v1
  // relaxes to multi-source without a data migration.
  await sql`
    CREATE OR REPLACE FUNCTION check_room_single_source()
    RETURNS TRIGGER AS $$
    DECLARE
      target_room UUID;
      source_count INTEGER;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        target_room := OLD.room_uid;
      ELSE
        target_room := NEW.room_uid;
      END IF;

      SELECT COUNT(*) INTO source_count
        FROM room_devices
        WHERE room_uid = target_room AND is_source = TRUE;

      IF source_count > 1 THEN
        RAISE EXCEPTION 'Room % cannot have more than one source device in v1', target_room;
      END IF;

      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    CREATE CONSTRAINT TRIGGER room_devices_single_source
      AFTER INSERT OR UPDATE OR DELETE ON room_devices
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION check_room_single_source()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS room_devices_single_source ON room_devices`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS check_room_single_source()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS room_devices_ensure_source ON room_devices`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS check_room_has_source_device()`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_room_devices_source`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_room_devices_device`.execute(db);
  await sql`DROP TABLE IF EXISTS room_devices`.execute(db);
}
