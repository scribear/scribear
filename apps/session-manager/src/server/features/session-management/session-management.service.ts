import {
  DeviceSessionEventType,
  SessionScope,
} from '@scribear/session-manager-schema';
import type { TranscriptionProviderConfig } from '@scribear/transcription-service-schema';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';
import { generateRandomCode } from '#src/server/utils/generate-random-code.js';

import type { SessionEvent } from './session-event-bus.service.js';

const POLL_TIMEOUT_MS = 25_000;

const JOIN_CODE_LENGTH = 8;

export class SessionManagementService {
  private _sessionManagementRepository: AppDependencies['sessionManagementRepository'];
  private _sessionEventBusService: AppDependencies['sessionEventBusService'];
  private _jwtService: AppDependencies['jwtService'];

  constructor(
    sessionManagementRepository: AppDependencies['sessionManagementRepository'],
    sessionEventBusService: AppDependencies['sessionEventBusService'],
    jwtService: AppDependencies['jwtService'],
  ) {
    this._sessionManagementRepository = sessionManagementRepository;
    this._sessionEventBusService = sessionEventBusService;
    this._jwtService = jwtService;
  }

  async authenticateWithJoinCode(
    joinCode: string,
  ): Promise<{ sessionToken: string } | { error: 'INVALID_JOIN_CODE' }> {
    const session =
      await this._sessionManagementRepository.findActiveSessionByJoinCode(
        joinCode,
      );

    if (!session) {
      return { error: 'INVALID_JOIN_CODE' };
    }

    const sessionToken = this._jwtService.signSessionToken({
      sessionId: session.id,
      scopes: [SessionScope.RECEIVE_TRANSCRIPTIONS],
    });

    return { sessionToken };
  }

  async createOnDemandSession(
    sourceDeviceId: string,
    transcriptionProviderKey: string,
    transcriptionProviderConfig: TranscriptionProviderConfig,
    endTimeUnixMs: number,
    enableJoinCode: boolean,
  ): Promise<
    | { sessionId: string; joinCode: string | null }
    | { error: 'INVALID_END_TIME' | 'INVALID_SOURCE_DEVICE' }
  > {
    const startTime = new Date();

    if (endTimeUnixMs <= startTime.getTime()) {
      return { error: 'INVALID_END_TIME' };
    }

    const deviceExists =
      await this._sessionManagementRepository.deviceExists(sourceDeviceId);
    if (!deviceExists) {
      return { error: 'INVALID_SOURCE_DEVICE' };
    }

    const endTime = new Date(endTimeUnixMs);
    const joinCode = enableJoinCode
      ? generateRandomCode(JOIN_CODE_LENGTH)
      : null;

    const { session, startEvent } =
      await this._sessionManagementRepository.createSession(
        sourceDeviceId,
        transcriptionProviderKey,
        transcriptionProviderConfig,
        startTime,
        endTime,
        joinCode,
      );

    // Emit START_SESSION so any waiting long-poll request is handled immediately.
    // END_SESSION is in the future and will be delivered via the DB timer mechanism.
    this._sessionEventBusService.emit(sourceDeviceId, {
      eventId: startEvent.id,
      eventType: DeviceSessionEventType.START_SESSION,
      sessionId: session.id,
      timestampUnixMs: startTime.getTime(),
    });

    return { sessionId: session.id, joinCode };
  }

  /**
   * Long-poll for the next session event for a device.
   * Resolves with the event once its timestamp is reached, or null if the
   * polling window expires with no event.
   */
  getDeviceSessionEvent(
    deviceId: string,
    prevEventId: number | undefined,
  ): Promise<SessionEvent | null> {
    const nowMs = Date.now();
    const windowEndMs = new Date(nowMs + POLL_TIMEOUT_MS);

    return new Promise((resolve, reject) => {
      let resolved = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this._sessionEventBusService.removeListener(deviceId, onBusEvent);
      };

      const resolveOnce = (event: SessionEvent | null) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(event);
      };

      const rejectOnce = (err: Error) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(err);
      };

      // Wake up if a new session is created while we are waiting
      const onBusEvent = (event: SessionEvent) => {
        resolveOnce(event);
      };

      // Subscribe before the DB query to avoid the race where a session is
      // created between the DB check returning empty and us subscribing.
      this._sessionEventBusService.addListener(deviceId, onBusEvent);

      this._sessionManagementRepository
        .getNextSessionEvent(deviceId, prevEventId ?? null, windowEndMs)
        .then((dbEvent) => {
          if (!dbEvent) {
            // Nothing scheduled within the window; wait for bus or timeout
            timer = setTimeout(() => {
              resolveOnce(null);
            }, POLL_TIMEOUT_MS);
            return;
          }

          const sessionEvent: SessionEvent = {
            eventId: dbEvent.id,
            eventType: dbEvent.event_type as DeviceSessionEventType,
            sessionId: dbEvent.session_id,
            timestampUnixMs: dbEvent.timestamp.getTime(),
          };

          if (dbEvent.timestamp.getTime() <= nowMs) {
            // Event is in the past, resolve immediately
            resolveOnce(sessionEvent);
          } else {
            // Event is in the future within the window, set a timer
            const delay = dbEvent.timestamp.getTime() - Date.now();
            timer = setTimeout(
              () => {
                resolveOnce(sessionEvent);
              },
              Math.max(0, delay),
            );
          }
        })
        .catch(rejectOnce);
    });
  }
}
