import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

export interface DevicePresenceConfig {
  /**
   * Minimum gap between two `last_seen_at` writes for the same device.
   *
   * Devices reach session-manager through a long poll that returns roughly
   * every 30 seconds, and every one of those returns is a request that would
   * otherwise write a row. At fleet scale that is a steady stream of UPDATEs to
   * buy a timestamp nobody reads at that resolution. Coalescing to a coarser
   * interval keeps the signal (a device that stops polling goes stale within
   * the TTL) and drops most of the writes.
   */
  writeIntervalMs: number;
  /**
   * How long after its last sighting a device is still considered online.
   *
   * Must be comfortably longer than the poll cycle plus `writeIntervalMs`, or a
   * healthy device flips offline between two writes. It is the sum that
   * matters, which is why these two are configured together.
   */
  onlineTtlMs: number;
}

/**
 * Tracks when each device was last heard from (B1.6).
 *
 * **Why a service rather than an UPDATE in the handler.** The stamp is taken in
 * the device-token hook, so it covers every device-authenticated route rather
 * than only the schedule long poll — a device that is talking to us at all is
 * alive, whatever it happens to be asking for. That breadth is only affordable
 * with the write coalescing below.
 *
 * **Writes are fire-and-forget.** Presence is diagnostic; a failed UPDATE must
 * never turn a working device request into a 500. Failures are logged and
 * swallowed, and the in-memory clock is only advanced once the write succeeds,
 * so a database blip means the next request retries rather than skipping the
 * stamp for a whole interval.
 */
export class DevicePresenceService {
  private _config: DevicePresenceConfig;
  private _repository: AppDependencies['deviceManagementRepository'];
  private _logger: AppDependencies['logger'];
  /** Last time a write was *committed* per device uid. */
  private _lastWrittenMs = new Map<string, number>();

  constructor(
    devicePresenceConfig: DevicePresenceConfig,
    deviceManagementRepository: AppDependencies['deviceManagementRepository'],
    logger: AppDependencies['logger'],
  ) {
    this._config = devicePresenceConfig;
    this._repository = deviceManagementRepository;
    this._logger = logger;
  }

  /**
   * Records that a device was just heard from, subject to the write interval.
   *
   * Returns immediately; the write, if one is due, runs in the background.
   */
  touch(deviceUid: string, nowMs: number = Date.now()): void {
    const lastWritten = this._lastWrittenMs.get(deviceUid);
    if (
      lastWritten !== undefined &&
      nowMs - lastWritten < this._config.writeIntervalMs
    ) {
      return;
    }

    void this._repository
      .updateLastSeenAt(deviceUid, new Date(nowMs))
      .then(() => {
        this._lastWrittenMs.set(deviceUid, nowMs);
      })
      .catch((err: unknown) => {
        this._logger.warn(
          { err, deviceUid },
          'failed to record device last-seen',
        );
      });
  }

  /**
   * Forgets a device's write clock, so the next sighting writes immediately.
   *
   * Called when a device is deleted or re-registered: without this, a device
   * re-registered inside the write interval would appear stale until the
   * interval elapsed, and deleted uids would accumulate in the map for the
   * lifetime of the process.
   */
  forget(deviceUid: string): void {
    this._lastWrittenMs.delete(deviceUid);
  }

  /**
   * Whether a device seen at `lastSeenAt` counts as online now.
   *
   * A device that has never been seen is offline, not unknown: from an
   * operator's point of view "has never checked in" and "has not checked in
   * lately" both mean the same thing, which is that it is not currently
   * usable.
   */
  isOnline(lastSeenAt: Date | null, nowMs: number = Date.now()): boolean {
    if (lastSeenAt === null) return false;
    return nowMs - lastSeenAt.getTime() <= this._config.onlineTtlMs;
  }
}
