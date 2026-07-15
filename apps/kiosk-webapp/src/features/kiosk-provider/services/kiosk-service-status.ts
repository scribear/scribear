/**
 * Top-level lifecycle phase of the kiosk app, mirroring the four states in
 * the kiosk specification:
 *
 * - `INITIALIZING` - on entry, fetching device/room info to decide whether
 *   the device is registered and active.
 * - `UNREGISTERED` - no valid `DEVICE_TOKEN`. UI shows the activation form.
 * - `IDLE` - registered, polling the schedule, no active session.
 * - `ACTIVE` - participating in a live session.
 */
export enum KioskLifecycle {
  INITIALIZING = 'INITIALIZING',
  UNREGISTERED = 'UNREGISTERED',
  IDLE = 'IDLE',
  ACTIVE = 'ACTIVE',
}

/**
 * Sub-status of a session connection while the kiosk is `ACTIVE`. Drives the
 * connection indicator in the UI; not used outside `ACTIVE`.
 */
export enum SessionConnectionStatus {
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
}
