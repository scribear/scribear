---
'@scribear/node-server-schema': minor
'@scribear/scribear-redis': minor
'@scribear/node-server': minor
---

Publish Node Server telemetry to the fleet backplane (B1.7 part 2, second of
four PRs).

Past ~100 rooms the fleet runs several Node Server instances, and sticky routing
pins each session to exactly one of them, so no single instance can answer what
the fleet is doing. Each instance now writes what it knows to Redis every two
seconds: its own `/status` process record, one record per live session, and a
route key naming it as that session's owner. The reader's cost stops depending
on how many instances there are, and an instance that is up and idle stops being
indistinguishable from one that has died.

Liveness is expiry. Every key carries a TTL of five heartbeats and nothing is
ever deleted, so an instance that stops writing stops existing and a `kill -9`'d
one's rooms leave the fleet view with no cleanup path to get wrong.

Redis being unavailable costs the dashboard its cross-instance view and costs
sessions nothing: no caller awaits a beat, the connection refuses to queue
commands while disconnected, and a failed beat is logged once and retried by the
next one.

**New field on `GET /api/node-server/v1/status`.** Session records now carry
`providerKey`, the provider the session's upstream was opened against — the
field that joins a room to the provider health reported for it. It is required,
so a consumer validating the response (the Monitoring Sidecar does) rejects a
body from a Node Server that predates this change; deploy the two together.

New env: `REDIS_URL` (unset = publishing off, the default) and
`NODE_INSTANCE_ID` (defaults to the hostname).
