import { deriveTestAudioDeviceSecret } from '@scribear/session-manager-schema/test-audio';

import type { TestAudioRoomsConfig } from '#src/app-config/app-config.js';
import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

import {
  TEST_AUDIO_ROOM_TIMEZONE,
  TEST_AUDIO_SEEDS,
  TEST_AUDIO_TRANSCRIPTION_PROVIDER_ID,
  TEST_AUDIO_TRANSCRIPTION_STREAM_CONFIG,
  type TestAudioSeed,
} from './test-audio-rooms.constants.js';

/**
 * Boot-time seeder for the two operator test-audio rooms.
 *
 * This replaces `deployment/provision-test-audio.sh`, a 190-line script an
 * operator had to run once, by hand, with `jq`, scraping a `DEVICE_TOKEN` out of
 * a `Set-Cookie` header and pasting two lines into `.env`. Nothing is copied any
 * more: one secret, `TEST_AUDIO_DEVICE_SECRET`, is given to this service and to
 * the generator, and each side computes the same per-device credential from it
 * (`deriveTestAudioDeviceSecret`). What this service stores is
 * `bcrypt(derived)`; what the generator presents is `{deviceUid}:{derived}`.
 *
 * When `TEST_AUDIO_DEVICE_SECRET` is unset, nothing at all is seeded and the
 * generator's two devices report `configured: false` — exactly the inert state
 * an unprovisioned deployment had before, and the same shape as
 * `DEMO_ROOM_ENABLED`.
 *
 * For each of the two sources, `seed()` idempotently ensures:
 *
 *   1. an **activated** device at a fixed uid, whose stored hash is re-written
 *      from the current secret on every boot (see
 *      `upsertActivatedWithFixedUid` for why re-hashing is the right default);
 *   2. a dedicated room at a fixed uid, `autoSessionEnabled: false`;
 *   3. that device as that room's **source**, converging a membership that was
 *      changed underneath us;
 *   4. one standing, open-ended `ON_DEMAND` session at a fixed uid — the thing
 *      an idle generator attaches to, and the reason no operator has to create
 *      a session by hand any more.
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
 * exactly where it opens. The result would be a daily gap in which the generator
 * finds no session, AUTO rows deleted and re-inserted on every reconcile, and a
 * run that crosses an occurrence boundary cut off mid-stream.
 *
 * One open-ended `ON_DEMAND` session has none of those properties: it is active
 * from the moment it is inserted until someone ends it, `my-schedule` reports it
 * (a null `effectiveEnd` reads as "still running"), and `exchange-device-token`
 * accepts it. It also *pins the room*: the `sessions_no_overlap` exclusion
 * constraint models it as `[start, infinity)`, so no schedule, window or
 * on-demand session can ever be created in a test-audio room while it stands —
 * which is a property worth having in a room dedicated to synthetic audio.
 * ---------------------------------------------------------------------------
 *
 * SAFETY. A device token reaches only its own device's room, and that binding is
 * the entire safety boundary for these two devices. Fixing it in code is
 * *stronger* than an operator wiring it by hand — there is no argument to point
 * at the wrong room and no prompt to misanswer — and a re-run repairs a drifted
 * assignment instead of creating a second one. The one thing this seeder will
 * never do is adopt a room it did not create: every room it touches is named by
 * a reserved uid no database-generated uid can collide with, and a device found
 * living in some *other* room is refused loudly rather than dragged back, since
 * that is the one state in which synthetic speech could already be reaching a
 * lecture and a silent repair would hide it.
 */
export class TestAudioRoomsSeeder {
  private readonly _logger: AppDependencies['logger'];
  private readonly _config: TestAudioRoomsConfig;
  private readonly _roomManagementRepository: AppDependencies['roomManagementRepository'];
  private readonly _deviceManagementRepository: AppDependencies['deviceManagementRepository'];
  private readonly _scheduleManagementRepository: AppDependencies['scheduleManagementRepository'];
  private readonly _hashService: AppDependencies['hashService'];

  constructor(
    logger: AppDependencies['logger'],
    testAudioRoomsConfig: AppDependencies['testAudioRoomsConfig'],
    roomManagementRepository: AppDependencies['roomManagementRepository'],
    deviceManagementRepository: AppDependencies['deviceManagementRepository'],
    scheduleManagementRepository: AppDependencies['scheduleManagementRepository'],
    hashService: AppDependencies['hashService'],
  ) {
    this._logger = logger;
    this._config = testAudioRoomsConfig;
    this._roomManagementRepository = roomManagementRepository;
    this._deviceManagementRepository = deviceManagementRepository;
    this._scheduleManagementRepository = scheduleManagementRepository;
    this._hashService = hashService;
  }

