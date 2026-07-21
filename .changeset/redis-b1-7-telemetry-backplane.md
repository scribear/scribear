---
'@scribear/scribear-redis': minor
'@scribear/node-server-schema': minor
---

Add the Redis telemetry backplane's contract and container (B1.7 part 2, first
of four PRs). Nothing publishes or reads it yet; this PR defines what they will
agree on and stands up the infrastructure they will agree over.

**Why Redis, and why now.** Past ~100 rooms the fleet runs several Node Server
instances and several Transcription Service hosts, each holding its sessions'
counters in its own memory, with sticky routing pinning a session to one
instance. A dashboard that fans out over N instances gets slower and less
correct as N grows - a missed instance is indistinguishable from an idle one.
Redis is the shared last-value store instead: everyone publishes, the admin
server reads only Redis, and instance count stops mattering. This is master
plan §13.2's role 1, and it is the only shared dependency the plan adds - no
Prometheus, no third-party metrics product.

**Restores `infra/scribear-redis`,** deleted in the session-manager rearchitect
(81db8b2). Its typed pub/sub - `ChannelDefinition`, `createRedisPublisher`,
`createRedisSubscriber`, the latter validating each message against the
channel's schema and dropping what fails - comes back unchanged, along with its
tests. `package-lock.json` had carried the package as `extraneous` ever since,
so the lock file is also now consistent again.

**Snapshot-plus-index, with expiry as liveness.** Each publisher rewrites its
keys every heartbeat under a TTL of five heartbeats and adds itself to a sorted
index scored by publish time. Nothing deletes anything: a process that stops
writing stops existing, which is what makes a `kill -9`'d instance's rooms
leave the fleet view with no cleanup path to get wrong. Readers must range the
index by score rather than trust it whole, because sorted-set members have no
TTL of their own - the one sharp edge in the scheme, and the reason the
constants and the key layout ship together rather than in each publisher's
config.

**Three deviations from `PLAN-B1.7-providers-and-redis.md` §2.1**, all for the
same reason - the plan §2 draft predates part 1 landing:

1. **A Transcription Service host publishes one key, not one per provider.** A
   host reads its whole registry in a single pass, so per-provider keys buy no
   independent freshness while costing a second index and a composite member
   that has to be parsed back apart. Holding them together also makes each read
   internally consistent: the workers and the providers that ran on them are
   always from the same instant.
2. **Node Server instances get their own snapshot key,** which §2.1 has no
   equivalent of. Assembled from session records alone, an instance that is up
   and idle and an instance that is dead both contribute nothing, and the fleet
   view cannot tell them apart - which is the first question an operator asks.
3. **Payloads are the existing telemetry bodies, not new ones.** The session
   and process records are the `/status` schemas, composed rather than
   restated, and the host record is the `/providers/health` body. §2.2's sample
   invented a parallel vocabulary (`pipelineMsP95`, `sourceConnected`,
   `stage`); a consumer already parsing `/status` would have had to learn a
   second spelling of the same numbers. Both records now carry `processUid`,
   which §2.2 omitted - it is what lets a consumer tell a restart from a lull
   instead of reading monotonic counters back to zero as a large negative rate,
   and is the reason `74ed367` put it on `/providers/health`.

Alert and per-minute rate keys from §2.1 are deliberately absent: nothing
detects an alert yet, and a key schema with no writer is a guess.

**`node-server-schema` exports `STATUS_SESSION_SCHEMA`, `STATUS_PROCESS_SCHEMA`
and `LATENCY_SERIES_SCHEMA`,** previously module-private, and `STATUS_SCHEMA` is
now composed from the first two. The response body is byte-identical. Sharing
them is what keeps a field added to `/status` from silently meaning something
else on the backplane, and a unit test fails if a field stops flowing through.

**Deployment.** A `redis` container on the `backend` network only, not
published to the host, with authentication required and persistence off - every
key is a snapshot rewritten within seconds, so an RDB or AOF would restore only
state that is stale by construction, including rooms that no longer exist. It
is added ahead of its publishers on purpose: introducing shared infrastructure
in the same change that starts depending on it makes a telemetry bug and a
deployment bug look identical.

New env: `REDIS_PASSWORD` (deployment only; the services' own `REDIS_URL`
settings arrive with the publishers that read them).
