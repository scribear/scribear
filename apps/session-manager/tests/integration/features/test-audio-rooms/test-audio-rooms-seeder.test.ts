import { describe, expect } from 'vitest';

import {
  DEVICE_TOKEN_COOKIE_NAME,
  SESSION_MANAGER_BASE_PATH,
} from '@scribear/session-manager-schema';
import {
  TEST_AUDIO_FAULT_DEVICE_UID,
  TEST_AUDIO_GOOD_DEVICE_UID,
  TEST_AUDIO_GOOD_ROOM_NAME,
  TEST_AUDIO_GOOD_ROOM_UID,
  TEST_AUDIO_GOOD_SESSION_UID,
  deriveTestAudioDeviceToken,
} from '@scribear/session-manager-schema/test-audio';

import createServer from '#src/server/create-server.js';
import { useDb } from '#tests/utils/use-db.js';
import { buildTestAppConfig } from '#tests/utils/use-server.js';

/**
 * The seeded operator test-audio rooms — the thing that replaced
 * `deployment/provision-test-audio.sh`.
 *
 * Two properties matter enough to be asserted end to end rather than in halves:
 *
 *  1. **Idempotency across restarts.** Every row is keyed on a fixed uid, and
 *     nothing accumulates on the second, third or hundredth boot. This is not a
 *     hypothetical: the demo room shipped with name-keyed device/room inserts
 *     and left 10 duplicate placeholder devices on staging after 10 deploys.
 *  2. **The round trip.** The generator derives its own credential from the same
 *     secret and the same fixed uid, and that credential authenticates against
 *     the bcrypt hash this seeder stored — reaching the seeded room, and the
 *     standing session inside it, and nothing else. Asserting "the seeder wrote
 *     a hash" and "the derivation returns a string" separately would pass with
 *     the two sides computing different functions, which is the whole failure
 *     this design exists to make impossible.
 */

const TEST_AUDIO_SECRET = 'integration-test-audio-secret';

