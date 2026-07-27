import type { DemoRoomConfig } from '#src/app-config/app-config.js';
import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import type { Session } from '#src/server/features/schedule-management/schedule-management.repository.js';
import { generateRandomCode } from '#src/server/utils/generate-random-code.js';

import {
  DEMO_ROOM_NAME,
  DEMO_ROOM_UID,
  DEMO_SESSION_NAME,
  DEMO_SOURCE_DEVICE_NAME,
  DEMO_SOURCE_DEVICE_UID,
  DEMO_TRANSCRIPTION_PROVIDER_ID,
  DEMO_TRANSCRIPTION_STREAM_CONFIG,
} from './demo-room.constants.js';

// The demo device is never actually activated, so the code/expiry only need
// to satisfy the `devices_active_has_hash` CHECK constraint on first insert;
// on a repeat boot `createWithFixedUid` ignores them (ON CONFLICT DO NOTHING).
const PLACEHOLDER_ACTIVATION_CODE_LENGTH = 8;
const PLACEHOLDER_ACTIVATION_CODE_VALID_MINUTES = 5;

/**
 * Boot-time seeder for a joinable "demo caption room".
 *
 * This is the Session Manager half of the demo caption room; the Node Server
 * half (`DemoCaptionSource`) publishes a looping fixture caption stream for a
 * fixed `sessionUid` (see `apps/node-server/PLAN-Demo-CAPTION_ROOM.md`). A
 * browser can only join that stream through the normal join-code -> session
 * -token exchange, which requires a *real, currently-active* Session Manager
 * session whose `uid` is exactly that fixed value. This seeder ensures one
 * exists.
 *
 * At boot, when `demoRoomConfig.enabled`, `seed()`:
 *   1. Looks up a session by `demoRoomConfig.sessionUid`. If found, nothing is
 *      created - idempotent across restarts.
 *   2. Otherwise idempotently inserts a placeholder source device and a
 *      dedicated room (`autoSessionEnabled: false`, so the auto-session
 *      reconciler never touches it) under **fixed uids**, then inserts an
 *      open-ended (`scheduledEndTime: null`) `ON_DEMAND` session with that
 *      exact fixed `uid`. The device/room inserts use `ON CONFLICT (uid) DO
 *      NOTHING` (same pattern as the session insert below), so two instances
 *      racing to seed at once converge on one device/room/session triple
 *      instead of each leaving behind its own orphaned placeholder device and
 *      room - see the "10 duplicate demo sources on staging" incident this
 *      fixed: the session insert was already conflict-safe by fixed `uid`,
 *      but the device/room inserts previously had no fixed identity and no
 *      unique constraint on `name`, so every racing boot created its own.
 *   3. Either way, ensures a currently-valid join code exists and logs it -
 *      join codes rotate and there is no fixed one, so this is the only way
 *      for a developer to obtain a code to hand to a client/kiosk/standalone
 *      webapp.
 *
 * Enabled by default; when `DEMO_ROOM_ENABLED=false` it is never resolved and
 * no session is seeded (see `create-server.ts`).
 *
 * RECLAIMING A STRANDED DEVICE. `_createDemoSession` also repairs the
 * placeholder device being found outside the demo room - reachable only from
 * before `RoomManagementService`'s `DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE` guard
 * existed, since every API path that could move it there is refused now. This
 * is the one seeder in the family that *can* reclaim rather than always
 * refuse: the test-audio and canary sources are real, activated devices that
 * might be streaming into whatever room they were found in, so moving them
 * silently could hide a live pipeline problem. This device is never activated
 * and nobody holds its activation code, so it can never have been
 * authenticating audio into that other room.
 *
 * That safety argument has one hole: if the device is the *source* of the
 * room it was found in, removing it would leave that room without one, which
 * `room_devices_ensure_source` refuses at commit regardless of what this
 * seeder wants - and even if it did not, silently demoting a room's source is
 * a bigger surprise than a stranded placeholder is worth risking. So the
 * device is reclaimed only when it is a harmless non-source member elsewhere;
 * when it is the other room's source, this logs a loud warning and leaves the
 * demo room without a source until an operator resolves it by hand, the same
 * fallback the test-audio/canary seeders always take. Either branch logs,
 * because both mean the same thing: this device should never have left the
 * demo room, and something upstream let it.
 */
export class DemoRoomSeeder {
  private readonly _logger: AppDependencies['logger'];
  private readonly _config: DemoRoomConfig;
  private readonly _roomManagementRepository: AppDependencies['roomManagementRepository'];
  private readonly _deviceManagementRepository: AppDependencies['deviceManagementRepository'];
  private readonly _scheduleManagementRepository: AppDependencies['scheduleManagementRepository'];
  private readonly _sessionAuthService: AppDependencies['sessionAuthService'];

  constructor(
    logger: AppDependencies['logger'],
    demoRoomConfig: AppDependencies['demoRoomConfig'],
    roomManagementRepository: AppDependencies['roomManagementRepository'],
    deviceManagementRepository: AppDependencies['deviceManagementRepository'],
    scheduleManagementRepository: AppDependencies['scheduleManagementRepository'],
    sessionAuthService: AppDependencies['sessionAuthService'],
  ) {
    this._logger = logger;
    this._config = demoRoomConfig;
    this._roomManagementRepository = roomManagementRepository;
    this._deviceManagementRepository = deviceManagementRepository;
    this._scheduleManagementRepository = scheduleManagementRepository;
    this._sessionAuthService = sessionAuthService;
  }