  /**
   * Ensures both test-audio rooms, devices, memberships and standing sessions
   * exist and agree with the configured secret. No-op when the feature is
   * disabled. Safe to call once at boot; safe to call again on every restart.
   * @param now Reference instant; defaults to the current time.
   */
  async seed(now: Date = new Date()): Promise<void> {
    if (!this._config.enabled) return;

    for (const seed of TEST_AUDIO_SEEDS) {
      await this._seedOne(seed, now);
    }
  }

  private async _seedOne(seed: TestAudioSeed, now: Date): Promise<void> {
    const log = this._logger.child({ deviceId: seed.deviceId });

    // Hashed before the insert so the same value is used whether the row is
    // being created or its credential replaced. bcrypt is salted, so this is a
    // fresh hash every boot even when the secret has not changed - that is the
    // cost of the guarantee that the stored credential always matches the
    // environment, and it is two hashes per process start.
    const hash = await this._hashService.hash(
      deriveTestAudioDeviceSecret(this._config.deviceSecret, seed.deviceUid),
    );
    const device =
      await this._deviceManagementRepository.upsertActivatedWithFixedUid(
        seed.deviceUid,
        { name: seed.deviceName, hash },
      );

    const room = await this._roomManagementRepository.createWithFixedUid(
      seed.roomUid,
      {
        name: seed.roomName,
        timezone: TEST_AUDIO_ROOM_TIMEZONE,
        // Never: this room's session is standing and open-ended, so there is
        // nothing for the auto-session reconciler to do except try to end it.
        autoSessionEnabled: false,
      },
    );

    // The one state this seeder refuses to repair. `room_devices` has a unique
    // index on `device_uid`, so re-seeding the membership would fail anyway -
    // but failing with a message that names the room is the difference between
    // an operator discovering that synthetic audio has been pointed at a real
    // lecture and an operator reading a constraint violation.
    if (device.roomUid !== null && device.roomUid !== seed.roomUid) {
      log.error(
        { deviceUid: seed.deviceUid, foundInRoomUid: device.roomUid },
        'test-audio device is in a room it was not seeded into; refusing to move it. ' +
          'A synthetic source in an unexpected room can be streaming fixture speech ' +
          "into that room's live captions - check the room, then remove the device from it.",
      );
      return;
    }

    await this._roomManagementRepository.upsertSourceDevice(
      room.uid,
      device.uid,
    );

    await this._ensureStandingSession(seed, room.uid, now);
  }

  /**
   * Ensures the room's standing session exists and is currently active.
   *
   * Insert-once by fixed uid, so the session keeps its original start time and
   * its identity across restarts. The extra step over the demo room's seeder is
   * the re-open: a session that has been ended early is still *there*, so a
   * `DO NOTHING` insert would find it and leave the room permanently without
   * anything to stream into.
   */
  private async _ensureStandingSession(
    seed: TestAudioSeed,
    roomUid: string,
    now: Date,
  ): Promise<void> {
    const db = this._scheduleManagementRepository.db;
    const existing = await this._scheduleManagementRepository.findSessionByUid(
      db,
      seed.sessionUid,
    );

    if (!existing) {
      await this._scheduleManagementRepository.insertSessionWithUid(db, {
        uid: seed.sessionUid,
        roomUid,
        name: seed.sessionName,
        type: 'ON_DEMAND',
        scheduledSessionUid: null,
        scheduledStartTime: now,
        // Open-ended: this is what makes the session permanently active, and
        // what `DeviceAuthClient.findActiveSession` reads as "still running".
        scheduledEndTime: null,
        // Receive only. The device sends audio with its own device token, which
        // carries SEND_AUDIO because it is the room's source; a join code for a
        // test room only ever needs to let someone watch the captions come out.
        joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: TEST_AUDIO_TRANSCRIPTION_PROVIDER_ID,
        transcriptionStreamConfig: TEST_AUDIO_TRANSCRIPTION_STREAM_CONFIG,
      });
      this._logger.info(
        { deviceId: seed.deviceId, roomName: seed.roomName },
        'test-audio room seeded with a standing session',
      );
      return;
    }

    const reopened = await this._scheduleManagementRepository.reopenSession(
      db,
      seed.sessionUid,
    );
    if (reopened) {
      this._logger.warn(
        { deviceId: seed.deviceId, roomName: seed.roomName },
        'test-audio standing session had been given an end; re-opened it',
      );
    }
  }
}
