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
  UNKNOWN = 'UNKNOWN',
}
