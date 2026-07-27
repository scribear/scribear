import { deriveTestAudioDeviceSecret } from '@scribear/session-manager-schema/test-audio';

import type { CanaryRoomConfig } from '#src/app-config/app-config.js';
import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

import {
  CANARY_DEVICE_NAME,
  CANARY_DEVICE_UID,
  CANARY_ROOM_NAME,
  CANARY_ROOM_TIMEZONE,
  CANARY_ROOM_UID,
  CANARY_SESSION_NAME,
  CANARY_SESSION_UID,
  CANARY_TRANSCRIPTION_PROVIDER_ID,
  CANARY_TRANSCRIPTION_STREAM_CONFIG,
} from './canary-room.constants.js';

/**
 * Boot-time seeder for the monitoring canary's room, device and session.
 *
 * This retires `MONITORING_CANARY_DEVICE_TOKEN`, the last hand-provisioned
 * device credential in the fleet. An operator used to register a device through
 * the admin API, activate it, scrape `DEVICE_TOKEN` out of a `Set-Cookie`
 * header, paste it into `.env`, then create a room, attach the device, make it
 * the source and give the room a standing schedule — five steps documented in
 * `apps/monitoring-sidecar/.env.example`, each one a chance to point the canary
 * at a lecture hall. Nothing is copied any more: one secret,
 * `CANARY_DEVICE_SECRET`, is given to this service and to the sidecar, and each
 * side computes the same credential from it (`deriveTestAudioDeviceSecret` —
 * the one derivation every seeded synthetic device shares). What this service
 * stores is `bcrypt(derived)`; what the sidecar presents is
 * `{deviceUid}:{derived}`.
 *
 * When `CANARY_DEVICE_SECRET` is unset, nothing at all is seeded and the sidecar
 * leaves the canary switched off — exactly the inert state an unprovisioned
 * deployment had before, and the same shape as `TEST_AUDIO_DEVICE_SECRET` and
 * `DEMO_ROOM_ENABLED`.
 *
 * `seed()` idempotently ensures:
 *
 *   1. an **activated** device at a fixed uid, whose stored hash is re-written
 *      from the current secret on every boot (see
 *      `upsertActivatedWithFixedUid` for why re-hashing is the right default);
 *   2. a dedicated room at a fixed uid, `autoSessionEnabled: false`;
 *   3. that device as that room's **source**, converging a membership that was
 *      changed underneath us;
 *   4. one standing, open-ended `ON_DEMAND` session at a fixed uid — the thing
 *      each canary probe attaches to, and the reason no operator has to give
 *      the room a schedule by hand any more.
 *
 * Every insert is keyed on a **fixed uid**, never on a name, so restarts and
 * racing instances converge on one row each instead of accumulating duplicates.
 * That is not hypothetical: the demo room shipped with a name-based device/room
 * insert and left 10 duplicate placeholder devices on staging after 10 deploys.
 *
 * ---------------------------------------------------------------------------
 * WHY A STANDING SESSION RATHER THAN `autoSessionEnabled`.
 *
 * `autoSessionEnabled` is only a *master switch*: `reconcileAutoSessions` reads
 * the room's `auto_session_windows` rows and produces nothing when there are
 * none, so turning it on by itself creates no session, ever. Making it work
 * would mean seeding a window too — and a window cannot cover a whole day,
 * because `auto_session_windows_local_times_distinct` forbids one that closes
 * exactly where it opens. The result would be a daily gap in which the canary
 * finds no session and reports `NO_SESSION` for a stack with nothing wrong.
 *
 * One open-ended `ON_DEMAND` session has none of those properties: it is active
 * from the moment it is inserted until someone ends it, `my-schedule` reports it
 * (a null `effectiveEnd` reads as "still running"), and `exchange-device-token`
 * accepts it. It also *pins the room*: the `sessions_no_overlap` exclusion
 * constraint models it as `[start, infinity)`, so no schedule, window or
 * on-demand session can ever be created in the canary room while it stands.
 * ---------------------------------------------------------------------------
 *
 * SAFETY. A device token reaches only its own device's room, and that binding is
 * the entire safety boundary for this device. Fixing it in code is *stronger*
 * than an operator wiring it by hand — there is no argument to point at the
 * wrong room and no `Set-Cookie` header to misread — and a re-run repairs a
 * drifted assignment instead of creating a second one. It matters more here than
 * for the operator test-audio devices, because the canary is the only synthetic
 * source that streams **unattended**, on a timer, with nobody watching a meter.
 *
 * The one thing this seeder will never do is adopt a room it did not create:
 * the room it touches is named by a reserved uid no database-generated uid can
 * collide with, and a device found living in some *other* room is refused
 * loudly rather than dragged back, since that is the one state in which fixture
 * speech could already be reaching a lecture and a silent repair would hide it.
 */
export class CanaryRoomSeeder {
  private readonly _logger: AppDependencies['logger'];
  private readonly _config: CanaryRoomConfig;
  private readonly _roomManagementRepository: AppDependencies['roomManagementRepository'];
  private readonly _deviceManagementRepository: AppDependencies['deviceManagementRepository'];
  private readonly _scheduleManagementRepository: AppDependencies['scheduleManagementRepository'];
  private readonly _hashService: AppDependencies['hashService'];

