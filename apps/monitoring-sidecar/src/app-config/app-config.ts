import envSchema from 'env-schema';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { LogLevel } from '@scribear/base-fastify-server';

import type { AlertThresholds } from '#src/server/shared/alerts/alert-rules.js';
import type { CanaryAuthConfig } from '#src/server/shared/canary/canary-auth.js';
import type { CanaryRunnerConfig } from '#src/server/shared/canary/canary-runner.service.js';
import type { DockerLogSourceConfig } from '#src/server/shared/log-ingest/docker-log-source.js';
import { DEFAULT_SERVICE_DIALECTS } from '#src/server/shared/log-ingest/docker-log-source.js';
import type { LogIngestConfig } from '#src/server/shared/log-ingest/log-ingest.service.js';
import type {
  ProbePollerConfig,
  ProbeTarget,
} from '#src/server/shared/probes/probe-poller.service.js';

const SECOND_MS = 1_000;

const CONFIG_SCHEMA = Type.Object({
  LOG_LEVEL: Type.Enum(LogLevel),
  PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
  HOST: Type.String(),

  // Log ingest
  DOCKER_SOCKET_PATH: Type.String({ default: '/var/run/docker.sock' }),
  COMPOSE_PROJECT: Type.String({ default: 'scribear' }),

  /**
   * Must match `job_period_ms` in the deployed provider_config.json. It is the
   * denominator of the period-utilization proxy metric and cannot be read from
   * the logs, so a wrong value silently rescales that metric.
   */
  TRANSCRIPTION_JOB_PERIOD_MS: Type.Integer({ minimum: 1, default: 1_000 }),

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

  // Alert thresholds (§4 defaults; every one is deployment-tunable)
  ALERT_RATE_WINDOW_SEC: Type.Integer({ minimum: 1, default: 120 }),
  ALERT_UPSTREAM_CHURN_COUNT: Type.Integer({ minimum: 1, default: 3 }),
  ALERT_CONFIG_POLL_ERROR_COUNT: Type.Integer({ minimum: 1, default: 1 }),
  ALERT_DECODE_DROP_COUNT: Type.Integer({ minimum: 1, default: 10 }),
  ALERT_BUFFER_OVERFLOW_COUNT: Type.Integer({ minimum: 1, default: 5 }),
  ALERT_PERIOD_UTILIZATION_P95: Type.Number({ minimum: 0, default: 1.0 }),
  ALERT_PROBE_FAILURE_THRESHOLD: Type.Integer({ minimum: 1, default: 2 }),
  ALERT_AUTH_FAILURE_RATIO: Type.Number({
    minimum: 0,
    maximum: 1,
    default: 0.5,
  }),
  ALERT_AUTH_FAILURE_MIN_SAMPLES: Type.Integer({ minimum: 1, default: 5 }),
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
   * sidecar. Relative to the process working directory, which is the package
   * root both in the container and under `npm run dev`.
   */
  AUDIO_METER_PATH: Type.String({ default: 'public/audio-meter.html' }),

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

  get logIngestConfig(): LogIngestConfig {
    return {
      jobPeriodMs: this._env.TRANSCRIPTION_JOB_PERIOD_MS,
      // The long-poll route session-manager serves; a 401 here is the §3 N2
      // secret-drift detector.
      configStreamUrlFragment: '/session-config-stream/',
    };
  }

  get dockerLogSourceConfig(): DockerLogSourceConfig {
    return {
      socketPath: this._env.DOCKER_SOCKET_PATH,
      composeProject: this._env.COMPOSE_PROJECT,
      services: DEFAULT_SERVICE_DIALECTS,
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

  get alertThresholds(): AlertThresholds {
    return {
      rateWindowMs: this._env.ALERT_RATE_WINDOW_SEC * SECOND_MS,
      upstreamChurnCount: this._env.ALERT_UPSTREAM_CHURN_COUNT,
      configPollErrorCount: this._env.ALERT_CONFIG_POLL_ERROR_COUNT,
      decodeDropCount: this._env.ALERT_DECODE_DROP_COUNT,
      bufferOverflowCount: this._env.ALERT_BUFFER_OVERFLOW_COUNT,
      periodUtilizationP95: this._env.ALERT_PERIOD_UTILIZATION_P95,
      probeFailureThreshold: this._env.ALERT_PROBE_FAILURE_THRESHOLD,
      authFailureRatio: this._env.ALERT_AUTH_FAILURE_RATIO,
      authFailureMinSamples: this._env.ALERT_AUTH_FAILURE_MIN_SAMPLES,
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
