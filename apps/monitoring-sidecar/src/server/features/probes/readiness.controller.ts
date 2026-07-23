import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';

import { READINESS_SCHEMA } from './probes.schema.js';

/** Poll failures a human must fix; waiting will not clear them. */
const MISCONFIGURED_REASONS = new Set(['unauthorized', 'not-found']);

export class ReadinessController {
  private _metrics: MetricsRegistry;

  constructor(metricsRegistry: MetricsRegistry) {
    this._metrics = metricsRegistry;
  }

  /**
   * Reports ready once a collector has produced a result, and unready when a
   * status poll is failing for a reason only a human can fix.
   *
   * **Re-keyed in B1.2 PR 5b.** This used to require that log ingest had
   * decoded at least one line, which caught the common "Docker socket not
   * mounted" misconfiguration. Log ingest is gone, so the probe poller becomes
   * the is-this-collector-alive signal: it runs unconditionally against four
   * fixed targets and records a gauge per target, so an empty `probeUp` means
   * the sidecar is collecting nothing at all.
   *
   * The status-poll check closes the follow-up B1.1 PR 4 left open — a sidecar
   * whose status poll was rejected reported ready while the metrics behind it
   * silently froze. Only `unauthorized` and `not-found` count: a merely
   * unreachable service is that service's outage, not the sidecar's, and the
   * probe poller already alerts on it. Failing readiness there would make the
   * sidecar unhealthy every time anything it watches restarts.
   */
  readiness(
    _req: BaseFastifyRequest<typeof READINESS_SCHEMA>,
    res: BaseFastifyReply<typeof READINESS_SCHEMA>,
  ) {
    if (this._metrics.probeUp.entries().length === 0) {
      res.code(503).send({
        status: 'fail',
        checks: { collectors: 'no probe results collected yet' },
      });
      return;
    }

    // Current failures only: the counter is monotonic, so a reason that was
    // once seen and has since been fixed must not keep the sidecar unready.
    const misconfigured = this._metrics.serviceStatusPollErrorsTotal
      .entries()
      .filter(
        ({ labels }) =>
          MISCONFIGURED_REASONS.has(labels['reason'] ?? '') &&
          this._metrics.serviceStatusUp.get({
            service: labels['service'] ?? '',
          }) === 0,
      )
      .map(
        ({ labels }) =>
          `${labels['service'] ?? 'unknown'}: ${labels['reason'] ?? 'unknown'}`,
      );

    if (misconfigured.length > 0) {
      res.code(503).send({
        status: 'fail',
        checks: {
          collectors: `status poll rejected — ${misconfigured.join(', ')}`,
        },
      });
      return;
    }

    res.code(200).send({ status: 'ok' });
  }
}
