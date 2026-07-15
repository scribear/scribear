import EventEmitter from 'eventemitter3';

import { NetworkError } from '@scribear/base-api-client';
import {
  type WebSocketClient,
  SchemaValidationError as WsSchemaValidationError,
} from '@scribear/base-websocket-client';
import { createNodeServerClient } from '@scribear/node-server-client';
import {
  type TRANSCRIPTION_STREAM_SCHEMA,
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';
import { createSessionManagerClient } from '@scribear/session-manager-client';
import type { TranscriptionSequenceInput } from '@scribear/transcription-content-store';

import {
  ClientLifecycle,
  JoinError,
  SessionConnectionStatus,
} from './client-session-service-status';

/**
 * Snapshot of the active session. Persisted in `localStorage` so the page can
 * resume without prompting the user for a join code again.
 */
export interface SessionIdentity {
  sessionUid: string;
  sessionRefreshToken: string;
  clientId: string;
}

/**
 * Body of the `sessionStatus` server message. Mirrors the kiosk app's snapshot
 * so the UI can render "waiting for source" / "transcription unavailable"
 * indicators consistently.
 */
export interface SessionStatusSnapshot {
  transcriptionServiceConnected: boolean;
  sourceDeviceConnected: boolean;
}

/**
 * Combined transcript payload emitted toward Redux. Matches the shape accepted
 * by `handleTranscript` in `@scribear/transcription-content-store`.
 */
interface TranscriptEvent {
  final: TranscriptionSequenceInput | null;
  inProgress: TranscriptionSequenceInput | null;
}

/**
 * Events emitted by {@link ClientSessionService} for the Redux middleware to
 * consume. One emit per state transition or external observation; selectors
 * elsewhere map these into the UX slice.
 */
interface ClientSessionServiceEvents {
  lifecycleChange: (lifecycle: ClientLifecycle) => void;
  sessionIdentity: (identity: SessionIdentity | null) => void;
  connectionStatus: (status: SessionConnectionStatus) => void;
  sessionStatus: (status: SessionStatusSnapshot) => void;
  transcript: (event: TranscriptEvent) => void;
  joinError: (error: JoinError | null) => void;
  error: (message: string | null) => void;
}

/**
 * Refresh the session token at half its remaining lifetime, applying ±10% of
 * the same window as jitter. Far enough ahead of expiry to absorb browser
 * timer throttling without burning a fresh token immediately.
 */
const TOKEN_REFRESH_FRACTION = 0.5;
const TOKEN_REFRESH_JITTER = 0.1;

/**
 * Compute a uniform jitter offset in `[-jitter * base, +jitter * base]`.
 */
function jitter(baseMs: number, fraction: number): number {
  const span = baseMs * fraction;
  return (Math.random() * 2 - 1) * span;
}

/**
 * Decode the `exp` claim of a JWT. Returns `null` if the token can't be
 * parsed (malformed or unsigned).
 */
function decodeJwtExpiryMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(atob(parts[1] ?? '')) as { exp?: number };
    if (typeof payload.exp !== 'number') return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/**
 * Manages the client device's session lifecycle - join-code exchange, session
 * resume on page load, per-session WebSocket transport, and token refresh -
 * per the client app specification. The class is owned by a Redux middleware
 * that translates {@link ClientSessionServiceEvents} into store updates;
 * React components only read the resulting UX slice.
 *
 * Internal state (session token, socket handle, refresh timer) lives on the
 * instance and is intentionally never reflected back into Redux. The only
 * persisted state is the {@link SessionIdentity} (refresh token, session UID,
 * client ID), which the middleware writes to localStorage via redux-remember.
 */
export class ClientSessionService extends EventEmitter<ClientSessionServiceEvents> {
  private readonly _sessionManagerClient: ReturnType<
    typeof createSessionManagerClient
  >;
  private readonly _nodeServerClient: ReturnType<typeof createNodeServerClient>;

  private _lifecycle: ClientLifecycle = ClientLifecycle.INITIALIZING;
  private _identity: SessionIdentity | null = null;

  private _sessionToken: string | null = null;
  private _socket: WebSocketClient<typeof TRANSCRIPTION_STREAM_SCHEMA> | null =
    null;
  private _tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Increments on every teardown to invalidate in-flight async work that
   * captured a stale view of the session.
   */
  private _epoch = 0;

  constructor() {
    super();
    const baseUrl = window.location.origin;
    this._sessionManagerClient = createSessionManagerClient(baseUrl);
    this._nodeServerClient = createNodeServerClient(baseUrl);
  }

  get lifecycle(): ClientLifecycle {
    return this._lifecycle;
  }

  /**
   * Begin the lifecycle. If a stored {@link SessionIdentity} is provided, the
   * service attempts to resume that session; otherwise it transitions straight
   * to {@link ClientLifecycle.IDLE}. Idempotent: calling again restarts
   * initialization from scratch.
   */
  start(stored: SessionIdentity | null): void {
    this._teardownActiveSession();
    this._setLifecycle(ClientLifecycle.INITIALIZING);

    if (stored === null) {
      this._enterIdle();
      return;
    }

    this._identity = stored;
    this._enterActive(stored);
  }

  /**
   * Tear down every active connection and timer. Leaves the service in
   * {@link ClientLifecycle.INITIALIZING} to signal that nothing is currently
   * driving it - useful for HMR cleanup.
   */
  stop(): void {
    this._teardownActiveSession();
    this._identity = null;
    this.emit('sessionIdentity', null);
    this._setLifecycle(ClientLifecycle.INITIALIZING);
  }

  /**
   * Submit a join code on behalf of the user. On success, transitions to
   * {@link ClientLifecycle.ACTIVE}; on failure, stays in
   * {@link ClientLifecycle.IDLE} and emits a {@link JoinError}.
   */
  async joinSession(joinCode: string): Promise<void> {
    this._teardownActiveSession();
    this._identity = null;
    this.emit('sessionIdentity', null);
    this.emit('joinError', null);

    const [response, error] =
      await this._sessionManagerClient.sessionAuth.exchangeJoinCode({
        body: { joinCode },
      });

    if (error instanceof NetworkError) {
      this.emit('joinError', JoinError.NETWORK_ERROR);
      this._setLifecycle(ClientLifecycle.IDLE);
      return;
    }
    if (error !== null) {
      this.emit('joinError', JoinError.UNKNOWN);
      this._setLifecycle(ClientLifecycle.IDLE);
      return;
    }

    if (response.status !== 200) {
      this.emit('joinError', this._joinErrorFromStatus(response.status));
      this._setLifecycle(ClientLifecycle.IDLE);
      return;
    }

    const identity: SessionIdentity = {
      sessionUid: response.data.sessionUid,
      sessionRefreshToken: response.data.sessionRefreshToken,
      clientId: response.data.clientId,
    };
    this._identity = identity;
    this.emit('sessionIdentity', identity);

    // Cache the freshly-issued session token so the first WebSocket connect
    // can skip the extra refresh round-trip.
    this._sessionToken = response.data.sessionToken;

    this._enterActive(identity);
  }

  /**
   * Disconnect from the current session and reset to {@link ClientLifecycle.IDLE}.
   * Persisted identity is cleared so a page reload won't try to resume.
   */
  leaveSession(): void {
    this._teardownActiveSession();
    this._identity = null;
    this.emit('sessionIdentity', null);
    this._enterIdle();
  }

  private _enterIdle(): void {
    this._setLifecycle(ClientLifecycle.IDLE);
  }

  private _enterActive(identity: SessionIdentity): void {
    const epoch = ++this._epoch;
    this._setLifecycle(ClientLifecycle.ACTIVE);
    this.emit('connectionStatus', SessionConnectionStatus.CONNECTING);
    this.emit('error', null);
    // If joinSession just primed us with a fresh session token, the first
    // _authenticateSocket call uses it directly; otherwise (resume flow) it
    // trades the refresh token for one before sending AUTH.
    this._connectSocket(identity, epoch);
  }

  private _connectSocket(identity: SessionIdentity, epoch: number): void {
    const socket = this._nodeServerClient.transcriptionStreamClient({
      params: { sessionUid: identity.sessionUid },
    });
    this._socket = socket;

    socket.on('stateChange', (to) => {
      if (epoch !== this._epoch) return;
      if (to === 'OPEN') {
        this.emit('connectionStatus', SessionConnectionStatus.CONNECTED);
      } else if (to === 'WAITING_RETRY') {
        this.emit('connectionStatus', SessionConnectionStatus.DISCONNECTED);
      } else if (to === 'CONNECTING' || to === 'HANDSHAKING') {
        this.emit('connectionStatus', SessionConnectionStatus.CONNECTING);
      }
    });

    socket.on('open', () => {
      if (epoch !== this._epoch) return;
      void this._authenticateSocket(identity, epoch);
    });

    socket.on('message', (msg) => {
      if (epoch !== this._epoch) return;
      switch (msg.type) {
        case TranscriptionStreamServerMessageType.AUTH_OK:
          // Auth acknowledged; transcript and status messages now flow on the
          // established channel.
          break;
        case TranscriptionStreamServerMessageType.TRANSCRIPT:
          this.emit('transcript', {
            final: msg.final,
            inProgress: msg.inProgress,
          });
          break;
        case TranscriptionStreamServerMessageType.SESSION_STATUS:
          this.emit('sessionStatus', {
            transcriptionServiceConnected: msg.transcriptionServiceConnected,
            sourceDeviceConnected: msg.sourceDeviceConnected,
          });
          break;
        case TranscriptionStreamServerMessageType.SESSION_ENDED:
          // The server will close the socket immediately after; the close
          // handler drives the transition to IDLE.
          break;
      }
    });

    socket.on('close', (code) => {
      if (epoch !== this._epoch) return;
      // 1000 = normal close (sessionEnded message received) - session is
      // over and the persisted identity should be cleared.
      if (code === 1000) {
        this.leaveSession();
        return;
      }
      // 1008 = auth failure. The cached session token was rejected; drop it
      // so the next reconnect attempt forces a fresh refresh-token exchange
      // before sending AUTH again. WebSocketClient handles the reconnect
      // backoff internally.
      if (code === 1008) {
        this._sessionToken = null;
      }
    });

    socket.on('error', (err) => {
      if (epoch !== this._epoch) return;
      if (err instanceof WsSchemaValidationError) {
        this.emit('error', 'Session stream protocol mismatch.');
        this.leaveSession();
      }
    });

    socket.start();
  }

  /**
   * Send the AUTH message on the freshly-opened socket. Re-runs after every
   * reconnect because the WebSocketClient re-emits `open` on each successful
   * underlying socket open.
   */
  private async _authenticateSocket(
    identity: SessionIdentity,
    epoch: number,
  ): Promise<void> {
    let token = this._sessionToken;
    if (token !== null && this._isTokenExpired(token)) token = null;

    if (token === null) {
      token = await this._refreshSessionToken(identity, epoch);
      if (epoch !== this._epoch) return;
      if (token === null) return;
      this._sessionToken = token;
    }

    if (this._socket === null) return;
    this._socket.send({
      type: TranscriptionStreamClientMessageType.AUTH,
      sessionToken: token,
    });
    this._scheduleTokenRefresh(identity, token, epoch);
  }

  /**
   * Trade the refresh token for a fresh session token. On a 401/409, the
   * session is unrecoverable - clear stored identity and fall back to IDLE.
   * On a transient failure, surface it to the UI but stay in ACTIVE so the
   * WebSocketClient's reconnect loop keeps trying.
   */
  private async _refreshSessionToken(
    identity: SessionIdentity,
    epoch: number,
  ): Promise<string | null> {
    const [response, error] =
      await this._sessionManagerClient.sessionAuth.refreshSessionToken({
        body: { sessionRefreshToken: identity.sessionRefreshToken },
      });

    if (epoch !== this._epoch) return null;

    if (error instanceof NetworkError) {
      this.emit('error', 'Network error - retrying.');
      return null;
    }
    if (error !== null) {
      this.emit('error', 'Failed to refresh session token.');
      return null;
    }

    switch (response.status) {
      case 200:
        this.emit('error', null);
        return response.data.sessionToken;
      // 401 INVALID_REFRESH_TOKEN or 409 SESSION_ENDED: refresh token is no
      // longer usable. Drop the stored identity and return to IDLE so the
      // user can join a new session.
      case 401:
      case 409:
        this.leaveSession();
        return null;
      default:
        this.emit('error', 'Failed to refresh session token.');
        return null;
    }
  }

  private _scheduleTokenRefresh(
    identity: SessionIdentity,
    token: string,
    epoch: number,
  ): void {
    if (this._tokenRefreshTimer !== null) {
      clearTimeout(this._tokenRefreshTimer);
      this._tokenRefreshTimer = null;
    }

    const expiryMs = decodeJwtExpiryMs(token);
    if (expiryMs === null) return;

    const remainingMs = expiryMs - Date.now();
    if (remainingMs <= 0) {
      void this._refreshAndReauth(identity, epoch);
      return;
    }

    const baseDelay = remainingMs * TOKEN_REFRESH_FRACTION;
    const delayMs = Math.max(
      0,
      baseDelay + jitter(baseDelay, TOKEN_REFRESH_JITTER),
    );
    this._tokenRefreshTimer = setTimeout(() => {
      this._tokenRefreshTimer = null;
      void this._refreshAndReauth(identity, epoch);
    }, delayMs);
  }

  /**
   * Triggered by the refresh timer. Fetches a new token and sends a fresh
   * AUTH message on the existing socket - the connection continues
   * uninterrupted per the client app spec.
   */
  private async _refreshAndReauth(
    identity: SessionIdentity,
    epoch: number,
  ): Promise<void> {
    if (epoch !== this._epoch) return;
    if (this._socket === null) return;

    const token = await this._refreshSessionToken(identity, epoch);
    if (epoch !== this._epoch) return;
    if (token === null) return;

    this._sessionToken = token;
    this._socket.send({
      type: TranscriptionStreamClientMessageType.AUTH,
      sessionToken: token,
    });
    this._scheduleTokenRefresh(identity, token, epoch);
  }

  private _isTokenExpired(token: string): boolean {
    const expiryMs = decodeJwtExpiryMs(token);
    if (expiryMs === null) return true;
    return expiryMs <= Date.now();
  }

  private _joinErrorFromStatus(status: number): JoinError {
    switch (status) {
      case 404:
        return JoinError.JOIN_CODE_NOT_FOUND;
      case 410:
        return JoinError.JOIN_CODE_EXPIRED;
      case 409:
        return JoinError.SESSION_NOT_CURRENTLY_ACTIVE;
      default:
        return JoinError.UNKNOWN;
    }
  }

  private _teardownActiveSession(): void {
    this._epoch++;
    if (this._tokenRefreshTimer !== null) {
      clearTimeout(this._tokenRefreshTimer);
      this._tokenRefreshTimer = null;
    }
    if (this._socket !== null) {
      this._socket.removeAllListeners();
      this._socket.terminate(1000, 'session-end');
      this._socket = null;
    }
    this._sessionToken = null;
  }

  private _setLifecycle(next: ClientLifecycle): void {
    if (next === this._lifecycle) return;
    this._lifecycle = next;
    this.emit('lifecycleChange', next);
  }
}
