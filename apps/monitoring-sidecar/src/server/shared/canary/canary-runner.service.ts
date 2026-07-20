import { readFile } from 'node:fs/promises';

import type { BaseLogger } from '@scribear/base-fastify-server';

import type { CanaryAuthClient } from '#src/server/shared/canary/canary-auth.js';
import {
  CanarySession,
  type CanarySessionConfig,
} from '#src/server/shared/canary/canary-session.js';
import {
  CanaryOutcome,
  type CanaryRunResult,
} from '#src/server/shared/canary/canary-types.js';
import {
  type AudioChunk,
  decodeWav,
  sliceIntoChunks,
} from '#src/server/shared/canary/wav.js';
import type { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';

export interface CanaryRunnerConfig extends CanarySessionConfig {
  /** Whether the canary runs at all. Off unless a device token is configured. */
  enabled: boolean;
  /** Delay between the end of one probe and the start of the next. */
  intervalMs: number;
  /** Path to the fixture WAV to stream. */
  audioPath: string;
  /**
   * Chunk duration. Must match what a real source sends (100 ms in the kiosk)
   * so the canary exercises the same framing rate as production traffic.
   */
  chunkMs: number;
  /**
   * Sample rate the session's `transcriptionStreamConfig` declares. The
   * transcription service *rejects* audio whose WAV header disagrees, so a
   * mismatch here produces decode errors rather than captions.
   */
  expectedSampleRate: number;
  expectedChannels: number;
}

/**
 * Schedules canary probes and folds their results into metrics.
 *
 * Runs are sequential, never overlapping: two canaries streaming into the same
 * session would each see the other's audio, and the accuracy score would be
 * measuring a conversation the fixture never contained.
 */
export class CanaryRunnerService {
  private _config: CanaryRunnerConfig;
  private _session: CanarySession;
  private _metrics: MetricsRegistry;
  private _logger: BaseLogger;

  private _chunks: AudioChunk[] = [];
  private _lastResult: CanaryRunResult | null = null;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _running = false;
  private _stopped = false;

  constructor(
    canaryRunnerConfig: CanaryRunnerConfig,
    canaryAuthClient: CanaryAuthClient,
    metricsRegistry: MetricsRegistry,
    logger: BaseLogger,
  ) {
    this._config = canaryRunnerConfig;
    this._metrics = metricsRegistry;
    this._logger = logger;
    this._session = new CanarySession(
      canaryRunnerConfig,
      canaryAuthClient,
      logger,
    );
  }

  /** The most recent probe, or null before the first one completes. */
  get lastResult(): CanaryRunResult | null {
    return this._lastResult;
  }

  get enabled(): boolean {
    return this._config.enabled;
  }

  /** Loads the fixture and begins probing. */
  async start(): Promise<void> {
    if (!this._config.enabled) {
      this._logger.info(
        'Canary disabled (no device token configured); A2 checks will not run.',
      );
      return;
    }

    await this._loadAudio();
    this._stopped = false;
    void this._runLoop();
  }

  stop(): void {
    this._stopped = true;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /**
   * Runs a single probe and records it. Exposed so tests can drive the canary
   * deterministically instead of waiting on the interval.
   */
  async runOnce(): Promise<CanaryRunResult> {
    if (this._running) {
      throw new Error('A canary run is already in progress.');
    }
    this._running = true;
    try {
      const result = await this._session.run(this._chunks);
      this._lastResult = result;
      this._record(result);
      return result;
    } finally {
      this._running = false;
    }
  }

  /** Loads and validates the fixture, slicing it once for reuse. */
  private async _loadAudio(): Promise<void> {
    const raw = await readFile(this._config.audioPath);
    const wav = decodeWav(raw);

    // Fail loudly at startup rather than streaming audio the transcription
    // service will reject frame by frame. A silent format mismatch would look
    // exactly like a broken pipeline, and the canary would blame the system
    // for its own misconfiguration.
    if (wav.sampleRate !== this._config.expectedSampleRate) {
      throw new Error(
        `Canary audio is ${String(wav.sampleRate)} Hz but the session expects ${String(this._config.expectedSampleRate)} Hz; the transcription service will reject every frame.`,
      );
    }
    if (wav.channels !== this._config.expectedChannels) {
      throw new Error(
        `Canary audio has ${String(wav.channels)} channel(s) but the session expects ${String(this._config.expectedChannels)}.`,
      );
    }

    this._chunks = sliceIntoChunks(wav, this._config.chunkMs);
    this._logger.info(
      {
        audioPath: this._config.audioPath,
        durationMs: Math.round(wav.durationMs),
        chunks: this._chunks.length,
      },
      'canary audio loaded',
    );
  }

  private async _runLoop(): Promise<void> {
    // `for (;;)` with the stop check after the run, rather than
    // `while (!this._stopped)`: the flag is flipped by `stop()` while this
    // function is suspended on an await, which narrowing-based control flow
    // analysis cannot see.
    for (;;) {
      try {
        const result = await this.runOnce();
        this._logger.info(
          {
            outcome: result.outcome,
            transcripts: result.transcriptCount,
            recall: result.accuracy?.recall,
            ttftMs: result.timeToFirstTranscriptMs,
          },
          'canary run complete',
        );
      } catch (err) {
        // A throw here means the runner itself broke, not the pipeline. Record
        // it so the failure is visible rather than silently ending the loop.
        this._logger.error({ err }, 'canary run threw');
        this._metrics.canaryRunsTotal.inc({ outcome: CanaryOutcome.ERROR });
      }

      if (this._stopped) return;
      await new Promise<void>((resolve) => {
        this._timer = setTimeout(resolve, this._config.intervalMs);
        this._timer.unref();
      });
    }
  }

  /** Folds one result into the metric registry. */
  private _record(result: CanaryRunResult): void {
    const at = result.startedAtMs;
    this._metrics.canaryRunsTotal.inc({ outcome: result.outcome }, 1, at);

    // `NO_SESSION` means there was nothing to measure. Recording zeros for it
    // would drag every gauge down overnight and make the dashboard read as an
    // outage whenever the canary room is simply idle.
    if (result.outcome === CanaryOutcome.NO_SESSION) {
      this._metrics.canaryUp.set({}, 1);
      return;
    }

    this._metrics.canaryUp.set({}, result.outcome === CanaryOutcome.OK ? 1 : 0);
    this._metrics.canaryTranscriptsTotal.inc({}, result.transcriptCount, at);

    if (result.timeToFirstTranscriptMs !== null) {
      this._metrics.canaryTimeToFirstTranscriptMs.observe(
        result.timeToFirstTranscriptMs,
      );
    }
    if (result.accuracy !== null) {
      this._metrics.canaryAccuracyRecall.set({}, result.accuracy.recall);
      this._metrics.canaryAccuracyPrecision.set({}, result.accuracy.precision);
    }
    if (result.repetitionRatio !== null) {
      this._metrics.canaryRepetitionRatio.set({}, result.repetitionRatio);
    }
    if (result.pipelineMsP95 !== null) {
      this._metrics.canaryPipelineMsP95.set({}, result.pipelineMsP95);
    }
    if (result.e2eMsP95 !== null) {
      this._metrics.canaryE2eMsP95.set({}, result.e2eMsP95);
    }
    this._metrics.canaryClockSyncOk.set(
      {},
      result.clockSyncEstablished ? 1 : 0,
    );
  }
}
