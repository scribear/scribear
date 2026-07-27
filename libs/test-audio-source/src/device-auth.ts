import { DEVICE_TOKEN_COOKIE_NAME } from '@scribear/session-manager-schema';

/**
 * Session-manager calls a synthetic source device makes on its own behalf.
 *
 * These are deliberately hand-rolled `fetch` calls rather than
 * `@scribear/session-manager-client`. The device credential is an HTTP
 * *cookie*, and a synthetic source is a headless process with no cookie jar;
 * sending the header explicitly is clearer than teaching the shared client
 * about a jar it exists to avoid. There are only two calls.
 *
 * SECURITY: the holder authenticates as a **registered device**, holding
 * nothing but that device's token. It deliberately does not hold
 * `ADMIN_API_KEY` (which would let it create and destroy sessions in any room)
 * or `SESSION_TOKEN_SIGNING_KEY` (which would let it forge a token for any
 * session in the fleet). A synthetic audio source that could mint arbitrary
 * credentials would be a far larger liability than anything it exists to
 * detect. The cost of that choice is a one-time manual device registration.
 *
 * That restriction is also the whole safety boundary for these devices: a
 * device token reaches only the room its device is registered to, so the
 * device-to-room assignment made at provisioning time decides — permanently
 * and by construction — which room synthetic audio can ever reach.
 */

/** A session token plus the scopes it actually carries. */
export interface SessionCredentials {
  sessionToken: string;
  scopes: string[];
  expiresAtMs: number;
}

/** Raised when the device token cannot be exchanged for a session token. */
export class DeviceAuthError extends Error {
  /** HTTP status from session-manager, or null if the request never completed. */
  readonly status: number | null;
  /** Machine-readable code from the error body, when present. */
  readonly code: string | null;

  constructor(message: string, status: number | null, code: string | null) {
    super(message);
    this.name = 'DeviceAuthError';
    this.status = status;
    this.code = code;
  }
}

/** Raised when there is no session to attach to. Handled, not alerted. */
export class NoActiveSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoActiveSessionError';
  }
}

export interface DeviceAuthConfig {
  sessionManagerBaseUrl: string;
  /** The device's `DEVICE_TOKEN` cookie value, `{deviceUid}:{secret}`. */
  deviceToken: string;
  /** Per-request timeout. */
  timeoutMs: number;
}

interface ScheduleSession {
  uid: string;
  /** `COALESCE(startOverride, scheduledStartTime)`. */
  effectiveStart: string;
  /** `COALESCE(endOverride, scheduledEndTime)`; null means open-ended. */
  effectiveEnd: string | null;
}

/**
 * Reads the device's own room schedule and mints session tokens.
 */
export class DeviceAuthClient {
  private _config: DeviceAuthConfig;

  // The parameter name must match the Awilix registration key exactly: the
  // container runs in CLASSIC mode and resolves by parameter NAME, so calling
  // this `config` would fail at resolution time — and only in tests that boot
  // the real container, never in ones that construct this class directly.
  constructor(deviceAuthConfig: DeviceAuthConfig) {
    this._config = deviceAuthConfig;
  }

