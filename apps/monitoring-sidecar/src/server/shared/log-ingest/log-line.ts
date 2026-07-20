/**
 * Normalized view of one log line from one monitored container.
 *
 * The two log producers in the stack emit deliberately similar but NOT
 * identical JSON, and the differences are load-bearing:
 *
 * | | node/TS (pino) | transcription-service (Python) |
 * |---|---|---|
 * | `level` | pino numbering: 40 = warn, 50 = error | stdlib numbering: 40 = error, 30 = warning |
 * | `time` | epoch **milliseconds** | epoch **seconds** |
 * | errors | `err` object via `stdSerializers.errWithCause` | `exc_info` pre-formatted traceback string |
 * | stream | stdout | stderr |
 *
 * Neither producer puts a service name in the body, so `service` is attributed
 * by the ingest source from the container, never read from the payload.
 */
export interface NormalizedLogLine {
  /** Compose service name, attributed by the log source. */
  service: string;
  /** Which producer's conventions this line follows. */
  dialect: LogDialect;
  /** Severity, normalized to a common scale (see {@link LogSeverity}). */
  severity: LogSeverity;
  /** Event time in epoch milliseconds, normalized across dialects. */
  timeMs: number;
  /** The `msg` field. */
  msg: string;
  /** All remaining top-level fields (pino bindings / Python context, flattened). */
  fields: Readonly<Record<string, unknown>>;
}

/** Which logger produced a line; determines how `level` and `time` are read. */
export enum LogDialect {
  PINO = 'pino',
  PYTHON = 'python',
}

/** Common severity scale both dialects map onto. */
export enum LogSeverity {
  TRACE = 'trace',
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal',
}

/**
 * pino level numbers. Note 40 = warn here but 40 = ERROR in stdlib — the single
 * most dangerous confusion when parsing both streams, and the reason dialect is
 * tracked explicitly rather than inferred per-line.
 */
function pinoSeverity(level: number): LogSeverity {
  if (level >= 60) return LogSeverity.FATAL;
  if (level >= 50) return LogSeverity.ERROR;
  if (level >= 40) return LogSeverity.WARN;
  if (level >= 30) return LogSeverity.INFO;
  if (level >= 20) return LogSeverity.DEBUG;
  return LogSeverity.TRACE;
}

/** Python stdlib logging level numbers. */
function pythonSeverity(level: number): LogSeverity {
  if (level >= 50) return LogSeverity.FATAL;
  if (level >= 40) return LogSeverity.ERROR;
  if (level >= 30) return LogSeverity.WARN;
  if (level >= 20) return LogSeverity.INFO;
  return LogSeverity.DEBUG;
}

/**
 * Decodes one raw JSON log line into the normalized shape.
 *
 * Returns `null` for anything that is not a JSON object with a string `msg` —
 * which covers blank lines, partial writes, and the PrettyPrintFormatter output
 * used when transcription-service runs in development mode. Callers should
 * count these rather than treating them as errors.
 */
export function normalizeLogLine(
  raw: string,
  service: string,
  dialect: LogDialect,
): NormalizedLogLine | null {
  const trimmed = raw.trim();
  if (trimmed === '' || !trimmed.startsWith('{')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const msg = obj['msg'];
  if (typeof msg !== 'string') return null;

  const level = typeof obj['level'] === 'number' ? obj['level'] : 30;
  const rawTime = typeof obj['time'] === 'number' ? obj['time'] : Number.NaN;

  // Python's JsonFormatter writes `int(formatTime(record, "%s"))` — epoch
  // SECONDS. pino writes epoch milliseconds. Normalizing here means every
  // downstream rate/window calculation can assume milliseconds.
  const timeMs = Number.isNaN(rawTime)
    ? Date.now()
    : dialect === LogDialect.PYTHON
      ? rawTime * 1_000
      : rawTime;

  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'level' || k === 'time' || k === 'msg') continue;
    fields[k] = v;
  }

  return {
    service,
    dialect,
    severity:
      dialect === LogDialect.PYTHON
        ? pythonSeverity(level)
        : pinoSeverity(level),
    timeMs,
    msg,
    fields,
  };
}