  constructor(
    logger: AppDependencies['logger'],
    canaryRoomConfig: AppDependencies['canaryRoomConfig'],
    roomManagementRepository: AppDependencies['roomManagementRepository'],
    deviceManagementRepository: AppDependencies['deviceManagementRepository'],
    scheduleManagementRepository: AppDependencies['scheduleManagementRepository'],
    hashService: AppDependencies['hashService'],
  ) {
    this._logger = logger;
    this._config = canaryRoomConfig;
    this._roomManagementRepository = roomManagementRepository;
    this._deviceManagementRepository = deviceManagementRepository;
    this._scheduleManagementRepository = scheduleManagementRepository;
    this._hashService = hashService;
  }

  /**
   * Ensures the canary room, device, membership and standing session exist and
   * agree with the configured secret. No-op when the feature is disabled. Safe
   * to call once at boot; safe to call again on every restart.
   * @param now Reference instant; defaults to the current time.
   */
  async seed(now: Date = new Date()): Promise<void> {
    if (!this._config.enabled) return;

    // Hashed before the insert so the same value is used whether the row is
    // being created or its credential replaced. bcrypt is salted, so this is a
    // fresh hash every boot even when the secret has not changed - that is the
    // cost of the guarantee that the stored credential always matches the
    // environment, and it is one hash per process start.
    const hash = await this._hashService.hash(
      deriveTestAudioDeviceSecret(this._config.deviceSecret, CANARY_DEVICE_UID),
    );
    const device =
      await this._deviceManagementRepository.upsertActivatedWithFixedUid(
        CANARY_DEVICE_UID,
        { name: CANARY_DEVICE_NAME, hash },
      );

    const room = await this._roomManagementRepository.createWithFixedUid(
      CANARY_ROOM_UID,
      {
        name: CANARY_ROOM_NAME,
        timezone: CANARY_ROOM_TIMEZONE,
        // Never: this room's session is standing and open-ended, so there is
        // nothing for the auto-session reconciler to do except try to end it.
        autoSessionEnabled: false,
      },
    );

    // The one state this seeder refuses to repair. `room_devices` has a unique
    // index on `device_uid`, so re-seeding the membership would fail anyway -
    // but failing with a message that names the room is the difference between
    // an operator discovering that the canary has been pointed at a real
    // lecture and an operator reading a constraint violation.
    if (device.roomUid !== null && device.roomUid !== CANARY_ROOM_UID) {
      this._logger.error(
        { deviceUid: CANARY_DEVICE_UID, foundInRoomUid: device.roomUid },
        'monitoring canary device is in a room it was not seeded into; refusing to move it. ' +
          'The canary streams fixture speech into that room every probe interval, unattended - ' +
          'check the room, then remove the device from it.',
      );
      return;
    }

    await this._roomManagementRepository.upsertSourceDevice(
      room.uid,
      device.uid,
    );

    await this._ensureStandingSession(room.uid, now);
  }

  /**
   * Ensures the room's standing session exists and is currently active.
   *
   * Insert-once by fixed uid, so the session keeps its original start time and
   * its identity across restarts. The extra step over the demo room's seeder is
   * the re-open: a session that has been ended early is still *there*, so a
   * `DO NOTHING` insert would find it and leave the canary permanently
   * reporting `NO_SESSION` with no way back.
   */
  private async _ensureStandingSession(
    roomUid: string,
    now: Date,
  ): Promise<void> {
    const db = this._scheduleManagementRepository.db;
    const existing = await this._scheduleManagementRepository.findSessionByUid(
      db,
      CANARY_SESSION_UID,
    );

    if (!existing) {
      await this._scheduleManagementRepository.insertSessionWithUid(db, {
        uid: CANARY_SESSION_UID,
        roomUid,
        name: CANARY_SESSION_NAME,
        type: 'ON_DEMAND',
        scheduledSessionUid: null,
        scheduledStartTime: now,
        // Open-ended: this is what makes the session permanently active, and
        // what `DeviceAuthClient.findActiveSession` reads as "still running".
        scheduledEndTime: null,
        // Receive only, as for the test-audio rooms. These are the scopes a
        // *join code* grants; the canary does not use one. It opens both its
        // sockets - /source to stream and /client to read the captions back -
        // with a session token minted from its own device token, which carries
        // SEND_AUDIO because it is the room's source. A join code for a
        // monitoring room only ever needs to let a human watch the captions
        // come out.
        joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: CANARY_TRANSCRIPTION_PROVIDER_ID,
        transcriptionStreamConfig: CANARY_TRANSCRIPTION_STREAM_CONFIG,
      });
      this._logger.info(
        { roomName: CANARY_ROOM_NAME },
        'monitoring canary room seeded with a standing session',
      );
      return;
    }

    const reopened = await this._scheduleManagementRepository.reopenSession(
      db,
      CANARY_SESSION_UID,
    );
    if (reopened) {
      this._logger.warn(
        { roomName: CANARY_ROOM_NAME },
        'monitoring canary standing session had been given an end; re-opened it',
      );
    }
  }
}