  /**
   * Finds the session currently active in this device's room.
   *
   * Uses the device's own `my-schedule` view, so the holder can only ever see
   * — and therefore only ever stream into — the room it is registered to. That
   * is the structural guarantee that a synthetic source cannot inject audio
   * into a real lecture: it has no way to name another room's session.
   *
   * @throws {NoActiveSessionError} when nothing is running right now.
   */
  async findActiveSession(nowMs: number = Date.now()): Promise<string> {
    // sinceVersion=0 makes the long poll return the current schedule
    // immediately rather than blocking until the next change.
    const response = await this._request(
      '/api/session-manager/v1/schedule-management/my-schedule?sinceVersion=0',
      { method: 'GET' },
    );

    if (response.status === 404) {
      throw new NoActiveSessionError(
        'This device is not assigned to a room. Add it to its dedicated room in the admin UI.',
      );
    }
    if (response.status === 204) {
      throw new NoActiveSessionError(
        'Schedule unchanged and no session listed.',
      );
    }
    if (!response.ok) {
      throw await this._toAuthError(response, 'fetch device schedule');
    }

    const body = (await response.json()) as { sessions?: ScheduleSession[] };
    const sessions = body.sessions ?? [];
    const active = sessions.find((session) => {
      const start = Date.parse(session.effectiveStart);
      if (!Number.isFinite(start) || start > nowMs) return false;
      // A null `effectiveEnd` is an open-ended session, which is exactly how a
      // standing test-room session is configured — treat it as still running
      // rather than skipping it for having no end.
      if (session.effectiveEnd === null) return true;
      const end = Date.parse(session.effectiveEnd);
      return Number.isFinite(end) && nowMs < end;
    });

    if (active === undefined) {
      throw new NoActiveSessionError(
        "No session is currently active in this device's room.",
      );
    }
    return active.uid;
  }

  /**
   * Reads the room this device belongs to.
   *
   * Not needed to stream — {@link findActiveSession} already confines the
   * device to it — but worth surfacing: the room assignment *is* the safety
   * boundary, and an operator about to press "start" on a synthetic audio
   * source should be able to read the name of the room it will reach off the
   * screen rather than infer it from a provisioning script they ran once.
   *
   * @throws {NoActiveSessionError} when the device is in no room at all.
   */
  async findMyRoom(): Promise<{ uid: string; name: string }> {
    const response = await this._request(
      '/api/session-manager/v1/room-management/get-my-room',
      { method: 'GET' },
    );

    if (response.status === 404) {
      throw new NoActiveSessionError(
        'This device is not assigned to a room, so it has nowhere to stream.',
      );
    }
    if (!response.ok) {
      throw await this._toAuthError(response, 'read the device room');
    }

    const body = (await response.json()) as { uid: string; name: string };
    return { uid: body.uid, name: body.name };
  }

  /** Exchanges the device token for a short-lived session token. */
  async mintSessionToken(sessionUid: string): Promise<SessionCredentials> {
    const response = await this._request(
      '/api/session-manager/v1/session-auth/exchange-device-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionUid }),
      },
    );

    if (response.status === 409) {
      throw new NoActiveSessionError(
        'Session is no longer active; it ended between discovery and token exchange.',
      );
    }
    if (!response.ok) {
      throw await this._toAuthError(response, 'exchange device token');
    }

    const body = (await response.json()) as {
      sessionToken: string;
      sessionTokenExpiresAt: string;
      scopes: string[];
    };
    return {
      sessionToken: body.sessionToken,
      scopes: body.scopes,
      expiresAtMs: Date.parse(body.sessionTokenExpiresAt),
    };
  }

  private async _request(path: string, init: RequestInit): Promise<Response> {
    const url = `${this._config.sessionManagerBaseUrl}${path}`;
    // Built via Headers rather than object spread so any HeadersInit shape the
    // caller passes is merged correctly.
    const headers = new Headers(init.headers);
    headers.set(
      'cookie',
      `${DEVICE_TOKEN_COOKIE_NAME}=${this._config.deviceToken}`,
    );
    try {
      return await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this._config.timeoutMs),
      });
    } catch (err) {
      throw new DeviceAuthError(
        `Could not reach session-manager: ${err instanceof Error ? err.message : String(err)}`,
        null,
        null,
      );
    }
  }

  private async _toAuthError(
    response: Response,
    action: string,
  ): Promise<DeviceAuthError> {
    const body: unknown = await response.json().catch(() => null);
    const code =
      typeof body === 'object' && body !== null && 'code' in body
        ? String(body.code)
        : null;
    return new DeviceAuthError(
      `Failed to ${action}: HTTP ${String(response.status)}${code === null ? '' : ` (${code})`}.`,
      response.status,
      code,
    );
  }
}
