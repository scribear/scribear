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
 *
 * `TERMINAL` is the modeled unrecoverable state: the kiosk has stopped
 * retrying and will not reconnect to this session on its own. It exists
 * because without it a permanent fault (a token minted without `SEND_AUDIO`,
 * a device assigned to the wrong room, a schema drift after a partial deploy)
 * is indistinguishable from a flaky network forever - the kiosk drops to
 * `IDLE`, the panel says "Inactive, waiting for a session to start." while a
 * session is in fact running, schedule sync rediscovers the same session,
 * and the cycle repeats unbounded with nothing on screen naming the cause.
 *
 * The kiosk stays in {@link KioskLifecycle.ACTIVE} while `TERMINAL`, so the
 * captions already on the wall survive, the session name and join code stay
 * on the panel, and the banner can say what happened and who has to fix it.
 * Terminal is scoped to one session: the next session (or the current one
 * disappearing from the schedule) clears it and starts fresh.
 */
export enum SessionConnectionStatus {
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  TERMINAL = 'TERMINAL',
}
