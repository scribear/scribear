import { EventEmitter } from 'eventemitter3';
import { type Static, type TSchema } from 'typebox';

import {
  NetworkError,
  UnexpectedResponseError,
  createEndpointClient,
} from '@scribear/base-api-client';
import type {
  BaseLongPollRouteSchema,
  BaseRouteDefinition,
} from '@scribear/base-schema';

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Phases of the long-poll lifecycle. */
type LongPollState = 'IDLE' | 'POLLING' | 'WAITING_RETRY' | 'CLOSED';

/**
 * Exponential backoff configuration. Delay at attempt `n` is
 * `min(initialMs * factor^n, maxMs) +/- jitter`, where jitter is
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
 * Typed bag of path parameters required by the route. The version cursor is
 * managed internally by the client and is not part of `ConnectParams`.
 */
type ConnectParams<S extends BaseLongPollRouteSchema> = {
  [K in 'params' as undefined extends S[K] ? never : K]: S[K] extends TSchema
    ? Static<S[K]>
    : never;
};

/** Constructor options for {@link LongPollClient}. */
interface LongPollClientOptions<S extends BaseLongPollRouteSchema> {
  /** Route schema describing responses. Must satisfy {@link BaseLongPollRouteSchema}. */
  schema: S;
  /** Route definition used alongside `baseUrl` to construct the request URL. */
  route: BaseRouteDefinition;
  /** Base URL of the server (http:// or https://). */
  baseUrl: string;
  /** Path parameters to substitute into the route URL. */
  params: ConnectParams<S>;
  /** Additional HTTP headers merged into every request (e.g. `Authorization`). */
  headers?: Record<string, string>;
  /** Exponential backoff configuration for retry attempts after errors. */
  backoff?: Partial<BackoffOptions>;
  /**
   * Fetch options applied to every request. `method`, `headers`, and `signal`
   * are always overridden; all other fields are forwarded.
   */
  requestInit?: Omit<RequestInit, 'method' | 'headers' | 'signal'>;
  /**
   * Querystring parameter name for the version cursor sent on each poll
   * (e.g. `'sinceVersion'`).
   */
  versionParam: string;
  /**
   * Key in the 200 response body that carries the new cursor value
   * (e.g. `'roomScheduleVersion'`). Must be a numeric field.
   */
  versionResponseKey: string;
  /** Starting cursor value. Defaults to `0`. */
  initialVersion?: number;
}

/** Strongly-typed event map for {@link LongPollClient}. */
interface LongPollClientEvents<S extends BaseLongPollRouteSchema> {
  stateChange: (to: LongPollState, from: LongPollState) => void;
  /** Fires on every 200 response with validated payload. */
  data: (
    payload: S['response'][200] extends TSchema
      ? Static<S['response'][200]>
      : never,
  ) => void;
  error: (err: NetworkError | UnexpectedResponseError | Error) => void;
  /**
   * Fires on stop (explicit `close()` or unrecoverable error).
   * `reconnectInMs` is the scheduled retry delay, or `null` if no retry.
   */
  close: (reconnectInMs: number | null) => void;
}

/** Discriminated result of a single poll attempt, used internally. */
type PollResult<S extends BaseLongPollRouteSchema> =
  | {
      kind: '200';
      data: S['response'][200] extends TSchema
        ? Static<S['response'][200]>
        : never;
    }
  | { kind: '204' }
  | { kind: 'error'; err: NetworkError | UnexpectedResponseError };

/**
 * A self-managing long-poll client that handles the request loop, cursor
 * bookkeeping, and reconnection with exponential backoff.
 *
 * Each poll appends the current version cursor to the URL. The server
 * responds with 200 + payload (cursor advances), 204 (no change, re-poll
 * immediately), or an error (triggers backoff retry).
 *
 * State machine:
 * ```
 *   IDLE -> POLLING (start())
 *   POLLING -> POLLING (200 or 204 — re-polls immediately)
 *   POLLING -> WAITING_RETRY (network error or non-2xx response)
 *   POLLING -> CLOSED (close() called)
 *   WAITING_RETRY -> POLLING (retry timer fires)
 *   * -> CLOSED (close())
 * ```
 */
export class LongPollClient<
  S extends BaseLongPollRouteSchema,
