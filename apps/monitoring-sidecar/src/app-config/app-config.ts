import envSchema from 'env-schema';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { LogLevel } from '@scribear/base-fastify-server';

import {
  type AlertThresholds,
  DEFAULT_THRESHOLDS,
} from '#src/server/shared/alerts/alert-rules.js';
import type { CanaryAuthConfig } from '#src/server/shared/canary/canary-auth.js';
import type { CanaryRunnerConfig } from '#src/server/shared/canary/canary-runner.service.js';
import type { NodeStatusPollerConfig } from '#src/server/shared/node-status/node-status-poller.service.js';
import type {
  ProbePollerConfig,
  ProbeTarget,
} from '#src/server/shared/probes/probe-poller.service.js';
import { parseJobPeriods } from '#src/server/shared/transcription-metrics/job-period-config.js';
import type { TranscriptionMetricsPollerConfig } from '#src/server/shared/transcription-metrics/transcription-metrics-poller.service.js';

const SECOND_MS = 1_000;

/**
 * A numeric threshold that `compose.yml` may pass through as an **empty string**.
 *
 * Compose has no way to omit a key conditionally, so a variable an operator has
 * not set arrives as `""`. Left as `Type.Number` that is fatal - ajv rejects it
 * and the sidecar refuses to boot - and the obvious fix, repeating the default in
 * `compose.yml`, puts the number in two places that then drift. Empty therefore
 * means "use the default", and the defaults stay solely in
 * {@link DEFAULT_THRESHOLDS}, next to the measurements that justify them.
 */
const OPTIONAL_NUMBER = Type.Union(
  [Type.Number({ minimum: 0 }), Type.Literal('')],
  {
    default: '',
  },
);

/** Falls back to the compiled default when compose passed an empty string. */
function threshold(value: number | '', fallback: number): number {
  return value === '' ? fallback : value;
}

