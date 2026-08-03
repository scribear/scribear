import EventEmitter from 'eventemitter3';

import { ClockSync, encodeAudioFrame } from '@scribear/audio-frame-protocol';
import {
  InvalidResponseBodyError,
  NetworkError,
  UnexpectedResponseError,
} from '@scribear/base-api-client';
import {
  type LongPollClient,
  LongPollResponseError,
} from '@scribear/base-long-poll-client';
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
  type TranscriptionServiceDisconnectReason,
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
  /**
   * Present only when `transcriptionServiceConnected` is `false` and the
   * cause is known - today, `AT_CAPACITY` means the Transcription Service
   * explicitly refused the connection (close 1013) rather than it dropping
   * or crashing. Absent when connected, or when disconnected for an
   * undistinguished reason. Mirrors the wire field on `SESSION_STATUS`.
   */
  transcriptionServiceDisconnectReason?: TranscriptionServiceDisconnectReason;
}

/**
 * A user-visible failure, carrying the severity it should be reported with.
 *
 * The severity is decided here rather than in the store because only this
 * service knows whether it is still retrying: `'warning'` means degraded but
 * retrying (no action yet), `'error'` means nothing is retrying and a human
 * has to do something. Conflating the two is what let a permanently-rejected
 * kiosk read the same as a five-second network blip.
 */
export interface KioskFault {
  severity: 'warning' | 'error';
  message: string;
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
  /**
   * Why the kiosk is degraded or stuck, or `null` to clear. Every value
   * emitted here reaches the wall, via the connection banner - this used to
   * be written to Redux and read by nothing, so `'Failed to fetch device
   * info.'` and `'Session stream protocol mismatch.'` were computed,
   * dispatched, stored, and never rendered.
   */
  error: (fault: KioskFault | null) => void;
  /**
   * Health of the schedule long-poll, which is a separate failure domain from
   * the session socket: it can be dead for hours while the panel calmly reads
   * "Inactive, waiting for a session to start." and no session ever starts.
   */
  scheduleSyncError: (fault: KioskFault | null) => void;
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
 * How often the source re-probes the node server's clock (Cristian's
 * algorithm) to keep the latency `sentAt` correction fresh against drift. The
 * first probe is sent immediately on connect so an estimate is available
 * within one round trip.
 */
const TIME_SYNC_INTERVAL_MS = 15_000;

/**
 * Cadence for re-fetching `getMyDevice`. Long because device-level changes
 * (rename, room reassignment, source flag flip) are infrequent operator
 * actions. The schedule long-poll already covers per-session changes; this
 * loop is purely the fallback for changes outside any active session.
 */
const DEVICE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Bounded retry budget for `exchange-device-token`, counted per session
 * rather than per attempt: a failed token fetch used to drop the kiosk to
 * `IDLE`, where schedule sync immediately rediscovered the same still-active
 * session and tried again, forever, with the panel reading "Inactive,
 * waiting for a session to start." the whole time. Counting across those
 * cycles is what makes the loop converge, and exhausting the budget is
 * terminal and visible.
 */
const MAX_TOKEN_FETCH_FAILURES = 5;
const TOKEN_FETCH_RETRY_BASE_MS = 500;
const TOKEN_FETCH_RETRY_MAX_MS = 5_000;

/**
 * How many consecutive 1008 closes to tolerate before declaring the session
 * terminal, when the close reason isn't one we recognise as permanent. A
 * merely-stale token also closes 1008 and is genuinely fixed by the refetch
 * on the next attempt, so a couple of retries are worth having; an unbounded
 * number is what turned a permanently-bad credential into a silent
 * ACTIVE-IDLE loop on a wall-mounted display.
 */
const MAX_CONSECUTIVE_AUTH_FAILURES = 3;

/**
 * Close reasons node-server sends with 1008 (see
 * `transcription-stream.auth.ts` / `.controller.ts`) that can never succeed
 * on a retry: the token was minted for a different session, or without the
 * scope this role needs, or this device's role is not allowed to send audio
 * at all. Reconnecting with a freshly-minted token reproduces all three
 * exactly, because they are properties of the device's configuration rather
 * than of the credential.
 *
 * The reason string does reach the browser - node-server passes it to
 * `socket.close(code, reason)`, so it rides in the close frame - but an empty
 * or unfamiliar reason is not treated as recoverable either:
 * {@link MAX_CONSECUTIVE_AUTH_FAILURES} bounds the unrecognised case
 * independently.
 */
