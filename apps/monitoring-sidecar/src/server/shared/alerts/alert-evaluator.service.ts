import {
  type Alert,
  type AlertRule,
  type AlertThresholds,
  DEFAULT_RULES,
  SEVERITY_RANK,
} from '#src/server/shared/alerts/alert-rules.js';
import type { CanaryRunnerService } from '#src/server/shared/canary/canary-runner.service.js';
import type { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import type { ProbePollerService } from '#src/server/shared/probes/probe-poller.service.js';
import type { TranscriptionMetricsPollerService } from '#src/server/shared/transcription-metrics/transcription-metrics-poller.service.js';

/**
 * Evaluates the alert rules on demand.
 *
 * Evaluation is pull-based rather than a background loop: rules are pure
 * functions of current metric state, so computing them when the snapshot is
 * requested avoids a second source of truth that could disagree with the
 * metrics shown alongside it.
 *
 * This lives in the sidecar because the deployment does not run Grafana or
 * Alertmanager — the plan's §10.3 routing question was resolved as
 * "self-contained". Alerts are exposed as data; nothing here pages anyone.
 */
export class AlertEvaluatorService {
  private _metrics: MetricsRegistry;
  private _probePoller: ProbePollerService;
  private _canaryRunner: CanaryRunnerService;
  private _thresholds: AlertThresholds;
  private _transcriptionPoller: TranscriptionMetricsPollerService;
  private _rules: readonly AlertRule[];

  // Every parameter name matches its Awilix registration key. Awilix runs in
  // CLASSIC mode here, resolving by parameter NAME — a mismatch fails at
  // resolution time, which unit tests that construct directly will not catch.
  constructor(
    metricsRegistry: MetricsRegistry,
    probePollerService: ProbePollerService,
    canaryRunnerService: CanaryRunnerService,
    alertThresholds: AlertThresholds,
    transcriptionMetricsPollerService: TranscriptionMetricsPollerService,
    alertRules: readonly AlertRule[] = DEFAULT_RULES,
  ) {
    this._metrics = metricsRegistry;
    this._probePoller = probePollerService;
    this._canaryRunner = canaryRunnerService;
    this._thresholds = alertThresholds;
    this._transcriptionPoller = transcriptionMetricsPollerService;
    this._rules = alertRules;
  }

  /** Evaluates every rule, returning firing alerts worst-first. */
  evaluate(nowMs: number = Date.now()): Alert[] {
    const context = {
      metrics: this._metrics,
      probes: this._probePoller.statuses(),
      canary: this._canaryRunner.lastResult,
      nowMs,
      thresholds: this._thresholds,
      providerDevices: this._transcriptionPoller.providerDevices,
    };

    const alerts: Alert[] = [];
    for (const rule of this._rules) {
      alerts.push(...rule(context));
    }

    // Worst-first, then by id so equal-severity output is stable across polls
    // (a dashboard list that reorders itself on every refresh is unusable).
    alerts.sort((a, b) => {
      const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      return bySeverity !== 0 ? bySeverity : a.id.localeCompare(b.id);
    });
    return alerts;
  }
}
