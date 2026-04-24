import { EventEmitter } from 'eventemitter3';
import WebSocket from 'isomorphic-ws';
import { type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

import type {
  BaseRouteDefinition,
  BaseWebSocketRouteSchema,
} from '@scribear/base-schema';

import { buildWsUrl } from './build-ws-url.js';
import { ConnectionError, SchemaValidationError } from './errors.js';

/**
 * The server message payload type declared by the route schema.
 */
type ServerMessage<S extends BaseWebSocketRouteSchema> =
  S['serverMessage'] extends TSchema ? Static<S['serverMessage']> : never;

/**
 * The client message payload type declared by the route schema.
 */
type ClientMessage<S extends BaseWebSocketRouteSchema> =
  S['clientMessage'] extends TSchema ? Static<S['clientMessage']> : never;

/**
 * Literal union of close codes declared on the route schema, or `number` if
 * none are declared. Narrows the value emitted with `close` events.
 */
type WsCloseCodeOf<S extends BaseWebSocketRouteSchema> =
  S['closeCodes'] extends Partial<Record<infer K extends number, unknown>>
    ? K
    : number;

/**
 * URL input sites that can appear on a WebSocket route schema (path params,
 * querystring). Used only to derive {@link ConnectParams}.
 */
type InputKey = 'querystring' | 'params';

/**
 * Typed bag of URL inputs required by the route. Keys are present only when
 * the corresponding schema field is declared.
 */
type ConnectParams<S extends BaseWebSocketRouteSchema> = {
  [K in InputKey as undefined extends S[K] ? never : K]: S[K] extends TSchema
    ? Static<S[K]>
    : never;
};

/**
 * Phases the client transitions through. See the {@link WebSocketClient}
 * class docs for the allowed transitions.
 */
type ConnectionState =
  | 'IDLE'
  | 'CONNECTING'
  | 'HANDSHAKING'
  | 'OPEN'
  | 'WAITING_RETRY'
  | 'CLOSED';

/**
 * Exponential backoff configuration for reconnect attempts. Delay at attempt
 * `n` is `min(initialMs * factor^n, maxMs) +/- jitter`, where jitter is
 * `delay * jitterPct` in uniform `[-jitter, +jitter]`.
 */
interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitterPct: number;
}

const DEFAULT_BACKOFF: BackoffOptions = {
  initialMs: 1000,
  maxMs: 30_000,
  factor: 2,
  jitterPct: 0.3,
};

/**
 * Policy applied when the outbound send buffer reaches its limit. `error`
 * emits an `error` event and drops the message; the other two silently drop
 * the oldest or newest queued item to make room.
 */
type SendQueueOverflow = 'drop-oldest' | 'drop-newest' | 'error';

/**
 * Constructor options for {@link WebSocketClient}. `schema`, `route`,
 * `baseUrl`, and `params` are required; every other field has a default.
 */
