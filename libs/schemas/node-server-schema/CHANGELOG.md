# @scribear/node-server-schema

## 0.2.0

### Minor Changes

- 8be4adb: Thread opaque, nullable `sessionUid`/`roomUid` from Node Server through to
  Transcription Service (Part 1 of the monitoring dashboard plan; Part 2 -
  actually using them there - is deliberately deferred).

  `TRANSCRIPTION_STREAM_SCHEMA`'s `CONFIG` client message gains snake_case
  `session_uid`/`room_uid`, matching the wire protocol's existing casing and
  the file's own `final_chunk_ids`/`in_progress_chunk_ids` tolerance pattern:
  `Type.Optional(Type.Union([Type.String(), Type.Null()]))`, so a
  Transcription Service that predates these fields still validates the
  message. `TranscriptionOrchestratorService._openSession` sends both, sourced
  from the session it already reads (`sessionUid` is its own parameter,
  `roomUid` from `Session.roomUid`).

  Separately, but for the same reason, Node Server's own outbound `/fleet`
  telemetry (`STATUS_SESSION_SCHEMA`, composed by `@scribear/scribear-redis`'s
  `SESSION_SNAPSHOT_SCHEMA` - unmodified here, since composition picks the
  field up automatically) gains a camelCase `roomUid: string | null`
  (optional, so an older Node Server's snapshot still validates), populated
  from the same `Session.roomUid` the orchestrator already tracks per open
  session.

  `admin-webapp` restates the Redis snapshot shape by hand (to keep `ioredis`
  out of the browser bundle) and gains the matching `roomUid` field. The fleet
  panel's session card now shows the room uid (or "no room"), and the
  session-search filter matches against it as well as `sessionUid` - the
  actual point of the change, letting an operator find a room by name-ish
  identifier instead of only by opaque session uid.

  Transcription Service's Python side stores `session_uid`/`room_uid` on the
  session/job object for every provider (`WhisperStreamingProvider`,
  `DebugProvider`, `LumenGraniteProvider`) but does nothing else with them
  yet - no logging, no metrics, no `/providers/health` change. That
  service has no `package.json`/changelog, so it isn't listed above.

- 240f48b: Add inbound service-API-key authentication to node-server (monitoring plan
  B1.1, second of four PRs — the auth infrastructure only; no route consumes it
  until the status endpoint lands).

  Node Server had no inbound-authed HTTP route at all: its OpenAPI security
  schemes were empty, there was no hooks directory, and its only authentication
  was per-WebSocket and performed inside the stream controller. The status
  endpoint that B1.1 exposes carries per-session operational detail, so it needs
  a trust boundary that did not exist yet. This builds one by mirroring Session
  Manager's `ServiceAuthService` + `serviceApiKeyHook` pair rather than inventing
  a second scheme.

  The key is a new `NODE_SERVER_SERVICE_API_KEY`, deliberately distinct from the
  `SESSION_MANAGER_SERVICE_API_KEY` this service already holds. That one is
  presented _outbound_ to Session Manager; the new one is required _inbound_ from
  observability consumers. They are opposite directions across different trust
  boundaries, and sharing one string would mean that compromising the monitoring
  sidecar also grants Session Manager access.

  Comparison goes through `constantTimeEqual`, which HMACs both operands to a
  fixed-width digest before `timingSafeEqual` — so the comparison cannot throw on
  a length mismatch and the secret's length is not observable from response
  timing. The service also refuses to construct when the key is still the literal
  `CHANGEME` placeholder.

  The hook is attached per route rather than plugin-scoped, so adding it cannot
  accidentally put an API key in front of the liveness and readiness probes or
  the transcription WebSocket.

  Note for reviewers: the 401 body's `code` is declared as a schema `const` of
  `INVALID_SERVICE_KEY` while the thrown error's code is the generic
  `UNAUTHORIZED`. The serializer emits the constant, so the wire response is
  `INVALID_SERVICE_KEY` — this matches Session Manager's existing behaviour, and
  the two services now document and emit the same code for the same failure.

- b02e9ff: Add `GET /api/node-server/v1/status` (monitoring plan B1.1, third of four PRs)
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
  would answer a _missing_ credential with 400 VALIDATION_ERROR while a _wrong_
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

- d947523: Aggregate transcript latency server-side and report percentiles (B1.4).

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

- 7562c6b: Publish Node Server telemetry to the fleet backplane (B1.7 part 2, second of
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

- 5977be2: Add the Redis telemetry backplane's contract and container (B1.7 part 2, first
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

## 0.1.0
