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
 */
export enum SessionConnectionStatus {
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
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
