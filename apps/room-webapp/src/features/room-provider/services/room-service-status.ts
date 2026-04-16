/**
 * Enum representing all possible runtime states of the `RoomService`.
 *
 * - `INACTIVE` - service has not been started.
 * - `NOT_REGISTERED` / `REGISTERING` / `REGISTRATION_ERROR` - device registration flow.
 * - `IDLE` - registered and polling for sessions, but no active session.
 * - `ERROR` - an unrecoverable error has occurred; service is suspended.
 * - `SESSION_CONNECTING` / `SESSION_ERROR` - session connection lifecycle.
 * - `ACTIVE` - in an active session and streaming audio.
 * - `ACTIVE_MUTE` - in an active session but microphone is muted.
 */
export enum RoomServiceStatus {
  INACTIVE = 'INACTIVE',

  NOT_REGISTERED = 'NOT_REGISTERED',
  REGISTERING = 'REGISTERING',
  REGISTRATION_ERROR = 'REGISTRATION_ERROR',

  IDLE = 'IDLE',
  ERROR = 'ERROR',

  SESSION_CONNECTING = 'SESSION_CONNECTING',
  SESSION_ERROR = 'SESSION_ERROR',
  ACTIVE = 'ACTIVE',
  ACTIVE_MUTE = 'ACTIVE_MUTE',
}
