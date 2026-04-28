import EventEmitter from 'eventemitter3';

import {
  NetworkError,
  UnexpectedResponseError,
} from '@scribear/base-api-client';
import { type LongPollClient } from '@scribear/base-long-poll-client';
import {
  type WebSocketClient,
  SchemaValidationError as WsSchemaValidationError,
} from '@scribear/base-websocket-client';
import type {
  AudioStream,
  MicrophoneService,
} from '@scribear/microphone-store';
import { createNodeServerClient } from '@scribear/node-server-client';
import {
  type TRANSCRIPTION_STREAM_SCHEMA,
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';
import { createSessionManagerClient } from '@scribear/session-manager-client';
import {
  MY_SCHEDULE_SCHEMA,
  type Session,
} from '@scribear/session-manager-schema';
import type { TranscriptionSequenceInput } from '@scribear/transcription-content-store';

import {
  KioskLifecycle,
  SessionConnectionStatus,
} from './kiosk-service-status';

/**
 * Stored shape of a join code returned by `fetch-join-code`. Mirrors the
 * `JOIN_CODE_ENTRY_SCHEMA` so it can be passed straight to the UI.
 */
export interface JoinCodeEntry {
  joinCode: string;
  validStart: string;
  validEnd: string;
}

/**
 * Combined transcript payload emitted toward Redux. Matches the shape
 * accepted by `handleTranscript` in `@scribear/transcription-content-store`.
 */
interface TranscriptEvent {
  final: TranscriptionSequenceInput | null;
  inProgress: TranscriptionSequenceInput | null;
}

/**
 * Snapshot of the device's own info, taken from `getMyDevice`.
 */
export interface DeviceInfo {
  uid: string;
  name: string;
  isSource: boolean;
}

/**
 * Snapshot of the device's room, taken from `getMyRoom`.
 */
export interface RoomInfo {
  uid: string;
  name: string;
  timezone: string;
}

/**
 * Body of the `sessionStatus` server message - whether the upstream
 * transcription service is currently connected and whether a source device
 * is currently streaming audio. Used by the UI to show "waiting for source"
 * or "transcription unavailable" indicators.
 */
export interface SessionStatusSnapshot {
  transcriptionServiceConnected: boolean;
  sourceDeviceConnected: boolean;
}

/**
 * Events emitted by {@link KioskService} for the Redux middleware to consume.
 * One emit per state transition or external observation; selectors elsewhere
 * map these into the UX store.
 */
interface KioskServiceEvents {
  lifecycleChange: (lifecycle: KioskLifecycle) => void;
  deviceInfo: (device: DeviceInfo | null) => void;
  roomInfo: (room: RoomInfo | null) => void;
  scheduleUpdated: (sessions: Session[]) => void;
  activeSession: (info: { sessionUid: string; name: string } | null) => void;
  connectionStatus: (status: SessionConnectionStatus) => void;
  sessionStatus: (status: SessionStatusSnapshot) => void;
  transcript: (event: TranscriptEvent) => void;
  joinCode: (
    codes: { current: JoinCodeEntry; next: JoinCodeEntry | null } | null,
  ) => void;
  registrationError: (message: string | null) => void;
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
 * Same fractional schedule as the session token: refresh the displayed join
 * code halfway through its window, with ±10% jitter.
 */
const JOIN_CODE_REFRESH_FRACTION = 0.5;
const JOIN_CODE_REFRESH_JITTER = 0.1;

/**
 * Audio capture parameters - 16 kHz mono with ~100 ms slices. Matches the
 * format whisper-streaming accepts; if other providers gain different
 * requirements they should be selected per-session in a follow-up.
 */
const AUDIO_CHANNELS = 1;
const AUDIO_SAMPLE_RATE = 16_000;
const AUDIO_CHUNK_MS = 100;

/**
 * Cap initialization retries so a brief network failure doesn't strand the
 * kiosk in `INITIALIZING` forever.
 */
const INIT_RETRY_DELAY_MS = 5_000;

/**
 * Cadence for re-fetching `getMyDevice`. Long because device-level changes
 * (rename, room reassignment, source flag flip) are infrequent operator
 * actions. The schedule long-poll already covers per-session changes; this
 * loop is purely the fallback for changes outside any active session.
 */
const DEVICE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

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
 * Server-derived state of a session relative to the corrected wall clock.
 */
type SessionRuntimeState = 'UPCOMING' | 'ACTIVE' | 'ENDED';

/**
 * Compute a session's current state from its `effectiveStart` /
 * `effectiveEnd` timestamps and the corrected "now" in epoch ms.
 *
 * Open-ended sessions (no `effectiveEnd`) never transition to `ENDED` from
 * timestamps alone; they end only when the server signals a `sessionEnd` or
 * removes them from the schedule.
 */
function computeSessionState(
  session: Session,
  nowMs: number,
): SessionRuntimeState {
  const startMs = Date.parse(session.effectiveStart);
  const endMs =
    session.effectiveEnd !== null ? Date.parse(session.effectiveEnd) : null;
  if (nowMs < startMs) return 'UPCOMING';
  if (endMs !== null && nowMs >= endMs) return 'ENDED';
  return 'ACTIVE';
}

/**
 * Manages the kiosk device's lifecycle - registration, schedule polling, and
 * per-session WebSocket transport - per the kiosk app specification. The
 * class is owned by a Redux middleware that translates {@link KioskServiceEvents}
 * into store updates; React components only read the resulting UX slice.
 *
 * Internal state (tokens, timers, socket handles, schedule cursor, clock
 * offset) lives on the instance and is intentionally never reflected back
 * into Redux - the only persisted credential is the `DEVICE_TOKEN` cookie,
 * managed by the browser.
 */
export class KioskService extends EventEmitter<KioskServiceEvents> {
  private readonly _microphoneService: MicrophoneService;
  private readonly _sessionManagerClient: ReturnType<
    typeof createSessionManagerClient
  >;
  private readonly _nodeServerClient: ReturnType<typeof createNodeServerClient>;

  private _lifecycle: KioskLifecycle = KioskLifecycle.INITIALIZING;
  private _device: DeviceInfo | null = null;
  private _room: RoomInfo | null = null;

  /**
   * Estimated `serverNowMs - clientNowMs`. Updated on every successful
   * `mySchedule` response so timer arithmetic uses server time, neutralising
   * device clock drift.
   */
  private _serverClockOffsetMs = 0;

  private _muted = true;

  private _initRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private _deviceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _schedulePoll: LongPollClient<typeof MY_SCHEDULE_SCHEMA> | null =
    null;
  private _sessionStartTimer: ReturnType<typeof setTimeout> | null = null;
  private _sessionEndTimer: ReturnType<typeof setTimeout> | null = null;

  private _activeSession: Session | null = null;
  private _socket: WebSocketClient<typeof TRANSCRIPTION_STREAM_SCHEMA> | null =
    null;
  private _audioStream: AudioStream | null = null;
  private _sessionToken: string | null = null;
  private _tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _joinCodeRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(microphoneService: MicrophoneService) {
    super();
    this._microphoneService = microphoneService;
    const baseUrl = window.location.origin;
    this._sessionManagerClient = createSessionManagerClient(baseUrl);
    this._nodeServerClient = createNodeServerClient(baseUrl);
  }

  get lifecycle(): KioskLifecycle {
    return this._lifecycle;
  }

  /**
   * Begin the lifecycle. Runs the `INITIALIZING` flow which decides between
   * `UNREGISTERED` and `IDLE` based on `getMyDevice`. Idempotent: calling
   * again restarts initialization from scratch.
   */
  start(): void {
    this._teardownAll();
    this._setLifecycle(KioskLifecycle.INITIALIZING);
    void this._initialize();
  }

  /**
   * Tear down every active connection, timer, and socket. Leaves the service
   * in `INITIALIZING` to signal that nothing is currently driving it.
   */
  stop(): void {
    this._teardownAll();
    this._setLifecycle(KioskLifecycle.INITIALIZING);
  }

  /**
   * Submit an activation code on behalf of the user. On success, restart the
   * initialization flow so the new `DEVICE_TOKEN` is picked up.
   */
  async activateDevice(activationCode: string): Promise<void> {
    this.emit('registrationError', null);

    const [response, error] =
      await this._sessionManagerClient.deviceManagement.activateDevice({
        body: { activationCode },
      });

    if (error instanceof NetworkError) {
      this.emit('registrationError', 'Network error - please try again.');
      return;
    }
    if (error instanceof UnexpectedResponseError) {
      this.emit(
        'registrationError',
        `Activation failed (HTTP ${error.status.toString()}).`,
      );
      return;
    }
    if (response === null) return;

    if (response.status === 200) {
      // Success - re-run initialization to pick up the new DEVICE_TOKEN cookie.
      this.start();
      return;
    }

    this.emit(
      'registrationError',
      this._activationErrorMessage(response.status),
    );
  }

  /**
   * Mute outgoing audio. Mic capture continues but no binary frames are
   * forwarded to the WebSocket. Display-only devices are unaffected.
   */
  mute(): void {
    this._muted = true;
  }

  /**
   * Unmute outgoing audio. Subsequent chunks are forwarded again.
   */
  unmute(): void {
    this._muted = false;
  }

  private async _initialize(): Promise<void> {
    const [response, error] =
      await this._sessionManagerClient.deviceManagement.getMyDevice({});

    if (error instanceof NetworkError) {
      this._scheduleInitRetry();
      return;
    }
    if (error instanceof UnexpectedResponseError) {
      this.emit('error', 'Failed to fetch device info.');
      this._scheduleInitRetry();
      return;
    }
    if (response === null) {
      this._scheduleInitRetry();
      return;
    }

    if (response.status === 401) {
      this._device = null;
      this.emit('deviceInfo', null);
      this._setLifecycle(KioskLifecycle.UNREGISTERED);
      return;
    }
    // TS narrows further based on STANDARD_ERROR_REPLIES (400/500/etc.) but
    // typescript-eslint's narrowing collapses to 200 here; explicit guard
    // keeps both happy and treats other declared error bodies as a retry.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (response.status !== 200) {
      this.emit('error', 'Failed to fetch device info.');
      this._scheduleInitRetry();
      return;
    }

    const { uid, name, roomUid, isSource } = response.data;
    if (roomUid === null || isSource === null) {
      // Activated but not yet assigned to a room - treat as IDLE with no
      // schedule. The schedule poll would 404, so skip it. The device
      // refresh loop is what eventually picks up a later room assignment.
      this._device = { uid, name, isSource: false };
      this.emit('deviceInfo', this._device);
      this._room = null;
      this.emit('roomInfo', null);
      this.emit('scheduleUpdated', []);
      this._setLifecycle(KioskLifecycle.IDLE);
      this._scheduleDeviceRefresh();
      return;
    }

    this._device = { uid, name, isSource };
    this.emit('deviceInfo', this._device);
    this._scheduleDeviceRefresh();
    await this._enterIdle();
  }

  private _scheduleInitRetry(): void {
    if (this._initRetryTimer !== null) clearTimeout(this._initRetryTimer);
    this._initRetryTimer = setTimeout(() => {
      this._initRetryTimer = null;
      void this._initialize();
    }, INIT_RETRY_DELAY_MS);
  }

  /**
   * Schedule a long-cadence re-fetch of `getMyDevice`. Catches operator-side
   * changes that don't surface through the schedule long-poll: room
   * reassignment, source/display flip, rename, or deactivation. Material
   * changes restart the lifecycle so the schedule poll picks up the new room;
   * cosmetic changes (just `name`) only re-emit `deviceInfo`.
   */
  private _scheduleDeviceRefresh(): void {
    if (this._deviceRefreshTimer !== null) {
      clearTimeout(this._deviceRefreshTimer);
    }
    this._deviceRefreshTimer = setTimeout(() => {
      this._deviceRefreshTimer = null;
      void this._refreshDeviceInfo();
    }, DEVICE_REFRESH_INTERVAL_MS);
  }

  private async _refreshDeviceInfo(): Promise<void> {
    const [response, error] =
      await this._sessionManagerClient.deviceManagement.getMyDevice({});

    // Network/transient errors: just retry on the next interval. We don't
    // tear anything down because the schedule long-poll and active socket
    // will surface their own connectivity issues independently.
    if (error instanceof NetworkError) {
      this._scheduleDeviceRefresh();
      return;
    }
    if (error instanceof UnexpectedResponseError) {
      this._scheduleDeviceRefresh();
      return;
    }
    if (response === null) {
      this._scheduleDeviceRefresh();
      return;
    }

    if (response.status === 401) {
      // Device was deactivated - drop everything and show the activation form.
      this._teardownAll();
      this._device = null;
      this.emit('deviceInfo', null);
      this._setLifecycle(KioskLifecycle.UNREGISTERED);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (response.status !== 200) {
      this._scheduleDeviceRefresh();
      return;
    }

    const { uid, name, roomUid, isSource } = response.data;
    const previous = this._device;
    const effectiveIsSource = roomUid === null ? false : (isSource ?? false);

    const deviceIdentityChanged = (previous?.uid ?? null) !== uid;
    const sourceChanged = previous?.isSource !== effectiveIsSource;
    const roomAssignmentChanged =
      (this._room?.uid ?? null) !== (roomUid ?? null);

    if (deviceIdentityChanged || sourceChanged || roomAssignmentChanged) {
      // Restart from scratch so the schedule poll re-binds to the new room
      // and any active socket is renegotiated with the correct role.
      this.start();
      return;
    }

    if (previous.name !== name) {
      this._device = { uid, name, isSource: effectiveIsSource };
      this.emit('deviceInfo', this._device);
    }
    this._scheduleDeviceRefresh();
  }

  private _activationErrorMessage(status: number): string {
    switch (status) {
      case 404:
        return 'Activation code not found.';
      case 410:
        return 'Activation code expired.';
      default:
        return `Activation failed (HTTP ${status.toString()}).`;
    }
  }

  private async _enterIdle(): Promise<void> {
    this._teardownActiveSession();
    this._setLifecycle(KioskLifecycle.IDLE);

    await this._fetchRoomInfo();
    this._startSchedulePoll();
  }

  private async _fetchRoomInfo(): Promise<void> {
    const [response, error] =
      await this._sessionManagerClient.roomManagement.getMyRoom({});

    if (error !== null || response.status !== 200) {
      this._room = null;
      this.emit('roomInfo', null);
      return;
    }
    this._room = {
      uid: response.data.uid,
      name: response.data.name,
      timezone: response.data.timezone,
    };
    this.emit('roomInfo', this._room);
  }

  private _startSchedulePoll(): void {
    this._schedulePoll?.close();

    const poll = this._sessionManagerClient.scheduleManagement.mySchedule({});
    this._schedulePoll = poll;

    poll.on('data', (payload) => {
      // Refresh server-clock offset on every successful response so timer
      // computations track server time, not the device's clock.
      this._serverClockOffsetMs = Date.parse(payload.serverTime) - Date.now();
      this.emit('scheduleUpdated', payload.sessions);
      this._syncSchedule(payload.sessions);
    });
    poll.on('error', () => {
      // Backoff is handled inside the long-poll client; nothing to do here.
    });

    poll.start();
  }

  /**
   * Run the kiosk-spec schedule sync algorithm against a freshly-fetched
   * session list:
   *
   * 1. If a session is currently `ACTIVE`, transition into it.
   * 2. If we were `ACTIVE` for a session that's no longer active, drop back
   *    to `IDLE`.
   * 3. Otherwise schedule a timer for the soonest `UPCOMING` session.
   */
  private _syncSchedule(sessions: Session[]): void {
    const nowMs = Date.now() + this._serverClockOffsetMs;

    let activeSession: Session | null = null;
    let nextUpcoming: Session | null = null;
    let nextUpcomingStartMs = Infinity;

    for (const session of sessions) {
      const state = computeSessionState(session, nowMs);
      if (state === 'ACTIVE') {
        activeSession = session;
      } else if (state === 'UPCOMING') {
        const startMs = Date.parse(session.effectiveStart);
        if (startMs < nextUpcomingStartMs) {
          nextUpcoming = session;
          nextUpcomingStartMs = startMs;
        }
      }
    }

    this._clearSessionStartTimer();
    this._clearSessionEndTimer();

    if (activeSession !== null) {
      const sameSession =
        this._activeSession !== null &&
        this._activeSession.uid === activeSession.uid;
      if (!sameSession) {
        void this._enterActive(activeSession);
      }
      this._armSessionEndTimer(activeSession, sessions, nowMs);
      return;
    }

    if (this._lifecycle === KioskLifecycle.ACTIVE) {
      // Active session disappeared from the schedule (deleted, ended, etc.).
      void this._enterIdle();
      return;
    }

    if (nextUpcoming !== null) {
      const delayMs = Math.max(0, nextUpcomingStartMs - nowMs);
      const upcoming = nextUpcoming;
      this._sessionStartTimer = setTimeout(() => {
        this._sessionStartTimer = null;
        // Re-resolve via a fresh sync so we use the latest schedule state.
        // The server may have moved or cancelled the session in the meantime.
        if (this._schedulePoll === null) return;
        this._syncSchedule([
          upcoming,
          ...sessions.filter((s) => s.uid !== upcoming.uid),
        ]);
      }, delayMs);
    }
  }

  /**
   * Defense-in-depth client-side timer mirroring the node server's
   * `effectiveEnd` timer. The server's `sessionEnded` + 1000 close is the
   * primary signal; this timer handles the case where the schedule update
   * arrives but the WS path is degraded (e.g. proxy keeping the connection
   * half-open). On fire, re-runs `_syncSchedule` so the session-state
   * computation drops the kiosk back to IDLE if the end has actually passed.
   */
  private _armSessionEndTimer(
    active: Session,
    sessions: Session[],
    nowMs: number,
  ): void {
    if (active.effectiveEnd === null) return;
    const endMs = Date.parse(active.effectiveEnd);
    const delayMs = endMs - nowMs;
    if (delayMs <= 0) return;
    this._sessionEndTimer = setTimeout(() => {
      this._sessionEndTimer = null;
      if (this._schedulePoll === null) return;
      this._syncSchedule(sessions);
    }, delayMs);
  }

  private _clearSessionStartTimer(): void {
    if (this._sessionStartTimer !== null) {
      clearTimeout(this._sessionStartTimer);
      this._sessionStartTimer = null;
    }
  }

  private _clearSessionEndTimer(): void {
    if (this._sessionEndTimer !== null) {
      clearTimeout(this._sessionEndTimer);
      this._sessionEndTimer = null;
    }
  }

  private async _enterActive(session: Session): Promise<void> {
    this._teardownActiveSession();
    this._activeSession = session;
    this._setLifecycle(KioskLifecycle.ACTIVE);
    this.emit('activeSession', { sessionUid: session.uid, name: session.name });
    this.emit('connectionStatus', SessionConnectionStatus.CONNECTING);

    const token = await this._fetchSessionToken(session.uid);
    if (token === null) {
      this.emit('connectionStatus', SessionConnectionStatus.DISCONNECTED);
      // Fall back to IDLE; the schedule poll will re-trigger if the session
      // is still active on the next cycle.
      void this._enterIdle();
      return;
    }
    this._sessionToken = token;

    const isSource = this._device?.isSource === true;
    this._connectSocket(session, isSource);

    // Kiosks are public-facing displays; both source and display kiosks show
    // the join code so people in the room can scan it to receive transcripts
    // on their own devices. Empty `joinCodeScopes` means the session opted
    // out of join codes entirely (e.g. private session) - skip the fetch.
    if (session.joinCodeScopes.length > 0) {
      void this._refreshJoinCode(session.uid);
    }
  }

  private async _fetchSessionToken(sessionUid: string): Promise<string | null> {
    const [response, error] =
      await this._sessionManagerClient.sessionAuth.exchangeDeviceToken({
        body: { sessionUid },
      });

    if (error !== null) return null;
    if (response.status !== 200) return null;
    return response.data.sessionToken;
  }

  private _connectSocket(session: Session, isSource: boolean): void {
    const factory = isSource
      ? this._nodeServerClient.transcriptionStreamSource
      : this._nodeServerClient.transcriptionStreamClient;

    const socket = factory({ params: { sessionUid: session.uid } });
    this._socket = socket;

    socket.on('stateChange', (to) => {
      if (to === 'OPEN') {
        this.emit('connectionStatus', SessionConnectionStatus.CONNECTED);
      } else if (to === 'WAITING_RETRY') {
        this.emit('connectionStatus', SessionConnectionStatus.DISCONNECTED);
      } else if (to === 'CONNECTING' || to === 'HANDSHAKING') {
        this.emit('connectionStatus', SessionConnectionStatus.CONNECTING);
      }
    });

    socket.on('open', () => {
      // Send the auth message once the socket is open. The server replies
      // with `authOk`; we just wait for it as part of the message stream.
      const sessionToken = this._sessionToken;
      if (sessionToken === null) return;
      socket.send({
        type: TranscriptionStreamClientMessageType.AUTH,
        sessionToken,
      });
      this._scheduleTokenRefresh(sessionToken, session.uid);

      if (isSource) void this._beginAudioCapture(socket);
    });

    socket.on('message', (msg) => {
      switch (msg.type) {
        case TranscriptionStreamServerMessageType.AUTH_OK:
          // Auth acknowledged. No further action needed - audio/transcripts
          // flow on the established channel.
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
          // handler below will drive the transition to IDLE.
          break;
      }
    });

    socket.on('close', (code) => {
      // 1000 = normal close (sessionEnded), 1008 = auth failure.
      if (code === 1000) {
        void this._enterIdle();
      } else if (code === 1008) {
        // Auth failed - session token may have been rejected. Drop to IDLE
        // and let schedule sync rediscover the session if it's still active.
        void this._enterIdle();
      }
      // Other codes trigger automatic reconnection inside WebSocketClient.
    });

    socket.on('error', (err) => {
      if (err instanceof WsSchemaValidationError) {
        this.emit('error', 'Session stream protocol mismatch.');
        void this._enterIdle();
      }
    });

    socket.start();
  }

  private async _beginAudioCapture(
    socket: WebSocketClient<typeof TRANSCRIPTION_STREAM_SCHEMA>,
  ): Promise<void> {
    const stream = await this._microphoneService.getAudioStream(
      AUDIO_CHANNELS,
      AUDIO_SAMPLE_RATE,
      AUDIO_CHUNK_MS,
      (buffer) => {
        if (this._socket !== socket) return;
        if (this._muted) return;
        socket.sendBinary(buffer);
      },
    );
    if (this._socket !== socket) {
      this._microphoneService.closeAudioStream(stream);
      return;
    }
    this._audioStream = stream;
  }

  private _scheduleTokenRefresh(token: string, sessionUid: string): void {
    if (this._tokenRefreshTimer !== null) {
      clearTimeout(this._tokenRefreshTimer);
      this._tokenRefreshTimer = null;
    }

    const expiryMs = decodeJwtExpiryMs(token);
    if (expiryMs === null) return;

    const remainingMs = expiryMs - Date.now();
    if (remainingMs <= 0) {
      // Already expired - refresh immediately.
      void this._refreshSessionToken(sessionUid);
      return;
    }

    const baseDelay = remainingMs * TOKEN_REFRESH_FRACTION;
    const delayMs = Math.max(
      0,
      baseDelay + jitter(baseDelay, TOKEN_REFRESH_JITTER),
    );
    this._tokenRefreshTimer = setTimeout(() => {
      this._tokenRefreshTimer = null;
      void this._refreshSessionToken(sessionUid);
    }, delayMs);
  }

  /**
   * Re-issue the session token by calling `exchange-device-token` again. The
   * device cookie is the stable credential; there is no separate refresh
   * token for device-authenticated sessions in the current schema.
   */
  private async _refreshSessionToken(sessionUid: string): Promise<void> {
    if (this._socket === null) return;
    if (this._activeSession?.uid !== sessionUid) return;

    const token = await this._fetchSessionToken(sessionUid);
    if (token === null) {
      // Refresh failed - drop the connection and let schedule sync recover.
      void this._enterIdle();
      return;
    }
    this._sessionToken = token;
    this._socket.send({
      type: TranscriptionStreamClientMessageType.AUTH,
      sessionToken: token,
    });
    this._scheduleTokenRefresh(token, sessionUid);
  }

  private async _refreshJoinCode(sessionUid: string): Promise<void> {
    if (this._joinCodeRefreshTimer !== null) {
      clearTimeout(this._joinCodeRefreshTimer);
      this._joinCodeRefreshTimer = null;
    }

    const [response, error] =
      await this._sessionManagerClient.sessionAuth.fetchJoinCode({
        body: { sessionUid },
      });

    if (this._activeSession?.uid !== sessionUid) return;

    if (error !== null || response.status !== 200) {
      this.emit('joinCode', null);
      return;
    }

    const { current, next } = response.data;
    this.emit('joinCode', { current, next });

    const validEndMs = Date.parse(current.validEnd);
    const remainingMs = validEndMs - Date.now();
    if (remainingMs <= 0) {
      // Already expired - re-fetch immediately to pick up the new current.
      void this._refreshJoinCode(sessionUid);
      return;
    }
    const baseDelay = remainingMs * JOIN_CODE_REFRESH_FRACTION;
    const delayMs = Math.max(
      0,
      baseDelay + jitter(baseDelay, JOIN_CODE_REFRESH_JITTER),
    );
    this._joinCodeRefreshTimer = setTimeout(() => {
      this._joinCodeRefreshTimer = null;
      void this._refreshJoinCode(sessionUid);
    }, delayMs);
  }

  private _teardownActiveSession(): void {
    if (this._tokenRefreshTimer !== null) {
      clearTimeout(this._tokenRefreshTimer);
      this._tokenRefreshTimer = null;
    }
    if (this._joinCodeRefreshTimer !== null) {
      clearTimeout(this._joinCodeRefreshTimer);
      this._joinCodeRefreshTimer = null;
    }
    if (this._audioStream !== null) {
      this._microphoneService.closeAudioStream(this._audioStream);
      this._audioStream = null;
    }
    if (this._socket !== null) {
      this._socket.removeAllListeners();
      this._socket.terminate(1000, 'session-end');
      this._socket = null;
    }
    if (this._activeSession !== null) {
      this._activeSession = null;
      this.emit('activeSession', null);
    }
    this._sessionToken = null;
    this.emit('joinCode', null);
  }

  private _teardownAll(): void {
    if (this._initRetryTimer !== null) {
      clearTimeout(this._initRetryTimer);
      this._initRetryTimer = null;
    }
    if (this._deviceRefreshTimer !== null) {
      clearTimeout(this._deviceRefreshTimer);
      this._deviceRefreshTimer = null;
    }
    this._clearSessionStartTimer();
    this._clearSessionEndTimer();
    if (this._schedulePoll !== null) {
      this._schedulePoll.removeAllListeners();
      this._schedulePoll.close();
      this._schedulePoll = null;
    }
    this._teardownActiveSession();
  }

  private _setLifecycle(next: KioskLifecycle): void {
    if (next === this._lifecycle) return;
    this._lifecycle = next;
    this.emit('lifecycleChange', next);
  }
}
