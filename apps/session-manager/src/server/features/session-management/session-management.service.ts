import crypto from 'node:crypto';

import {
  DeviceSessionEventType,
  SessionChannelEventType,
  SessionTokenScope,
} from '@scribear/session-manager-schema';
import type { TranscriptionProviderConfig } from '@scribear/transcription-service-schema';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';
import { generateRandomCode } from '#src/server/utils/generate-random-code.js';

import type { SessionEvent } from './session-event-bus.service.js';

const POLL_TIMEOUT_MS = 25_000;

const DEFAULT_JOIN_CODE_LENGTH = 8;

const JWT_LIFETIME_S = 5 * 60;

const JOIN_CODE_DURATION_MS = 5 * 60 * 1_000;
const JOIN_CODE_ROTATION_THRESHOLD_MS = 1 * 60 * 1_000;

const REFRESH_TOKEN_SECRET_LENGTH = 32;
const REFRESH_TOKEN_SEPARATOR = ':';

export class SessionManagementService {
  private _log: AppDependencies['logger'];
  private _sessionManagementRepository: AppDependencies['sessionManagementRepository'];
  private _sessionRefreshTokenRepository: AppDependencies['sessionRefreshTokenRepository'];
  private _sessionJoinCodeRepository: AppDependencies['sessionJoinCodeRepository'];
  private _sessionEventBusService: AppDependencies['sessionEventBusService'];
  private _jwtService: AppDependencies['jwtService'];
  private _hashService: AppDependencies['hashService'];
  private _redisPublisher: AppDependencies['redisPublisher'];

  constructor(
    logger: AppDependencies['logger'],
    sessionManagementRepository: AppDependencies['sessionManagementRepository'],
    sessionRefreshTokenRepository: AppDependencies['sessionRefreshTokenRepository'],
    sessionJoinCodeRepository: AppDependencies['sessionJoinCodeRepository'],
    sessionEventBusService: AppDependencies['sessionEventBusService'],
    jwtService: AppDependencies['jwtService'],
    hashService: AppDependencies['hashService'],
    redisPublisher: AppDependencies['redisPublisher'],
  ) {
    this._log = logger;
    this._sessionManagementRepository = sessionManagementRepository;
    this._sessionRefreshTokenRepository = sessionRefreshTokenRepository;
    this._sessionJoinCodeRepository = sessionJoinCodeRepository;
    this._sessionEventBusService = sessionEventBusService;
    this._jwtService = jwtService;
    this._hashService = hashService;
    this._redisPublisher = redisPublisher;
  }

  async authenticateWithJoinCode(
    joinCode: string,
  ): Promise<{ sessionToken: string; sessionRefreshToken: string } | null> {
    const session =
      await this._sessionJoinCodeRepository.findActiveSessionByJoinCode(
        joinCode,
      );

    if (!session) {
      this._log.warn('Join code not found');
      return null;
    }

    const scopes = [SessionTokenScope.RECEIVE_TRANSCRIPTIONS];

    const { refreshTokenId, sessionRefreshToken } =
      await this._createRefreshToken(session.id, scopes, 'join_code');

    const sessionToken = this._signShortLivedToken(
      session.id,
      refreshTokenId,
      scopes,
    );

    return { sessionToken, sessionRefreshToken };
  }

  async authenticateSourceDevice(
    deviceId: string,
    sessionId: string,
  ): Promise<{
    sessionToken: string;
    sessionRefreshToken: string;
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

    const scopes = [
      SessionTokenScope.RECEIVE_TRANSCRIPTIONS,
      SessionTokenScope.SEND_AUDIO,
    ];

    const { refreshTokenId, sessionRefreshToken } =
      await this._createRefreshToken(session.id, scopes, 'source_device');

    const sessionToken = this._signShortLivedToken(
      session.id,
      refreshTokenId,
      scopes,
    );

    return { sessionToken, sessionRefreshToken };
  }

