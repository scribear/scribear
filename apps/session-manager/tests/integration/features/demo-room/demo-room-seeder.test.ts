import { describe, expect } from 'vitest';

import createServer from '#src/server/create-server.js';
import { useDb } from '#tests/utils/use-db.js';
import { buildTestAppConfig } from '#tests/utils/use-server.js';

const DEMO_SESSION_UID = 'deadbeef-0000-4000-8000-000000000001';
const DEMO_DEVICE_UID = 'deadbeef-0000-4000-8000-000000000002';
const DEMO_ROOM_UID = 'deadbeef-0000-4000-8000-000000000003';

/**
 * Regression test for a real staging incident: every server restart created
 * a brand-new placeholder device and room for the demo caption room (only
 * the session insert was conflict-safe by fixed uid), leaving 10 duplicate
 * "Demo Room Source" devices behind after 10 restarts/deploys. Boots the
 * whole server twice in a row against the same database - simulating a
 * restart - and asserts the device/room/session all stay singletons.
 */
describe('demo room seeding (restart idempotency)', (it) => {
  const dbContext = useDb(['sessions', 'rooms', 'devices']);

  async function bootAndSeed() {
    const config = buildTestAppConfig({ demoRoomConfig: { enabled: true } });
    const { fastify } = await createServer(config);
    await fastify.ready();
    await fastify.close();
  }

  it('seeds one device, room, and session on first boot, and does not duplicate them on a second boot', async () => {
    // Act - two independent boots against the same database, like a restart.
    await bootAndSeed();
    await bootAndSeed();

    // Assert - exactly one row each, at the fixed uids.
    const devices = await dbContext.db
      .selectFrom('devices')
      .select('uid')
      .execute();
    expect(devices).toStrictEqual([{ uid: DEMO_DEVICE_UID }]);

    const rooms = await dbContext.db
      .selectFrom('rooms')
      .select('uid')
      .execute();
    expect(rooms).toStrictEqual([{ uid: DEMO_ROOM_UID }]);

    const sessions = await dbContext.db
      .selectFrom('sessions')
      .select('uid')
      .execute();
    expect(sessions).toStrictEqual([{ uid: DEMO_SESSION_UID }]);

    const roomDevices = await dbContext.db
      .selectFrom('room_devices')
      .selectAll()
      .execute();
    expect(roomDevices).toHaveLength(1);
  });

  /**
   * The placeholder device found stranded outside the demo room - reachable
   * only from before `DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE` existed, so this
   * manipulates `room_devices` directly to reconstruct that pre-guard state.
   * `_createDemoSession` only re-examines the device's room at all when the
   * demo session itself is missing, so each case also deletes the session row
   * to force that path, without touching the (still-seeded) demo room row.
   */
  describe('a stranded placeholder device', (it) => {
    async function stealDevice(
      newRoomUid: string,
      isSource: boolean,
    ): Promise<void> {
      await dbContext.db
        .updateTable('room_devices')
        .set({ room_uid: newRoomUid, is_source: isSource })
        .where('device_uid', '=', DEMO_DEVICE_UID)
        .execute();
      await dbContext.db
        .deleteFrom('sessions')
        .where('uid', '=', DEMO_SESSION_UID)
        .execute();
    }

    it('reclaims it when it is only a non-source member of another room', async () => {
      // Arrange - seed once, then give the device's row to another room as a
      // harmless non-source member. That room needs its own source first:
      // `room_devices_ensure_source` refuses any change that would leave a
      // room without one, including inserting a non-source-only member.
      await bootAndSeed();
      const otherRoom = await dbContext.db
        .insertInto('rooms')
        .values({
          name: 'Other Room',
          timezone: 'UTC',
          auto_session_enabled: false,
        })
        .returning('uid')
        .executeTakeFirstOrThrow();
      const otherSource = await dbContext.db
        .insertInto('devices')
        .values({
          name: 'Other Source',
          activation_code: 'OTHERSRC1',
          expiry: new Date(Date.now() + 5 * 60_000),
        })
        .returning('uid')
        .executeTakeFirstOrThrow();
      await dbContext.db
        .insertInto('room_devices')
        .values({
          room_uid: otherRoom.uid,
          device_uid: otherSource.uid,
          is_source: true,
        })
        .execute();
      await stealDevice(otherRoom.uid, false);

      // Act
      await bootAndSeed();

      // Assert - the device is back as the demo room's source, and the other
      // room keeps its own (untouched) source.
      const membership = await dbContext.db
        .selectFrom('room_devices')
        .selectAll()
        .where('device_uid', '=', DEMO_DEVICE_UID)
        .executeTakeFirstOrThrow();
      expect(membership.room_uid).toBe(DEMO_ROOM_UID);
      expect(membership.is_source).toBe(true);

      const otherRoomDevices = await dbContext.db
        .selectFrom('room_devices')
        .selectAll()
        .where('room_uid', '=', otherRoom.uid)
        .execute();
      expect(otherRoomDevices).toStrictEqual([
        expect.objectContaining({
          device_uid: otherSource.uid,
          is_source: true,
        }),
      ]);
    });

    it('refuses to reclaim it, and leaves the demo room sourceless, when it is the source of another room', async () => {
      // Arrange - this time the device itself is the only thing keeping the
      // other room's source invariant satisfied; reclaiming it would either
      // strand that room or be refused at commit by
      // `room_devices_ensure_source`, so the seeder must not attempt it.
      await bootAndSeed();
      const otherRoom = await dbContext.db
        .insertInto('rooms')
        .values({
          name: 'Other Room',
          timezone: 'UTC',
          auto_session_enabled: false,
        })
        .returning('uid')
        .executeTakeFirstOrThrow();
      await stealDevice(otherRoom.uid, true);

      // Act
      await bootAndSeed();

      // Assert - untouched in the other room, and the demo room now has no
      // devices at all rather than a silently-wrong one.
      const membership = await dbContext.db
        .selectFrom('room_devices')
        .selectAll()
        .where('device_uid', '=', DEMO_DEVICE_UID)
        .executeTakeFirstOrThrow();
      expect(membership.room_uid).toBe(otherRoom.uid);
      expect(membership.is_source).toBe(true);

      const demoRoomDevices = await dbContext.db
        .selectFrom('room_devices')
        .selectAll()
        .where('room_uid', '=', DEMO_ROOM_UID)
        .execute();
      expect(demoRoomDevices).toStrictEqual([]);
    });
  });
});
