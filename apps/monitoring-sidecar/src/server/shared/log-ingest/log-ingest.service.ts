import type { BaseLogger } from '@scribear/base-fastify-server';

import {
  type LogDialect,
  type NormalizedLogLine,
  normalizeLogLine,
} from '#src/server/shared/log-ingest/log-line.js';
import {
  type LogParser,
  RequestCorrelator,
  defaultParsers,
} from '#src/server/shared/log-ingest/log-parsers.js';
import type { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';

export interface LogIngestConfig {
  /**
   * The transcription job period in milliseconds, used as the denominator of
   * the period-utilization proxy metric. Must match `job_period_ms` in the
   * deployed `provider_config.json`; there is no way to read it from the logs,
   * so a mismatch silently rescales the metric.
   */
  jobPeriodMs: number;
  /**
   * URL substring identifying the session-config long-poll route. Matched
   * against the `req.url` recovered by request correlation.
   */
  configStreamUrlFragment: string;
}

/** A raw line handed to the ingest by a log source. */
export interface RawLogLine {
  service: string;
  dialect: LogDialect;
  text: string;
}

/**
 * Folds raw container log lines into metrics.
 *
 * Pure and synchronous by design: sources push lines in, metrics come out, and
 * nothing here does I/O. That keeps the whole A1 parser surface unit-testable
 * against captured log fixtures with no Docker, no network, and no clock
 * dependence (every metric write is stamped with the line's own timestamp).
 */
export class LogIngestService {
  private _metrics: MetricsRegistry;
  private _logger: BaseLogger;
  private _config: LogIngestConfig;
  private _parsers: LogParser[];
  private _correlator = new RequestCorrelator();

  constructor(
    metricsRegistry: MetricsRegistry,
    logger: BaseLogger,
    logIngestConfig: LogIngestConfig,
  ) {
    this._metrics = metricsRegistry;
    this._logger = logger;
    this._config = logIngestConfig;
    this._parsers = defaultParsers(logIngestConfig.jobPeriodMs);
  }

  /** Ingests one raw line. Never throws; malformed input is counted, not raised. */
  ingest(raw: RawLogLine): void {
    const line = normalizeLogLine(raw.text, raw.service, raw.dialect);
    if (line === null) {
      // Blank lines, partial writes, and PrettyPrintFormatter output in dev
      // mode all land here. Counted so a spike is visible (it means the sidecar
      // is looking at a stream it cannot read).
      this._metrics.logLinesMalformedTotal.inc({ service: raw.service });
      return;
    }

    if (this._handleFastifyRequestLine(line)) return;

    for (const parser of this._parsers) {
      if (!parser.match(line)) continue;
      try {
        parser.apply(line, this._metrics);
        this._metrics.logLinesParsedTotal.inc({
          service: line.service,
          parser: parser.id,
        });
      } catch (err) {
        // A throwing parser must never stall ingestion of the stream.
        this._logger.warn(
          { err, parser: parser.id, msg: line.msg },
          'log parser threw',
        );
      }
      return;
    }

    this._metrics.logLinesUnparsedTotal.inc({ service: line.service });
  }

  /** Ingests many lines. Convenience for fixture replay and batched sources. */
  ingestAll(lines: Iterable<RawLogLine>): void {
    for (const line of lines) this.ingest(line);
  }

  /** Exposed for tests asserting the correlator does not leak. */
  get pendingCorrelations(): number {
    return this._correlator.size;
  }

  /**
   * Handles Fastify's two auto-logged request lines.
   *
   * `incoming request` carries `req.url` but no status; `request completed`
   * carries `res.statusCode` but no URL. Only the pair identifies "a
   * session-config-stream poll returned 401". Returns true when the line was a
   * Fastify request line (claimed either way), so the standalone parsers are
   * skipped.
   */
  private _handleFastifyRequestLine(line: NormalizedLogLine): boolean {
    const reqId = line.fields['reqId'];
    if (typeof reqId !== 'string') return false;

    if (line.msg === 'incoming request') {
      const req = line.fields['req'];
      if (typeof req === 'object' && req !== null) {
        const url = (req as Record<string, unknown>)['url'];
        if (typeof url === 'string') {
          this._correlator.noteRequest(reqId, url, line.timeMs);
        }
      }
      return true;
    }

    if (line.msg === 'request completed') {
      const res = line.fields['res'];
      const url = this._correlator.takeUrl(reqId);
      if (
        url !== undefined &&
        url.includes(this._config.configStreamUrlFragment) &&
        typeof res === 'object' &&
        res !== null
      ) {
        const status = (res as Record<string, unknown>)['statusCode'];
        if (typeof status === 'number') {
          if (status === 401 || status === 403) {
            this._metrics.smConfigPollErrorsTotal.inc(
              { service: line.service, status: String(status) },
              1,
              line.timeMs,
            );
          } else if (status < 400) {
            this._metrics.smConfigPollOkTotal.inc(
              { service: line.service },
              1,
              line.timeMs,
            );
          }
        }
      }
      return true;
    }

    return false;
  }
}