  async createOnDemandSession(
    sourceDeviceId: string,
    transcriptionProviderKey: string,
    transcriptionProviderConfig: TranscriptionProviderConfig,
    endTimeUnixMs: number | undefined,
    enableJoinCode: boolean,
    joinCodeLength: number | undefined,
    enableJoinCodeRotation: boolean | undefined,
  ): Promise<{ sessionId: string } | null> {
    const startTime = new Date();

    if (endTimeUnixMs !== undefined && endTimeUnixMs <= startTime.getTime()) {
      this._log.warn('Session end time is not in the future');
      return null;
    }

    const deviceExists =
      await this._sessionManagementRepository.deviceExists(sourceDeviceId);
    if (!deviceExists) {
      this._log.warn({ sourceDeviceId }, 'Source device not found');
      return null;
    }

    const endTime =
      endTimeUnixMs !== undefined ? new Date(endTimeUnixMs) : null;
    const codeLength = enableJoinCode
      ? (joinCodeLength ?? DEFAULT_JOIN_CODE_LENGTH)
      : null;
    const rotationEnabled = enableJoinCode
      ? (enableJoinCodeRotation ?? true)
      : null;

    const { session, startEvent } =
      await this._sessionManagementRepository.createSession(
        sourceDeviceId,
        transcriptionProviderKey,
        transcriptionProviderConfig,
        startTime,
        endTime,
        codeLength,
        rotationEnabled,
      );

    // Create the initial join code if enabled
    if (codeLength !== null) {
      const code = generateRandomCode(codeLength);
      const expiresAt = new Date(startTime.getTime() + JOIN_CODE_DURATION_MS);
      await this._sessionJoinCodeRepository.create(
        session.id,
        code,
        startTime,
        expiresAt,
      );
    }

    // Emit START_SESSION so any waiting long-poll request is handled immediately.
    // END_SESSION is in the future and will be delivered via the DB timer mechanism.
    this._sessionEventBusService.emit(sourceDeviceId, {
      eventId: startEvent.id,
      eventType: DeviceSessionEventType.START_SESSION,
      sessionId: session.id,
      timestampUnixMs: startTime.getTime(),
    });

    return { sessionId: session.id };
  }

  /**
   * Refreshes a session token using the opaque refresh token string.
   * Returns a new short-lived JWT or null if the refresh token is invalid.
   */
  async refreshSessionToken(
    refreshTokenString: string,
  ): Promise<{ sessionToken: string } | null> {
    const decoded = this._decodeRefreshToken(refreshTokenString);
    if (!decoded) {
      this._log.warn('Invalid refresh token format');
      return null;
    }

    const tokenRecord = await this._sessionRefreshTokenRepository.findById(
      decoded.id,
    );
    if (!tokenRecord) {
      this._log.warn('Refresh token not found');
      return null;
    }

    if (tokenRecord.expiry && tokenRecord.expiry.getTime() < Date.now()) {
      this._log.warn('Refresh token expired');
      return null;
    }

    const isValid = await this._hashService.verify(
      decoded.secret,
      tokenRecord.secret_hash,
    );
    if (!isValid) {
      this._log.warn('Refresh token secret mismatch');
      return null;
    }

    // Verify the session is still active
    const session = await this._sessionManagementRepository.findSessionById(
      tokenRecord.session_id,
    );
    if (!session) {
      this._log.warn('Session not found for refresh token');
      return null;
    }

    const now = new Date();
    if (session.start_time > now) {
      this._log.warn('Session has not started yet');
      return null;
    }
    if (session.end_time && session.end_time <= now) {
      this._log.warn('Session has ended');
      return null;
    }

    const scopes = tokenRecord.scope as SessionTokenScope[];
    const sessionToken = this._signShortLivedToken(
      tokenRecord.session_id,
      tokenRecord.id,
      scopes,
    );

    return { sessionToken };
  }

  /**
   * Returns transcription configuration for a session.
   */
  async getSessionConfig(sessionId: string): Promise<{
    transcriptionProviderKey: string;
    transcriptionProviderConfig: TranscriptionProviderConfig;
    endTimeUnixMs: number | null;
  } | null> {
    const session =
      await this._sessionManagementRepository.findSessionById(sessionId);
    if (!session) {
      return null;
    }

    return {
      transcriptionProviderKey: session.transcription_provider_key,
      transcriptionProviderConfig:
        session.transcription_provider_config as TranscriptionProviderConfig,
      endTimeUnixMs: session.end_time ? session.end_time.getTime() : null,
    };
  }

