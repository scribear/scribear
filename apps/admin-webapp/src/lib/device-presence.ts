export interface DevicePresenceFacts {
  /** Activation state — not presence. Kept separate on purpose (see below). */
  active: boolean;
  /** Whether `lastSeenAt` is within the server's online TTL. */
  online: boolean;
  lastSeenAt: string | null;
}

/**
 * `lastSeenAt` in a human-readable form. Distinguishes "never seen" (no
 * presence ping since presence tracking shipped — not necessarily
 * unregistered, see `Device.lastSeenAt`'s doc comment) from "last seen at
 * <time>", so "Offline" never reads the same whether the device dropped a
 * minute ago or has never once connected.
 */
export function formatLastSeen(lastSeenAt: string | null): string {
  return lastSeenAt === null
    ? 'Never seen'
    : `Last seen ${new Date(lastSeenAt).toLocaleString()}`;
}

/**
 * Presence color, deliberately independent of the Active/Pending
 * activation-state chip's own color:
 *
 * - Online → `success`. Nothing to check.
 * - Offline while activated → `warning`. This is the case the silent-room
 *   runbook's "is the kiosk plugged in?" question exists for: the device was
 *   set up and is expected to be reachable, so its absence is a real thing to
 *   go check — but not `error`, because a reboot or a network blip is not
 *   necessarily terminal, and `info` would understate it (§10: `info` implies
 *   no action, and there may well be one).
 * - Offline while still pending activation → `default`. The device has never
 *   been set up, so its absence is expected, not a fault.
 */
export function devicePresenceColor(
  facts: Pick<DevicePresenceFacts, 'active' | 'online'>,
): 'success' | 'warning' | 'default' {
  if (facts.online) return 'success';
  return facts.active ? 'warning' : 'default';
}
