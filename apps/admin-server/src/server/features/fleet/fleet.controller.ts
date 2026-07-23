import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import type { FleetEvent } from '@scribear/scribear-redis';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import {
  errorEnvelope,
  okEnvelope,
} from '#src/server/shared/envelope/envelope.js';

/** How often a heartbeat comment keeps an idle stream from looking dead to an intermediary. */
const SSE_HEARTBEAT_MS = 15_000;

export class FleetController {
  private _telemetry: AppDependencies['fleetTelemetryService'];
  private _events: AppDependencies['fleetEventsService'];
  private _logger: AppDependencies['logger'];

  constructor(
    fleetTelemetryService: AppDependencies['fleetTelemetryService'],
    fleetEventsService: AppDependencies['fleetEventsService'],
    logger: AppDependencies['logger'],
  ) {
    this._telemetry = fleetTelemetryService;
    this._events = fleetEventsService;
    this._logger = logger;
  }

  /**
   * Snapshot of every live room, node-server instance and provider across the
   * fleet, read entirely from Redis (B1.7 §2.5) — no fan-out to instances.
   *
   * 503, not 200-with-empty-data: unlike `/health` (which always speaks for
   * itself), an empty result here is indistinguishable from "nothing is
   * running" unless the caller can tell "telemetry is unavailable" apart from
   * "the fleet is genuinely idle."
   */
  async fleet(req: BaseFastifyRequest, res: BaseFastifyReply) {
    if (!this._telemetry.enabled) {
      return res
        .code(503)
        .send(
          errorEnvelope(
            'TELEMETRY_UNAVAILABLE',
            'Live fleet telemetry is not configured (REDIS_URL unset).',
            req.id,
          ),
        );
    }

    try {
      const snapshot = await this._telemetry.snapshot();
      return await res.code(200).send(okEnvelope(snapshot));
    } catch (err) {
      this._logger.warn({ err }, 'fleet snapshot failed');
      return res
        .code(503)
        .send(
          errorEnvelope(
            'TELEMETRY_DEGRADED',
            'Could not read live fleet telemetry.',
            req.id,
          ),
        );
    }
  }

  /**
   * Sub-second fleet deltas over SSE (B1.7 §2.5), so the room grid updates a
   * session's connectivity as it happens instead of on the next `/fleet` poll.
   * Snapshot-then-deltas: a client is expected to have already read `/fleet`
   * and to merge these onto it, not to treat this stream as the source of the
   * initial state.
   *
   * 503 is sent *before* hijacking, same reasoning and shape as `fleet()`
   * above — once the response is hijacked there is no envelope left to send.
   */
  async fleetStream(req: BaseFastifyRequest, res: BaseFastifyReply) {
    if (!this._events.enabled) {
      return res
        .code(503)
        .send(
          errorEnvelope(
            'TELEMETRY_UNAVAILABLE',
            'Live fleet telemetry is not configured (REDIS_URL unset).',
            req.id,
          ),
        );
    }

    res.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Belt-and-suspenders: the nginx location for this route also disables
      // buffering, but this keeps a direct (non-proxied) connection correct
      // too.
      'X-Accel-Buffering': 'no',
    });
    res.hijack();

    let unregister: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const cleanup = () => {
      if (heartbeat !== null) clearInterval(heartbeat);
      if (unregister !== null) unregister();
    };
    const send = (event: FleetEvent) => {
      try {
        res.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (err) {
        this._logger.debug({ err }, 'fleet stream write failed');
        cleanup();
      }
    };
    unregister = this._events.addListener(send);
    heartbeat = setInterval(() => {
      try {
        res.raw.write(':\n\n');
      } catch {
        cleanup();
      }
    }, SSE_HEARTBEAT_MS);
    req.raw.on('close', cleanup);
  }
}