describe('test-audio room seeding', () => {
  const dbContext = useDb(['sessions', 'rooms', 'devices']);

  async function boot(deviceSecret: string) {
    const config = buildTestAppConfig({
      testAudioRoomsConfig: {
        enabled: deviceSecret !== '',
        deviceSecret,
      },
    });
    const { fastify } = await createServer(config);
    await fastify.ready();
    return fastify;
  }

  async function bootAndSeed(deviceSecret = TEST_AUDIO_SECRET) {
    const fastify = await boot(deviceSecret);
    await fastify.close();
  }

  /** Row counts for every table the seeder touches. */
  async function counts() {
    const [devices, rooms, roomDevices, sessions] = await Promise.all([
      dbContext.db.selectFrom('devices').selectAll().execute(),
      dbContext.db.selectFrom('rooms').selectAll().execute(),
      dbContext.db.selectFrom('room_devices').selectAll().execute(),
      dbContext.db.selectFrom('sessions').selectAll().execute(),
    ]);
    return {
      devices: devices.length,
      rooms: rooms.length,
      roomDevices: roomDevices.length,
      sessions: sessions.length,
    };
  }

  describe('idempotency', (it) => {
    it('creates exactly one device, room, membership and session per source, and adds nothing on the second or third boot', async () => {
      // Arrange - three boots against one database, because a bug that only
      // shows on the *third* pass is exactly what an ON CONFLICT written
      // against the wrong constraint looks like: the second run reuses the row
      // the first created and the third finds two.
      await bootAndSeed();
      const afterFirst = await counts();

      // Act
      await bootAndSeed();
      const afterSecond = await counts();
      await bootAndSeed();
      const afterThird = await counts();

      // Assert - two sources, so two of everything, on every table the seeder
      // writes to. `room_devices` is included deliberately: a seeder that is
      // idempotent on three tables and not the fourth still accumulates rows.
      expect(afterFirst).toStrictEqual({
        devices: 2,
        rooms: 2,
        roomDevices: 2,
        sessions: 2,
      });
      expect(afterSecond).toStrictEqual(afterFirst);
      expect(afterThird).toStrictEqual(afterFirst);
    });

    it('seeds at the reserved uids rather than at whatever the database generated', async () => {
      // Arrange
      await bootAndSeed();

      // Act
      const devices = await dbContext.db
        .selectFrom('devices')
        .select('uid')
        .orderBy('uid')
        .execute();

      // Assert - the fixed uids are what make the inserts genuinely conflict-
      // safe and what the generator derives its credentials against, so a
      // database-generated uid here would break both properties at once.
      expect(devices.map((d) => d.uid).sort()).toStrictEqual(
        [TEST_AUDIO_GOOD_DEVICE_UID, TEST_AUDIO_FAULT_DEVICE_UID].sort(),
      );
    });
  });

  describe('with no secret configured', (it) => {
    it('seeds nothing at all', async () => {
      // Arrange / Act - the inert default. A deployment that has never asked
      // for this feature must not find two rooms and two devices appear in its
      // admin console after an upgrade.
      await bootAndSeed('');

      // Assert
      expect(await counts()).toStrictEqual({
        devices: 0,
        rooms: 0,
        roomDevices: 0,
        sessions: 0,
      });
    });
  });

  describe('convergence after the rows were changed underneath it', (it) => {
    it('re-creates the room, the membership and the session after the room was deleted', async () => {
      // Arrange - the reachable drift, and the documented way to retire these
      // devices: deleting the room cascades away its membership and its
      // session, leaving the device alive and roomless with a still-valid
      // credential. That is the one state in which a synthetic source could be
      // moved somewhere it does not belong, so the next boot must put it back
      // rather than leave it loose.
      //
      // (Demoting the lone source instead is not reachable: the
      // `room_devices_ensure_source` trigger refuses it, and room-management
      // now refuses to add a second device to a test-audio room to promote.)
      await bootAndSeed();
      await dbContext.db
        .deleteFrom('rooms')
        .where('uid', '=', TEST_AUDIO_GOOD_ROOM_UID)
        .execute();

      // Act
      await bootAndSeed();

      // Assert - back to one of everything, not two.
      expect(await counts()).toStrictEqual({
        devices: 2,
        rooms: 2,
        roomDevices: 2,
        sessions: 2,
      });
      const membership = await dbContext.db
        .selectFrom('room_devices')
        .selectAll()
        .where('device_uid', '=', TEST_AUDIO_GOOD_DEVICE_UID)
        .executeTakeFirstOrThrow();
      expect(membership.is_source).toBe(true);
      expect(membership.room_uid).toBe(TEST_AUDIO_GOOD_ROOM_UID);
    });

    it('re-opens a standing session that was given an end', async () => {
      // Arrange - an operator pressing "end session early" on a test room. The
      // row still exists, so an insert keyed on the uid finds it and does
      // nothing; without the re-open the room is permanently dead and a
      // restart no longer fixes it.
      await bootAndSeed();
      await dbContext.db
        .updateTable('sessions')
        .set({ end_override: new Date() })
        .where('uid', '=', TEST_AUDIO_GOOD_SESSION_UID)
        .execute();

      // Act
      await bootAndSeed();

      // Assert
      const session = await dbContext.db
        .selectFrom('sessions')
        .selectAll()
        .where('uid', '=', TEST_AUDIO_GOOD_SESSION_UID)
        .executeTakeFirstOrThrow();
      expect(session.end_override).toBeNull();
      expect(session.scheduled_end_time).toBeNull();
    });

    it('re-activates a device that was reset to the pending state', async () => {
      // Arrange - `reregister-device` clears `hash` and `active`, which would
      // otherwise leave a seeded source permanently unable to authenticate.
      await bootAndSeed();
      await dbContext.db
        .updateTable('devices')
        .set({
          active: false,
          hash: null,
          activation_code: 'ABCD1234',
          expiry: new Date(Date.now() + 60_000),
        })
        .where('uid', '=', TEST_AUDIO_GOOD_DEVICE_UID)
        .execute();

      // Act
      await bootAndSeed();

      // Assert
      const device = await dbContext.db
        .selectFrom('devices')
        .selectAll()
        .where('uid', '=', TEST_AUDIO_GOOD_DEVICE_UID)
        .executeTakeFirstOrThrow();
      expect(device.active).toBe(true);
      expect(device.hash).not.toBeNull();
      expect(device.activation_code).toBeNull();
    });

    it('re-hashes on every boot, so changing the secret rotates the credential', async () => {
      // Arrange - the reason the device insert is DO UPDATE and not DO NOTHING.
      // bcrypt is salted, so the stored hash cannot be compared against the
      // derived secret to detect drift; the only cheap guarantee is to rewrite
      // it. Booting with a second secret must leave the FIRST one unusable.
      await bootAndSeed('first-secret');
      const before = await dbContext.db
        .selectFrom('devices')
        .select('hash')
        .where('uid', '=', TEST_AUDIO_GOOD_DEVICE_UID)
        .executeTakeFirstOrThrow();

      // Act
      const fastify = await boot('second-secret');

      // Assert - the old token is refused, the new one is accepted, against
      // one row that was updated rather than duplicated.
      const stale = await fastify.inject({
        method: 'GET',
        url: `${SESSION_MANAGER_BASE_PATH}/room-management/get-my-room`,
        cookies: {
          [DEVICE_TOKEN_COOKIE_NAME]: deriveTestAudioDeviceToken(
            'first-secret',
            TEST_AUDIO_GOOD_DEVICE_UID,
          ),
        },
      });
      const fresh = await fastify.inject({
        method: 'GET',
        url: `${SESSION_MANAGER_BASE_PATH}/room-management/get-my-room`,
        cookies: {
          [DEVICE_TOKEN_COOKIE_NAME]: deriveTestAudioDeviceToken(
            'second-secret',
            TEST_AUDIO_GOOD_DEVICE_UID,
          ),
        },
      });
      await fastify.close();

      expect(stale.statusCode).toBe(401);
      expect(fresh.statusCode).toBe(200);

      const after = await dbContext.db
        .selectFrom('devices')
        .select('hash')
        .where('uid', '=', TEST_AUDIO_GOOD_DEVICE_UID)
        .executeTakeFirstOrThrow();
      expect(after.hash).not.toBe(before.hash);
      expect(await counts()).toStrictEqual({
        devices: 2,
        rooms: 2,
        roomDevices: 2,
        sessions: 2,
      });
    });
  });

  describe('the round trip the design rests on', (it) => {
    it('accepts the token the generator derives, reaching only the seeded room and its standing session', async () => {
      // Arrange - boot the real server, then present exactly what
      // `apps/test-audio-generator` puts in its DEVICE_TOKEN cookie: a value
      // this test computes with the same shared function the generator calls,
      // from the secret and the fixed uid, with nothing having been copied
      // from the database. If the seeder's derivation and the generator's ever
      // disagree, this is the assertion that fails.
      const fastify = await boot(TEST_AUDIO_SECRET);
      const cookies = {
        [DEVICE_TOKEN_COOKIE_NAME]: deriveTestAudioDeviceToken(
          TEST_AUDIO_SECRET,
          TEST_AUDIO_GOOD_DEVICE_UID,
        ),
      };

      // Act
      const room = await fastify.inject({
        method: 'GET',
        url: `${SESSION_MANAGER_BASE_PATH}/room-management/get-my-room`,
        cookies,
      });
      const schedule = await fastify.inject({
        method: 'GET',
        url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/my-schedule?sinceVersion=0`,
        cookies,
      });
      const exchange = await fastify.inject({
        method: 'POST',
        url: `${SESSION_MANAGER_BASE_PATH}/session-auth/exchange-device-token`,
        cookies,
        body: { sessionUid: TEST_AUDIO_GOOD_SESSION_UID },
      });
      await fastify.close();

      // Assert - the credential verifies; it reaches the room it was seeded
      // into and no other, since `get-my-room` is scoped to the device's own
      // membership; a session is already active there with no operator having
      // created one, which is the manual step this replaced; and the token it
      // exchanges for carries SEND_AUDIO, because the seeder made the device
      // that room's source.
      expect(room.statusCode).toBe(200);
      expect(room.json<{ uid: string; name: string }>()).toMatchObject({
        uid: TEST_AUDIO_GOOD_ROOM_UID,
        name: TEST_AUDIO_GOOD_ROOM_NAME,
      });

      expect(schedule.statusCode).toBe(200);
      const { sessions } = schedule.json<{
        sessions: { uid: string; effectiveEnd: string | null }[];
      }>();
      // Open-ended, which is what `DeviceAuthClient.findActiveSession` reads as
      // "still running" - an ended session would be absent, not merely closed.
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.uid).toBe(TEST_AUDIO_GOOD_SESSION_UID);
      expect(sessions[0]?.effectiveEnd).toBeNull();

      expect(exchange.statusCode).toBe(200);
      expect(exchange.json<{ scopes: string[] }>().scopes).toContain(
        'SEND_AUDIO',
      );
    });

    it('refuses a token derived from a different secret', async () => {
      // Arrange - the negative half. A derivation that ignored its key would
      // pass every assertion above and this one would catch it.
      const fastify = await boot(TEST_AUDIO_SECRET);

      // Act
      const res = await fastify.inject({
        method: 'GET',
        url: `${SESSION_MANAGER_BASE_PATH}/room-management/get-my-room`,
        cookies: {
          [DEVICE_TOKEN_COOKIE_NAME]: deriveTestAudioDeviceToken(
            'not-the-configured-secret',
            TEST_AUDIO_GOOD_DEVICE_UID,
          ),
        },
      });
      await fastify.close();

      // Assert
      expect(res.statusCode).toBe(401);
    });
  });
});
