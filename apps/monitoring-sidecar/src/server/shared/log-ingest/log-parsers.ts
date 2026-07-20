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

/**
 * **All five transcription/decode parsers were retired in B1.2 PR 5.**
 *
 * `pythonDecodeDropParser`, `createJobCompletionParser`, `bufferOverflowParser`,
 * `audioTooFastParser` and `noSpeechParser` inferred decode drops, job timings,
 * buffer overflows, audio-too-fast rejections and no-speech buffers from log
 * text. All five now come from transcription-service's `GET /metrics/status` via
 * `TranscriptionMetricsPollerService`, which reports them as authoritative
 * in-process counters. Three of them were incremented *inside a spawned worker
 * process*, so logging them was the only reason they were ever visible.
 *
 * The log lines themselves remain in transcription-service as forensics; the
 * sidecar simply stopped deriving numbers from them. This mirrors what B1.1 did
 * to the node-server parsers.
 *
 * What is left below is the session-manager config-poll correlator, the last
 * consumer of log ingest.
 */

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

/**
 * Every standalone parser, in evaluation order.
 *
 * Empty since B1.2 PR 5: the only surviving detector is the config-poll
 * correlator, which LogIngestService drives directly rather than through a
 * `LogParser`. Every ingested line therefore now counts as unparsed, which is
 * why `logLinesUnparsedTotal` stopped being a useful drift alarm.
 */
export function defaultParsers(): LogParser[] {
  return [];
}
