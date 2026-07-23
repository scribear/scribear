---
'@scribear/node-server-schema': minor
'@scribear/node-server': minor
'@scribear/monitoring-sidecar': minor
---

Aggregate transcript latency server-side and report percentiles (B1.4).

Node Server correlated every transcript back to the audio frame that produced
it, published a `latencyUpdate` to whoever was subscribed, and then threw the
number away. The only way to see a room's latency was to be a client watching
that room, which is exactly the wrong property for an operations dashboard.

`GET /api/node-server/v1/status` now carries bounded latency windows:

- a process-wide `latency[]`, and a `latency[]` on each entry of `sessions[]`;
- one series per `(measure, kind)` — `pipeline` (audio ingress to transcript,
  monotonic clock only) versus `e2e` (source capture to transcript, using the
  clock-corrected send time), each split into `final` and `inProgress`;
- each series carries `count`/`sum` (lifetime, difference them like a counter)
  plus `sampleCount`/`min`/`max`/`mean`/`p50`/`p95`/`p99` over the retained ring
  (4096 process-wide, 512 per session).

Interim and final transcripts are reported separately rather than pooled: a
final is only emitted once the provider decides an utterance ended, so pooling
would give a p50 describing interims and a p95 describing finals. A series with
no samples is omitted rather than reported as zeroes — an `e2e` series is absent
entirely when no source supplies a send timestamp, which is not the same as an
end-to-end latency of zero. Percentiles are nearest-rank, matching what the
sidecar and transcription-service already use.

These are the first non-integer fields in the status response.

Per-session windows are discarded when the session's last connection closes,
the same lifetime as `subscriberCount`. A sample for a session with no recorded
connection still counts process-wide but creates no per-session entry, so the
map stays bounded by live rooms.

The sidecar exports the process-wide figures as
`scribear_node_pipeline_latency_ms` and `scribear_node_e2e_latency_ms`, labelled
`kind` and `quantile` — gauges, not histograms, because Node Server reports
pre-computed percentiles and observing a p95 into a local histogram would yield
a distribution of p95s. Per-session percentiles are deliberately not mirrored
into Prometheus; they would add a dozen series per live room to every scrape,
and the fleet SPA can read them from `/status` directly.
