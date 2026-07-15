import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { MaterializationFailedError } from '#src/server/features/schedule-management/schedule-management.service.js';

export interface MaterializationWorkerConfig {
  /**
   * When false, `start()` becomes a no-op. Used to disable the loop in
   * integration tests so the timer doesn't fire mid-test.
   */
  enabled: boolean;
  /** Interval between drain passes. */
  intervalMs: number;
  /**
   * Rooms with `last_materialized_at` older than `now - staleAfterMs`
   * (or null) are picked up.
   */
  staleAfterMs: number;
  /**
   * Safety cap on rooms processed per drain pass; protects against runaway
   * loops if the staleness predicate is misconfigured. Set high enough that
   * a healthy backlog clears in a single pass.
   */
  maxRoomsPerTick: number;
}

const SECOND_MS = 1000;
const HOUR_MS = 60 * 60 * SECOND_MS;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_MATERIALIZATION_WORKER_CONFIG: MaterializationWorkerConfig =
  {
    enabled: true,
    intervalMs: HOUR_MS,
    staleAfterMs: DAY_MS,
    maxRoomsPerTick: 1000,
  };

/**
 * Background loop that periodically extends the materialization horizon for
 * each room. Runs in-process; multi-instance deployments are safe because the
 * underlying `findOneStaleRoomForMaterialization` query uses
 * `FOR UPDATE SKIP LOCKED`, so each instance picks distinct rooms and API
 * writes that race with the worker either skip the locked row or block until
 * the worker's transaction commits.
 *
 * Each tick drains all currently-stale rooms (one transaction per room for
 * failure isolation), then waits `intervalMs` before the next pass. Per-room
 * errors are logged and skipped; whole-iteration errors (e.g. DB unreachable)
 * are logged and the worker waits for the next tick.
 */
export class MaterializationWorker {
  private _log: AppDependencies['logger'];
  private _scheduleService: AppDependencies['scheduleManagementService'];
  private _config: MaterializationWorkerConfig;

  private _timer: NodeJS.Timeout | null = null;
  private _running = false;
  private _inFlight: Promise<void> | null = null;

  constructor(
    logger: AppDependencies['logger'],
    scheduleManagementService: AppDependencies['scheduleManagementService'],
    materializationWorkerConfig: AppDependencies['materializationWorkerConfig'],
  ) {
    this._log = logger;
    this._scheduleService = scheduleManagementService;
    this._config = materializationWorkerConfig;
  }

  /**
   * Starts the loop. Idempotent: subsequent calls while already running are
   * no-ops.
   */
  start(): void {
    if (!this._config.enabled) {
      this._log.debug('materialization worker disabled by config');
      return;
    }
    if (this._running) return;
    this._running = true;
    this._log.info(
      {
        intervalMs: this._config.intervalMs,
        staleAfterMs: this._config.staleAfterMs,
      },
      'materialization worker started',
    );
    this._scheduleNext();
  }

  /**
   * Signals the loop to stop and waits for any in-flight tick to finish.
   * Idempotent.
   */
  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._inFlight) {
      await this._inFlight.catch(() => {
        // Tick errors are already logged inside `_runTick`.
      });
    }
    this._log.info('materialization worker stopped');
  }

  /**
   * Drains all currently-stale rooms and stamps `last_materialized_at`. Public
   * for tests; the loop calls it on a timer.
   * @returns The number of rooms processed during this drain.
   */
  async drainOnce(): Promise<number> {
    let processed = 0;
    const cutoff = new Date(Date.now() - this._config.staleAfterMs);
    // Failed rooms are excluded from subsequent picks within this drain so
    // we don't loop on the same broken row; they'll be retried on the next
    // tick once the skip set is reset.
    const failedUids: string[] = [];
    while (processed + failedUids.length < this._config.maxRoomsPerTick) {
      try {
        const uid = await this._scheduleService.materializeOneStaleRoom(
          new Date(),
          cutoff,
          failedUids,
        );
        if (uid === null) break;
        processed += 1;
      } catch (err) {
        if (err instanceof MaterializationFailedError) {
          failedUids.push(err.roomUid);
          this._log.error(
            { err: err.innerError, roomUid: err.roomUid },
            'materialization worker: room failed; skipping for this tick',
          );
          continue;
        }
        // Pre-room failure (e.g. DB unreachable, find query failed). Abort
        // the drain and let the next tick retry from scratch.
        this._log.error(
          { err },
          'materialization worker: drain aborted before locking a room',
        );
        break;
      }
    }
    if (processed > 0 || failedUids.length > 0) {
      this._log.debug(
        { processed, failed: failedUids.length },
        'materialization worker drain complete',
      );
    }
    return processed;
  }

  private _scheduleNext(): void {
    if (!this._running) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._inFlight = this._runTick().finally(() => {
        this._inFlight = null;
        this._scheduleNext();
      });
    }, this._config.intervalMs);
  }

  private async _runTick(): Promise<void> {
    try {
      await this.drainOnce();
    } catch (err) {
      this._log.error({ err }, 'materialization worker tick failed');
    }
  }
}
