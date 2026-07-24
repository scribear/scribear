import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { DEMO_ROOM_STATUS_SCHEMA } from '@scribear/session-manager-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import type { Session } from '#src/server/features/schedule-management/schedule-management.repository.js';

/**
 * Admin-facing status for the demo caption room.
 *
 * The seeder (`DemoRoomSeeder`) creates a joinable session at boot when the
 * feature is enabled but only *logs* the rotating join code; there is no other
 * way to obtain it. This controller closes that gap for the admin console: it
 * reports whether the feature is on and the seeded session is currently
 * joinable, and — when it is — mints/returns a currently-valid join code (via
 * the same idempotent `ensureCurrentJoinCode` the seeder uses) so the console
 * can build a one-click "open live captions" link.
 *
 * The join code is only ever returned to an authenticated admin operator (this
 * route is admin-key protected). When `DEMO_ROOM_ENABLED=false` the feature is
 * off and this route reports `enabled: false` with a `null` join code.
 */
export class DemoRoomController {
  private readonly _config: AppDependencies['demoRoomConfig'];
  private readonly _scheduleManagementRepository: AppDependencies['scheduleManagementRepository'];
  private readonly _sessionAuthService: AppDependencies['sessionAuthService'];

  constructor(
    demoRoomConfig: AppDependencies['demoRoomConfig'],
    scheduleManagementRepository: AppDependencies['scheduleManagementRepository'],
    sessionAuthService: AppDependencies['sessionAuthService'],
  ) {
    this._config = demoRoomConfig;
    this._scheduleManagementRepository = scheduleManagementRepository;
    this._sessionAuthService = sessionAuthService;
  }

  async status(
    _req: BaseFastifyRequest<typeof DEMO_ROOM_STATUS_SCHEMA>,
    res: BaseFastifyReply<typeof DEMO_ROOM_STATUS_SCHEMA>,
  ) {
    const { enabled, sessionUid } = this._config;

    if (!enabled) {
      res.code(200).send({
        enabled: false,
        sessionUid,
        active: false,
        roomName: null,
        joinCode: null,
      });
      return;
    }

    const now = new Date();
    const db = this._scheduleManagementRepository.db;
    const session = await this._scheduleManagementRepository.findSessionByUid(
      db,
      sessionUid,
    );

    if (!session) {
      // Enabled, but the seeder has not created the session (not booted yet, or
      // seeding failed). Configured but not joinable.
      res.code(200).send({
        enabled: true,
        sessionUid,
        active: false,
        roomName: null,
        joinCode: null,
      });
      return;
    }

    const active = isSessionCurrentlyActive(session, now);
    // Only mint a code when it would actually exchange — a code for an inactive
    // session would 409 on exchange and mislead the console.
    const joinCode = active
      ? await this._sessionAuthService.ensureCurrentJoinCode(sessionUid, now)
      : null;

    res.code(200).send({
      enabled: true,
      sessionUid,
      active,
      roomName: session.name,
      joinCode,
    });
  }
}

/**
 * Mirrors the active-window check the session-auth service applies before an
 * exchange: started, and not yet ended (open-ended sessions have a null
 * `effectiveEnd` and are always current once started). The seeded demo session
 * is open-ended, so this is effectively "has the seed run and its start passed".
 */
function isSessionCurrentlyActive(session: Session, now: Date): boolean {
  if (session.effectiveStart.getTime() > now.getTime()) return false;
  if (
    session.effectiveEnd !== null &&
    session.effectiveEnd.getTime() <= now.getTime()
  ) {
    return false;
  }
  return true;
}
