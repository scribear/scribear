import EventEmitter from 'eventemitter3';

import {
  InvalidResponseBodyError,
  NetworkError,
  UnexpectedResponseError,
} from '@scribear/base-api-client';
import {
  type WebSocketClient,
  SchemaValidationError as WsSchemaValidationError,
} from '@scribear/base-websocket-client';
import { createNodeServerClient } from '@scribear/node-server-client';
import {
  LatencyKind,
  type TRANSCRIPTION_STREAM_SCHEMA,
  type TranscriptionServiceDisconnectReason,
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';
import { createSessionManagerClient } from '@scribear/session-manager-client';
import type {
  LatencySample,
  TranscriptionSequenceInput,
} from '@scribear/transcription-content-store';

import {
  ClientLifecycle,
  JoinError,
  JoinNotice,
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
  // Present only when `transcriptionServiceConnected` is `false` and the
  // cause is known (today: the Transcription Service explicitly refused the
  // connection for being at capacity - close 1013). Absent when connected,
  // when disconnected for an undistinguished reason, or when the publisher
  // predates this field. Drives the wording of the connection-status banner.
  transcriptionServiceDisconnectReason?: TranscriptionServiceDisconnectReason;
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
  latency: (sample: LatencySample) => void;
  joinError: (error: JoinError | null) => void;
  /**
   * Why the join dialog is being shown, when the reason is not a failure, or
   * `null` to clear. Today the only value is "the session ended normally";
   * without it that case reopened the join dialog with nothing on it at all.
   */
  joinNotice: (notice: JoinNotice | null) => void;
  /**
   * Why this session is unrecoverable, or `null` to clear. Deliberately
   * narrow: it used to also carry transient blips ("Network error -
   * retrying.") that nothing rendered, which is how a session could hammer
   * session-manager once a second with the user seeing only "Reconnecting…".
   * Every value emitted here now reaches the user, via the connection
   * banner's terminal branch.
   */
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
 * Bounded retry budget for the session-token refresh, counted across
 * reconnects rather than per socket. A failed refresh means `_authenticateSocket`
 * never sends AUTH, node-server's 5 s watchdog closes the socket 1008
 * `auth-timeout`, and the reconnect lands in the same failed refresh - but
 * because the socket stayed open for those 5 s (longer than the transport's
 * `stableConnectionThresholdMs`) the backoff counter resets every cycle. The
 * result is an unbounded ~1 s hammer loop against session-manager that the
 * user only ever sees as "Reconnecting…". Counting consecutive failures
 * globally is what makes that loop converge: every cycle spends from the same
 * budget, and exhausting it is terminal and visible.
 */
const REFRESH_MAX_CONSECUTIVE_FAILURES = 5;
const REFRESH_RETRY_BASE_MS = 300;
const REFRESH_RETRY_MAX_MS = 2000;

/**
 * session-manager rate-limits `refresh-session-token` (and `exchange-join-code`)
 * per client IP using `@fastify/rate-limit`'s default store
 * (`LocalStore.incr`, see the package's `store/LocalStore.js`), which is a
 * **fixed window** counter, not a sliding one: a bucket starts on the IP's
 * first request in a window and every request within `timeWindow` of that
 * start counts against the same cap, however it's distributed in time. The
 * bucket does not partially drain - it stays fully "spent" until
 * `iterationStartMs + timeWindow` passes, at which point it resets all at
 * once. This client cannot see `iterationStartMs`, so it cannot know how much
 * of the current window is already behind it when a 429 first arrives.
 *
 * The window length itself is per-deployment config on the server
 * (`SessionAuthRateLimitConfig.refreshSessionTokenWindowMs`, an env var read
 * in session-manager's `app-config.ts`) - not a constant this client can read
 * or a value worth copying, since it can be retuned independently of this
 * code. What's stable enough to build a client-side heuristic on is the
 * *shipped default*, 60 seconds, which is also the number this feature's own
 * design doc uses when describing the limiter. Nothing here assumes a
 * specific request *count* (that number changes independently of the window
 * and this client never needs it).
 *
 * The generic exponential schedule above (300/600/1200/2000ms) burns the
 * entire {@link REFRESH_MAX_CONSECUTIVE_FAILURES} budget in about 4.5
 * seconds - many multiples faster than a fixed window still mid-cycle could
 * ever clear, so an overloaded lecture hall always exhausted its budget
 * within the *same* window it started in, then went terminal telling
 * everyone to "wait a minute" after its own retry loop had already given up
 * seconds earlier.
 *
 * Because the bucket's phase is unknown, no single wait can be timed
 * precisely - so when the most recent failure was specifically a 429 (see
 * `_refreshFailureCause`), retries are spread a quarter of the assumed
 * window apart instead of firing in the first few seconds: four delays of
 * {@link RATE_LIMIT_RETRY_DELAY_MS} spend the same 5-attempt budget across
 * roughly one window's duration, so at least one attempt is likely to land
 * after whatever reset boundary this IP's bucket actually has, rather than
 * gambling the whole budget on the first few seconds of it.
 *
 * This cannot use the `Retry-After` header the limiter sets (which *would*
 * name the real remaining time), because `createEndpointClient` returns only
 * `{status, data}` and discards response headers entirely - reading it would
 * require a `base-api-client` change. The default window length is the best
 * available substitute.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_RETRY_DELAY_MS = RATE_LIMIT_WINDOW_MS / 4;

/**
 * Statuses nginx synthesizes itself - never session-manager - when it cannot
 * reach or times out talking to it. Verified against this deployment's own
 * config: `infra/scribear-nginx/nginx.conf`'s `location /api/session-manager/`
 * sets no `error_page` or `proxy_intercept_errors`, so on a connect failure or
 * timeout nginx returns its own bare response under one of these three
 * codes - none of which any route schema declares, so `createEndpointClient`
 * reports them as a plain `UnexpectedResponseError` before ever attempting to
 * read a body. A `status` in this set is the same "can't reach the service"
 * story as `InvalidResponseBodyError`, just arriving through the
 * undeclared-status branch instead of a body-parse failure - see
 * `_causeFromError` for where the two are folded together.
 */
const GATEWAY_ERROR_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * How many consecutive 1008 closes to tolerate before declaring the session
 * terminal, when the close reason isn't one we recognise as permanent. The
 * kiosk app already treats any 1008 as terminal; the client is a little more
 * forgiving because a merely-stale cached token also closes 1008 and is
 * genuinely fixed by the refresh on the next attempt.
 */
const MAX_CONSECUTIVE_AUTH_FAILURES = 3;

/**
 * Close reasons node-server sends with 1008 that can never succeed on a
 * retry (see `transcription-stream.auth.ts`): the token was minted for a
 * different session, or without `RECEIVE_TRANSCRIPTIONS`. Reconnecting with
 * the same refresh token reproduces both exactly.
 *
 * The reason string does reach the browser - node-server passes it to
 * `socket.close(code, reason)`, so it rides in the close frame and surfaces
 * as `CloseEvent.reason` - but an empty or unfamiliar reason is not treated
 * as recoverable either: {@link MAX_CONSECUTIVE_AUTH_FAILURES} bounds the
 * unrecognised case independently.
 */
const PERMANENT_AUTH_CLOSE_REASONS = new Set([
  'missing-scope',
  'session-mismatch',
]);

/**
 * Classify a `createEndpointClient` failure that is neither `null` nor a
 * `NetworkError` into the two user-facing stories worth telling apart: the
 * request never reached anything that could answer as session-manager
 * (`'service-unreachable'`), or it reached something that answered with
 * content this build doesn't recognize (`'version-mismatch'`). Shared between
 * the join and refresh paths (see `joinSession` and `_refreshSessionToken`)
 * so the two don't drift into different definitions of the same distinction.
 *
 * `InvalidResponseBodyError` (a declared status with no readable body) and an
 * `UnexpectedResponseError` on one of {@link GATEWAY_ERROR_STATUSES} (an
 * undeclared status nginx synthesizes itself) are both folded into
 * `'service-unreachable'`: to a viewer they mean the same thing - try again
 * shortly - even though one arrives via a body-parse failure and the other
 * via the undeclared-status branch, before any body is even read.
 */
function classifyUnexpectedResponseError(
  error: UnexpectedResponseError,
): 'service-unreachable' | 'version-mismatch' {
  if (error instanceof InvalidResponseBodyError) return 'service-unreachable';
  if (GATEWAY_ERROR_STATUSES.has(error.status)) return 'service-unreachable';
  return 'version-mismatch';
}

/**
 * Compute a uniform jitter offset in `[-jitter * base, +jitter * base]`.
 */
function jitter(baseMs: number, fraction: number): number {
  const span = baseMs * fraction;
  return (Math.random() * 2 - 1) * span;
}

/**
 * Resolve after `ms`, so an async retry loop can back off without owning a
 * timer handle. Teardown is detected by the epoch check that follows every
 * await, not by cancelling this.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decode a base64url string to its raw text. `atob` only accepts standard
 * base64, so map the URL-safe alphabet back first; `atob` itself tolerates
 * the missing `=` padding.
 */
function base64UrlDecode(value: string): string {
  return atob(value.replaceAll('-', '+').replaceAll('_', '/'));
}

/**
 * Number of `.`-separated segments in a session token: `{payload}.{signature}`.
 */
const SESSION_TOKEN_SEGMENTS = 2;

/**
 * Read the `exp` claim out of a session token. Returns `null` if the token
 * can't be parsed.
 *
 * A ScribeAR session token is NOT a JWT, despite looking like one: it is
 * `base64url(payloadJSON).base64url(HMAC-SHA256)` - **two** segments, payload
 * first (see session-manager's `SessionTokenService.sign`). This function
 * previously read `parts[1]` as a JWT's payload would be, so it fed the raw
 * signature to `JSON.parse` and returned `null` for every token ever issued.
 * Nothing crashed, because both callers treat `null` as "unknown expiry" -
 * which silently meant the proactive refresh timer was never armed on any
 * connection, and every socket open burned a refresh round-trip before it
 * could send AUTH.
 *
 * The signature is not checked here; only session-manager and node-server
 * hold the signing key. This is a scheduling hint, not an authorization
 * decision - a tampered `exp` can only make this client refresh at the wrong
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

  /**
   * Increments on every authentication attempt. The socket reconnects
   * internally without the epoch changing, so `open` can fire again while a
   * previous attempt is still awaiting a token refresh; the generation lets
   * the older attempt bail instead of racing the newer one.
   */
  private _authGeneration = 0;

  /**
   * Consecutive failures, reset on the corresponding success. Both are
   * deliberately *not* reset by a reconnect - see
   * {@link REFRESH_MAX_CONSECUTIVE_FAILURES}.
   */
  private _refreshFailures = 0;
  private _authFailures = 0;

  /**
   * Best-known cause of the most recent refresh failure. Reset on every
   * success and whenever a fresh session becomes `ACTIVE`. Used for two
   * things: choosing the terminal message once the retry budget is spent (see
   * {@link _refreshTerminalMessage}), and - for `'rate-limited'` only -
   * pacing the retry delay itself (see {@link RATE_LIMIT_RETRY_DELAY_MS}).
   *
   * - `'rate-limited'`: session-manager's per-IP limit (429) fired. Nothing
   *   is wrong with the join code, the session, or this device - a lecture
   *   hall behind one campus NAT shares a client IP and trips it collectively.
   *   Self-clearing; the advice must not be "join again with a new join
   *   code", because a new join code is exchanged over a rate-limited route
   *   too, reproducing the problem from every seat in the room at once.
   * - `'service-unreachable'`: see {@link classifyUnexpectedResponseError} -
   *   either a declared status with no readable body (`InvalidResponseBodyError`),
   *   or an undeclared status nginx synthesizes itself when it can't reach
   *   session-manager ({@link GATEWAY_ERROR_STATUSES}). The same "join again"
   *   trap applies: a new join code goes over the same broken path.
   * - `'version-mismatch'`: everything else `classifyUnexpectedResponseError`
   *   sees - a declared status whose body parsed but didn't match this
   *   client's schema, or some other status this build's schema doesn't know
   *   at all. Usually means this client and the deployed session-manager are
   *   out of sync after a partial deploy - a reload can pick up a matching
   *   build.
   * - `'other'`: `NetworkError`, or anything not distinguished above. Keeps
   *   the original "Lost access to this session…" wording.
   */
  private _refreshFailureCause:
    | 'rate-limited'
    | 'service-unreachable'
    | 'version-mismatch'
    | 'other' = 'other';

  /**
   * Set once the session has been declared unrecoverable, to keep the
   * transition one-way for the remainder of this session.
   */
  private _terminal = false;

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
    // Re-announce the resumed identity. Without this the middleware never
    // dispatches `setActiveSession`, so `clientSessionService.session` stays
    // null after a page reload, `setConnectionStatus`/`setSessionStatus`
    // early-return on every event, and the reloaded viewer gets no banner at
    // all - not even while its socket is dead. The value is identical to what
    // is already persisted, so re-emitting it is a no-op for storage.
    this.emit('sessionIdentity', stored);
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
    // _teardownActiveSession bumped _epoch; capture it so that a later teardown
    // (a second joinSession, or a leaveSession) invalidates this in-flight
    // exchange - otherwise a stale response would open a leaked socket and
    // clobber the newer session.
    const epoch = this._epoch;
    this._identity = null;
    this.emit('sessionIdentity', null);
    this.emit('joinError', null);
    // A "the previous session ended" notice explains the dialog the user is
    // looking at; the moment they act on it, it is stale.
    this.emit('joinNotice', null);

    const [response, error] =
      await this._sessionManagerClient.sessionAuth.exchangeJoinCode({
        body: { joinCode: joinCode.trim().toUpperCase() },
      });

    if (epoch !== this._epoch) return;

    if (error instanceof NetworkError) {
      this.emit('joinError', JoinError.NETWORK_ERROR);
      this._setLifecycle(ClientLifecycle.IDLE);
      return;
    }
    if (error !== null) {
      this.emit(
        'joinError',
        classifyUnexpectedResponseError(error) === 'service-unreachable'
          ? JoinError.SERVICE_UNREACHABLE
          : JoinError.VERSION_MISMATCH,
      );
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
   *
   * This is the *user-initiated* leave (the Leave button, and the internal
   * paths where there is nothing to explain), so it carries no notice: the
   * user knows why the join dialog is back. Ending because the session itself
   * ended goes through {@link _endSession} with a {@link JoinNotice} instead.
   */
  leaveSession(): void {
    this._endSession(null);
  }

  /**
   * Return to {@link ClientLifecycle.IDLE}, optionally telling the user why.
   * `notice` is emitted before the lifecycle change so the join dialog opens
   * with its explanation already in the store rather than blank for a frame.
   * Passing `null` also *clears* any stale notice, which is what makes a
   * subsequent user-initiated leave not still claim the session ended.
   */
  private _endSession(notice: JoinNotice | null): void {
    this._teardownActiveSession();
    this._identity = null;
    this.emit('sessionIdentity', null);
    this.emit('joinNotice', notice);
    this._enterIdle();
  }

  private _enterIdle(): void {
    this._setLifecycle(ClientLifecycle.IDLE);
  }

  private _enterActive(identity: SessionIdentity): void {
    const epoch = ++this._epoch;
    this._terminal = false;
    this._refreshFailures = 0;
    this._refreshFailureCause = 'other';
    this._authFailures = 0;
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
          // established channel. This is the only proof the credential was
          // accepted, so it's what clears the consecutive-failure budget.
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
            // Spread rather than assign directly: `exactOptionalPropertyTypes`
            // forbids setting an optional property to an explicit `undefined`,
            // and `msg.transcriptionServiceDisconnectReason` is `undefined`
            // (not absent) whenever the server didn't send it.
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
          // handler drives the transition to IDLE.
          break;
        case TranscriptionStreamServerMessageType.LATENCY_UPDATE:
          this.emit('latency', {
            kind: msg.kind === LatencyKind.FINAL ? 'final' : 'inProgress',
            pipelineMs: msg.pipelineMs,
            e2eMs: msg.e2eMs,
          });
          break;
        case TranscriptionStreamServerMessageType.TIME_SYNC_PONG:
          // The client does not run clock sync (it never sends audio); ignore.
          break;
      }
    });

    socket.on('close', (code, reason) => {
      if (epoch !== this._epoch) return;
      // 1000 = normal close (sessionEnded message received) - session is
      // over and the persisted identity should be cleared. This is the one
      // close code that is *expected*, so it is also the one the user must be
      // told about explicitly: everything else on screen is about to be
      // replaced by the join dialog, and without the notice that dialog
      // reopens blank and a normal end is indistinguishable from a crash.
      if (code === 1000) {
        this._endSession(JoinNotice.SESSION_ENDED);
        return;
      }
      // 1008 = auth failure. The cached session token was rejected; drop it
      // so the next reconnect attempt forces a fresh refresh-token exchange
      // before sending AUTH again. WebSocketClient handles the reconnect
      // backoff internally - which is exactly the problem when the rejection
      // is permanent: 1008 is not in its `normalCloseCodes`, so it would
      // reconnect into the identical rejection forever. Bound it.
      if (code === 1008) {
        this._sessionToken = null;
        this._authFailures++;
        if (PERMANENT_AUTH_CLOSE_REASONS.has(reason)) {
          this._enterTerminal(
            'This session refused the connection. Leave the session and join again with a new join code.',
          );
          return;
        }
        if (this._authFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
          this._enterTerminal(
            'Could not connect to this session. Leave the session and join again with a new join code.',
          );
          return;
        }
      }
      // Note: 1013 ("at capacity") is NOT a code this socket ever receives -
      // and TRANSCRIPTION_STREAM_SCHEMA's closeCodes (1000/1001/1006/1007/
      // 1008/1011/1012) deliberately don't declare it, so `code === 1013`
      // would be a type error here, not just a no-op. Admission control
      // refuses the *upstream* link from node-server to the Transcription
      // Service with 1013 (see TranscriptionServiceDisconnectReason); this
      // client-facing socket stays open throughout, and node-server instead
      // reports that refusal via the next SESSION_STATUS message's
      // `transcriptionServiceDisconnectReason: 'at-capacity'`, which is what
      // `deriveConnectionBanner` renders. So there is no distinct close-code
      // branch to add here - this comment exists so a future reader doesn't
      // go looking for one.
    });

    socket.on('error', (err) => {
      if (epoch !== this._epoch) return;
      if (err instanceof WsSchemaValidationError) {
        // Client and server disagree about the wire format. Reconnecting
        // cannot fix a schema drift, and dropping to IDLE (as this used to)
        // discarded the explanation along with the session - the join dialog
        // reopened with no indication of what happened.
        this._enterTerminal(
          'Session stream protocol mismatch. This app may be out of date - reload the page.',
        );
      }
    });

    socket.start();
  }

  /**
   * Send the AUTH message on the freshly-opened socket. Re-runs after every
   * reconnect because the WebSocketClient re-emits `open` on each successful
   * underlying socket open - so it takes a generation and abandons any
   * earlier attempt still waiting on a refresh.
   */
  private async _authenticateSocket(
    identity: SessionIdentity,
    epoch: number,
  ): Promise<void> {
    const generation = ++this._authGeneration;

    let token = this._sessionToken;
    if (token !== null && this._isTokenExpired(token)) token = null;

    if (token === null) {
      token = await this._refreshWithBackoff(identity, epoch, generation);
      if (epoch !== this._epoch || generation !== this._authGeneration) return;
      // Refresh gave up (transiently, or terminally); either way there is
      // nothing to authenticate with. The socket will be closed by
      // node-server's auth watchdog, or already has been.
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
   * Retry {@link _refreshSessionToken} with exponential backoff until it
   * succeeds or the consecutive-failure budget is exhausted, at which point
   * the session becomes terminal. Returns `null` if it gave up or if the
   * attempt was superseded (teardown, or a newer socket open).
   */
  private async _refreshWithBackoff(
    identity: SessionIdentity,
    epoch: number,
    generation: number,
  ): Promise<string | null> {
    for (;;) {
      const token = await this._refreshSessionToken(identity, epoch);
      if (epoch !== this._epoch || generation !== this._authGeneration) {
        return null;
      }
      if (token !== null) return token;

      if (this._refreshFailures >= REFRESH_MAX_CONSECUTIVE_FAILURES) {
        this._enterTerminal(this._refreshTerminalMessage());
        return null;
      }

      // Every cause but a rate limit keeps the original fast exponential
      // schedule - those are the failures a quick retry can plausibly clear.
      // A 429 gets a schedule aligned with the limiter's own window instead
      // of a faster one: see {@link RATE_LIMIT_RETRY_DELAY_MS} for why.
      const delayMs =
        this._refreshFailureCause === 'rate-limited'
          ? RATE_LIMIT_RETRY_DELAY_MS
          : Math.min(
              REFRESH_RETRY_BASE_MS * 2 ** (this._refreshFailures - 1),
              REFRESH_RETRY_MAX_MS,
            );
      await sleep(delayMs + jitter(delayMs, TOKEN_REFRESH_JITTER));
      if (epoch !== this._epoch || generation !== this._authGeneration) {
        return null;
      }
    }
  }

  /**
   * Word the terminal message once the refresh retry budget is exhausted, by
   * the cause of the most recent failure (see {@link _refreshFailureCause}).
   * The generic "join again with a new join code" advice is actively harmful
   * for the two infrastructure-shaped causes - `exchange-join-code` goes over
   * the same rate limit, and the same broken proxy/gateway - so both get
   * their own wording naming what to actually wait on.
   */
  private _refreshTerminalMessage(): string {
    switch (this._refreshFailureCause) {
      case 'rate-limited':
        return 'Too many people are reconnecting at once, so this session could not renew its access. Wait a minute, then reload this page — you do not need a new join code.';
      case 'service-unreachable':
        return 'Could not reach the session service to renew access. This looks like a network or server problem rather than an issue with this session - wait a few minutes, then reload this page.';
      case 'version-mismatch':
        return 'This app could not understand the session service’s response, so it could not renew access. Reload the page to pick up a matching version.';
      case 'other':
        return 'Lost access to this session and could not restore it. Leave the session and join again with a new join code.';
    }
  }

  /**
   * Trade the refresh token for a fresh session token, once. On a 401/409 the
   * session is unrecoverable - clear stored identity and fall back to IDLE.
   * Any other failure returns `null` after charging the consecutive-failure
   * budget; retrying and giving up is {@link _refreshWithBackoff}'s job.
   *
   * Every failure also updates {@link _refreshFailureCause}, because the
   * budget alone can't say *why* it ran out - and "why" is what decides both
   * the terminal wording and, for a 429, the retry pacing itself.
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

    // Transient failures are deliberately not written to `error`: the
    // connection banner already says "Reconnecting…" for all of them, and the
    // only thing worth telling the user is the point at which retrying stops.
    if (error !== null) {
      this._refreshFailures++;
      // NetworkError (fetch itself failed) has no further story to tell -
      // 'other'. Everything else goes through the same classifier the join
      // path uses, so the two don't independently decide what "service
      // unreachable" vs. "version mismatch" means.
      this._refreshFailureCause =
        error instanceof NetworkError
          ? 'other'
          : classifyUnexpectedResponseError(error);
      return null;
    }

    switch (response.status) {
      case 200:
        this._refreshFailures = 0;
        this._refreshFailureCause = 'other';
        return response.data.sessionToken;
      // 401 INVALID_REFRESH_TOKEN: refresh token is no longer usable. Drop
      // the stored identity and return to IDLE so the user can join a new
      // session. Nothing specific to say - the cause is a credential the user
      // never saw - so this keeps the bare join dialog it always had.
      case 401:
        this.leaveSession();
        return null;
      // 409 SESSION_ENDED: session-manager saying the same thing the 1000
      // close says, over the other channel (this path is how a viewer whose
      // socket died first learns of it). Same event, so the same notice -
      // otherwise which of the two channels noticed first would decide
      // whether the user gets an explanation.
      case 409:
        this._endSession(JoinNotice.SESSION_ENDED);
        return null;
      // 429 RATE_LIMITED: session-manager's per-IP limit on
      // `refresh-session-token`. Transient by construction, so it keeps
      // retrying like any other transient failure - it only changes what the
      // user is told if the budget runs out first.
      case 429:
        this._refreshFailures++;
        this._refreshFailureCause = 'rate-limited';
        return null;
      default:
        this._refreshFailures++;
        this._refreshFailureCause = 'other';
        return null;
    }
  }

  /**
   * Arm the proactive refresh timer for `token`, so a long-lived viewer keeps
   * a valid credential without ever having to reconnect to get one. A token
   * whose expiry can't be read leaves no timer armed - which, until
   * {@link decodeSessionTokenExpiryMs} was fixed, was every token.
   */
  private _scheduleTokenRefresh(
    identity: SessionIdentity,
    token: string,
    epoch: number,
  ): void {
    if (this._tokenRefreshTimer !== null) {
      clearTimeout(this._tokenRefreshTimer);
      this._tokenRefreshTimer = null;
    }

    const expiryMs = decodeSessionTokenExpiryMs(token);
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

    const generation = ++this._authGeneration;
    const token = await this._refreshWithBackoff(identity, epoch, generation);
    if (epoch !== this._epoch || generation !== this._authGeneration) return;
    if (token === null) return;

    this._sessionToken = token;
    this._socket.send({
      type: TranscriptionStreamClientMessageType.AUTH,
      sessionToken: token,
    });
    this._scheduleTokenRefresh(identity, token, epoch);
  }

  private _isTokenExpired(token: string): boolean {
    const expiryMs = decodeSessionTokenExpiryMs(token);
    if (expiryMs === null) return true;
    return expiryMs <= Date.now();
  }

  /**
   * Declare the session unrecoverable: stop every retry loop, tear the socket
   * down, and tell the user - with the reason - that this session is over and
   * what to do about it. Stays in {@link ClientLifecycle.ACTIVE} on purpose,
   * so the captions already on screen survive and the Leave button (which is
   * bound to ACTIVE) is still there to rejoin with.
   *
   * One-way for the rest of the session; `joinSession`/`start` clear it.
   */
  private _enterTerminal(message: string): void {
    if (this._terminal) return;
    // Bumps the epoch, so every in-flight retry, refresh and timer this
    // session armed is abandoned rather than merely ignored.
    this._teardownActiveSession();
    this._terminal = true;
    this.emit('error', message);
    this.emit('connectionStatus', SessionConnectionStatus.TERMINAL);
  }

  private _joinErrorFromStatus(status: number): JoinError {
    switch (status) {
      case 404:
        return JoinError.JOIN_CODE_NOT_FOUND;
      case 410:
        return JoinError.JOIN_CODE_EXPIRED;
      case 409:
        return JoinError.SESSION_NOT_CURRENTLY_ACTIVE;
      // 429 RATE_LIMITED: session-manager's per-IP limit on
      // `exchange-join-code`. Only reaches here because the route now declares
      // 429; while it was undeclared the endpoint client reported it as an
      // `UnexpectedResponseError` and it never got as far as this switch.
      case 429:
        return JoinError.RATE_LIMITED;
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