const CONFIG_SCHEMA = Type.Object({
  LOG_LEVEL: Type.Enum(LogLevel),
  PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
  HOST: Type.String(),

  /**
   * Per-provider job periods, `whisper=500,lumen_granite=3000`, matching
   * `job_period_ms` **per provider** in the deployed provider_config.json.
   *
   * A map and not a single integer, and with no default, because that is what
   * this field is on the other side: the CUDA template ships whisper at 500 ms
   * and lumen_granite at 3000 ms in the same file, so one global number is wrong
   * for at least one of them. It used to default to 1000, which matched neither,
   * and the only symptom was a `scribear_asr_period_utilization` series scaled by
   * 2x and 0.33x respectively — no error, no warning.
   *
   * Empty (the default) means no period is stated and no period-utilization
   * series is published; a provider absent from the map is likewise skipped
   * rather than guessed at. Nothing else is affected: `asrRtf` and the T1
   * duty-ratio alert are measured by transcription-service itself. See
   * {@link parseJobPeriods} for the format and for why a bare number is rejected.
   */
  TRANSCRIPTION_JOB_PERIOD_MS: Type.String({ default: '' }),

  // Probe polling (A3)
  PROBE_INTERVAL_SEC: Type.Integer({ minimum: 1, default: 10 }),
  PROBE_TIMEOUT_SEC: Type.Integer({ minimum: 1, default: 5 }),
  NODE_SERVER_BASE_URL: Type.String({ default: 'http://node-server:80' }),
  SESSION_MANAGER_BASE_URL: Type.String({
    default: 'http://session-manager:80',
  }),
  ADMIN_SERVER_BASE_URL: Type.String({ default: 'http://admin-server:80' }),
  TRANSCRIPTION_SERVICE_BASE_URL: Type.String({
    default: 'http://transcription-service:80',
  }),

  // node-server status polling (B1.1)
  /**
   * Must match node-server's `NODE_SERVER_SERVICE_API_KEY`. Empty disables
   * status polling entirely, which leaves the connection, upstream, auth and
   * latency-quality metrics empty — they have no other source since the log
   * parsers for them were retired.
   */
  NODE_SERVER_SERVICE_API_KEY: Type.String({ default: '' }),
  /**
   * Status poll cadence. Defaults to the probe interval: the two answer
   * adjacent questions ("is it up" / "what is it doing") and there is no reason
   * for them to drift apart unless a deployment finds the status payload
   * expensive.
   */
  NODE_STATUS_INTERVAL_SEC: Type.Integer({ minimum: 1, default: 10 }),

  // transcription-service metrics polling (B1.2)
  /**
   * Must match transcription-service's `METRICS_API_KEY`. Empty disables the
   * poll, which leaves job timings, RTF, worker utilization and the
   * buffer-overflow counters empty — they have no other source since the log
   * parsers for them were retired.
   *
   * The service leaves the route unregistered when *its* key is empty, so a key
   * set here but not there produces a 404, reported as the `not-found` poll
   * reason rather than as an auth failure.
   */
  TRANSCRIPTION_SERVICE_METRICS_KEY: Type.String({ default: '' }),
  TRANSCRIPTION_METRICS_INTERVAL_SEC: Type.Integer({ minimum: 1, default: 10 }),

  // Alert thresholds (§4 defaults; every one is deployment-tunable)
  ALERT_RATE_WINDOW_SEC: Type.Integer({ minimum: 1, default: 120 }),
  ALERT_UPSTREAM_CHURN_COUNT: Type.Integer({ minimum: 1, default: 3 }),
  ALERT_DECODE_DROP_COUNT: Type.Integer({ minimum: 1, default: 10 }),
  ALERT_BUFFER_OVERFLOW_COUNT: Type.Integer({ minimum: 1, default: 5 }),
  ALERT_RTF_P95: Type.Number({ minimum: 0, default: 1.0 }),
  /**
   * Mean RTF (duty ratio) over `ALERT_RATE_WINDOW_SEC` at or above which the T1
   * early warning fires. Must stay below `ALERT_RTF_P95` to be worth anything —
   * the point is to fire while captions are still on time.
   */
  ALERT_ASR_DUTY_RATIO: OPTIONAL_NUMBER,
  ALERT_ASR_DUTY_RATIO_MIN_JOBS: Type.Integer({ minimum: 1, default: 20 }),
  /**
   * Share of a provider's job periods that may be dropped — no pass ran in them
   * at all, because the previous pass overran — over `ALERT_RATE_WINDOW_SEC`
   * before the T1 tail warning fires.
   *
   * **Reasoned, not measured**, unlike `ALERT_ASR_DUTY_RATIO` beside it: it is
   * set to the 1% the p99 RTF fallback path implies, so the alert means the same
   * thing whichever signal produced it.
   */
  ALERT_ASR_DROPPED_PERIOD_RATIO: OPTIONAL_NUMBER,
  /**
   * Minimum passes observed in the window before that share — or the reported
   * p99 RTF standing in for it — is believed. Higher than
   * `ALERT_ASR_DUTY_RATIO_MIN_JOBS` because a p99 over 24 samples is just the
   * single worst pass, and because it is what stops a 1% share firing on one
   * dropped period. Raising `ALERT_RATE_WINDOW_SEC` is the way to bring a
   * long-period provider above it.
   */
  ALERT_ASR_TAIL_MIN_JOBS: OPTIONAL_NUMBER,
  /**
   * Reported p99 RTF at or above which the tail warning fires for a
   * transcription-service too old to report dropped periods. Not the 1.0
   * realtime line, which measured as routine: a healthy single session reported
   * p99 2.17 while captioning correctly.
   */
  ALERT_ASR_TAIL_P99_RTF: Type.Number({ minimum: 0, default: 3.0 }),
  ALERT_PROBE_FAILURE_THRESHOLD: Type.Integer({ minimum: 1, default: 2 }),
  ALERT_AUTH_FAILURE_RATIO: Type.Number({
    minimum: 0,
    maximum: 1,
    default: 0.5,
  }),
  ALERT_AUTH_FAILURE_MIN_SAMPLES: Type.Integer({ minimum: 1, default: 5 }),
  ALERT_CLOCK_SKEW_RATIO: Type.Number({ minimum: 0, maximum: 1, default: 0.2 }),
  ALERT_CLOCK_SKEW_MIN_SAMPLES: Type.Integer({ minimum: 1, default: 20 }),
  ALERT_PENDING_EVICTION_COUNT: Type.Integer({ minimum: 1, default: 10 }),
  ALERT_CANARY_FIRST_TRANSCRIPT_MS: Type.Integer({
    minimum: 1,
    default: 15_000,
  }),
  ALERT_CANARY_MIN_RECALL: Type.Number({
    minimum: 0,
    maximum: 1,
    default: 0.5,
  }),
  ALERT_CANARY_MAX_REPETITION_RATIO: Type.Number({
    minimum: 0,
    maximum: 1,
    default: 0.8,
  }),

  /**
   * The standalone audio meter page (A4), served as a convenience by the
   * sidecar. The page lives in the shared `libs/audio-meter-page/` directory so
   * admin-webapp can serve the same file through its own nginx without a second
   * copy; this path is relative to the process working directory, which is the
   * repo root in dev and the package's WORKDIR in the container.
   */
  AUDIO_METER_PATH: Type.String({
    default: '../../libs/audio-meter-page/audio-meter.html',
  }),

  // Synthetic canary (A2)
  /**
   * The canary device's `DEVICE_TOKEN` cookie value, in `{deviceUid}:{secret}`
   * form. Empty disables the canary entirely — it is the only credential the
   * canary holds, and without it there is nothing to authenticate as.
   *
   * Obtain it by registering a device via the admin API and calling
   * `activate-device`; the response sets the cookie. See `.env.example`.
   */
  CANARY_DEVICE_TOKEN: Type.String({ default: '' }),
  /** Seconds between the end of one probe and the start of the next. */
  CANARY_INTERVAL_SEC: Type.Integer({ minimum: 10, default: 300 }),
  /** How long each probe streams audio for. */
  CANARY_RUN_DURATION_SEC: Type.Integer({ minimum: 1, default: 40 }),
  /** Grace period after the last frame for trailing transcripts. */
  CANARY_DRAIN_SEC: Type.Integer({ minimum: 1, default: 10 }),
  /** How long to wait for sockets to open and the upstream to report ready. */
  CANARY_UPSTREAM_WAIT_SEC: Type.Integer({ minimum: 1, default: 20 }),
  CANARY_AUDIO_PATH: Type.String({
    default: '/app/test_audio_files/speech/harvard_16k_mono.wav',
  }),
  /**
   * Ground-truth text for the audio, used by the accuracy proxy. Read from a
   * file so a deployment can swap the fixture without a rebuild.
   */
  CANARY_TRANSCRIPT_PATH: Type.String({
    default: '/app/test_audio_files/speech/harvard_16k_mono.txt',
  }),
  /**
   * Chunk duration. 100 ms matches the kiosk's `AUDIO_CHUNK_MS`, so the canary
   * frames audio at the same rate production sources do.
   */
  CANARY_CHUNK_MS: Type.Integer({ minimum: 10, default: 100 }),
  /**
   * Must equal the `sample_rate` / `num_channels` in the canary session's
   * `transcriptionStreamConfig`. The transcription service raises on any
   * mismatch rather than resampling, so a wrong value here means every frame
   * is rejected.
   */
  CANARY_SAMPLE_RATE: Type.Integer({ minimum: 1, default: 16_000 }),
  CANARY_CHANNELS: Type.Integer({ minimum: 1, default: 1 }),
});