interface WebSocketClientOptions<S extends BaseWebSocketRouteSchema> {
  /**
   * Route schema describing allowed client/server messages and close codes.
   */
  schema: S;
  /**
   * Route definition used alongside {@link baseUrl} to build the WebSocket URL.
   */
  route: BaseRouteDefinition;
  /**
   * Base URL of the server. HTTP schemes are translated to ws/wss.
   */
  baseUrl: string;
  /**
   * Path parameters and querystring values to substitute into the route URL.
   */
  params: ConnectParams<S>;
  /**
   * Protocol-level handshake run once per successful socket open and before
   * the `open` event fires. Typical use is sending an auth credential and
   * waiting for the server's acknowledgement message. Reject to abandon this
   * connection attempt and trigger a retry.
   */
  onHandshake?: (
    sender: {
      send: (msg: ClientMessage<S>) => void;
      sendBinary: (data: Buffer | ArrayBuffer) => void;
    },
    messages: EventEmitter<{ message: (msg: ServerMessage<S>) => void }>,
  ) => Promise<void>;
  /**
   * Close codes that should be treated as intentional closes. The client
   * transitions to `CLOSED` instead of scheduling a reconnect.
   *
   * Defaults to `[1000, 1001]` (Normal Closure and Going Away). Codes like
   * 1006 (Abnormal Closure) and 1012 (Service Restart) are intentionally
   * excluded from the default so the client reconnects on network drops and
   * server restarts.
   */
  normalCloseCodes?: number[];
  /**
   * Exponential backoff configuration for reconnect attempts.
   */
  backoff?: Partial<BackoffOptions>;
  /**
   * Maximum number of outbound messages buffered while not `OPEN`. Defaults
   * to 64. Set to 0 to disable buffering entirely.
   */
  sendQueueLimit?: number;
  /**
   * Policy when the send queue fills up. Defaults to `drop-oldest`.
   */
  sendQueueOverflow?: SendQueueOverflow;
  /**
   * `bufferedAmount` threshold in bytes. When the socket is `OPEN` and the
   * underlying send buffer exceeds this value, the overflow policy is applied
   * instead of sending. Defaults to 65536 (64 KiB). Set to `Infinity` to
   * disable backpressure checking.
   */
  backpressureHighWaterMark?: number;
}

/**
 * Event signatures emitted by {@link WebSocketClient}. The client extends
 * `EventEmitter<WebSocketClientEvents<S>>` so handlers are strongly typed.
 */
interface WebSocketClientEvents<S extends BaseWebSocketRouteSchema> {
  stateChange: (to: ConnectionState, from: ConnectionState) => void;
  open: () => void;
  message: (msg: ServerMessage<S>) => void;
  binaryMessage: (data: Buffer | ArrayBuffer) => void;
  /**
   * Fires on every underlying close. `reconnectInMs` is the scheduled delay
   * before the next connect attempt; `null` means no further reconnect will
   * happen (either a normal close code was received or `terminate()` was
   * called).
   */
  close: (
    code: WsCloseCodeOf<S>,
    reason: string,
    reconnectInMs: number | null,
  ) => void;
  error: (err: SchemaValidationError | ConnectionError | Error) => void;
}

/**
 * Tagged union of outbound frames waiting for the socket to reach `OPEN`.
 * Text frames carry a pre-serialized JSON string; binary frames carry the
 * raw buffer.
 */
type QueuedSend =
  | { kind: 'text'; payload: string }
  | { kind: 'binary'; payload: Buffer | ArrayBuffer };

/**
 * A self-managing WebSocket client that handles connection, an optional
 * protocol handshake, reconnection with exponential backoff, and outbound
 * send buffering while the socket is down.
 *
 * ```
 * state machine:
 *   IDLE -> CONNECTING
 *   CONNECTING -> HANDSHAKING (socket open)
 *   CONNECTING -> WAITING_RETRY (socket error)
 *   HANDSHAKING -> OPEN (onHandshake resolves)
 *   HANDSHAKING -> WAITING_RETRY (onHandshake rejects or close)
 *   OPEN -> WAITING_RETRY (abnormal close)
 *   OPEN -> CLOSED (normal close code)
 *   WAITING_RETRY -> CONNECTING (retry timer fires)
 *   * -> CLOSED (terminate())
 * ```
 */
export class WebSocketClient<
  S extends BaseWebSocketRouteSchema,
