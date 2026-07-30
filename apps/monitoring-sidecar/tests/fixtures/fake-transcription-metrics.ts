import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One `{labels, value}` counter series as the endpoint reports it. */
export interface FakeCounterSeries {
  labels: Record<string, string>;
  value: number;
}

/** One histogram series. `count`/`sum` are lifetime; the rest describe the ring. */
export interface FakeHistogramSeries {
  labels: Record<string, string>;
  count: number;
  sum: number;
  sampleCount: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface FakeMetricsBody {
  processUid: string;
  processStartedAt: string;
  numWorkers: number;
  providerKeys: string[];
  /**
   * Per-provider `job_period_ms`. Optional and absent from the default body,
   * because transcription-service does not send it yet — the sidecar reads it in
   * preference to its own config the moment it appears.
   */
  providerJobPeriodMs?: Record<string, number>;
  workers: {
    workerId: number;
    utilization: number;
    liveJobCount: number;
    totalJobsRegistered: number;
    contextIds: number[];
    alive: boolean;
  }[];
  counters: Record<string, FakeCounterSeries[]>;
  histograms: Record<string, FakeHistogramSeries[]>;
}

export const FAKE_PROCESS_UID = 'tx-process-1';
export const WHISPER = { provider_key: 'whisper' };
/**
 * A second provider with a different configured period. The CUDA template
 * really does run this alongside whisper at 3000 ms against whisper's 500 ms, so
 * per-provider tests use the pair rather than two invented keys.
 */
export const LUMEN_GRANITE = { provider_key: 'lumen_granite' };

/** A histogram series with every stat set to the same value, for terse tests. */
export function histogramSeries(
  value: number,
  overrides: Partial<FakeHistogramSeries> = {},
): FakeHistogramSeries {
  return {
    labels: WHISPER,
    count: 10,
    sum: value * 10,
    sampleCount: 10,
    min: value,
    max: value,
    mean: value,
    p50: value,
    p95: value,
    p99: value,
    ...overrides,
  };
}

/**
 * `asrDroppedPeriodsTotal` is deliberately **not** here, so the default body is
 * the older-service shape that omits it — the case the tail alert's p99 fallback
 * exists for. A test that wants the counter reported passes it explicitly.
 *
 * `binaryDroppedBeforeAuthTotal` / `binaryDroppedBeforeConfigTotal` are
 * likewise absent by default, for the same reason: they predate this change
 * on an older transcription-service, and the default body should model that
 * service rather than one that already sends everything.
 */
const EMPTY_COUNTERS = {
  jobsCompletedTotal: [],
  jobsFailedTotal: [],
  asrAudioSecondsTotal: [],
  bufferOverflowTotal: [],
  bufferOverflowSecondsTotal: [],
  audioDroppedBufferFullTotal: [],
  audioDroppedBufferFullSecondsTotal: [],
  vadNoSpeechTotal: [],
  noWordsTotal: [],
  decodeDropsTotal: [],
};

const EMPTY_HISTOGRAMS = {
  asrSchedulingDelayMs: [],
  asrExecutionMs: [],
  asrTotalMs: [],
  asrRtf: [],
};

/**
 * A well-formed body, overridable field by field. `counters` and `histograms`
 * are merged one level deep so a test can set a single series without
 * restating the other eight.
 */
export function metricsBody(
  overrides: Partial<FakeMetricsBody> = {},
): FakeMetricsBody {
  return {
    processUid: FAKE_PROCESS_UID,
    processStartedAt: '2026-07-20T12:00:00+00:00',
    numWorkers: 2,
    providerKeys: ['whisper'],
    workers: [],
    ...overrides,
    counters: { ...EMPTY_COUNTERS, ...(overrides.counters ?? {}) },
    histograms: { ...EMPTY_HISTOGRAMS, ...(overrides.histograms ?? {}) },
  };
}

export interface FakeTranscriptionMetrics {
  baseUrl: string;
  statusUrl: string;
  /** Replaces the body served on the next poll. */
  setBody: (body: FakeMetricsBody) => void;
  /** Serves this status code instead of the payload. 404 = route unregistered. */
  setFailure: (status: number | null) => void;
  /** Serves a body that does not match the schema. */
  setMalformed: (malformed: boolean) => void;
  /** Authorization headers seen, in order. */
  authHeaders: (string | undefined)[];
  close: () => Promise<void>;
}

/**
 * A stand-in for transcription-service's `GET /metrics/status`.
 *
 * Real HTTP over loopback rather than a stubbed `fetch`, for the same reason as
 * the node-server fake: the poller's job is to talk to a service across a
 * network boundary. The 404 path matters more here than it did for node-server,
 * because transcription-service genuinely leaves the route unregistered when its
 * own key is empty.
 */
export async function startFakeTranscriptionMetrics(
  apiKey: string,
): Promise<FakeTranscriptionMetrics> {
  let body = metricsBody();
  let failure: number | null = null;
  let malformed = false;
  const authHeaders: (string | undefined)[] = [];

  const server = createServer((req, res) => {
    authHeaders.push(req.headers.authorization);

    if (failure !== null) {
      res.writeHead(failure, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'ERROR', message: 'boom' }));
      return;
    }

    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 'INVALID_METRICS_KEY',
          message: 'Missing or invalid metrics API key.',
        }),
      );
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(malformed ? { unexpected: true } : body));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  return {
    baseUrl,
    statusUrl: `${baseUrl}/metrics/status`,
    setBody: (next) => {
      body = next;
    },
    setFailure: (status) => {
      failure = status;
    },
    setMalformed: (next) => {
      malformed = next;
    },
    authHeaders,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
