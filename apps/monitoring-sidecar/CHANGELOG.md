# @scribear/monitoring-sidecar

## 0.1.0

### Minor Changes

- Initial monitoring sidecar implementing Part A items A1 (log-metrics
  collector) and A3 (probe & version poller) from
  `PLAN-MONITORING-DASHBOARD.md`.

  Parses the JSON logs of node-server, session-manager, admin-server, and
  transcription-service into counters and histograms; polls every service's
  liveness/readiness probes; evaluates the §3 failure-catalog alert rules
  in-process; and serves both a JSON snapshot for the admin SPA and a
  Prometheus text endpoint.

  All state is in memory — restarting the sidecar zeroes every metric, and
  historical trends are out of scope for this version.
