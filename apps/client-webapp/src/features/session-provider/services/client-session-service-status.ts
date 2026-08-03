/**
 * Top-level lifecycle phase of the client app, mirroring the three states in
 * the client app specification:
 *
 * - `INITIALIZING` - on entry, attempting to resume a stored session.
 * - `IDLE` - no active session. UI shows the join-code form.
 * - `ACTIVE` - connected (or reconnecting) to a live session.
 */
export enum ClientLifecycle {
  INITIALIZING = 'INITIALIZING',
  IDLE = 'IDLE',
  ACTIVE = 'ACTIVE',
}

/**
 * Sub-status of a session connection while the client is `ACTIVE`. Drives the
 * connection indicator in the UI; not used outside `ACTIVE`.
 *
 * `TERMINAL` is the modeled unrecoverable state: the service has stopped
 * retrying and will not reconnect on its own. It exists because without it a
 * permanent fault (a rejected session token, a scope mismatch, a schema drift)
 * is indistinguishable from a flaky network forever - the client reconnects,
 * fails the same way, resets its backoff because the socket survived long
 * enough to look "stable", and hammers the server roughly once a second while
 * the user just sees "Reconnecting…". The session stays `ACTIVE` in TERMINAL
 * so the transcript already on screen survives and the Leave button remains
 * available for the user to rejoin.
 */
export enum SessionConnectionStatus {
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  TERMINAL = 'TERMINAL',
}

/**
 * Why the join dialog is being shown, when the reason is *not* a failure.
 * Sits alongside {@link JoinError} on the same dialog and is deliberately
 * separate from it: these are expected outcomes, rendered as `info` per the
 * severity convention (`info` = expected, no action; `warning` = degraded,
 * retrying; `error` = terminal, action required), so they must not paint the
 * join field red or read as something the user did wrong.
 *
 * It exists because a session ending normally used to be indistinguishable
 * from a crash: node-server closes the viewer's socket 1000, the client drops
 * back to `IDLE`, and the join dialog reopened completely blank - the
 * captions simply vanished with no explanation anywhere on screen.
 */
export enum JoinNotice {
  SESSION_ENDED = 'SESSION_ENDED',
}

/**
 * Outcome of the most recent join-code submission. Surfaces a specific
 * failure mode to the UI without polluting the lifecycle state machine -
 * `JOIN_ERROR` lives alongside `IDLE`, not as its own lifecycle phase.
 */
export enum JoinError {
  NETWORK_ERROR = 'NETWORK_ERROR',
  JOIN_CODE_NOT_FOUND = 'JOIN_CODE_NOT_FOUND',
  JOIN_CODE_EXPIRED = 'JOIN_CODE_EXPIRED',
  SESSION_NOT_CURRENTLY_ACTIVE = 'SESSION_NOT_CURRENTLY_ACTIVE',
  /**
   * session-manager's per-IP rate limit on `exchange-join-code` fired. Its own
   * case because it is the one join failure where nothing is wrong with the
   * join code, the session, or this device: a lecture hall behind one campus
   * NAT shares a single client IP and trips the limit collectively. It used to
   * land in {@link JoinError.UNKNOWN} - "Unable to join session. Please try
   * again." - which instructs the entire room to retry into more 429s.
   *
   * Transient and self-clearing, so it is rendered as `warning`, not `error`
   * (see the severity convention on {@link JoinNotice}).
   */
  RATE_LIMITED = 'RATE_LIMITED',
  /**
   * `exchange-join-code` failed in a way that points at the path to
   * session-manager rather than at this join code - two distinct
   * `createEndpointClient` outcomes collapse here because, to a viewer, they
   * mean the same thing ("try again shortly"):
   *
   * - `InvalidResponseBodyError`: a *declared* status arrived with no
   *   structured body to read at all - most plausibly session-manager itself
   *   failing partway through a response it had already started (a crash, an
   *   OOM kill, an unhandled exception after headers were sent), or the
   *   connection dropping mid-body.
   * - A plain `UnexpectedResponseError` whose `status` is one of nginx's own
   *   upstream-failure codes (502/503/504) - this deployment's
   *   `infra/scribear-nginx/nginx.conf` proxies `/api/session-manager/` with
   *   no `error_page`/`proxy_intercept_errors` override, so those three
   *   statuses are nginx's own synthesized response when it cannot reach or
   *   times out talking to session-manager, never declared by any route
   *   schema, and therefore never even reach the JSON-parsing step that could
   *   produce an `InvalidResponseBodyError` for them.
   *
   * Distinct from {@link JoinError.VERSION_MISMATCH} below: there,
   * session-manager (not its gateway) answered with something concrete this
   * build just doesn't recognize.
   */
  SERVICE_UNREACHABLE = 'SERVICE_UNREACHABLE',
  /**
   * `exchange-join-code` came back as a plain `UnexpectedResponseError` whose
   * `status` is *not* one of the gateway codes above - a declared status
   * whose body parsed as JSON but didn't match what this client was compiled
   * against, or some other status this build's schema doesn't know at all.
   * session-manager (or, for a status it never declared, its schema
   * definition) is answering with something this specific build doesn't
   * recognize - the usual cause is this client and the deployed service being
   * out of sync after a partial deploy, which a reload can fix if a newer
   * bundle is available.
   */
  VERSION_MISMATCH = 'VERSION_MISMATCH',
  /**
   * A declared status this switch doesn't otherwise map (e.g. a structured
   * 500 whose body parsed and matched schema fine). Kept deliberately generic
   * - unlike {@link JoinError.SERVICE_UNREACHABLE} and
   * {@link JoinError.VERSION_MISMATCH}, session-manager both received the
   * request and returned a well-formed reply, so there's no infrastructure or
   * version story to tell.
   */
  UNKNOWN = 'UNKNOWN',
}
