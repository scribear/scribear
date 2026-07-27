import type { BaseLogger } from '@scribear/base-fastify-server';
import {
  type ClipId,
  DeviceAuthClient,
  type DeviceAuthConfig,
  FAULT_PARAM_DEFAULTS,
  FaultEngine,
  type FaultParams,
  GOOD_PARAM_DEFAULTS,
  GoodEngine,
  type GoodParams,
  clampFaultParams,
  clampGoodParams,
  createSeededRng,
} from '@scribear/test-audio-source';

import type { ClipCatalogService } from '#src/server/shared/clips/clip-catalog.service.js';
import {
  DeviceRunner,
  type DeviceRunnerConfig,
} from '#src/server/shared/devices/device-runner.js';
import type {
  DeviceId,
  DeviceState,
} from '#src/server/shared/devices/device-state.js';

/**
 * Owns the two devices and is the only thing the controller talks to.
 *
 * One runner each, constructed once and kept for the process lifetime. The
 * engines in particular must outlive a run: `GoodEngine` carries the brown
 * noise integrator's state, and rebuilding it per run would put a seam in the
 * noise floor every time an operator pressed start.
 */

export interface DeviceRunManagerConfig extends DeviceRunnerConfig {
  /**
   * Per-device token, `{deviceUid}:{secret}`, **derived** from
   * `TEST_AUDIO_DEVICE_SECRET` and the device's fixed uid rather than
   * configured. Empty means no secret is set: the device reports
   * `configured: false` and refuses to start.
   *
   * SECURITY: a device token reaches **only its own device's room**. That is
   * the entire safety boundary for these two devices — neither has any way to
   * name another room — so the device-to-room assignment decides, permanently
   * and by construction, which room synthetic audio can ever reach. That
   * assignment is now seeded by the Session Manager under a reserved uid, which
   * is stronger than an operator making it by hand: there is no argument to
   * point at the wrong room, and room-management refuses to move either device
   * out of its own room afterwards.
   */
  deviceTokens: Record<DeviceId, string>;
  /** Base config for {@link DeviceAuthClient}; the token is filled per device. */
  deviceAuth: Omit<DeviceAuthConfig, 'deviceToken'>;
  /**
   * The clip the `fault` device streams.
   *
   * Fixed rather than a knob because `FaultParams` has none: PLAN §2.2 is one
   * knob per fault and nothing else, so that every parameter on that card maps
   * to something the stack reports. The choice of source material is not a
   * fault, so it is configuration.
   */
  faultClip: ClipId;
  /** Seed for the fault engine's draws, so a reported run can be reproduced. */
  rngSeed: number;
  /** How often the devices re-read which room they belong to. */
  roomRefreshMs: number;
}

