import { describe, expect } from 'vitest';

import {
  CANARY_DEVICE_UID,
  CANARY_ROOM_NAME,
  CANARY_ROOM_UID,
  CANARY_SESSION_UID,
  DEVICE_TOKEN_COOKIE_NAME,
  SESSION_MANAGER_BASE_PATH,
} from '@scribear/session-manager-schema';
import { deriveTestAudioDeviceToken } from '@scribear/session-manager-schema/test-audio';

import createServer from '#src/server/create-server.js';
import { useDb } from '#tests/utils/use-db.js';
import { buildTestAppConfig } from '#tests/utils/use-server.js';

/**
 * The seeded monitoring canary room — the thing that replaced
 * `MONITORING_CANARY_DEVICE_TOKEN`.
 *
 * The same two properties matter here as for the test-audio rooms, and for the
 * same reasons:
 *
 *  1. **Idempotency across restarts.** Every row is keyed on a fixed uid, and
 *     nothing accumulates on the second, third or hundredth boot. The demo room
 *     shipped with name-keyed device/room inserts and left 10 duplicate
 *     placeholder devices on staging after 10 deploys.
 *  2. **The round trip.** The monitoring sidecar derives its own credential from
 *     the same secret and the same fixed uid, and that credential authenticates
 *     against the bcrypt hash this seeder stored — reaching the canary room and
 *     the standing session inside it, and nothing else. Asserting "the seeder
 *     wrote a hash" and "the derivation returns a string" separately would pass
 *     with the two sides computing different functions, which is the whole
 *     failure this design exists to make impossible.
 */

const CANARY_SECRET = 'integration-canary-secret';

