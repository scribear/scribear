---
'@scribear/monitoring-sidecar': major
---

Delete Docker log ingestion entirely (B1.2 PR 5b).

PR 5a retired the last five log parsers, leaving the ingest pipeline with one
consumer: the session-manager config-poll correlator. Keeping the Docker Engine
socket mount, the container discovery, the line normalizer and the correlator
alive for a single detector was not a trade worth making, so all of it is gone.

**The sidecar no longer needs the Docker socket.** That mount was
root-equivalent access to the host. Every signal it fed now comes from an authed
HTTP endpoint instead.

**A real coverage regression, stated plainly.** Nothing now detects a
`session-config-stream` 401 — the direct signature of the secret cross-wiring in
ISSUES-To-Review.md. The N1 upstream churn it causes is still detected, so the
symptom alerts, but the alert no longer names the cause. Restoring it needs a
session-manager status endpoint, the same shape B1.1 and B1.2 gave node-server
and transcription-service.

Removed: the `configPollErrorRule` (N2/S3) and its `ALERT_CONFIG_POLL_ERROR_COUNT`
threshold; the `scribear_sm_config_poll_*` and `scribear_log_lines_*` metrics;
the snapshot's `ingest` block; and the `DOCKER_SOCKET_PATH` / `COMPOSE_PROJECT`
env vars.

**Readiness is re-keyed.** It required an ingested log line, which no longer
exists. It now requires at least one probe result, and additionally reports
unready when a status poll is being rejected with `unauthorized` or `not-found`
— closing the follow-up B1.1 left open, where a sidecar whose status poll was
refused reported ready while the metrics behind it silently froze. A merely
unreachable service does not fail readiness; that is the monitored service's
outage, not the sidecar's. The readiness `checks` key is renamed `logIngest` to
`collectors`.
