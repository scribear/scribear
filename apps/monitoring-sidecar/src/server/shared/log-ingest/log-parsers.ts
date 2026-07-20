import type { NormalizedLogLine } from '#src/server/shared/log-ingest/log-line.js';
import type { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';

/**
 * A parser claims a log line and folds it into metrics.
 *
 * Each parser is keyed to a literal log string in the monitored services. Every
 * `match` below is annotated with the exact source location it corresponds to,
 * because these strings are an implicit contract: the services do not know the
 * sidecar exists, so a reworded log message silently breaks a metric. The
 * `scribear_log_lines_unparsed_total` counter is the drift alarm for exactly
 * this failure mode.
 */
export interface LogParser {
  /** Stable identifier, used as the `parser` label on parse counters. */
  readonly id: string;
  /** Cheap predicate deciding whether this parser handles the line. */
  match(line: NormalizedLogLine): boolean;
  /** Folds the line into the registry. Only called when `match` returned true. */
  apply(line: NormalizedLogLine, metrics: MetricsRegistry): void;
}

/** Reads a string field, or undefined when absent/not a string. */
function str(line: NormalizedLogLine, key: string): string | undefined {
  const v = line.fields[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * transcription-service: `Dropping malformed audio frame` (capital D).
 *
 * The node-server side of this signal moved to the status endpoint in B1.1,
 * along with WebSocket closes and upstream state transitions - see
 * {@link NodeStatusPollerService}. This parser stays because
 * transcription-service has no status endpoint yet (B1.2), so its decode drops
 * are still only visible in log text.
 *
 * @see transcription_service/src/webserver/features/transcription_stream/transcription_stream_controller.py
 */
export const pythonDecodeDropParser: LogParser = {
  id: 'python-decode-drop',
  match: (line) => line.msg === 'Dropping malformed audio frame',
  apply: (line, metrics) => {
    metrics.safpDecodeDropsTotal.inc(
      { service: line.service, side: 'transcription' },
      1,
      line.timeMs,
    );
  },
};

/**
 * transcription-service job completion, carrying `JobStatistics`.
 *
 * The nested `stats` object holds only the four raw `perf_counter_ns`
 * timestamps — `asdict()` does not serialize the derived `@property`
 * accessors — so scheduling delay and execution time are computed here using
 * the same arithmetic as `job_result.py`.
 *
 * @see transcription_service/src/shared/utils/worker_pool/job_result.py
 */
export function createJobCompletionParser(jobPeriodMs: number): LogParser {
  return {
    id: 'job-completion',
    match: (line) => line.msg === 'Completed transcription job',
    apply: (line, metrics) => {
      const stats = line.fields['stats'];
      if (typeof stats !== 'object' || stats === null) return;
      const s = stats as Record<string, unknown>;

      const periodStart = s['period_start_ns'];
      const scheduled = s['job_scheduled_time_ns'];
      const startExec = s['start_execute_time_ns'];
      const complete = s['complete_time_ns'];
      if (
        typeof periodStart !== 'number' ||
        typeof scheduled !== 'number' ||
        typeof startExec !== 'number' ||
        typeof complete !== 'number'
      ) {
        return;
      }

      const labels = {
        service: line.service,
        providerKey: str(line, 'provider_key') ?? 'unknown',
      };

      const NS_PER_MS = 1_000_000;
      const schedulingDelayMs = (scheduled - periodStart) / NS_PER_MS;
      const executionMs = (complete - startExec) / NS_PER_MS;

      // These are perf_counter_ns deltas — monotonic and unaffected by clock
      // skew — but a negative value would mean the fields arrived out of order,
      // so guard rather than poison the histogram.
      if (schedulingDelayMs >= 0) {
        metrics.asrSchedulingDelayMs.observe(schedulingDelayMs, labels);
      }
      if (executionMs >= 0) {
        metrics.asrProcessingMs.observe(executionMs, labels);
        if (jobPeriodMs > 0) {
          metrics.asrPeriodUtilization.observe(
            executionMs / jobPeriodMs,
            labels,
          );
        }
      }
    },
  };
}

/**
 * transcription-service: `Buffer full. Forcing finalization of audio up to: N`
 *
 * The message is an f-string with a 4-decimal float appended, so this matches on
 * prefix rather than equality.
 * @see transcription_service/.../whisper_streaming_job.py
 */
export const bufferOverflowParser: LogParser = {
  id: 'buffer-overflow',
  match: (line) => line.msg.startsWith('Buffer full. Forcing finalization'),
  apply: (line, metrics) => {
    metrics.asrBufferOverflowTotal.inc(
      {
        service: line.service,
        workerId: str(line, 'worker_id') ?? 'unknown',
      },
      1,
      line.timeMs,
    );
  },
};

/**
 * transcription-service: client pushed audio faster than realtime.
 *
 * `TranscriptionClientError("Client sent audio too quickly.")` is raised, not
 * logged directly; it surfaces via the controller's error hook as
 * `"Websocket encountered error: Client sent audio too quickly."`. Hence a
 * substring match rather than a prefix or equality match.
 */
export const audioTooFastParser: LogParser = {
  id: 'audio-too-fast',
  match: (line) => line.msg.includes('Client sent audio too quickly'),
  apply: (line, metrics) => {
    metrics.asrAudioTooFastTotal.inc(
      {
        service: line.service,
        socketId: str(line, 'socket_id') ?? 'unknown',
      },
      1,
      line.timeMs,
    );
  },
};

/**
 * transcription-service: buffer produced no speech.
 *
 * Two distinct lines with different visibility. `No words transcribed in
 * buffer.` is INFO and always present; `VAD detected no speech in buffer` is
 * DEBUG and therefore invisible unless transcription-service is deliberately
 * run at LOG_LEVEL=debug. They are labelled separately so a dashboard can tell
 * "VAD saw nothing" from "VAD saw speech but Whisper produced no words" —
 * the §3 T5/T8 distinction — without silently conflating them.
 */
export const noSpeechParser: LogParser = {
  id: 'no-speech',
  match: (line) =>
    line.msg === 'No words transcribed in buffer.' ||
    line.msg === 'VAD detected no speech in buffer',
  apply: (line, metrics) => {
    const kind = line.msg.startsWith('VAD') ? 'vad_no_speech' : 'no_words';
    metrics.asrNoSpeechTotal.inc(
      { service: line.service, kind },
      1,
      line.timeMs,
    );
  },
};

/**
 * session-manager `session-config-stream` outcomes (§3 N2 / S3).
 *
 * The 401 is produced by `service-api-key.hook.ts` via `HttpError.unauthorized`,
 * and the base error handler does NOT log `BaseHttpError`s. So the only trace
 * is Fastify's own `request completed` line carrying `res.statusCode`. That
 * line has no URL, so the URL must be recovered from the matching `incoming
 * request` line via `reqId` — see {@link RequestCorrelator}.
 */
export const configPollParser: LogParser = {
  id: 'config-poll',
  // Handled by the correlator rather than a standalone matcher; see
  // LogIngestService. Present here for catalogue completeness.
  match: () => false,
  apply: () => {
    // no-op
  },
};

/**
 * Correlates Fastify's two auto-logged lines (`incoming request` then `request
 * completed`, sharing a `reqId`) so a status code can be attributed to a URL.
 *
 * Entries are evicted by count and age, so a request that never completes (an
 * in-flight long poll — and `session-config-stream` is a long poll, so this is
 * the common case, not an edge case) cannot leak memory.
 */
export class RequestCorrelator {
  private _urls = new Map<string, { url: string; atMs: number }>();
  private _maxEntries: number;
  private _maxAgeMs: number;

  constructor(maxEntries = 10_000, maxAgeMs = 600_000) {
    this._maxEntries = maxEntries;
    this._maxAgeMs = maxAgeMs;
  }

  /** Records the URL of an incoming request keyed by its request id. */
  noteRequest(reqId: string, url: string, nowMs: number): void {
    this._urls.set(reqId, { url, atMs: nowMs });
    this._evict(nowMs);
  }

  /** Resolves and consumes the URL for a completed request. */
  takeUrl(reqId: string): string | undefined {
    const entry = this._urls.get(reqId);
    if (entry === undefined) return undefined;
    this._urls.delete(reqId);
    return entry.url;
  }

  get size(): number {
    return this._urls.size;
  }

  private _evict(nowMs: number): void {
    const cutoff = nowMs - this._maxAgeMs;
    for (const [key, entry] of this._urls) {
      if (entry.atMs >= cutoff) break; // Map preserves insertion order.
      this._urls.delete(key);
    }
    while (this._urls.size > this._maxEntries) {
      const oldest = this._urls.keys().next();
      if (oldest.done === true) break;
      this._urls.delete(oldest.value);
    }
  }
}

/** Every standalone parser, in evaluation order. */
export function defaultParsers(jobPeriodMs: number): LogParser[] {
  return [
    pythonDecodeDropParser,
    createJobCompletionParser(jobPeriodMs),
    bufferOverflowParser,
    audioTooFastParser,
    noSpeechParser,
  ];
}
