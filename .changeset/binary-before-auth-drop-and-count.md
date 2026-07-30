---
'@scribear/monitoring-sidecar': minor
---

Export the binary-before-auth drop counters, and stop transcription-service
closing the socket on an early binary frame.

A binary frame arriving before AUTH — or, on transcription-service, before
CONFIG — used to close the socket with 1008. That turns a recoverable client
ordering bug into a silent outage: the client auto-reconnects, re-sends AUTH,
its first audio chunk again beats AUTH_OK, and the loop repeats forever with
no audio delivered and nothing naming the cause. node-server hit exactly this
and was fixed the same way; transcription-service now drops the frame, counts
it, and leaves the connection open. A peer that never completes the handshake
at all is still closed by the existing `ws_init_timeout` watchdog.

node-server's `binaryBeforeAuthDropsTotal` had been counted and serialised for
some time but consumed by nothing — no registry counter, no `/metrics` series,
no panel, no alert. It and transcription-service's two new counters are now
wired through the sidecar as:

- `scribear_node_binary_before_auth_drops_total`
- `scribear_asr_binary_dropped_before_auth_total` (per provider)
- `scribear_asr_binary_dropped_before_config_total` (per provider)

All three wire fields are optional, so a node-server or transcription-service
built before this change is polled without failing validation: absent records
no increment rather than a zero.

No alert thresholds — none of these counters has a measured baseline yet.
