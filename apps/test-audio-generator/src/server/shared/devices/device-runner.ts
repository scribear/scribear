import type { BaseLogger } from '@scribear/base-fastify-server';
import { HttpError } from '@scribear/base-fastify-server';
import type {
  AudioChunk,
  ChunkPlanner,
  ClipId,
  DeviceAuthClient,
  FaultParams,
  GoodParams,
  StreamCounters,
  TestAudioStreamConfig,
} from '@scribear/test-audio-source';
import { TestAudioStream } from '@scribear/test-audio-source';

import type {
  DeviceId,
  DeviceState,
  RunState,
} from '#src/server/shared/devices/device-state.js';

/**
 * One device: its parameters, its state machine, and the run it is in.
 *
 * Everything about *what* the device sends lives in its engine, which came from
 * `libs/test-audio-source`. Everything here is about the run: claiming the
 * device, bounding it, reporting it, and giving it back.
 */

/** What a runner needs of a device's engine. Both library engines satisfy it. */
export interface DeviceEngine<TParams> extends ChunkPlanner {
  readonly params: TParams;
  setParams(params: TParams): void;
}

/**
 * What a runner needs of the clip catalog.
 *
 * Narrower than `ClipCatalogService` on purpose: the catalog's real work is
 * reading files and building the longform clip, none of which belongs in a test
 * about who may start a device. A structural type is also the only kind a stand-
 * in can satisfy, since a class with private fields is not assignable from one.
 */
export interface ClipSource {
  load(clip: ClipId): Promise<readonly AudioChunk[]>;
}

export interface DeviceRunnerConfig {
  stream: TestAudioStreamConfig;
  /**
   * Hard ceiling on `durationSec`, from `TEST_AUDIO_MAX_DURATION_SEC`.
   *
   * The authoritative cap: admin-server's schema rejects only absurd values, on
   * the stated principle that the cap belongs to the process that has to honour
   * it. Nothing else stops a device streaming into a room overnight.
   */
  maxDurationSec: number;
}

/** The live run. Absent means the device is not on the audio path. */
interface ActiveRun {
  stream: TestAudioStream;
  startedAtMs: number;
  expiresAtMs: number;
  autoStop: ReturnType<typeof setTimeout>;
  /**
   * Set by `stop()` and by the auto-stop timer.
   *
   * Needed in addition to `TestAudioStream.stop()` because that method's flag
   * is reset at the top of `run()`: a stop arriving while the clip is still
   * loading would otherwise be forgotten the moment the stream actually
   * started. Checked immediately before `run()` is called.
   */
  stopRequested: boolean;
  done: Promise<void>;
}

/** What a finished run left behind, kept until the next start clears it. */
interface LastRun {
  counters: StreamCounters;
  sessionUid: string | null;
  startedAtMs: number;
  expiresAtMs: number;
  error: string | null;
}

export class DeviceRunner<TParams extends GoodParams | FaultParams> {
  private _deviceId: DeviceId;
  private _engine: DeviceEngine<TParams>;
  private _clamp: (patch: Partial<TParams>) => TParams;
  private _resolveClip: (params: TParams) => ClipId;
  /** Null when no device token is configured; the device then cannot start. */
  private _auth: DeviceAuthClient | null;
  private _clips: ClipSource;
  private _config: DeviceRunnerConfig;
  private _logger: BaseLogger;

  private _run: ActiveRun | null = null;
  private _lastRun: LastRun | null = null;
  private _roomName: string | null = null;

  constructor(options: {
    deviceId: DeviceId;
    engine: DeviceEngine<TParams>;
    clamp: (patch: Partial<TParams>) => TParams;
    resolveClip: (params: TParams) => ClipId;
    auth: DeviceAuthClient | null;
    clips: ClipSource;
    config: DeviceRunnerConfig;
    logger: BaseLogger;
  }) {
    this._deviceId = options.deviceId;
    this._engine = options.engine;
    this._clamp = options.clamp;
    this._resolveClip = options.resolveClip;
    this._auth = options.auth;
    this._clips = options.clips;
    this._config = options.config;
    this._logger = options.logger;
  }

  get deviceId(): DeviceId {
    return this._deviceId;
  }

  get configured(): boolean {
    return this._auth !== null;
  }