  /**
   * Ensures the demo room/device/session exist and a join code is minted,
   * then logs the join code. No-op when the feature is disabled. Safe to call
   * once at boot; safe to call again on every restart (idempotent).
   * @param now Reference instant; defaults to the current time.
   */
  async seed(now: Date = new Date()): Promise<void> {
    if (!this._config.enabled) return;

    const db = this._scheduleManagementRepository.db;
    const existing = await this._scheduleManagementRepository.findSessionByUid(
      db,
      this._config.sessionUid,
    );
    const session = existing ?? (await this._createDemoSession(now));

    const joinCode = await this._sessionAuthService.ensureCurrentJoinCode(
      session.uid,
      now,
    );
    if (joinCode === null) {
      // Defensive: we just resolved this session (found or created), so a
      // missing join code here would only mean it was deleted concurrently.
      this._logger.error(
        { sessionUid: session.uid },
        'demo caption room: session vanished before a join code could be minted',
      );
      return;
    }

    this._logger.info(
      { joinCode, sessionUid: session.uid },
      'demo caption room seeded; join with this code',
    );
  }

  /**
   * Idempotently ensures the placeholder source device and the dedicated
   * demo room exist (fixed uids, `ON CONFLICT (uid) DO NOTHING`), links the
   * device to the room as its source (on first creation, or reclaiming it if
   * it was found stranded as a non-source member elsewhere - see "RECLAIMING
   * A STRANDED DEVICE" on the class docs), then inserts the open-ended
   * `ON_DEMAND` session with the fixed demo `uid`.
   */
  private async _createDemoSession(now: Date): Promise<Session> {
    const device = await this._deviceManagementRepository.createWithFixedUid(
      DEMO_SOURCE_DEVICE_UID,
      {
        name: DEMO_SOURCE_DEVICE_NAME,
        activationCode: generateRandomCode(PLACEHOLDER_ACTIVATION_CODE_LENGTH),
        expiry: new Date(
          now.getTime() + PLACEHOLDER_ACTIVATION_CODE_VALID_MINUTES * 60_000,
        ),
      },
    );

    const room = await this._roomManagementRepository.createWithFixedUid(
      DEMO_ROOM_UID,
      { name: DEMO_ROOM_NAME, timezone: 'UTC', autoSessionEnabled: false },
    );

    if (device.roomUid === null) {
      // First creation, or a device cleanly detached since (the escape hatch
      // `remove-device-from-room` deliberately leaves available). Link it -
      // `addDeviceToRoom` has no conflict handling, so this only runs once.
      await this._roomManagementRepository.addDeviceToRoom(
        room.uid,
        device.uid,
        true,
      );
    } else if (device.roomUid !== room.uid) {
      // Stranded outside the demo room. Reachable only from before
      // room-management's guards existed: `DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE`
      // now refuses every API path (`add-device-to-room`, `set-source-device`,
      // `create-room`) that could attach this device anywhere, so nothing
      // going forward can put it here again.
      //
      // Unlike the test-audio and canary seeders - which refuse outright to
      // move a source found outside its seeded room, because those sources
      // are real, activated, and might already be streaming into whatever
      // room they were found in - this device is never activated and nobody
      // holds its activation code, so it cannot be authenticating audio
      // anywhere. That makes reclaiming it safe *unless* it is the other
      // room's source: `room_devices_ensure_source` requires every room to
      // keep at least one source device at commit, so removing it would
      // either throw (if nothing else there can take over) or silently leave
      // a real, functioning room without the source an operator put there for
      // a reason neither this seeder nor its uid can distinguish from a real
      // one. That case is refused loudly instead, exactly like the
      // test-audio/canary sources, and the demo room is left without a
      // source until an operator resolves it by hand.
      if (device.isSource) {
        this._logger.warn(
          { deviceUid: device.uid, foundInRoomUid: device.roomUid },
          'demo caption room: placeholder source device is the source of ' +
            'another room; refusing to reclaim it automatically. The demo ' +
            'room has no source device until this is resolved by hand.',
        );
      } else {
        this._logger.warn(
          { deviceUid: device.uid, foundInRoomUid: device.roomUid },
          'demo caption room: placeholder source device was stranded ' +
            'outside the demo room as a non-source member; reclaiming it',
        );
        await this._roomManagementRepository.removeDeviceFromRoom(device.uid);
        await this._roomManagementRepository.addDeviceToRoom(
          room.uid,
          device.uid,
          true,
        );
      }
    }

    const db = this._scheduleManagementRepository.db;
    return this._scheduleManagementRepository.insertSessionWithUid(db, {
      uid: this._config.sessionUid,
      roomUid: room.uid,
      name: DEMO_SESSION_NAME,
      type: 'ON_DEMAND',
      scheduledSessionUid: null,
      scheduledStartTime: now,
      scheduledEndTime: null,
      joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS', 'SEND_AUDIO'],
      transcriptionProviderId: DEMO_TRANSCRIPTION_PROVIDER_ID,
      transcriptionStreamConfig: DEMO_TRANSCRIPTION_STREAM_CONFIG,
    });
  }
}
