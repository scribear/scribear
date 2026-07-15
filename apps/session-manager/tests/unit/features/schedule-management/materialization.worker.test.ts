import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import {
  type MaterializationWorkerConfig,
  MaterializationWorker,
} from '#src/server/features/schedule-management/materialization.worker.js';
import { MaterializationFailedError } from '#src/server/features/schedule-management/schedule-management.service.js';
import { type MockLogger, createMockLogger } from '#tests/utils/mock-logger.js';

type ServiceMock = {
  materializeOneStaleRoom: ReturnType<typeof vi.fn>;
};

const BASE_CONFIG: MaterializationWorkerConfig = {
  enabled: true,
  intervalMs: 60_000,
  staleAfterMs: 24 * 60 * 60 * 1000,
  maxRoomsPerTick: 100,
};

describe('MaterializationWorker', () => {
  let logger: MockLogger;
  let service: ServiceMock;

  beforeEach(() => {
    logger = createMockLogger();
    service = { materializeOneStaleRoom: vi.fn() };
  });

  function makeWorker(
    overrides: Partial<MaterializationWorkerConfig> = {},
  ): MaterializationWorker {
    return new MaterializationWorker(
      logger as never,
      service as unknown as AppDependencies['scheduleManagementService'],
      { ...BASE_CONFIG, ...overrides },
    );
  }

  describe('drainOnce', (it) => {
    it('returns 0 immediately when no stale rooms exist', async () => {
      // Arrange
      service.materializeOneStaleRoom.mockResolvedValue(null);
      const worker = makeWorker();

      // Act
      const processed = await worker.drainOnce();

      // Assert
      expect(processed).toBe(0);
      expect(service.materializeOneStaleRoom).toHaveBeenCalledTimes(1);
    });

    it('keeps draining until the service returns null', async () => {
      // Arrange
      service.materializeOneStaleRoom
        .mockResolvedValueOnce('room-1')
        .mockResolvedValueOnce('room-2')
        .mockResolvedValueOnce('room-3')
        .mockResolvedValueOnce(null);
      const worker = makeWorker();

      // Act
      const processed = await worker.drainOnce();

      // Assert
      expect(processed).toBe(3);
      expect(service.materializeOneStaleRoom).toHaveBeenCalledTimes(4);
    });

    it('respects maxRoomsPerTick', async () => {
      // Arrange - service would keep returning rooms forever
      service.materializeOneStaleRoom.mockImplementation(async () => 'room');
      const worker = makeWorker({ maxRoomsPerTick: 5 });

      // Act
      const processed = await worker.drainOnce();

      // Assert
      expect(processed).toBe(5);
      expect(service.materializeOneStaleRoom).toHaveBeenCalledTimes(5);
    });

    it('skips rooms that fail and continues with the rest', async () => {
      // Arrange
      const cause = new Error('boom');
      service.materializeOneStaleRoom
        .mockResolvedValueOnce('room-good-1')
        .mockRejectedValueOnce(new MaterializationFailedError('room-bad', cause))
        .mockResolvedValueOnce('room-good-2')
        .mockResolvedValueOnce(null);
      const worker = makeWorker();

      // Act
      const processed = await worker.drainOnce();

      // Assert - two good rooms processed, one failed and skipped
      expect(processed).toBe(2);
      // Subsequent calls must include the failed UID in excludeUids so the
      // SKIP LOCKED query doesn't return it again on this tick.
      const lastCallArgs = service.materializeOneStaleRoom.mock.calls.at(-1);
      expect(lastCallArgs?.[2]).toEqual(['room-bad']);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ roomUid: 'room-bad', err: cause }),
        expect.any(String),
      );
    });

    it('aborts the drain when a non-MaterializationFailedError error is thrown', async () => {
      // Arrange - simulates DB connection failure during the SELECT
      service.materializeOneStaleRoom
        .mockResolvedValueOnce('room-1')
        .mockRejectedValueOnce(new Error('connection lost'));
      const worker = makeWorker();

      // Act
      const processed = await worker.drainOnce();

      // Assert - one room processed before the abort
      expect(processed).toBe(1);
      expect(service.materializeOneStaleRoom).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('drain aborted'),
      );
    });

    it('uses cutoff = now - staleAfterMs', async () => {
      // Arrange
      service.materializeOneStaleRoom.mockResolvedValue(null);
      const worker = makeWorker({ staleAfterMs: 60_000 });
      vi.useFakeTimers();
      const fixedNow = new Date('2026-01-01T12:00:00Z');
      vi.setSystemTime(fixedNow);

      // Act
      await worker.drainOnce();

      // Assert
      const [, cutoff] = service.materializeOneStaleRoom.mock.calls[0]!;
      expect((cutoff as Date).toISOString()).toBe(
        new Date(fixedNow.getTime() - 60_000).toISOString(),
      );

      // Cleanup
      vi.useRealTimers();
    });
  });

  describe('start / stop lifecycle', (it) => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('start is a no-op when disabled', () => {
      // Arrange
      const worker = makeWorker({ enabled: false });
      vi.useFakeTimers();

      // Act
      worker.start();
      vi.advanceTimersByTime(BASE_CONFIG.intervalMs * 5);

      // Assert
      expect(service.materializeOneStaleRoom).not.toHaveBeenCalled();
    });

    it('runs drainOnce on each tick', async () => {
      // Arrange
      vi.useFakeTimers();
      service.materializeOneStaleRoom.mockResolvedValue(null);
      const worker = makeWorker({ intervalMs: 1_000 });
      worker.start();

      // Act - advance one full interval and let the in-flight tick resolve
      await vi.advanceTimersByTimeAsync(1_000);

      // Assert - first tick fired and drained (returns null immediately)
      expect(service.materializeOneStaleRoom).toHaveBeenCalledTimes(1);

      // Act - advance another interval; second tick should fire
      await vi.advanceTimersByTimeAsync(1_000);

      // Assert
      expect(service.materializeOneStaleRoom).toHaveBeenCalledTimes(2);

      // Cleanup
      await worker.stop();
    });

    it('start is idempotent', async () => {
      // Arrange
      vi.useFakeTimers();
      service.materializeOneStaleRoom.mockResolvedValue(null);
      const worker = makeWorker({ intervalMs: 1_000 });

      // Act
      worker.start();
      worker.start();
      worker.start();
      await vi.advanceTimersByTimeAsync(1_000);

      // Assert - only one tick fired even though start() was called three times
      expect(service.materializeOneStaleRoom).toHaveBeenCalledTimes(1);

      // Cleanup
      await worker.stop();
    });

    it('stop awaits the in-flight tick', async () => {
      // Arrange - hold the tick open until we resolve manually
      vi.useFakeTimers();
      let resolveTick: (() => void) | null = null;
      service.materializeOneStaleRoom.mockImplementation(
        () =>
          new Promise<null>((resolve) => {
            resolveTick = () => resolve(null);
          }),
      );
      const worker = makeWorker({ intervalMs: 1_000 });
      worker.start();
      await vi.advanceTimersByTimeAsync(1_000);

      // Act - call stop while a tick is in flight
      const stopPromise = worker.stop();

      // The stop must not resolve while the tick is pending.
      let stopped = false;
      stopPromise.then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);

      // Resolve the in-flight tick.
      resolveTick!();
      await stopPromise;

      // Assert
      expect(stopped).toBe(true);
    });

    it('stop is idempotent and safe to call when never started', async () => {
      // Arrange
      const worker = makeWorker();

      // Act / Assert - none of these should throw
      await worker.stop();
      await worker.stop();
    });

    it('continues looping after a tick throws', async () => {
      // Arrange - first tick throws, subsequent ticks succeed
      vi.useFakeTimers();
      service.materializeOneStaleRoom
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValue(null);
      const worker = makeWorker({ intervalMs: 1_000 });
      worker.start();

      // Act - advance through both ticks
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      // Assert - both ticks fired despite the first one throwing
      expect(service.materializeOneStaleRoom).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('drain aborted'),
      );

      // Cleanup
      await worker.stop();
    });
  });
});
