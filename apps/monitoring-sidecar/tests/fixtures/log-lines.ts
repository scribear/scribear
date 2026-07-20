import type { RawLogLine } from '#src/server/shared/log-ingest/log-ingest.service.js';
import { LogDialect } from '#src/server/shared/log-ingest/log-line.js';

/**
 * Log-line fixtures shaped to match what the services actually emit.
 *
 * Each builder mirrors a specific logger call site, including the details that
 * are easy to get wrong: pino writes epoch MILLISECONDS and uses 40 for warn,
 * while the Python JsonFormatter writes epoch SECONDS and uses 40 for error.
 * Getting either backwards would make the parsers pass tests and fail in
 * production, so the dialect difference is baked into the fixtures rather than
 * abstracted away.
 *
 * NOTE: these are hand-built from the source call sites, not captured from a
 * running staging deployment. They pin the parsers to the code as it exists,
 * but they cannot prove the parsers survive contact with real production log
 * volume or with lines this author did not anticipate.
 */

/** Builds a pino-shaped line (node-server, session-manager, admin-server). */
export function pinoLine(
  service: string,
  level: number,
  msg: string,
  fields: Record<string, unknown> = {},
  timeMs = 1_755_624_000_000,
): RawLogLine {
  return {
    service,
    dialect: LogDialect.PINO,
    text: JSON.stringify({
      level,
      time: timeMs,
      pid: 1,
      hostname: '9f2ca1b3c4d5',
      msg,
      ...fields,
    }),
  };
}

/**
 * Builds a Python JsonFormatter line (transcription-service).
 *
 * `timeSec` is seconds, matching `int(formatTime(record, "%s"))`.
 */
export function pythonLine(
  msg: string,
  level: number,
  fields: Record<string, unknown> = {},
  timeSec = 1_755_624_000,
): RawLogLine {
  return {
    service: 'transcription-service',
    dialect: LogDialect.PYTHON,
    text: JSON.stringify({
      level,
      time: timeSec,
      pid: 7,
      hostname: 'a1b2c3d4e5f6',
      msg,
      ...fields,
    }),
  };
}

/** pino levels. 40 is WARN here — contrast with {@link PY_LEVEL}. */
export const PINO_LEVEL = {
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
} as const;

/** Python stdlib levels. 40 is ERROR here — contrast with {@link PINO_LEVEL}. */
export const PY_LEVEL = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
} as const;

/**
 * node-server dropping a malformed SAFP frame.
 * `err` is a plain string here because the call site passes `err.message`.
 */
export function nodeDecodeDrop(sessionUid = 'sess-1', timeMs?: number) {
  return pinoLine(
    'node-server',
    PINO_LEVEL.WARN,
    'dropping malformed audio frame',
    { err: 'bad frame header', sessionUid },
    timeMs,
  );
}

/** transcription-service dropping a malformed SAFP frame (capital D). */
export function pythonDecodeDrop(timeSec?: number) {
  return pythonLine(
    'Dropping malformed audio frame',
    PY_LEVEL.WARNING,
    { socket_id: 'sock-9' },
    timeSec,
  );
}

/** A server-initiated WebSocket close. */
export function wsClose(
  code: number,
  reason: string,
  role = 'source',
  sessionUid = 'sess-1',
  timeMs?: number,
) {
  return pinoLine(
    'node-server',
    PINO_LEVEL.INFO,
    'transcription-stream socket closed',
    { sessionUid, role, code, reason },
    timeMs,
  );
}

/** A peer-initiated WebSocket close (client vanished). */
export function wsClosePeer(
  code: number,
  reason: string,
  role = 'source',
  sessionUid = 'sess-1',
  timeMs?: number,
) {
  return pinoLine(
    'node-server',
    PINO_LEVEL.INFO,
    'transcription-stream socket closed by peer',
    { sessionUid, role, code, reason },
    timeMs,
  );
}