> extends EventEmitter<LongPollClientEvents<S>> {
  private readonly _versionResponseKey: string;
  private readonly _initialVersion: number;
  private readonly _backoff: BackoffOptions;
  private readonly _pathParams: Record<string, string> | undefined;
  private readonly _headers: Record<string, string>;
  private readonly _requestInit: Omit<
    RequestInit,
    'method' | 'headers' | 'signal'
  >;
  private readonly _versionParam: string;
  /**
   * Single-shot typed fetch built from `createEndpointClient`. The poll loop
   * calls this per iteration; retry and cursor management live outside it.
   * Cast to a loose signature because the version cursor querystring param is
   * injected dynamically — the public API remains fully typed via events.
   */
  private readonly _endpointFn: (
    params: Record<string, unknown>,
    init?: RequestInit,
  ) => Promise<[{ status: number; data: unknown } | null, Error | null]>;

  private _state: LongPollState = 'IDLE';
  private _abortController: AbortController | null = null;
  private _retryTimer: ReturnType<typeof setTimeout> | null = null;
  private _currentVersion: number;
  private _attempt = 0;

  constructor(options: LongPollClientOptions<S>) {
    super();
    this._versionResponseKey = options.versionResponseKey;
    this._initialVersion = options.initialVersion ?? 0;
    this._currentVersion = this._initialVersion;
    this._backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this._pathParams = (
      options.params as { params?: Record<string, string> }
    ).params;
    this._headers = options.headers ?? {};
    this._requestInit = options.requestInit ?? {};
    this._versionParam = options.versionParam;

    // BaseLongPollRouteSchema extends BaseRouteSchema, so the schema is passed
    // directly. URL construction, fetch, JSON parsing, and schema validation
    // are all delegated to createEndpointClient.
    this._endpointFn = createEndpointClient(
      options.schema,
      options.route,
      options.baseUrl,
    ) as unknown as typeof this._endpointFn;
  }

  get state(): LongPollState {
    return this._state;
  }

  /** Number of consecutive failed attempts since the last successful response. */
  get attempt(): number {
    return this._attempt;
  }

  /** Begin the polling loop. No-op if already running. */
  start(): void {
    if (this._state !== 'IDLE' && this._state !== 'CLOSED') return;
    this._attempt = 0;
    this._currentVersion = this._initialVersion;
    this._poll();
  }

  /**
   * Permanently stop polling and cancel any pending retry. Calling
   * `start()` after `close()` begins a fresh lifecycle from the initial cursor.
   */
  close(): void {
    this._clearRetry();
    if (this._abortController !== null) {
      this._abortController.abort();
      this._abortController = null;
    }
    const prev = this._state;
    this._setState('CLOSED');
    if (prev !== 'IDLE' && prev !== 'CLOSED') this._emit('close', null);
  }

  private _poll(): void {
    this._setState('POLLING');
    const controller = new AbortController();
    this._abortController = controller;
    void this._run(controller);
  }

  private async _run(controller: AbortController): Promise<void> {
    while (this._state === 'POLLING') {
      const [result, err] = await this._endpointFn(
        {
          ...(this._pathParams !== undefined
            ? { params: this._pathParams }
            : {}),
          querystring: { [this._versionParam]: this._currentVersion },
        },
        {
          ...this._requestInit,
          headers: this._headers,
          signal: controller.signal,
        },
      );

      if (err !== null) {
        if (err instanceof NetworkError && isAbortError(err.cause)) return;
        this._handleFailure(err as NetworkError | UnexpectedResponseError);
        return;
      }

      this._attempt = 0;

      if (result === null || result.status === 204) continue;

      // status === 200
      const newVersion = (result.data as Record<string, unknown>)[
        this._versionResponseKey
      ];
      if (typeof newVersion === 'number') this._currentVersion = newVersion;
      this._emit(
        'data',
        result.data as PollResult<S> extends { kind: '200'; data: infer D }
          ? D
          : never,
      );
    }
  }

  private _handleFailure(err: NetworkError | UnexpectedResponseError): void {
    this._emit('error', err);
    if (this._state === 'CLOSED') return;
    const delay = this._computeBackoffDelay(this._attempt);
    this._scheduleRetry(delay);
  }

  private _scheduleRetry(delayMs: number): void {
    this._setState('WAITING_RETRY');
    this._attempt += 1;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this._state !== 'WAITING_RETRY') return;
      this._poll();
    }, delayMs);
    this._emit('close', delayMs);
  }

  private _clearRetry(): void {
    if (this._retryTimer !== null) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
  }

  private _computeBackoffDelay(attempt: number): number {
    const base = Math.min(
      this._backoff.initialMs * Math.pow(this._backoff.factor, attempt),
      this._backoff.maxMs,
    );
    const jitter = base * this._backoff.jitterPct;
    const offset = (Math.random() * 2 - 1) * jitter;
    return Math.max(0, Math.round(base + offset));
  }

  /**
   * Bypass the generic EventEmitter type check so internal lifecycle event
   * emissions compile. The public `.on()`/`.once()` API remains fully typed
   * through `LongPollClientEvents<S>`.
   */
  private _emit(event: string, ...args: unknown[]): void {
    (this as EventEmitter).emit(event, ...args);
  }

  private _setState(next: LongPollState): void {
    if (next === this._state) return;
    const prev = this._state;
    this._state = next;
    this._emit('stateChange', next, prev);
  }
}

export type {
  LongPollState,
  BackoffOptions,
  ConnectParams,
  LongPollClientOptions,
  LongPollClientEvents,
};