  /** True while the device is on the audio path, in either running state. */
  get running(): boolean {
    return this._run !== null;
  }

  /**
   * Starts a bounded run and returns immediately.
   *
   * Synchronous up to the point the device is claimed, deliberately: an
   * operator's second click, or a retry after a slow response, must find the
   * device already busy rather than slip past the check while the first request
   * was awaiting a clip load. Everything after the claim — loading audio,
   * finding the session, opening sockets — happens in the background and is
   * reported as `connecting`.
   *
   * @throws 422 `DEVICE_NOT_CONFIGURED`, 409 `DEVICE_BUSY`, 422 `DURATION_TOO_LONG`
   */
  start(patch: Partial<TParams>, durationSec: number): DeviceState {
    const auth = this._auth;
    if (auth === null) {
      throw HttpError.unprocessable(
        'DEVICE_NOT_CONFIGURED',
        `No device token is configured for the "${this._deviceId}" source, so it has nothing to authenticate as. Provision it with deployment/provision-test-audio.sh.`,
      );
    }
    if (this._run !== null) {
      throw HttpError.conflict(
        'DEVICE_BUSY',
        `The "${this._deviceId}" source is already running. Stop it before starting a new run, or retune it in place with PATCH /params.`,
      );
    }
    if (durationSec > this._config.maxDurationSec) {
      throw HttpError.unprocessable(
        'DURATION_TOO_LONG',
        `A run may last at most ${String(this._config.maxDurationSec)}s (TEST_AUDIO_MAX_DURATION_SEC); ${String(durationSec)}s was requested.`,
        { maxDurationSec: this._config.maxDurationSec },
      );
    }

    const params = this._clamp({ ...this._engine.params, ...patch });
    this._engine.setParams(params);
    this._lastRun = null;

    const startedAtMs = Date.now();
    const expiresAtMs = startedAtMs + durationSec * 1000;
    const stream = new TestAudioStream(
      this._config.stream,
      auth,
      this._engine,
      this._logger,
    );

    const run: ActiveRun = {
      stream,
      startedAtMs,
      expiresAtMs,
      // Replaced below; assigning after construction keeps `_execute` able to
      // reference the same object it is told to finish.
      done: Promise.resolve(),
      stopRequested: false,
      // The auto-stop, and it is unconditional: it is armed here, before any
      // I/O, and nothing in the request path can cancel it except a stop. A
      // device whose operator walked away, whose BFF was redeployed, or whose
      // admin session expired still ends on time.
      autoStop: setTimeout(() => {
        this._requestStop(run, 'run reached its duration');
      }, durationSec * 1000),
    };
    // Never hold the process open for a run that is going to be cut short
    // anyway; shutdown stops every device explicitly.
    run.autoStop.unref();
    this._run = run;
    run.done = this._execute(run, this._resolveClip(params));

    this._logger.info(
      { deviceId: this._deviceId, durationSec, params },
      'test-audio run starting',
    );
    return this.snapshot();
  }

  /**
   * Stops a run, or clears a failed one.
   *
   * Idempotent and never an error: the operator's remedy for a device in an
   * unexpected state is this button, and a stop that 409s on an already-stopped
   * device would take the remedy away exactly when it is wanted. On an idle
   * device it clears a recorded error and answers with the current state.
   */
  async stop(): Promise<DeviceState> {
    const run = this._run;
    if (run === null) {
      if (this._lastRun !== null) this._lastRun.error = null;
      return this.snapshot();
    }

    this._requestStop(run, 'stopped by an operator');
    // Awaited so the caller's answer describes a device that has actually left
    // the audio path, rather than one that is about to. The wait is bounded by
    // the send loop's chunk interval.
    await run.done;
    return this.snapshot();
  }

  /**
   * Retunes the device.
   *
   * Applies to a running device without restarting the stream — the point of
   * the feature is turning a knob and watching a meter move, and a restart
   * would drop the session and lose everything the operator was watching. On an
   * idle device the same call updates the parameters the next run will start
   * with, so the SPA's controls mean the same thing in both states.
   *
   * Note `clip` on the `good` device is the one parameter a live retune cannot
   * honour, because the chunks were sliced at start; it takes effect on the
   * next run. Every other knob is read per chunk by the engine.
   */
  updateParams(patch: Partial<TParams>): DeviceState {
    const params = this._clamp({ ...this._engine.params, ...patch });
    this._engine.setParams(params);
    this._logger.info(
      { deviceId: this._deviceId, patch, running: this.running },
      'test-audio device retuned',
    );
    return this.snapshot();
  }

