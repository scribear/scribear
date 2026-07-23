---
'@scribear/node-server': minor
---

Add in-process telemetry counters to node-server (monitoring plan B1.1, first
of four PRs — counters only, no endpoint yet).

`NodeServerMetricsService` is a singleton because the signals originate in
objects with different lifetimes: WebSocket close codes and auth outcomes
happen in the request-scoped stream controller, which dies with the connection,
while session and upstream state live on the orchestrator singleton. Counters
are monotonic for the life of the process and carry a per-boot `processUid` so
a consumer can tell a restart from a genuine decrease.

Three signals were previously discarded entirely and are now both counted and
logged. The pending-chunk map evicting at its 2000-entry cap is the point where
latency correlation starts silently degrading, and it logged nothing. A
negative end-to-end latency — the source clock still ahead of ours despite sync
— was nulled and thrown away, so clock skew left no trace at all; it is now
counted, and logged at `debug` because under real skew it fires per chunk.
Transcripts referencing an already-evicted chunk are counted too.

Receive-only client connections are now counted as subscribers. They never
reach the orchestrator — they subscribe to the transcript bus directly — so
fan-out cost in a large room was not measurable anywhere before this.

Auth successes are counted alongside failures on purpose: a signing-key
mismatch between session-manager and node-server shows up as the failure
*ratio* approaching 100%, which a failure count alone cannot distinguish from a
handful of bad clients.

Close reasons are normalised against a known-reason allowlist before being used
as a counter label. On a peer-initiated close the reason is arbitrary
remote-supplied text, so recording it verbatim would let any client grow the
label map without bound.

No behaviour changes: every counter sits beside an existing branch, and the
audio hot path gains only integer increments.