export class DeviceRunManagerService {
  private _good: DeviceRunner<GoodParams>;
  private _fault: DeviceRunner<FaultParams>;
  private _logger: BaseLogger;
  private _roomRefreshMs: number;
  private _roomTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    deviceRunManagerConfig: DeviceRunManagerConfig,
    clipCatalogService: ClipCatalogService,
    logger: BaseLogger,
  ) {
    this._logger = logger;
    this._roomRefreshMs = deviceRunManagerConfig.roomRefreshMs;

    const runnerConfig: DeviceRunnerConfig = {
      stream: deviceRunManagerConfig.stream,
      maxDurationSec: deviceRunManagerConfig.maxDurationSec,
    };
    const authFor = (deviceId: DeviceId): DeviceAuthClient | null => {
      const deviceToken = deviceRunManagerConfig.deviceTokens[deviceId];
      if (deviceToken === '') return null;
      return new DeviceAuthClient({
        ...deviceRunManagerConfig.deviceAuth,
        deviceToken,
      });
    };

    this._good = new DeviceRunner<GoodParams>({
      deviceId: 'good',
      engine: new GoodEngine(
        GOOD_PARAM_DEFAULTS,
        createSeededRng(deviceRunManagerConfig.rngSeed),
      ),
      clamp: clampGoodParams,
      resolveClip: (params) => params.clip,
      auth: authFor('good'),
      clips: clipCatalogService,
      config: runnerConfig,
      logger,
    });

    this._fault = new DeviceRunner<FaultParams>({
      deviceId: 'fault',
      engine: new FaultEngine(
        FAULT_PARAM_DEFAULTS,
        // A different seed from the `good` device's, so that two devices run
        // together do not draw the same sequence. They gate different things,
        // but identical streams would make a coincidence look like a cause.
        createSeededRng(deviceRunManagerConfig.rngSeed ^ 0x5f5f5f5f),
      ),
      clamp: clampFaultParams,
      resolveClip: () => deviceRunManagerConfig.faultClip,
      auth: authFor('fault'),
      clips: clipCatalogService,
      config: runnerConfig,
      logger,
    });

    for (const runner of this._runners()) {
      if (!runner.configured) {
        logger.info(
          { deviceId: runner.deviceId },
          'test-audio device has no token configured; it will report configured:false and refuse to start',
        );
      }
    }
  }

  /** Both devices, in the order the operator's page lays them out. */
  list(): DeviceState[] {
    return this._runners().map((runner) => runner.snapshot());
  }

  start(
    deviceId: DeviceId,
    params: Record<string, unknown>,
    durationSec: number,
  ): DeviceState {
    // `Record<string, unknown>` rather than a union of the two partials: the
    // device is named in the path, so the body's half is not known statically,
    // and TypeScript happens to accept the assignment either way. The type is
    // therefore not what makes this safe. Two things are: the controller has
    // already rejected any key this device does not have, and the runner clamps
    // every value through `params.ts` before the engine sees it — which is
    // exactly why that clamping lives in the library rather than at the HTTP
    // edge.
    return deviceId === 'good'
      ? this._good.start(params, durationSec)
      : this._fault.start(params, durationSec);
  }

  stop(deviceId: DeviceId): Promise<DeviceState> {
    return this._runner(deviceId).stop();
  }

  updateParams(
    deviceId: DeviceId,
    params: Record<string, unknown>,
  ): DeviceState {
    return deviceId === 'good'
      ? this._good.updateParams(params)
      : this._fault.updateParams(params);
  }

  /** True once at least one device has answered — the readiness signal. */
  get anyConfigured(): boolean {
    return this._runners().some((runner) => runner.configured);
  }

  /**
   * Reads each device's room now, and keeps re-reading it.
   *
   * On an interval rather than per request: `GET /devices` is polled every 3 s
   * by an open admin page, and hanging two session-manager round trips off each
   * poll would make the operator's panel as slow as the slowest of them, to
   * report a value that changes only when someone re-provisions a device.
   */
  startRoomRefresh(): void {
    void this.refreshRooms();
    this._roomTimer = setInterval(() => {
      void this.refreshRooms();
    }, this._roomRefreshMs);
    this._roomTimer.unref();
  }

  /** Exposed so a test can drive the refresh without waiting on the interval. */
  async refreshRooms(): Promise<void> {
    await Promise.all(this._runners().map((runner) => runner.refreshRoom()));
  }

  /**
   * Stops both devices and the refresh. Called from the `onClose` hook.
   *
   * A shutdown that left a run going would keep frames on the wire from a
   * process that is no longer answering for them, and the sockets would die
   * with the container rather than closing.
   */
  async shutdown(): Promise<void> {
    if (this._roomTimer !== null) {
      clearInterval(this._roomTimer);
      this._roomTimer = null;
    }
    await Promise.all(this._runners().map((runner) => runner.stop()));
    this._logger.info('test-audio devices stopped');
  }

  private _runners(): [DeviceRunner<GoodParams>, DeviceRunner<FaultParams>] {
    return [this._good, this._fault];
  }

  private _runner(
    deviceId: DeviceId,
  ): DeviceRunner<GoodParams> | DeviceRunner<FaultParams> {
    return deviceId === 'good' ? this._good : this._fault;
  }
}
