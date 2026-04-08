/**
 * Enum representing all possible runtime states of the `ClientSessionService`.
 *
 * - `IDLE` - not connected to any session.
 * - `JOINING` - join code submitted, awaiting authentication.
 * - `JOIN_ERROR` - join code authentication failed (invalid code, etc.).
 * - `CONNECTING` - authenticated, opening WebSocket connection.
 * - `CONNECTION_ERROR` - WebSocket connection or token refresh failed.
 * - `ACTIVE` - connected and receiving transcriptions.
 */
export enum ClientSessionServiceStatus {
  IDLE = 'IDLE',
  JOINING = 'JOINING',
  JOIN_ERROR = 'JOIN_ERROR',
  CONNECTING = 'CONNECTING',
  CONNECTION_ERROR = 'CONNECTION_ERROR',
  ACTIVE = 'ACTIVE',
}