const PERMANENT_AUTH_CLOSE_REASONS = new Set([
  'missing-scope',
  'session-mismatch',
  'binary-not-allowed-for-role',
]);

/**
 * How many consecutive schedule long-poll failures to absorb before saying so
 * on screen. The poll's own backoff is 1s/2s/4s..., so three failures is
 * roughly seven seconds of genuine outage - long enough not to flag a single
 * blip, short enough that "the schedule is not updating" is on the wall
 * within one lecture-hall attention span rather than never.
 */
const SCHEDULE_SYNC_DEGRADED_AFTER = 3;

/**
 * Compute a uniform jitter offset in `[-jitter * base, +jitter * base]`.
 */
function jitter(baseMs: number, fraction: number): number {
  const span = baseMs * fraction;
  return (Math.random() * 2 - 1) * span;
}

/**
 * Resolve after `ms`, so an async retry loop can back off without owning a
 * timer handle. Teardown is detected by the session-identity check that
 * follows every await, not by cancelling this.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decode a base64url string (the encoding used by JWT segments) to its raw
 * text. `atob` only accepts standard base64, so map the URL-safe alphabet
 * back first; `atob` itself tolerates the missing `=` padding.
 */
function base64UrlDecode(value: string): string {
  return atob(value.replaceAll('-', '+').replaceAll('_', '/'));
}

/** A ScribeAR session token has exactly two segments: payload, then HMAC. */
const SESSION_TOKEN_SEGMENTS = 2;

/**
 * Read the `exp` claim out of a session token. Returns `null` if the token
 * can't be parsed.
 *
 * A ScribeAR session token is NOT a JWT, despite looking like one: it is
 * `base64url(payloadJSON).base64url(HMAC-SHA256)` - **two** segments, payload
 * first (see session-manager's `SessionTokenService.sign`). This previously
 * read `parts[1]` as a JWT's payload would be, so it fed the raw HMAC
 * signature to `JSON.parse` and returned `null` for every token ever issued.
 * Nothing crashed, because both callers treat `null` as "unknown expiry" -
 * which silently meant `_scheduleTokenRefresh` never armed a proactive
 * refresh on any connection. A socket that stayed open never noticed (auth is
 * only checked at AUTH time, not continuously), but any reconnect after the
 * token's 5-minute lifetime - a tab reload, a network blip, a service
 * restart - presented the same stale, never-refreshed token and was closed
 * 1008 `token-expired`, dropping the source to IDLE with nothing surfaced.
 * client-webapp had the identical bug, fixed in `8ff4582`.
 *
 * The signature is not checked here; only session-manager and node-server
 * hold the signing key. This is a scheduling hint, not an authorization
 * decision - a tampered `exp` can only make this kiosk refresh at the wrong
 * time, never make a bad token acceptable.
 */
function decodeSessionTokenExpiryMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== SESSION_TOKEN_SEGMENTS) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[0] ?? '')) as {
      exp?: number;
    };
    if (typeof payload.exp !== 'number') return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/**
 * Outcome of one `exchange-device-token` call. A failure always carries the
 * reason it failed and whether retrying could ever help - the previous
 * `string | null` return threw both away, which is why session-manager being
 * down, an unreachable gateway, a 500, and a revoked device cookie were
 * indistinguishable to everyone including the operator. (`exchange-device-
 * token` has no rate limiter - see `session-auth.router.ts` - so a 429 is not
 * one of the outcomes this route can ever produce.)
 */
type TokenFetchResult =
  | { token: string }
  | { token: null; permanent: boolean; message: string };

/**
 * Turn a declared non-200 from `exchange-device-token` into a cause, an
 * audience, and a next action. `permanent` is the load-bearing part: it
 * decides whether the kiosk keeps retrying (and says "retrying") or stops and
 * asks for a human, and the two statuses that are permanent here are both
 * device *configuration* problems that no amount of reconnecting can resolve.
 */
