import { beforeEach, describe, expect, vi } from 'vitest';

import { DevicePresenceService } from '#src/server/shared/services/device-presence.service.js';

const DEVICE = 'device-1';
const WRITE_INTERVAL_MS = 60_000;
const ONLINE_TTL_MS = 180_000;

describe('DevicePresenceService', () => {
  let repository: { updateLastSeenAt: ReturnType<typeof vi.fn> };
  let logger: { warn: ReturnType<typeof vi.fn> };
  let service: DevicePresenceService;

  beforeEach(() => {
    repository = { updateLastSeenAt: vi.fn().mockResolvedValue(undefined) };
    logger = { warn: vi.fn() };
    service = new DevicePresenceService(
      { writeIntervalMs: WRITE_INTERVAL_MS, onlineTtlMs: ONLINE_TTL_MS },
      repository as never,
      logger as never,
    );
  });

  describe('write coalescing', (it) => {
    it('writes on the first sighting of a device', async () => {
      // Act
      service.touch(DEVICE, 1_000);
      await vi.waitFor(() => {
        expect(repository.updateLastSeenAt).toHaveBeenCalledTimes(1);
      });

      // Assert
      expect(repository.updateLastSeenAt).toHaveBeenCalledWith(
        DEVICE,
        new Date(1_000),
      );
    });

    it('skips a second sighting inside the write interval', async () => {
      // Arrange — devices long-poll every ~30s, so without coalescing this is
      // a database write per device per poll for a timestamp nobody reads at
      // that resolution.
      service.touch(DEVICE, 1_000);
      await vi.waitFor(() => {
        expect(repository.updateLastSeenAt).toHaveBeenCalledTimes(1);
      });

      // Act
      service.touch(DEVICE, 1_000 + WRITE_INTERVAL_MS - 1);

      // Assert
      expect(repository.updateLastSeenAt).toHaveBeenCalledTimes(1);
    });

    it('writes again once the interval has elapsed', async () => {
      // Arrange
      service.touch(DEVICE, 1_000);
      await vi.waitFor(() => {
        expect(repository.updateLastSeenAt).toHaveBeenCalledTimes(1);
      });

      // Act
      service.touch(DEVICE, 1_000 + WRITE_INTERVAL_MS);

      // Assert
      await vi.waitFor(() => {
        expect(repository.updateLastSeenAt).toHaveBeenCalledTimes(2);
      });
    });

    it('coalesces per device rather than globally', async () => {
      // Arrange / Act
      service.touch(DEVICE, 1_000);
      service.touch('device-2', 1_000);

      // Assert
      await vi.waitFor(() => {
        expect(repository.updateLastSeenAt).toHaveBeenCalledTimes(2);
      });
    });

    it('retries on the next sighting when a write fails', async () => {
      // Arrange — the clock only advances on a committed write, so a database
      // blip costs one sighting rather than a whole interval of blindness.
      repository.updateLastSeenAt.mockRejectedValueOnce(new Error('db down'));
      service.touch(DEVICE, 1_000);
      await vi.waitFor(() => {
        expect(logger.warn).toHaveBeenCalledTimes(1);
      });

      // Act
      service.touch(DEVICE, 1_500);

      // Assert
      await vi.waitFor(() => {
        expect(repository.updateLastSeenAt).toHaveBeenCalledTimes(2);
      });
    });

    it('does not throw when a write fails', () => {
      // Arrange — presence is diagnostic; it must never turn a working device
      // request into a 500.
      repository.updateLastSeenAt.mockRejectedValueOnce(new Error('db down'));

      // Act / Assert
      expect(() => {
        service.touch(DEVICE, 1_000);
      }).not.toThrow();
    });

    it('writes immediately after the device is forgotten', async () => {
      // Arrange — a device deleted and re-registered inside the interval would
      // otherwise look stale until the interval elapsed.
      service.touch(DEVICE, 1_000);
      await vi.waitFor(() => {
        expect(repository.updateLastSeenAt).toHaveBeenCalledTimes(1);
      });

      // Act
      service.forget(DEVICE);
      service.touch(DEVICE, 1_100);

      // Assert
      await vi.waitFor(() => {
        expect(repository.updateLastSeenAt).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('online derivation', (it) => {
    it('counts a recent sighting as online', () => {
      // Arrange
      const now = 1_000_000;
      const seen = new Date(now - ONLINE_TTL_MS + 1);

      // Act / Assert
      expect(service.isOnline(seen, now)).toBe(true);
    });

    it('counts a sighting older than the TTL as offline', () => {
      // Arrange
      const now = 1_000_000;
      const seen = new Date(now - ONLINE_TTL_MS - 1);

      // Act / Assert
      expect(service.isOnline(seen, now)).toBe(false);
    });

    it('counts a never-seen device as offline rather than unknown', () => {
      // Arrange — "never checked in" and "has not checked in lately" mean the
      // same thing to an operator: not currently usable.

      // Act / Assert
      expect(service.isOnline(null, 1_000_000)).toBe(false);
    });
  });
});
