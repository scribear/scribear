import { describe, expect } from 'vitest';

import createServer from '#src/server/create-server.js';
import { buildTestAppConfig } from '#tests/utils/use-server.js';
import { useDb } from '#tests/utils/use-db.js';

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
});
