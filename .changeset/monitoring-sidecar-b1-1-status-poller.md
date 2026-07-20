---
'@scribear/monitoring-sidecar': minor
---

Source node-server telemetry from its status endpoint instead of its log text
(monitoring plan B1.1, last of four PRs). This completes the cut-over: the log
parsers for WebSocket closes, upstream state transitions, upstream churn and
node-side decode drops are **removed**, and a new status poller feeds those same
four metric names from `GET /api/node-server/v1/status`.

Log inference worked, but it was lossy by construction — it depended on the log
level, on the collector being attached for the whole window, and on nothing
rotating out — and several signals had no log line at all. The endpoint also
carries things logs never could: subscriber counts per session (nothing measured
fan-out before), auth successes as the denominator that turns the S2 signal into
a ratio, pending-chunk evictions, and the clock-skew discards behind S5.

**Absolute totals, not increments.** The endpoint reports counters that are
monotonic since node-server booted, so the poller tracks the previous absolute
per series and applies only the difference. That keeps the sidecar's own
counters monotonic and — importantly — keeps the rolling windows the alert rules
evaluate against meaningful, which a plain `set()` would have destroyed.

**Restarts rebase rather than diff.** A restarted node-server reports every
counter back at zero. `processUid` changes on every boot, so a change clears the
baselines and the fresh totals are attributed in full, since they are all events
this sidecar has not seen. A counter that goes backwards without a uid change is
treated the same way, so a restart between two polls can never produce a
negative rate.

**One metric got coarser, deliberately.** `scribear_node_upstream_churn_total`
was per-session from logs; node-server counts it per process. The N1 rule now
matches each series against its own labels and names the affected rooms from the
new per-session upstream gauge instead. The trade is worth it: the counter is
lossless where the log-derived one silently missed anything that happened while
the collector was detached.

**New alert for the blind spot this creates.** A node-server that is healthy but
rejecting the sidecar's service key leaves four metrics reporting nothing while
every probe stays green — a state the old log-based collector could not get
into. `nodeStatusUnavailableRule` fires on that, critical when the key is
rejected and warning when the endpoint is merely unreachable (which the probe
poller already alerts on).

The snapshot served to the admin SPA now includes a `gauges` block. Point-in-time
values had nowhere to go before, and per-session state is exactly what the
dashboard needs to draw a room rather than a number. Gauges for a session that
ends are deleted rather than frozen at their last value — except when the
response was truncated, where absence means "not told about" rather than
"ended".

Polling is disabled when `NODE_SERVER_SERVICE_API_KEY` is unset, matching how
the canary treats its device token: a default deployment must not 401 against
node-server on every interval forever. The startup log says so once, and the
metrics it would have fed stay empty rather than wrong.

transcription-service's decode-drop parser stays — that service has no status
endpoint yet (B1.2), so its side of the metric is still only visible in logs.
node-server's three A1 log lines also stay, as the per-event forensic record
behind the counters.
