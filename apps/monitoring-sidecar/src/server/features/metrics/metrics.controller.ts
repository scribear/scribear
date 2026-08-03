import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AlertEvaluatorService } from '#src/server/shared/alerts/alert-evaluator.service.js';
import type { AlertThresholds } from '#src/server/shared/alerts/alert-rules.js';
import type { CanaryRunnerService } from '#src/server/shared/canary/canary-runner.service.js';
import type { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import {
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheus,
} from '#src/server/shared/metrics/prometheus-exporter.js';
import { buildSnapshot } from '#src/server/shared/metrics/snapshot-builder.js';
import type { ProbePollerService } from '#src/server/shared/probes/probe-poller.service.js';

import type {
  ALERTS_SCHEMA,
  PROMETHEUS_SCHEMA,
  SNAPSHOT_SCHEMA,
} from './metrics.schema.js';

/**
 * Serves both output formats over the same in-memory state.
 *
 * `/snapshot` is the primary surface (the admin SPA consumes it); `/metrics`
 * exists so the numbers can be scraped into existing IT monitoring without a
 * rewrite, even though this deployment runs no Prometheus today.
 */
export class MetricsController {
  private _metrics: MetricsRegistry;
  private _probePoller: ProbePollerService;
  private _alertEvaluator: AlertEvaluatorService;
  private _canaryRunner: CanaryRunnerService;
  private _thresholds: AlertThresholds;

  constructor(
    metricsRegistry: MetricsRegistry,
    probePollerService: ProbePollerService,
    alertEvaluatorService: AlertEvaluatorService,
    canaryRunnerService: CanaryRunnerService,
    alertThresholds: AlertThresholds,
  ) {
    this._metrics = metricsRegistry;
    this._probePoller = probePollerService;
    this._alertEvaluator = alertEvaluatorService;
    this._canaryRunner = canaryRunnerService;
    this._thresholds = alertThresholds;
  }

  snapshot(
    _req: BaseFastifyRequest<typeof SNAPSHOT_SCHEMA>,
    res: BaseFastifyReply<typeof SNAPSHOT_SCHEMA>,
  ) {
    const now = Date.now();
    const snapshot = buildSnapshot(
      this._metrics,
      this._probePoller.statuses(),
      this._alertEvaluator.evaluate(now),
      this._canaryRunner.lastResult,
      this._thresholds.rateWindowMs,
      now,
    );
    res.code(200).send(snapshot);
  }

  /** Alerts alone, for callers that poll frequently and don't need the metrics. */
  alerts(
    _req: BaseFastifyRequest<typeof ALERTS_SCHEMA>,
    res: BaseFastifyReply<typeof ALERTS_SCHEMA>,
  ) {
    res.code(200).send({ alerts: this._alertEvaluator.evaluate() });
  }

  prometheus(
    _req: BaseFastifyRequest<typeof PROMETHEUS_SCHEMA>,
    res: BaseFastifyReply<typeof PROMETHEUS_SCHEMA>,
  ) {
    res
      .code(200)
      .header('content-type', PROMETHEUS_CONTENT_TYPE)
      .send(renderPrometheus(this._metrics));
  }
}