export interface BaseConfig {
  isDevelopment: boolean;
  logLevel: LogLevel;
  port: number;
  host: string;
}

export class AppConfig {
  private _isDevelopment: boolean;
  private _env: Static<typeof CONFIG_SCHEMA>;

  get baseConfig(): BaseConfig {
    return {
      isDevelopment: this._isDevelopment,
      logLevel: this._env.LOG_LEVEL,
      port: this._env.PORT,
      host: this._env.HOST,
    };
  }

  get probePollerConfig(): ProbePollerConfig {
    const targets: ProbeTarget[] = [
      {
        service: 'node-server',
        livenessUrl: `${this._env.NODE_SERVER_BASE_URL}/api/node-server/v1/probes/liveness`,
        readinessUrl: `${this._env.NODE_SERVER_BASE_URL}/api/node-server/v1/probes/readiness`,
      },
      {
        service: 'session-manager',
        livenessUrl: `${this._env.SESSION_MANAGER_BASE_URL}/api/session-manager/v1/probes/liveness`,
        readinessUrl: `${this._env.SESSION_MANAGER_BASE_URL}/api/session-manager/v1/probes/readiness`,
      },
      {
        service: 'admin-server',
        livenessUrl: `${this._env.ADMIN_SERVER_BASE_URL}/api/admin/v1/probes/liveness`,
        readinessUrl: `${this._env.ADMIN_SERVER_BASE_URL}/api/admin/v1/probes/readiness`,
      },
      {
        // transcription-service mounts its probes at the root, with no
        // /api/<service>/v1 prefix, unlike every Node service.
        service: 'transcription-service',
        livenessUrl: `${this._env.TRANSCRIPTION_SERVICE_BASE_URL}/probes/liveness`,
        readinessUrl: `${this._env.TRANSCRIPTION_SERVICE_BASE_URL}/probes/readiness`,
      },
    ];

    return {
      intervalMs: this._env.PROBE_INTERVAL_SEC * SECOND_MS,
      timeoutMs: this._env.PROBE_TIMEOUT_SEC * SECOND_MS,
      targets,
    };
  }