/** An upstream transcription connection state transition. */
export function upstreamState(
  from: string,
  to: string,
  sessionUid = 'sess-1',
  timeMs?: number,
) {
  return pinoLine(
    'node-server',
    PINO_LEVEL.INFO,
    'upstream transcription state change',
    { sessionUid, from, to },
    timeMs,
  );
}

/**
 * A completed transcription job.
 *
 * `stats` carries only the four raw perf_counter_ns timestamps — the derived
 * properties are NOT serialized by `asdict()`, which is exactly why the parser
 * has to compute the deltas itself.
 */
export function jobCompletion(
  opts: {
    schedulingDelayMs?: number;
    executionMs?: number;
    providerKey?: string;
    timeSec?: number;
  } = {},
) {
  const schedulingDelayMs = opts.schedulingDelayMs ?? 5;
  const executionMs = opts.executionMs ?? 400;
  const NS_PER_MS = 1_000_000;

  const periodStart = 5_000_000_000;
  const scheduled = periodStart + schedulingDelayMs * NS_PER_MS;
  const startExec = scheduled + 2 * NS_PER_MS;
  const complete = startExec + executionMs * NS_PER_MS;

  return pythonLine(
    'Completed transcription job',
    PY_LEVEL.INFO,
    {
      stats: {
        period_start_ns: periodStart,
        job_scheduled_time_ns: scheduled,
        start_execute_time_ns: startExec,
        complete_time_ns: complete,
      },
      final: 'hello world',
      in_progress: null,
      provider_key: opts.providerKey ?? 'whisper',
      socket_id: 'sock-1',
    },
    opts.timeSec,
  );
}

/** Buffer force-finalized; the message is an f-string with a float appended. */
export function bufferOverflow(timeSec?: number) {
  return pythonLine(
    'Buffer full. Forcing finalization of audio up to: 12.3456',
    PY_LEVEL.INFO,
    { job_id: 'job-3', worker_id: '0', context_id: 'ctx-1' },
    timeSec,
  );
}

/**
 * Client sent audio too quickly.
 *
 * Surfaces through the controller's error hook, prefixed with "Websocket
 * encountered error: " — never as a bare message.
 */
export function audioTooFast(timeSec?: number) {
  return pythonLine(
    'Websocket encountered error: Client sent audio too quickly.',
    PY_LEVEL.WARNING,
    { socket_id: 'sock-4', exc_info: 'Traceback (most recent call last): ...' },
    timeSec,
  );
}

/** No words transcribed (INFO — always visible). Note the trailing period. */
export function noWords(timeSec?: number) {
  return pythonLine(
    'No words transcribed in buffer.',
    PY_LEVEL.INFO,
    { job_id: 'job-3' },
    timeSec,
  );
}

/** VAD found no speech (DEBUG — invisible unless the service runs at debug). */
export function vadNoSpeech(timeSec?: number) {
  return pythonLine(
    'VAD detected no speech in buffer',
    PY_LEVEL.DEBUG,
    { job_id: 'job-3' },
    timeSec,
  );
}

/** Fastify's auto-logged `incoming request` line. */
export function incomingRequest(
  reqId: string,
  url: string,
  service = 'session-manager',
  timeMs?: number,
) {
  return pinoLine(
    service,
    PINO_LEVEL.INFO,
    'incoming request',
    {
      reqId,
      req: {
        method: 'GET',
        url,
        host: 'session-manager',
        remoteAddress: '172.18.0.4',
        remotePort: 51234,
      },
    },
    timeMs,
  );
}

/** Fastify's auto-logged `request completed` line. */
export function requestCompleted(
  reqId: string,
  statusCode: number,
  service = 'session-manager',
  timeMs?: number,
) {
  return pinoLine(
    service,
    PINO_LEVEL.INFO,
    'request completed',
    { reqId, res: { statusCode }, responseTime: 1.23 },
    timeMs,
  );
}

/** The session-config long-poll URL, as it appears in `req.url`. */
export const CONFIG_STREAM_URL =
  '/api/session-manager/v1/schedule-management/session-config-stream/sess-1';