function describeTokenFetchFailure(status: number): {
  permanent: boolean;
  message: string;
} {
  switch (status) {
    case 401:
      return {
        permanent: true,
        message:
          "This kiosk's registration is no longer valid, so it cannot join the session running in this room. Re-activate the device from the admin console.",
      };
    case 403:
      return {
        permanent: true,
        message:
          "This kiosk is not assigned to the room running this session, so it cannot join it. An administrator needs to check the device's room assignment.",
      };
    case 404:
      return {
        permanent: false,
        message:
          'This session no longer exists. Waiting for the schedule to catch up…',
      };
    case 409:
      return {
        permanent: false,
        message:
          'This session is not currently active. Waiting for the schedule to catch up…',
      };
    default:
      return {
        permanent: false,
        message: `The session service could not issue credentials (HTTP ${status.toString()}). Retrying…`,
      };
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
  private _clockSync = new ClockSync();
  private _timeSyncTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Consecutive-failure budgets for the current session. Deliberately *not*
   * reset by `_teardownActiveSession`, because the kiosk's own recovery path
   * for both failures is ACTIVE -> IDLE -> (schedule sync) -> ACTIVE: a
   * per-attempt counter would be refilled by the very loop it exists to
   * bound. They are keyed to the session uid instead, so a genuinely new
   * session starts with a full budget - see {@link _resetFailureBudget}.
   */
  private _failureBudgetSessionUid: string | null = null;
  private _tokenFetchFailures = 0;
  private _authFailures = 0;

  /** Consecutive schedule long-poll failures since the last good response. */
  private _schedulePollFailures = 0;

  /**
   * Set once the current session has been declared unrecoverable, to keep the
   * transition one-way until the session is torn down.
   */
  private _terminal = false;

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
    this._sendSourceState(false);
  }

  /**
   * Unmute outgoing audio. Subsequent chunks are forwarded again.
   */
  unmute(): void {
    this._muted = false;
    this._sendSourceState(true);
  }

  /**
   * Send the current mic state to the node server so the fleet dashboard can
   * distinguish "mic is off" from "something broke" when no audio arrives.
   * No-op when no socket is connected (the state will be seeded on the next
   * AUTH_OK). Safe to call from `mute`/`unmute` which may fire before a
   * socket exists.
   */
  private _sendSourceState(
    microphoneActive: boolean,
    socket?: WebSocketClient<typeof TRANSCRIPTION_STREAM_SCHEMA>,
  ): void {
    const sock = socket ?? this._socket;
    if (sock === null) return;
    sock.send({
      type: TranscriptionStreamClientMessageType.SOURCE_STATE,
      microphoneActive,
    });
  }

  private async _initialize(): Promise<void> {
    const [response, error] =
      await this._sessionManagerClient.deviceManagement.getMyDevice({});

    if (error instanceof NetworkError) {
      this.emit('error', {
        severity: 'warning',
        message: 'Cannot reach the ScribeAR server. Retrying…',
      });
      this._scheduleInitRetry();
      return;
    }
    if (error instanceof UnexpectedResponseError) {
      this.emit('error', {
        severity: 'warning',
        message: `Failed to fetch device info (HTTP ${error.status.toString()}). Retrying…`,
      });
      this._scheduleInitRetry();
      return;
    }
    if (response === null) {
      this.emit('error', {
        severity: 'warning',
        message: 'Failed to fetch device info. Retrying…',
      });
      this._scheduleInitRetry();
      return;
    }

    if (response.status === 401) {
      // Not an error to report: the activation form this drops to is itself
      // the explanation, and it says what to do next.
      this.emit('error', null);
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
      // No HTTP status in the message: the narrowing collapse noted above
      // leaves `response.status` with no usable type here. The two device
      // failures an operator has to tell apart - unreachable and
      // rejected-with-a-status - are already distinguished by the two
      // branches above.
      this.emit('error', {
        severity: 'warning',
        message: 'Failed to fetch device info. Retrying…',
      });
      this._scheduleInitRetry();
      return;
    }

    // Whatever the last attempt complained about is now stale.
    this.emit('error', null);

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
    // Every fault this service reports is scoped to a session or to
    // initialization; arriving at IDLE means the session that carried the
    // explanation is gone, so leaving its message up would be describing
    // something that is no longer happening.
    this.emit('error', null);
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
    this._schedulePollFailures = 0;
    this.emit('scheduleSyncError', null);

    const poll = this._sessionManagerClient.scheduleManagement.mySchedule({});
    this._schedulePoll = poll;

    poll.on('data', (payload) => {
      this._schedulePollFailures = 0;
      this.emit('scheduleSyncError', null);
      // Refresh server-clock offset on every successful response so timer
      // computations track server time, not the device's clock.
      this._serverClockOffsetMs = Date.parse(payload.serverTime) - Date.now();
      this.emit('scheduleUpdated', payload.sessions);
      this._syncSchedule(payload.sessions);
    });
    poll.on('error', (err) => {
      // Retry and backoff are the long-poll client's job, so there is nothing
      // to *do* here - but there is something to say. Swallowing this
      // entirely meant schedule sync could be dead for hours behind
      // "Inactive, waiting for a session to start.", which is the same
      // sentence a healthy kiosk shows between lectures.
      this._schedulePollFailures++;
      if (this._schedulePollFailures < SCHEDULE_SYNC_DEGRADED_AFTER) return;
      this.emit('scheduleSyncError', {
        severity: 'warning',
        message: this._scheduleSyncMessage(err),
      });
    });

    poll.start();
  }

  /**
   * Name the schedule-sync failure specifically enough to be actionable:
   * unreachable (check the network/deployment) reads differently from a
   * server that is answering with a 500 (check session-manager).
   */
  private _scheduleSyncMessage(err: Error): string {
    const consequence =
      'Scheduled sessions may not start or end on time on this kiosk.';
    if (err instanceof NetworkError) {
      return `Cannot reach the ScribeAR schedule service. ${consequence}`;
    }
    // Checked before `UnexpectedResponseError`, which it extends. These are
    // statuses the route *declares*, so the server is up and answering - the
    // problem is this device, and only a human can fix it. Before the
    // long-poll client learned to treat a declared non-200 as a failure, these
    // bodies were emitted as if they were the schedule payload and the kiosk
    // showed nothing at all.
    if (err instanceof LongPollResponseError) {
      if (err.status === 401) {
        return `This kiosk's registration is no longer valid, so it has stopped receiving schedule updates. Re-activate the device from the admin console.`;
      }
      if (err.status === 404) {
        return `This kiosk is not assigned to a room, so it has no schedule. Assign it to a room from the admin console.`;
      }
    }
    if (err instanceof UnexpectedResponseError) {
      return `The schedule service is failing (HTTP ${err.status.toString()}). ${consequence}`;
    }
    return `Schedule updates have stopped arriving. ${consequence}`;
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
    this._resetFailureBudget(session.uid);
    this._activeSession = session;
    this._setLifecycle(KioskLifecycle.ACTIVE);
    this.emit('activeSession', { sessionUid: session.uid, name: session.name });
    this.emit('connectionStatus', SessionConnectionStatus.CONNECTING);

    const token = await this._acquireSessionToken(session);
    // A newer _enterActive / _enterIdle may have superseded this session while
    // the token request was in flight. If so, that flow now owns the socket
    // and token state - bail before clobbering it (and leaking a socket).
    if (this._activeSession !== session) return;
    // No token means `_acquireSessionToken` has already reported why and, if
    // it gave up, entered TERMINAL. Do not open a socket: doing so used to
    // reach OPEN with nothing to authenticate with, so the banner closed and
    // the room read as connected for the five seconds until node-server's
    // auth watchdog closed it - then did the whole thing again.
    if (token === null) return;
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

  /**
   * Reset the per-session failure budgets, but only when this really is a
   * different session. `_enterActive` runs again for the *same* session every
   * time schedule sync rediscovers it after a drop to IDLE, which is exactly
   * the loop the budgets bound - refilling them there would make them
   * unbounded again.
   */
  private _resetFailureBudget(sessionUid: string): void {
    if (this._failureBudgetSessionUid === sessionUid) return;
    this._failureBudgetSessionUid = sessionUid;
    this._tokenFetchFailures = 0;
    this._authFailures = 0;
  }

  /**
   * Obtain a session token for `session`, retrying transient failures with
   * exponential backoff and reporting the cause while it does. Returns `null`
   * if the attempt was superseded (a newer session took over), if the failure
   * can never succeed on a retry, or if the budget ran out - the latter two
   * having entered TERMINAL on the way out.
   */
  private async _acquireSessionToken(session: Session): Promise<string | null> {
    for (;;) {
      const result = await this._fetchSessionToken(session.uid);
      if (this._isSuperseded(session)) return null;

      if (result.token !== null) {
        this._tokenFetchFailures = 0;
        this.emit('error', null);
        return result.token;
      }

      if (result.permanent) {
        this._enterTerminal({ severity: 'error', message: result.message });
        return null;
      }

      this._tokenFetchFailures++;
      if (this._tokenFetchFailures >= MAX_TOKEN_FETCH_FAILURES) {
        this._enterTerminal({
          severity: 'error',
          message: `${result.message} This kiosk has stopped retrying; an administrator needs to check the ScribeAR services.`,
        });
        return null;
      }

      // Say which failure this is while it is still retrying. The banner's
      // generic "Connection lost. Reconnecting…" cannot distinguish
      // session-manager being unreachable from a revoked device cookie, and
      // those want two different people to do two different things.
      this.emit('error', { severity: 'warning', message: result.message });

      const delayMs = Math.min(
        TOKEN_FETCH_RETRY_BASE_MS * 2 ** (this._tokenFetchFailures - 1),
        TOKEN_FETCH_RETRY_MAX_MS,
      );
      await sleep(delayMs + jitter(delayMs, TOKEN_REFRESH_JITTER));
      if (this._isSuperseded(session)) return null;
    }
  }

  /**
   * Whether an in-flight retry for `session` should abandon: a newer
   * `_enterActive`/`_enterIdle` took over, or the socket's close handler
   * declared this session terminal while we were awaiting. Both leave the
   * retry loop with nothing useful to do and no right to touch the state the
   * newer flow now owns.
   */
  private _isSuperseded(session: Session): boolean {
    return this._activeSession !== session || this._terminal;
  }

  private async _fetchSessionToken(
    sessionUid: string,
  ): Promise<TokenFetchResult> {
    const [response, error] =
      await this._sessionManagerClient.sessionAuth.exchangeDeviceToken({
        body: { sessionUid },
      });

    if (error !== null) {
      if (error instanceof NetworkError) {
        return {
          token: null,
          permanent: false,
          message: 'Cannot reach the ScribeAR session service. Retrying…',
        };
      }
      // Checked before the generic UnexpectedResponseError case below because
      // InvalidResponseBodyError *is* one (subclass) - order matters. No
      // structured body at all means a declared status arrived with nothing
      // readable behind it - most plausibly session-manager itself failing
      // partway through a response it had already started (a crash, an OOM
      // kill, an exception after headers were sent), or the connection
      // dropping mid-body. (Not nginx substituting its own error page: this
      // deployment's `infra/scribear-nginx/nginx.conf` sets no `error_page`/
      // `proxy_intercept_errors` on `/api/session-manager/`, so nginx only
      // ever supplies its own body when it can't reach session-manager at
      // all - and that arrives as an *undeclared* status, handled below,
      // never reaching a body-parse step in the first place.)
      if (error instanceof InvalidResponseBodyError) {
        return {
          token: null,
          permanent: false,
          message: `The session service is unreachable (HTTP ${error.status.toString()} with no readable response). Retrying…`,
        };
      }
      // Everything else `createEndpointClient` reports here is an undeclared
      // status: `exchange-device-token` has no rate limiter (see
      // `session-auth.router.ts`), so this is never a 429 - either a genuine
      // 502/503/504 that nginx synthesized itself because it could not reach
      // session-manager, or a JSON body that parsed but didn't match this
      // client's schema (version drift after a partial deploy). Both are
      // transient by construction; everything permanent here is a declared
      // status, handled below. A generic "could not issue credentials"
      // message covers both without guessing which one it is.
      return {
        token: null,
        permanent: false,
        message: `The session service could not issue credentials (HTTP ${error.status.toString()}). Retrying…`,
      };
    }

    if (response.status !== 200) {
      return { token: null, ...describeTokenFetchFailure(response.status) };
    }
    return { token: response.data.sessionToken };
  }

  private _connectSocket(session: Session, isSource: boolean): void {
    const factory = isSource
      ? this._nodeServerClient.transcriptionStreamSource
      : this._nodeServerClient.transcriptionStreamClient;

    const socket = factory(
      { params: { sessionUid: session.uid } },
      {
        // Authenticate in the handshake and wait for `authOk` before the client
        // reports OPEN. The node server closes the socket with 1008
        // `binary-before-auth` on any binary frame that arrives before auth has
        // completed, and completing it is not instant on the server side: the
        // first source on a session waits for `registerSource` to fetch the
        // session config. Sending `auth` from the `open` handler and starting
        // capture on the next line left that as a race the source lost whenever
        // the server was the slower of the two.
        //
        // Doing it here closes the race by construction rather than by timing:
        // `sendBinary` only reaches the socket once the client is OPEN, and the
        // client does not reach OPEN until this resolves. It also means every
        // reconnect re-authenticates with the current token, instead of relying
        // on the `open` handler to remember to.
        onHandshake: async (sender, messages) => {
          const sessionToken = this._sessionToken;
          if (sessionToken === null) {
            // Rejecting abandons this attempt and schedules a retry, which is
            // the truth. Returning - as this used to - resolved the handshake
            // without sending AUTH, so the client reported OPEN, the banner
            // closed, and the room read "connected" with no captions until
            // node-server's five-second auth watchdog closed the socket.
            throw new Error('No session token available for AUTH.');
          }
          sender.send({
            type: TranscriptionStreamClientMessageType.AUTH,
            sessionToken,
          });
          // Probe the clock now rather than waiting for `open`. The node server
          // answers `timeSyncPing` without auth, and the reply reaches the
          // normal `message` handler even mid-handshake, so firing it here buys
          // a full auth round trip - which on a cold session is however long
          // `registerSource` takes to fetch the config. That is the difference
          // between the first audio chunks carrying `sentAt` (and so reporting
          // end-to-end latency) and only the later ones doing so.
          if (isSource) {
            sender.send({
              type: TranscriptionStreamClientMessageType.TIME_SYNC_PING,
              t0: Date.now(),
            });
          }
          await new Promise<void>((resolve) => {
            const onMessage = (msg: {
              type: TranscriptionStreamServerMessageType;
            }) => {
              if (msg.type === TranscriptionStreamServerMessageType.AUTH_OK) {
                messages.off('message', onMessage);
                resolve();
              }
            };
            messages.on('message', onMessage);
          });
        },
      },
    );
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
      // Auth already completed in the handshake above, so reaching OPEN means
      // the server has accepted us and binary frames are safe to send.
      //
      // This fires again on every reconnect, so both calls below must be safe
      // to repeat: each replaces its predecessor rather than stacking a second
      // interval and a second live microphone stream on top of it.
      const sessionToken = this._sessionToken;
      if (sessionToken === null) return;
      this._scheduleTokenRefresh(sessionToken, session.uid);

      if (isSource) {
        this._startTimeSync(socket);
        void this._beginAudioCapture(socket);
        // Seed the server with the current mic state, so a muted kiosk reads as
        // muted on the dashboard rather than as a session that mysteriously
        // sends no audio. Reaching `open` means auth already succeeded, and a
        // reconnect re-seeds for free.
        this._sendSourceState(!this._muted, socket);
      }
    });

    socket.on('message', (msg) => {
      switch (msg.type) {
        case TranscriptionStreamServerMessageType.AUTH_OK:
          // Auth acknowledged - audio/transcripts flow on the established
          // channel. This is the only proof the credential was accepted, so
          // it is what clears the consecutive-1008 budget.
          this._authFailures = 0;
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
            // Under `exactOptionalPropertyTypes`, an explicit `undefined`
            // isn't interchangeable with an omitted key - spread it in only
            // when the publisher actually sent it.
            ...(msg.transcriptionServiceDisconnectReason !== undefined
              ? {
                  transcriptionServiceDisconnectReason:
                    msg.transcriptionServiceDisconnectReason,
                }
              : {}),
          });
          break;
        case TranscriptionStreamServerMessageType.SESSION_ENDED:
          // The server will close the socket immediately after; the close
          // handler below will drive the transition to IDLE.
          break;
        case TranscriptionStreamServerMessageType.TIME_SYNC_PONG:
          // Complete a clock-sync probe: t0 echoed from our ping, t1 the
          // server's clock, and now our receive time.
          this._clockSync.record(msg.t0, msg.t1, Date.now());
          break;
        case TranscriptionStreamServerMessageType.LATENCY_UPDATE:
          // The source device does not display latency; ignore.
          break;
      }
    });

    socket.on('close', (code, reason) => {
      // 1000 = normal close (sessionEnded), 1008 = auth failure.
      if (code === 1000) {
        void this._enterIdle();
      } else if (code === 1008) {
        // Auth failed - the session token was rejected. Dropping to IDLE and
        // letting schedule sync rediscover the session is the right move for
        // a token that was merely stale, and the wrong move forever for one
        // that was rejected for a reason a fresh token cannot change: the
        // kiosk re-entered ACTIVE, was closed 1008 again, and looped with the
        // panel reading "Inactive, waiting for a session to start." between
        // cycles. So the reason is inspected, and the unrecognised case is
        // bounded rather than trusted.
        this._authFailures++;
        if (PERMANENT_AUTH_CLOSE_REASONS.has(reason)) {
          this._enterTerminal({
            severity: 'error',
            message:
              'This kiosk is not permitted to join the session running in this room. An administrator needs to check its role and room assignment.',
          });
          return;
        }
        if (this._authFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
          this._enterTerminal({
            severity: 'error',
            message: `The session refused this kiosk's credentials ${this._authFailures.toString()} times in a row${reason === '' ? '' : ` (${reason})`}. An administrator needs to check this device and the ScribeAR services.`,
          });
          return;
        }
        void this._enterIdle();
      }
      // Other codes trigger automatic reconnection inside WebSocketClient.
      // Note 1013 ("at capacity") never appears as `code` here - it is not
      // even declared in this route's closeCodes (this socket is
      // node-server<->kiosk; 1013 only ever closes node-server's own
      // upstream link to the Transcription Service, a different schema/
      // route entirely). That refusal reaches this app only indirectly, via
      // `transcriptionServiceDisconnectReason` on the `SESSION_STATUS`
      // message, consumed by `deriveConnectionBanner` - so no extra branch
      // is needed on the socket itself.
      // itself.
    });

    socket.on('error', (err) => {
      if (err instanceof WsSchemaValidationError) {
        // Kiosk and node-server disagree about the wire format - schema drift
        // after a partial deploy. Reconnecting cannot fix it, and dropping to
        // IDLE (as this used to) threw the explanation away along with the
        // session: the panel went back to "Inactive, waiting for a session to
        // start." and the message reached nothing, because nothing read it.
        this._enterTerminal({
          severity: 'error',
          message:
            'Session stream protocol mismatch: this kiosk is running a different version from the server. Reload this page; if that does not help, it needs redeploying.',
        });
      }
    });

    socket.start();
  }

  /**
   * Periodically probe the node server's clock so `sentAt` on audio frames can
   * be corrected into the server's clock domain (see {@link _clockSync}). The
   * first probe fires immediately; subsequent ones on an interval.
   */
  private _startTimeSync(
    socket: WebSocketClient<typeof TRANSCRIPTION_STREAM_SCHEMA>,
  ): void {
    const sendPing = () => {
      if (this._socket !== socket) return;
      socket.send({
        type: TranscriptionStreamClientMessageType.TIME_SYNC_PING,
        t0: Date.now(),
      });
    };
    sendPing();
    // Replace rather than stack: this runs again on every reconnect, and a
    // leaked interval would keep pinging on behalf of a dead socket forever.
    if (this._timeSyncTimer !== null) clearInterval(this._timeSyncTimer);
    this._timeSyncTimer = setInterval(sendPing, TIME_SYNC_INTERVAL_MS);
  }

  private async _beginAudioCapture(
    socket: WebSocketClient<typeof TRANSCRIPTION_STREAM_SCHEMA>,
  ): Promise<void> {
    // A reconnect calls this again. The previous stream captured the previous
    // socket handle, so its chunks are already discarded by the identity check
    // below - but it is still an open AudioContext with a live worklet, and
    // leaving one behind per reconnect leaks them for the life of the page.
    if (this._audioStream !== null) {
      this._microphoneService.closeAudioStream(this._audioStream);
      this._audioStream = null;
    }

    const stream = await this._microphoneService.getAudioStream(
      AUDIO_CHANNELS,
      AUDIO_SAMPLE_RATE,
      AUDIO_CHUNK_MS,
      (buffer) => {
        if (this._socket !== socket) return;
        if (this._muted) return;
        // Frame each chunk with a correlation id and, once the clock offset is
        // known, a server-domain send time so the node server can measure
        // end-to-end latency. Until the first clock-sync probe completes we
        // omit `sentAt` (the node still reports skew-free pipeline latency).
        const chunkId = crypto.randomUUID();
        const sentAt = this._clockSync.toRemote(Date.now());
        const fields = sentAt !== null ? { chunkId, sentAt } : { chunkId };
        const frame = encodeAudioFrame(fields, new Uint8Array(buffer));
        socket.sendBinary(frame.buffer as ArrayBuffer);
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

    const expiryMs = decodeSessionTokenExpiryMs(token);
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
    const socket = this._socket;
    if (socket === null) return;
    const session = this._activeSession;
    if (session?.uid !== sessionUid) return;

    const token = await this._acquireSessionToken(session);
    // Re-check after the await: teardown or a session switch may have swapped
    // or dropped the socket while the token request was in flight. Comparing
    // against the captured handle catches both (null, or a different socket).
    if (this._socket !== socket) return;
    // Retrying and giving up are `_acquireSessionToken`'s job. The socket is
    // still open and still authenticated on the *old* token, so there is
    // nothing to tear down here - dropping to IDLE on the first transient
    // failure, as this used to, threw away a working connection.
    if (token === null) return;
    this._sessionToken = token;
    socket.send({
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

  /**
   * Declare the current session unrecoverable: stop every retry loop, close
   * the socket, and say - with the cause and the next action - that this
   * kiosk has stopped trying.
   *
   * Deliberately keeps {@link KioskLifecycle.ACTIVE} and the active-session
   * identity, unlike {@link _teardownActiveSession}: the captions already on
   * the wall stay up, the panel keeps naming the session, and the banner has
   * somewhere to render. Dropping to IDLE instead would replace the
   * explanation with "Inactive, waiting for a session to start." - a
   * reassuring sentence that would be false.
   *
   * The join-code refresh is left running on purpose. It is a separate REST
   * loop against session-manager, and a room whose kiosk cannot join the
   * session can still have an audience joining it on their own devices.
   *
   * One-way until the session is torn down; `_teardownActiveSession` clears
   * it, so the next session (or this one ending) starts fresh.
   */
  private _enterTerminal(fault: KioskFault): void {
    if (this._terminal) return;
    this._terminal = true;
    this._stopSessionTransport();
    this.emit('error', fault);
    this.emit('connectionStatus', SessionConnectionStatus.TERMINAL);
  }

  /**
   * Stop everything carrying this session's audio and transcripts - socket,
   * capture, clock sync, token refresh - while leaving the session's identity
   * and join code alone. Split out of {@link _teardownActiveSession} so
   * {@link _enterTerminal} can stop the transport without also erasing the
   * session the user is being told about.
   */
  private _stopSessionTransport(): void {
    if (this._tokenRefreshTimer !== null) {
      clearTimeout(this._tokenRefreshTimer);
      this._tokenRefreshTimer = null;
    }
    if (this._timeSyncTimer !== null) {
      clearInterval(this._timeSyncTimer);
      this._timeSyncTimer = null;
    }
    this._clockSync.reset();
    if (this._audioStream !== null) {
      this._microphoneService.closeAudioStream(this._audioStream);
      this._audioStream = null;
    }
    if (this._socket !== null) {
      this._socket.removeAllListeners();
      this._socket.terminate(1000, 'session-end');
      this._socket = null;
    }
    this._sessionToken = null;
  }

  private _teardownActiveSession(): void {
    this._stopSessionTransport();
    if (this._joinCodeRefreshTimer !== null) {
      clearTimeout(this._joinCodeRefreshTimer);
      this._joinCodeRefreshTimer = null;
    }
    this._terminal = false;
    if (this._activeSession !== null) {
      this._activeSession = null;
      this.emit('activeSession', null);
    }
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
    // A full restart (start/stop, or a device change) is the one thing that
    // legitimately refills every budget: nothing about the previous device,
    // room, or session is still being retried.
    this._failureBudgetSessionUid = null;
    this._tokenFetchFailures = 0;
    this._authFailures = 0;
    this._schedulePollFailures = 0;
    this._teardownActiveSession();
  }

  private _setLifecycle(next: KioskLifecycle): void {
    if (next === this._lifecycle) return;
    this._lifecycle = next;
    this.emit('lifecycleChange', next);
  }
}