  get nodeStatusPollerConfig(): NodeStatusPollerConfig {
    return {
      // Fail closed. Polling without a key would 401 on every interval
      // forever, and node-server would log an auth failure each time.
      enabled: this._env.NODE_SERVER_SERVICE_API_KEY.length > 0,
      intervalMs: this._env.NODE_STATUS_INTERVAL_SEC * SECOND_MS,
      timeoutMs: this._env.PROBE_TIMEOUT_SEC * SECOND_MS,
      service: 'node-server',
      statusUrl: `${this._env.NODE_SERVER_BASE_URL}/api/node-server/v1/status`,
      apiKey: this._env.NODE_SERVER_SERVICE_API_KEY,
    };
  }

  get transcriptionMetricsPollerConfig(): TranscriptionMetricsPollerConfig {
    // Parsed here, reported to the poller, logged there: this class has no
    // logger and stays free of side effects, but a rejected entry must still be
    // said out loud rather than silently becoming "no periods configured".
    const { periods, errors } = parseJobPeriods(
      this._env.TRANSCRIPTION_JOB_PERIOD_MS,
    );

    return {
      // Fail closed, as for node-server: polling without a key would 401 or
      // 404 on every interval forever.
      enabled: this._env.TRANSCRIPTION_SERVICE_METRICS_KEY.length > 0,
      intervalMs: this._env.TRANSCRIPTION_METRICS_INTERVAL_SEC * SECOND_MS,
      timeoutMs: this._env.PROBE_TIMEOUT_SEC * SECOND_MS,
      service: 'transcription-service',
      // Root-mounted, with no /api/<service>/v1 prefix — the same exception
      // its probes make.
      statusUrl: `${this._env.TRANSCRIPTION_SERVICE_BASE_URL}/metrics/status`,
      apiKey: this._env.TRANSCRIPTION_SERVICE_METRICS_KEY,
      jobPeriodMsByProvider: periods,
      jobPeriodSpecErrors: errors,
    };
  }