  /**
   * Returns the current join code for a session, rotating if close to expiry.
   * Only the session's source device may request this.
   */
  async getSessionJoinCode(
    deviceId: string,
    sessionId: string,
  ): Promise<{ joinCode: string; expiresAtUnixMs: number } | null> {
    const session =
      await this._sessionManagementRepository.findActiveSessionBySourceDevice(
        deviceId,
        sessionId,
      );

    if (!session) {
      this._log.warn(
        { deviceId, sessionId },
        'Session not found for join code request',
      );
      return null;
    }

    // Look up join code config from full session record
    const fullSession =
      await this._sessionManagementRepository.findSessionById(sessionId);

    if (fullSession?.join_code_length == null) {
      this._log.warn({ sessionId }, 'Join codes not enabled for session');
      return null;
    }

    const rotationEnabled = fullSession.join_code_rotation_enabled ?? true;

    if (rotationEnabled) {
      const result = await this._sessionJoinCodeRepository.getOrRotateJoinCode(
        sessionId,
        fullSession.join_code_length,
        generateRandomCode,
        JOIN_CODE_DURATION_MS,
        JOIN_CODE_ROTATION_THRESHOLD_MS,
      );

      if (!result) {
        // No valid codes exist, create a fresh one
        const now = new Date();
        const expiresAt = new Date(now.getTime() + JOIN_CODE_DURATION_MS);
        const code = generateRandomCode(fullSession.join_code_length);
        await this._sessionJoinCodeRepository.create(
          sessionId,
          code,
          now,
          expiresAt,
        );
        return { joinCode: code, expiresAtUnixMs: expiresAt.getTime() };
      }

      return {
        joinCode: result.code,
        expiresAtUnixMs: result.expiresAt.getTime(),
      };
    }

    // Rotation disabled: return existing code or create one that doesn't expire
    // until the session ends
    const existing =
      await this._sessionJoinCodeRepository.getLatestValidCode(sessionId);

    if (existing) {
      return {
        joinCode: existing.code,
        expiresAtUnixMs: existing.expires_at.getTime(),
      };
    }

    // No valid code, create a long-lived one
    const now = new Date();
    const expiresAt =
      fullSession.end_time ?? new Date(now.getTime() + 24 * 60 * 60 * 1_000);
    const code = generateRandomCode(fullSession.join_code_length);
    await this._sessionJoinCodeRepository.create(
      sessionId,
      code,
      now,
      expiresAt,
    );
    return { joinCode: code, expiresAtUnixMs: expiresAt.getTime() };
  }

  /**
   * Ends an active session immediately, updating the DB and publishing to Redis.
   */
  async endSession(sessionId: string): Promise<boolean> {
    const session =
      await this._sessionManagementRepository.findSessionById(sessionId);
    if (!session) {
      this._log.warn({ sessionId }, 'Session not found for end');
      return false;
    }

    const now = new Date();
    if (session.end_time && session.end_time <= now) {
      this._log.warn({ sessionId }, 'Session already ended');
      return false;
    }

    await this._sessionManagementRepository.endSession(
      sessionId,
      session.source_device_id,
      now,
    );

    await this._sessionRefreshTokenRepository.deleteBySessionId(sessionId);
    await this._sessionJoinCodeRepository.deleteBySessionId(sessionId);

    await this._redisPublisher.publish(
      {
        type: SessionChannelEventType.SESSION_END,
        endTimeUnixMs: now.getTime(),
      },
      sessionId,
    );

    return true;
  }

  /**
   * Returns current and upcoming sessions for a device.
   * Includes active sessions (end_time IS NULL) and sessions that ended
   * within the last hour, ordered by start_time ascending.
   */
  async getDeviceSessions(deviceId: string): Promise<
    Array<{
      sessionId: string;
      startTime: number;
      endTime: number | null;
      isActive: boolean;
    }>
  > {
    return await this._sessionManagementRepository.getDeviceSessions(deviceId);
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

  private _signShortLivedToken(
    sessionId: string,
    clientId: string,
    scopes: SessionTokenScope[],
  ): string {
    const exp = Math.floor(Date.now() / 1000) + JWT_LIFETIME_S;
    return this._jwtService.signSessionToken({
      sessionId,
      clientId,
      scopes,
      exp,
    });
  }

  private async _createRefreshToken(
    sessionId: string,
    scopes: SessionTokenScope[],
    authMethod: string,
  ): Promise<{ refreshTokenId: string; sessionRefreshToken: string }> {
    const secret = crypto
      .randomBytes(REFRESH_TOKEN_SECRET_LENGTH)
      .toString('hex');
    const secretHash = await this._hashService.hash(secret);

    const { id } = await this._sessionRefreshTokenRepository.create(
      sessionId,
      scopes,
      authMethod,
      null,
      secretHash,
    );

    return {
      refreshTokenId: id,
      sessionRefreshToken: `${id}${REFRESH_TOKEN_SEPARATOR}${secret}`,
    };
  }

  private _decodeRefreshToken(
    token: string,
  ): { id: string; secret: string } | null {
    const separatorIndex = token.indexOf(REFRESH_TOKEN_SEPARATOR);
    if (separatorIndex === -1) return null;
    return {
      id: token.slice(0, separatorIndex),
      secret: token.slice(separatorIndex + 1),
    };
  }
}
