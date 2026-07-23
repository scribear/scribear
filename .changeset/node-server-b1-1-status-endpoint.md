---
'@scribear/node-server': minor
'@scribear/node-server-schema': minor
---

Add `GET /api/node-server/v1/status` (monitoring plan B1.1, third of four PRs)
— the authed telemetry endpoint the counters and the service-key auth from the
previous two PRs were built for. The monitoring sidecar switches to it in PR 4.

The response separates two kinds of number, because they decay differently.
`summary` and the labelled arrays are monotonic counters, never reset, meant to
be differenced by the consumer; `sessions[]` holds live gauges that vanish with
the session. `processUid` and `processStartedAt` sit at the top level because
differencing is only valid within one process lifetime — after a restart the
counters are back at zero, and a consumer that did not check would report a
large negative rate rather than a restart.

`sessions[]` is composed from two sources, which is the whole reason B1.1 needs
an endpoint rather than a getter: source counts, pending-chunk depth and
upstream state live on the orchestrator, while subscriber counts live on the
metrics service, because receive-only connections never reach the orchestrator
at all. The array restates its fields rather than embedding the
`SessionStatus` WebSocket message — that message is a client-facing contract,
and coupling operator telemetry to it would stop either from changing alone.
It is capped at 200 entries with a `sessionsTruncated` flag; a silent cap would
read as "that is all of them", while `summary.activeSessionCount` stays the
real total.

The `authorization` header is declared optional in the schema on purpose.
Fastify validates the request before the preHandler runs, so a required header
would answer a *missing* credential with 400 VALIDATION_ERROR while a *wrong*
one got 401. Leaving presence to the hook means every credential problem
answers 401 — one thing for a consumer to alert on, and the correct HTTP
semantic. A present-but-malformed header still fails validation with 400. This
is a deliberate divergence from the session-manager routes it otherwise
mirrors.

Two integration suites cover the failure modes that motivated the plan, both
against a real session. The second points node-server at an unreachable
transcription service and asserts that upstream churn climbs and the session
reports `WAITING_RETRY` — the scenario that previously produced no log lines at
all, and the reason the sidecar's log-parsing was replaced. It also drives past
the 2000-entry pending-chunk cap and asserts evictions are counted and the
gauge pins at the cap, which is the first evidence that cap is reachable in
practice.

The endpoint is for cluster-internal consumers only and must not be routed
through the public reverse proxy.