  get alertThresholds(): AlertThresholds {
    return {
      rateWindowMs: this._env.ALERT_RATE_WINDOW_SEC * SECOND_MS,
      upstreamChurnCount: this._env.ALERT_UPSTREAM_CHURN_COUNT,
      decodeDropCount: this._env.ALERT_DECODE_DROP_COUNT,
      bufferOverflowCount: this._env.ALERT_BUFFER_OVERFLOW_COUNT,
      rtfP95: this._env.ALERT_RTF_P95,
      asrDutyRatio: threshold(
        this._env.ALERT_ASR_DUTY_RATIO,
        DEFAULT_THRESHOLDS.asrDutyRatio,
      ),
      asrDutyRatioMinJobs: this._env.ALERT_ASR_DUTY_RATIO_MIN_JOBS,
      asrDroppedPeriodRatio: threshold(
        this._env.ALERT_ASR_DROPPED_PERIOD_RATIO,
        DEFAULT_THRESHOLDS.asrDroppedPeriodRatio,
      ),
      asrTailMinJobs: threshold(
        this._env.ALERT_ASR_TAIL_MIN_JOBS,
        DEFAULT_THRESHOLDS.asrTailMinJobs,
      ),
      asrTailP99Rtf: this._env.ALERT_ASR_TAIL_P99_RTF,
      probeFailureThreshold: this._env.ALERT_PROBE_FAILURE_THRESHOLD,
      authFailureRatio: this._env.ALERT_AUTH_FAILURE_RATIO,
      authFailureMinSamples: this._env.ALERT_AUTH_FAILURE_MIN_SAMPLES,
      clockSkewRatio: this._env.ALERT_CLOCK_SKEW_RATIO,
      clockSkewMinSamples: this._env.ALERT_CLOCK_SKEW_MIN_SAMPLES,
      pendingChunkEvictionCount: this._env.ALERT_PENDING_EVICTION_COUNT,
      canaryFirstTranscriptMs: this._env.ALERT_CANARY_FIRST_TRANSCRIPT_MS,
      canaryMinRecall: this._env.ALERT_CANARY_MIN_RECALL,
      canaryMaxRepetitionRatio: this._env.ALERT_CANARY_MAX_REPETITION_RATIO,
    };
  }

  get canaryAuthConfig(): CanaryAuthConfig {
    return {
      sessionManagerBaseUrl: this._env.SESSION_MANAGER_BASE_URL,
      deviceToken: this._env.CANARY_DEVICE_TOKEN,
      timeoutMs: this._env.PROBE_TIMEOUT_SEC * SECOND_MS,
    };
  }

  /**
   * @param expectedTranscript Ground-truth text, read at startup by the
   *   composition root. Passed in rather than read here so config stays
   *   synchronous and free of file I/O.
   */
  canaryRunnerConfig(expectedTranscript: string): CanaryRunnerConfig {
    return {
      // No device token means no canary. Failing closed keeps a default
      // deployment from emitting auth errors against session-manager forever.
      enabled: this._env.CANARY_DEVICE_TOKEN.length > 0,
      intervalMs: this._env.CANARY_INTERVAL_SEC * SECOND_MS,
      audioPath: this._env.CANARY_AUDIO_PATH,
      chunkMs: this._env.CANARY_CHUNK_MS,
      expectedSampleRate: this._env.CANARY_SAMPLE_RATE,
      expectedChannels: this._env.CANARY_CHANNELS,
      nodeServerBaseUrl: this._env.NODE_SERVER_BASE_URL,
      expectedTranscript,
      runDurationMs: this._env.CANARY_RUN_DURATION_SEC * SECOND_MS,
      drainMs: this._env.CANARY_DRAIN_SEC * SECOND_MS,
      upstreamWaitMs: this._env.CANARY_UPSTREAM_WAIT_SEC * SECOND_MS,
    };
  }

  /** Path to the standalone meter page, read by the composition root. */
  get audioMeterPath(): string {
    return this._env.AUDIO_METER_PATH;
  }

  /** Path to the ground-truth transcript, read by the composition root. */
  get canaryTranscriptPath(): string {
    return this._env.CANARY_TRANSCRIPT_PATH;
  }

  constructor(path?: string) {
    this._isDevelopment = process.argv.includes('--dev');

    this._env = envSchema<Static<typeof CONFIG_SCHEMA>>({
      dotenv: path ? { path } : {},
      schema: CONFIG_SCHEMA,
    });
  }
}
