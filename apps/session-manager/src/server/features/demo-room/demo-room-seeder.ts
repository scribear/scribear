import type { DemoRoomConfig } from '#src/app-config/app-config.js';
import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import type { Session } from '#src/server/features/schedule-management/schedule-management.repository.js';

import {
  DEMO_ROOM_NAME,
  DEMO_SESSION_NAME,
  DEMO_SOURCE_DEVICE_NAME,
  DEMO_TRANSCRIPTION_PROVIDER_ID,
  DEMO_TRANSCRIPTION_STREAM_CONFIG,
} from './demo-room.constants.js';

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
 *   2. Otherwise creates a placeholder source device, a dedicated room
 *      (`autoSessionEnabled: false`, so the auto-session reconciler never
 *      touches it), and an open-ended (`scheduledEndTime: null`) `ON_DEMAND`
 *      session inserted with that exact fixed `uid`.
 *   3. Either way, ensures a currently-valid join code exists and logs it -
 *      join codes rotate and there is no fixed one, so this is the only way
 *      for a developer to obtain a code to hand to a client/kiosk/standalone
 *      webapp.
 *
 * Enabled by default; when `DEMO_ROOM_ENABLED=false` it is never resolved and
 * no session is seeded (see `create-server.ts`).
 */
export class DemoRoomSeeder {
  private readonly _logger: AppDependencies['logger'];
  private readonly _config: DemoRoomConfig;
  private readonly _roomManagementService: AppDependencies['roomManagementService'];
  private readonly _deviceManagementService: AppDependencies['deviceManagementService'];
  private readonly _scheduleManagementRepository: AppDependencies['scheduleManagementRepository'];
  private readonly _sessionAuthService: AppDependencies['sessionAuthService'];

  constructor(
    logger: AppDependencies['logger'],
    demoRoomConfig: AppDependencies['demoRoomConfig'],
    roomManagementService: AppDependencies['roomManagementService'],
    deviceManagementService: AppDependencies['deviceManagementService'],
    scheduleManagementRepository: AppDependencies['scheduleManagementRepository'],
    sessionAuthService: AppDependencies['sessionAuthService'],
  ) {
    this._logger = logger;
    this._config = demoRoomConfig;
    this._roomManagementService = roomManagementService;
    this._deviceManagementService = deviceManagementService;
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
   * Creates the placeholder source device, the dedicated demo room, and the
   * open-ended `ON_DEMAND` session with the fixed demo `uid`.
   */
  private async _createDemoSession(now: Date): Promise<Session> {
    const device = await this._deviceManagementService.registerDevice(
      DEMO_SOURCE_DEVICE_NAME,
    );

    const room = await this._roomManagementService.createRoom({
      name: DEMO_ROOM_NAME,
      timezone: 'UTC',
      autoSessionEnabled: false,
      sourceDeviceUids: [device.deviceUid],
    });
    if (typeof room === 'string') {
      throw new Error(`demo caption room: createRoom failed: ${room}`);
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