describe('monitoring canary room seeding', () => {
  const dbContext = useDb(['sessions', 'rooms', 'devices']);

  async function boot(deviceSecret: string) {
    const config = buildTestAppConfig({
      canaryRoomConfig: {
        enabled: deviceSecret !== '',
        deviceSecret,
      },
    });
    const { fastify } = await createServer(config);
    await fastify.ready();
    return fastify;
  }

  async function bootAndSeed(deviceSecret = CANARY_SECRET) {
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
    it('creates exactly one device, room, membership and session, and adds nothing on the second or third boot', async () => {
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

      // Assert - every table the seeder writes to. `room_devices` is included
      // deliberately: a seeder that is idempotent on three tables and not the
      // fourth still accumulates rows.
      expect(afterFirst).toStrictEqual({
        devices: 1,
        rooms: 1,
        roomDevices: 1,
        sessions: 1,
      });
      expect(afterSecond).toStrictEqual(afterFirst);
      expect(afterThird).toStrictEqual(afterFirst);
    });

    it('seeds at the reserved uids rather than at whatever the database generated', async () => {
      // Arrange
      await bootAndSeed();

      // Act
      const [device, room, session] = await Promise.all([
        dbContext.db.selectFrom('devices').select('uid').execute(),
        dbContext.db.selectFrom('rooms').select('uid').execute(),
        dbContext.db.selectFrom('sessions').select('uid').execute(),
      ]);

      // Assert - the fixed uids are what make the inserts genuinely conflict-
      // safe, what the sidecar derives its credential against, and what
      // room-management's refusals are keyed on. A database-generated uid here
      // would break all three at once.
      expect(device.map((d) => d.uid)).toStrictEqual([CANARY_DEVICE_UID]);
      expect(room.map((r) => r.uid)).toStrictEqual([CANARY_ROOM_UID]);
      expect(session.map((s) => s.uid)).toStrictEqual([CANARY_SESSION_UID]);
    });
  });

  describe('with no secret configured', (it) => {
    it('seeds nothing at all', async () => {
      // Arrange / Act - the inert default, and the state every deployment that
      // never provisioned a canary device is already in. It must not find a
      // room and a device appear in its admin console after an upgrade.
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
      // Arrange - the reachable drift, and the documented way to retire the
      // canary: deleting the room cascades away its membership and its session,
      // leaving the device alive and roomless with a still-valid credential.
      // That is the one state in which the canary could be moved somewhere it
      // does not belong, so the next boot must put it back rather than leave it
      // loose.
      await bootAndSeed();
      await dbContext.db
        .deleteFrom('rooms')
        .where('uid', '=', CANARY_ROOM_UID)
        .execute();

      // Act
      await bootAndSeed();

      // Assert - back to one of everything, not two.
      expect(await counts()).toStrictEqual({
        devices: 1,
        rooms: 1,
        roomDevices: 1,
        sessions: 1,
      });
      const membership = await dbContext.db
        .selectFrom('room_devices')
        .selectAll()
        .where('device_uid', '=', CANARY_DEVICE_UID)
        .executeTakeFirstOrThrow();
      expect(membership.is_source).toBe(true);
      expect(membership.room_uid).toBe(CANARY_ROOM_UID);
    });

    it('re-opens a standing session that was given an end', async () => {
      // Arrange - an operator pressing "end session early" on the canary room.
      // The row still exists, so an insert keyed on the uid finds it and does
      // nothing; without the re-open the canary reports NO_SESSION forever and
      // a restart no longer fixes it.
      await bootAndSeed();
      await dbContext.db
        .updateTable('sessions')
        .set({ end_override: new Date() })
        .where('uid', '=', CANARY_SESSION_UID)
        .execute();

      // Act
      await bootAndSeed();

      // Assert
      const session = await dbContext.db
        .selectFrom('sessions')
        .selectAll()
        .where('uid', '=', CANARY_SESSION_UID)
        .executeTakeFirstOrThrow();
      expect(session.end_override).toBeNull();
      expect(session.scheduled_end_time).toBeNull();
    });

    it('re-activates a device that was reset to the pending state', async () => {
      // Arrange - `reregister-device` clears `hash` and `active`, which would
      // otherwise leave the canary permanently unable to authenticate.
      await bootAndSeed();
      await dbContext.db
        .updateTable('devices')
        .set({
          active: false,
          hash: null,
          activation_code: 'ABCD1234',
          expiry: new Date(Date.now() + 60_000),
        })
        .where('uid', '=', CANARY_DEVICE_UID)
        .execute();

      // Act
      await bootAndSeed();

      // Assert
      const device = await dbContext.db
        .selectFrom('devices')
        .selectAll()
        .where('uid', '=', CANARY_DEVICE_UID)
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
        .where('uid', '=', CANARY_DEVICE_UID)
        .executeTakeFirstOrThrow();

      // Act
      const fastify = await boot('second-secret');

      // Assert - the old token is refused, the new one is accepted, against one
      // row that was updated rather than duplicated.
      const stale = await fastify.inject({
        method: 'GET',
        url: `${SESSION_MANAGER_BASE_PATH}/room-management/get-my-room`,
        cookies: {
          [DEVICE_TOKEN_COOKIE_NAME]: deriveTestAudioDeviceToken(
            'first-secret',
            CANARY_DEVICE_UID,
          ),
        },
      });
      const fresh = await fastify.inject({
        method: 'GET',
        url: `${SESSION_MANAGER_BASE_PATH}/room-management/get-my-room`,
        cookies: {
          [DEVICE_TOKEN_COOKIE_NAME]: deriveTestAudioDeviceToken(
            'second-secret',
            CANARY_DEVICE_UID,
          ),
        },
      });
      await fastify.close();

      expect(stale.statusCode).toBe(401);
      expect(fresh.statusCode).toBe(200);

      const after = await dbContext.db
        .selectFrom('devices')
        .select('hash')
        .where('uid', '=', CANARY_DEVICE_UID)
        .executeTakeFirstOrThrow();
      expect(after.hash).not.toBe(before.hash);
      expect(await counts()).toStrictEqual({
        devices: 1,
        rooms: 1,
        roomDevices: 1,
        sessions: 1,
      });
    });
  });

  describe('the round trip the design rests on', (it) => {
    it('accepts the token the sidecar derives, reaching only the seeded room and its standing session', async () => {
      // Arrange - boot the real server, then present exactly what
      // `apps/monitoring-sidecar` puts in its DEVICE_TOKEN cookie: a value this
      // test computes with the same shared function that service calls, from
      // the secret and the fixed uid, with nothing having been copied from the
      // database. If the seeder's derivation and the sidecar's ever disagree,
      // this is the assertion that fails.
      const fastify = await boot(CANARY_SECRET);
      const cookies = {
        [DEVICE_TOKEN_COOKIE_NAME]: deriveTestAudioDeviceToken(
          CANARY_SECRET,
          CANARY_DEVICE_UID,
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
        body: { sessionUid: CANARY_SESSION_UID },
      });
      await fastify.close();

      // Assert - the credential verifies; it reaches the room it was seeded
      // into and no other, since `get-my-room` is scoped to the device's own
      // membership; a session is already active there with no operator having
      // created one, which is the manual step this replaced; and the token it
      // exchanges for carries both scopes the canary needs - SEND_AUDIO because
      // the seeder made the device that room's source, and
      // RECEIVE_TRANSCRIPTIONS because the canary reads the captions back on a
      // second socket to check the viewer fan-out.
      expect(room.statusCode).toBe(200);
      expect(room.json<{ uid: string; name: string }>()).toMatchObject({
        uid: CANARY_ROOM_UID,
        name: CANARY_ROOM_NAME,
      });

      expect(schedule.statusCode).toBe(200);
      const { sessions } = schedule.json<{
        sessions: { uid: string; effectiveEnd: string | null }[];
      }>();
      // Open-ended, which is what `DeviceAuthClient.findActiveSession` reads as
      // "still running" - an ended session would be absent, not merely closed.
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.uid).toBe(CANARY_SESSION_UID);
      expect(sessions[0]?.effectiveEnd).toBeNull();

      expect(exchange.statusCode).toBe(200);
      const { scopes } = exchange.json<{ scopes: string[] }>();
      expect(scopes).toContain('SEND_AUDIO');
      expect(scopes).toContain('RECEIVE_TRANSCRIPTIONS');
    });

    it('refuses a token derived from a different secret', async () => {
      // Arrange - the negative half. A derivation that ignored its key would
      // pass every assertion above and this one would catch it.
      const fastify = await boot(CANARY_SECRET);

      // Act
      const res = await fastify.inject({
        method: 'GET',
        url: `${SESSION_MANAGER_BASE_PATH}/room-management/get-my-room`,
        cookies: {
          [DEVICE_TOKEN_COOKIE_NAME]: deriveTestAudioDeviceToken(
            'not-the-configured-secret',
            CANARY_DEVICE_UID,
          ),
        },
      });
      await fastify.close();

      // Assert
      expect(res.statusCode).toBe(401);
    });

    it('does not share a credential with the test-audio devices seeded from a different secret', async () => {
      // Arrange - the property the separate secret buys, asserted rather than
      // assumed. The canary's derived credential is a function of
      // CANARY_DEVICE_SECRET alone; a deployment that set only
      // TEST_AUDIO_DEVICE_SECRET must not thereby have armed a canary.
      const fastify = await boot(CANARY_SECRET);

      // Act
      const res = await fastify.inject({
        method: 'GET',
        url: `${SESSION_MANAGER_BASE_PATH}/room-management/get-my-room`,
        cookies: {
          [DEVICE_TOKEN_COOKIE_NAME]: deriveTestAudioDeviceToken(
            'a-test-audio-secret',
            CANARY_DEVICE_UID,
          ),
        },
      });
      await fastify.close();

      // Assert
      expect(res.statusCode).toBe(401);
    });
  });
});