> extends EventEmitter<WebSocketClientEvents<S>> {
  private readonly _schema: S;
  private readonly _url: string;
  private readonly _onHandshake:
    | WebSocketClientOptions<S>['onHandshake']
    | undefined;
  private readonly _normalCloseCodes: ReadonlySet<number>;
  private readonly _backoff: BackoffOptions;
  private readonly _sendQueueLimit: number;
  private readonly _sendQueueOverflow: SendQueueOverflow;
  private readonly _backpressureHighWaterMark: number;

  private _ws: WebSocket | null = null;
  private _retryTimer: ReturnType<typeof setTimeout> | null = null;
  private _sendQueue: QueuedSend[] = [];
  private _handshakeRouter: EventEmitter<{
    message: (msg: ServerMessage<S>) => void;
  }> | null = null;

  private _state: ConnectionState = 'IDLE';
  private _attempt = 0;

  constructor(options: WebSocketClientOptions<S>) {
    super();
    this._schema = options.schema;
    this._url = buildWsUrl(
      options.baseUrl,
      options.route.url,
      (options.params as { params?: Record<string, string> }).params,
      (options.params as { querystring?: Record<string, string> }).querystring,
    );
    this._onHandshake = options.onHandshake;
    this._normalCloseCodes = new Set(options.normalCloseCodes ?? [1000, 1001]);
    this._backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this._sendQueueLimit = options.sendQueueLimit ?? 64;
    this._sendQueueOverflow = options.sendQueueOverflow ?? 'drop-oldest';
    this._backpressureHighWaterMark =
      options.backpressureHighWaterMark ?? 65536;
  }

  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Number of completed retry cycles since the last successful `OPEN`. Resets
   * to 0 on each successful connection.
   */
  get attempt(): number {
    return this._attempt;
  }

  /**
   * Begin the connection lifecycle. No-op if already running.
   */
  start(): void {
    if (this._state !== 'IDLE' && this._state !== 'CLOSED') return;
    this._attempt = 0;
    this._connect();
  }

  /**
   * Stop the client permanently, closing any active socket. No further
   * reconnect attempts are scheduled. Calling `start()` after `terminate()`
   * begins a fresh lifecycle.
   */
  terminate(code: WsCloseCodeOf<S>, reason = ''): void {
    this._clearRetry();
    if (this._ws !== null) {
      const sock = this._ws;
      sock.onopen = null;
      sock.onmessage = null;
      sock.onclose = null;
      sock.onerror = null;
      this._ws = null;
      try {
        sock.close(code, reason);
      } catch {
        // Ignore close errors during teardown.
      }
    }
    this._sendQueue = [];
    this._setState('CLOSED');
  }

  /**
   * Queue a typed client message. If the socket is `OPEN` the message is
   * sent immediately, otherwise it is buffered per the configured queue
   * policy.
   *
   * @param message The typed client message to send.
   */
  send(message: ClientMessage<S>): void {
    const payload = JSON.stringify(message);
    this._enqueue({ kind: 'text', payload });
  }

  /**
   * Queue a raw binary frame, subject to the same queueing rules as {@link send}.
   *
   * @param data Binary payload to send.
   */
  sendBinary(data: Buffer | ArrayBuffer): void {
    this._enqueue({ kind: 'binary', payload: data });
  }

  /**
   * Push a send item through the socket if `OPEN`, otherwise buffer it per
   * the configured queue policy. Called by {@link send} and {@link sendBinary}.
   *
   * @param item Text or binary payload wrapper.
   */
  private _enqueue(item: QueuedSend): void {
    if (this._state === 'OPEN' && this._ws !== null) {
      const buffered = this._ws.bufferedAmount;
      if (buffered <= this._backpressureHighWaterMark) {
        this._ws.send(item.payload);
        return;
      }
      // bufferedAmount exceeds high-water mark - apply overflow policy.
      // drop-oldest and drop-newest both drop the current item since there
      // is no queue to rearrange when the socket is already open.
      if (this._sendQueueOverflow === 'error') {
        this.emit(
          'error',
          new Error(
            `WebSocket send buffer exceeded high-water mark (${buffered.toString()} bytes buffered).`,
          ),
        );
      }
      return;
    }

    if (this._sendQueueLimit === 0) {
      if (this._sendQueueOverflow === 'error') {
        this.emit('error', new Error('Send queue is disabled (limit 0).'));
      }
      return;
    }

    if (this._sendQueue.length >= this._sendQueueLimit) {
      switch (this._sendQueueOverflow) {
        case 'drop-oldest':
          this._sendQueue.shift();
          this._sendQueue.push(item);
          return;
        case 'drop-newest':
          return;
        case 'error':
          this.emit(
            'error',
            new Error(
              `Send queue full (limit ${this._sendQueueLimit.toString()}).`,
            ),
          );
          return;
      }
    } else {
      this._sendQueue.push(item);
    }
  }

  /**
   * Drain every buffered send item onto the live socket, in order.
   */
  private _flushQueue(): void {
    if (this._ws === null) return;
    while (this._sendQueue.length > 0) {
      const item = this._sendQueue.shift();
      if (item === undefined) break;
      this._ws.send(item.payload);
    }
  }

  /**
   * Start a fresh TCP/WS connection and wire up the open/error handlers for
   * the pre-handshake phase. Subsequent lifecycle events are owned by
   * {@link _handleOpen}.
   */
  private _connect(): void {
    this._setState('CONNECTING');
    const ws = new WebSocket(this._url);
    this._ws = ws;

    ws.onopen = () => {
      if (this._ws !== ws) return;
      void this._handleOpen(ws);
    };

    ws.onerror = (event) => {
      if (this._ws !== ws) return;
      this._handleFailure(new ConnectionError(event.error));
    };
  }

  /**
   * Runs after the underlying socket has opened. Attaches the message/close
   * handlers, runs the optional handshake, and transitions to `OPEN` on
   * success.
   *
   * @param ws The freshly-opened socket. Guarded against races where
   *   `this._ws` has already been replaced.
   */
  private async _handleOpen(ws: WebSocket): Promise<void> {
    this._setState('HANDSHAKING');
    const router = new EventEmitter<{
      message: (msg: ServerMessage<S>) => void;
    }>();
    this._handshakeRouter = router;

    ws.onmessage = (event) => {
      this._handleMessage(ws, event.data);
    };
    ws.onclose = (event) => {
      this._handleClose(ws, event.code, event.reason);
    };
    ws.onerror = (event) => {
      if (this._ws !== ws) return;
      this.emit(
        'error',
        event.error instanceof Error ? event.error : new Error(event.message),
      );
    };

    try {
      if (this._onHandshake !== undefined) {
        await this._onHandshake(
          {
            send: (msg) => {
              ws.send(JSON.stringify(msg));
            },
            sendBinary: (data) => {
              ws.send(data);
            },
          },
          router,
        );
      }
    } catch (err) {
      if (this._ws === ws) {
        // 1008 Policy Violation: server's handshake response did not meet
        // the client's expected protocol.
        ws.close(1008, 'handshake-failed');
        this._handleFailure(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
      return;
    }

    // Re-check we're still the live socket; terminate() or a racing close
    // could have replaced this ws during the handshake.
    if (this._ws !== ws) return;

    this._attempt = 0;
    this._setState('OPEN');
    this.emit('open');
    this._flushQueue();
  }

  /**
   * Dispatch a raw frame from the underlying socket. Binary frames bypass
   * schema validation; text frames are JSON-parsed and validated against
   * `schema.serverMessage`.
   *
   * @param ws Socket the frame came from. Discarded if no longer current.
   * @param data Raw frame payload from the underlying WebSocket.
   */
  private _handleMessage(ws: WebSocket, data: unknown): void {
    if (this._ws !== ws) return;
    if (
      data instanceof ArrayBuffer ||
      (typeof Buffer !== 'undefined' && data instanceof Buffer)
    ) {
      if (!this._schema.allowServerBinaryMessage) {
        this.emit(
          'error',
          new SchemaValidationError('Receiving binary message is not allowed.'),
        );
        return;
      }
      this.emit('binaryMessage', data);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data as string);
    } catch {
      this.emit(
        'error',
        new SchemaValidationError('Received message is not valid JSON.'),
      );
      return;
    }

    if (!Value.Check(this._schema.serverMessage, parsed)) {
      this.emit(
        'error',
        new SchemaValidationError(
          'Received message did not match expected server message schema.',
        ),
      );
      return;
    }

    const msg = parsed as ServerMessage<S>;
    // Deliver to the handshake listener first so onHandshake can await
    // acknowledgement messages before the public `message` event fires.
    this._handshakeRouter?.emit('message', msg);
    this.emit('message', msg);
  }

  /**
   * Invoked on underlying socket close. Decides whether to reconnect based
   * on the close code and current state, schedules the retry, and emits
   * the public `close` event with the computed delay.
   *
   * @param ws Socket that closed.
   * @param rawCode Raw WebSocket close code from the underlying event.
   * @param reason Reason string from the underlying event.
   */
  private _handleClose(ws: WebSocket, rawCode: number, reason: string): void {
    if (this._ws !== ws) return;
    this._ws = null;
    this._handshakeRouter = null;

    const code = rawCode;
    if (!(code in this._schema.closeCodes)) {
      this.emit(
        'error',
        new SchemaValidationError(
          `Received unexpected WebSocket close code: ${code.toString()}.`,
        ),
      );
    }

    const willReconnect =
      !this._normalCloseCodes.has(code) && this._state !== 'CLOSED';

    let reconnectInMs: number | null = null;
    if (willReconnect) {
      reconnectInMs = this._computeBackoffDelay(this._attempt);
      this._scheduleRetry(reconnectInMs);
    } else {
      this._setState('CLOSED');
      this._sendQueue = [];
    }

    this.emit('close', code as WsCloseCodeOf<S>, reason, reconnectInMs);
  }

  /**
   * Handle a connection failure that didn't come via the socket's `onclose`
   * (e.g. pre-open error, handshake rejection). Emits `error`, tears the
   * socket down, and schedules a retry.
   *
   * @param err Underlying cause of the failure.
   */
  private _handleFailure(err: Error): void {
    this.emit('error', err);
    if (this._ws !== null) {
      const sock = this._ws;
      sock.onopen = null;
      sock.onmessage = null;
      sock.onclose = null;
      sock.onerror = null;
      this._ws = null;
      try {
        sock.close();
      } catch {
        // Ignore; the underlying transport may already be in a bad state.
      }
    }
    if (this._state === 'CLOSED') return;
    const delay = this._computeBackoffDelay(this._attempt);
    this._scheduleRetry(delay);
  }

  /**
   * Transition to `WAITING_RETRY` and schedule a reconnect attempt after `delayMs` milliseconds.
   */
  private _scheduleRetry(delayMs: number): void {
    this._setState('WAITING_RETRY');
    this._attempt += 1;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this._state !== 'WAITING_RETRY') return;
      this._connect();
    }, delayMs);
  }

  /**
   * Cancel any pending retry timer. Safe to call when no timer is active.
   */
  private _clearRetry(): void {
    if (this._retryTimer !== null) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
  }

  /**
   * @param attempt Zero-indexed retry count since the last successful open.
   * @returns Backoff delay in milliseconds, with uniform jitter applied.
   */
  private _computeBackoffDelay(attempt: number): number {
    const base = Math.min(
      this._backoff.initialMs * Math.pow(this._backoff.factor, attempt),
      this._backoff.maxMs,
    );
    const jitter = base * this._backoff.jitterPct;
    // Uniform noise in [-jitter, +jitter].
    const offset = (Math.random() * 2 - 1) * jitter;
    return Math.max(0, Math.round(base + offset));
  }

  /**
   * Transition to the given state and emit `stateChange` if it changed.
   *
   * @param next Target state.
   */
  private _setState(next: ConnectionState): void {
    if (next === this._state) return;
    const prev = this._state;
    this._state = next;
    this.emit('stateChange', next, prev);
  }
}

export type {
  ConnectionState,
  BackoffOptions,
  SendQueueOverflow,
  ConnectParams,
  WebSocketClientOptions,
  WebSocketClientEvents,
};
