import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';

import { READINESS_SCHEMA } from './probes.schema.js';

export class ReadinessController {
  private _metrics: MetricsRegistry;

  constructor(metricsRegistry: MetricsRegistry) {
    this._metrics = metricsRegistry;
  }

  /**
   * Reports ready once the log ingest has decoded at least one line.
   *
   * Deliberately weak: a sidecar attached to an idle stack legitimately sees
   * nothing, so anything stricter would flap. What this does catch is the
   * common misconfiguration where the Docker socket is not mounted or the
   * compose project name is wrong — in which case no line ever arrives and the
   * sidecar would otherwise report healthy while collecting nothing.
   */
  readiness(
    _req: BaseFastifyRequest<typeof READINESS_SCHEMA>,
    res: BaseFastifyReply<typeof READINESS_SCHEMA>,
  ) {
    const seen =
      this._metrics.logLinesParsedTotal.total() +
      this._metrics.logLinesUnparsedTotal.total() +
      this._metrics.logLinesMalformedTotal.total();

    if (seen === 0) {
      res.code(503).send({
        status: 'fail',
        checks: { logIngest: 'no log lines ingested yet' },
      });
      return;
    }

    res.code(200).send({ status: 'ok' });
  }
}