  /**
   * Re-reads the room this device's token reaches. Best effort, never throws.
   *
   * The room assignment is the entire safety boundary, so it is worth showing
   * on the operator's screen before they press start rather than only after.
   * A failure leaves the previous answer in place: a momentarily unreachable
   * session-manager should not make the panel claim the device has no room.
   */
  async refreshRoom(): Promise<void> {
    const auth = this._auth;
    if (auth === null) return;
    try {
      const room = await auth.findMyRoom();
      this._roomName = room.name;
    } catch (err) {
      this._logger.debug(
        { err, deviceId: this._deviceId },
        'could not read the test-audio device room',
      );
    }
  }

  /** Everything the control API reports about this device. */
  snapshot(): DeviceState {
    const run = this._run;
    const counters = run?.stream.counters ?? this._lastRun?.counters ?? null;

    return {
      deviceId: this._deviceId,
      configured: this.configured,
      state: this._state(),
      params: this._engine.params,
      sessionUid: run?.stream.sessionUid ?? this._lastRun?.sessionUid ?? null,
      roomName: this._roomName,
      startedAtMs: run?.startedAtMs ?? this._lastRun?.startedAtMs ?? null,
      expiresAtMs: run?.expiresAtMs ?? this._lastRun?.expiresAtMs ?? null,
      framesSent: counters?.framesSent ?? 0,
      framesFaulted: counters?.framesFaulted ?? 0,
      transcriptCount: counters?.transcriptCount ?? 0,
      lastTranscript: counters?.lastTranscript ?? null,
      error: this._lastRun?.error ?? null,
    };
  }

  /**
   * Derived rather than stored.
   *
   * `connecting` and `streaming` differ by exactly one observable — whether a
   * frame has reached the wire — so reading it off the counter is both simpler
   * and impossible to get out of step with, which a separately-assigned field
   * would not be.
   */
  private _state(): RunState {
    const run = this._run;
    if (run !== null) {
      return run.stream.counters.framesSent > 0 ? 'streaming' : 'connecting';
    }
    return this._lastRun?.error != null ? 'error' : 'idle';
  }

  private _requestStop(run: ActiveRun, reason: string): void {
    if (run.stopRequested) return;
    run.stopRequested = true;
    clearTimeout(run.autoStop);
    run.stream.stop();
    this._logger.info(
      { deviceId: this._deviceId, reason },
      'test-audio run stopping',
    );
  }

  /**
   * The run itself. Never throws: a rejected promise here would be an unhandled
   * rejection (nothing awaits it on the start path) and would leave the device
   * claimed forever.
   */
  private async _execute(run: ActiveRun, clip: ClipId): Promise<void> {
    let error: string | null = null;
    try {
      const chunks = await this._clips.load(clip);
      // The stop that arrived while the clip was loading. Checked here rather
      // than relying on `TestAudioStream.stop()`, which clears its own flag at
      // the top of `run()`.
      if (!run.stopRequested) {
        // `expiresAtMs` is passed as the deadline as well as being armed as a
        // timer: the send loop checks it every chunk, so the run ends on time
        // even if the timer was never able to fire.
        const result = await run.stream.run(chunks, run.expiresAtMs);
        error = result.error;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(run.autoStop);
      this._lastRun = {
        counters: run.stream.counters,
        sessionUid: run.stream.sessionUid,
        startedAtMs: run.startedAtMs,
        expiresAtMs: run.expiresAtMs,
        error,
      };
      // Only if this is still the current run: a start that raced a stop must
      // not have its successor cleared out from under it.
      if (this._run === run) this._run = null;

      if (error === null) {
        this._logger.info(
          { deviceId: this._deviceId, ...run.stream.counters },
          'test-audio run finished',
        );
      } else {
        this._logger.warn(
          { deviceId: this._deviceId, err: error },
          'test-audio run ended with an error',
        );
      }
    }
  }
}
