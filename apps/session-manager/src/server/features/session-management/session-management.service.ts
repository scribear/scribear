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
  private _log: AppDependencies['logger'];
  private _sessionManagementRepository: AppDependencies['sessionManagementRepository'];
  private _sessionEventBusService: AppDependencies['sessionEventBusService'];
  private _jwtService: AppDependencies['jwtService'];

  constructor(
    logger: AppDependencies['logger'],
    sessionManagementRepository: AppDependencies['sessionManagementRepository'],
    sessionEventBusService: AppDependencies['sessionEventBusService'],
    jwtService: AppDependencies['jwtService'],
  ) {
    this._log = logger;
    this._sessionManagementRepository = sessionManagementRepository;
    this._sessionEventBusService = sessionEventBusService;
    this._jwtService = jwtService;
  }

  async authenticateWithJoinCode(
    joinCode: string,
  ): Promise<{ sessionToken: string } | null> {
    const session =
      await this._sessionManagementRepository.findActiveSessionByJoinCode(
        joinCode,
      );

    if (!session) {
      this._log.warn('Join code not found');
      return null;
    }

    const sessionToken = this._jwtService.signSessionToken({
      sessionId: session.id,
      scopes: [SessionScope.RECEIVE_TRANSCRIPTIONS],
    });

    return { sessionToken };
  }

  async authenticateSourceDevice(
    deviceId: string,
    sessionId: string,
  ): Promise<{
    sessionToken: string;
    transcriptionProviderKey: string;
    transcriptionProviderConfig: TranscriptionProviderConfig;
  } | null> {
    const session =
      await this._sessionManagementRepository.findActiveSessionBySourceDevice(
        deviceId,
        sessionId,
      );

    if (!session) {
      this._log.warn(
        { deviceId, sessionId },
        'Session not found for source device',
      );
      return null;
    }

    const sessionToken = this._jwtService.signSessionToken({
      sessionId: session.id,
      scopes: [SessionScope.RECEIVE_TRANSCRIPTIONS, SessionScope.SEND_AUDIO],
    });

    return {
      sessionToken,
      transcriptionProviderKey: session.transcription_provider_key,
      transcriptionProviderConfig:
        session.transcription_provider_config as TranscriptionProviderConfig,
    };
  }

  async createOnDemandSession(
    sourceDeviceId: string,
    transcriptionProviderKey: string,
    transcriptionProviderConfig: TranscriptionProviderConfig,
    endTimeUnixMs: number,
    enableJoinCode: boolean,
  ): Promise<{ sessionId: string; joinCode: string | null } | null> {
    const startTime = new Date();

    if (endTimeUnixMs <= startTime.getTime()) {
      this._log.warn('Session end time is not in the future');
      return null;
    }

    const deviceExists =
      await this._sessionManagementRepository.deviceExists(sourceDeviceId);
    if (!deviceExists) {
      this._log.warn({ sourceDeviceId }, 'Source device not found');
      return null;
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
    const log = this._log.child({ deviceId });

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
        log.info('Event triggered via session event bus');
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
              log.info('Event long poll timed out');
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
            log.info('Past scheduled event triggered immediately');
            resolveOnce(sessionEvent);
          } else {
            // Event is in the future within the window, set a timer
            const delay = dbEvent.timestamp.getTime() - Date.now();
            timer = setTimeout(
              () => {
                log.info('Scheduled event triggered after timeout');
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
