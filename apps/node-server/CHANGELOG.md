# @scribear/node-server

## 0.2.0

### Minor Changes

- a46b976: Add `GET /api/admin/v1/fleet/stream` (B1.7 part 2.5): sub-second session
  status pushes over SSE, instead of waiting for the next 2 s heartbeat.

  Node Server's `_setStatus` — already the single edge-triggered writer of a
  session's connectivity — now also publishes each transition to a new
  in-process event bus channel. `RedisTelemetryPublisher` subscribes to it only
  once telemetry is switched on, and forwards each delta to a new Redis pub/sub
  channel, `scribe:v1:events`, on its existing heartbeat connection. No new
  Redis connection on Node Server, and no new dependency on the orchestrator:
  routing the delta through the in-process bus is what keeps a Redis-touching
  class out of a code path that resolves on every session regardless of
  `REDIS_URL`.

  `scribear-redis` gains the channel's contract: a `Type.Union` schema
  discriminated by `t`, with only the `session` variant defined today — a
  `node`/`provider` variant belongs there once something actually publishes
  one, not before.

  admin-server gains `FleetEventsService`, the first real consumer of the
  typed `createRedisSubscriber` this package restored in B1.7 part 2a: it
  subscribes once and fans every message out to connected SSE clients. The
  route answers 503 `TELEMETRY_UNAVAILABLE` before hijacking the response when
  `REDIS_URL` is unset, matching `GET /api/admin/v1/fleet`'s existing shape —
  after hijacking there is no envelope left to send. Requires an authed
  session cookie, same as every other admin route; a same-origin `EventSource`
  sends it automatically.

  Also fixes a real bug in `scribear-redis`'s `createRedisSubscriber`:
  `disconnect()` called `redis.quit()`, an ordinary command that queues behind
  the subscription already issued on construction and can hang forever against
  an unreachable or misconfigured Redis. Switched to the synchronous
  `redis.disconnect()` — nothing on a connection being torn down is worth
  waiting for. Safe to change: nothing else called this factory yet.

  No new env var — the SSE subscriber reuses admin-server's existing
  `REDIS_URL`. `infra/scribear-nginx`'s `nginx.conf` gains an exact-match
  `location = /api/admin/v1/fleet/stream` with buffering disabled and a long
  read timeout, since the general `/api/admin/` block is deliberately left
  alone for every other (bounded) admin route.

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

- 6f8e5b9: Add the monitoring sidecar (Part A items A1 + A3) and the node-server
  observability log lines it depends on.

  The sidecar is a standalone service that parses the other services' JSON logs
  into metrics, polls their liveness/readiness probes, evaluates the failure-mode
  alert rules in-process, and serves both a JSON snapshot and a Prometheus text
  endpoint. All state is in memory.

  node-server gains three `info` log lines that carry signals which previously
  existed only in memory: WebSocket close code/reason (server- and
  peer-initiated) and upstream transcription connection state transitions.
  Without these the upstream-flap and close-code metrics are not derivable from
  logs at all. No behaviour changes, and the added lines are off the audio hot
  path.

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

- 325ec8f: Add in-process telemetry counters to node-server (monitoring plan B1.1, first
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
  _ratio_ approaching 100%, which a failure count alone cannot distinguish from a
  handful of bad clients.

  Close reasons are normalised against a known-reason allowlist before being used
  as a counter label. On a peer-initiated close the reason is arbitrary
  remote-supplied text, so recording it verbatim would let any client grow the
  label map without bound.

  No behaviour changes: every counter sits beside an existing branch, and the
  audio hot path gains only integer increments.

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

### Patch Changes

- 08c0401: Make an upgrade that carries over a pre-monitoring `.env` fail loudly instead of
  silently coming up insecure, and document the upgrade in
  `deployment/UPGRADING.md`.

  `deployment/.env` is untracked, so it does not update when an operator pulls.
  The monitoring/fleet release adds two required secrets — `NODE_SERVER_SERVICE_KEY`
  and `REDIS_PASSWORD` — and Compose substitutes a blank string for an unset
  variable rather than erroring. Both blanks fail _open_:
  - `redis-server --requirepass ""` is not a password-protected server that
    rejects logins, it is an open server that accepts every unauthenticated
    command — and it would be holding the whole fleet's operational state.
  - An empty `NODE_SERVER_SERVICE_API_KEY` compares equal, via
    `constantTimeEqual`, to the empty string a caller presents as
    `Authorization: Bearer `, so the inbound service-auth guard admits
    unauthenticated requests to node-server's internal routes.

  Verified against a `.env` taken from before the release: `docker compose up`
  previously emitted two "variable is not set, defaulting to a blank string"
  warnings and proceeded. Those two variables now use Compose's `${VAR:?message}`
  form, so interpolation fails and the stack aborts before any container starts,
  naming the file to read. The message is repeated at every use site rather than
  abbreviated at some, because Compose reports only the first failure it reaches
  and it walks services alphabetically — the sidecar's copy fires before the node
  server's.

  `assertNotPlaceholderKey` now rejects the empty string alongside `CHANGEME`, in
  both node-server and session-manager, so the same misconfiguration is caught at
  boot on deployments that do not use Compose at all. Both copies of the util are
  kept byte-identical, as before.

  It also now matches `CHANGEME` as a case-insensitive **substring** rather than
  by equality. Only some of the stubs in `.env.example` are the bare word; the
  rest carry a suffix that exists purely to satisfy a minimum-length rule —
  `CHANGEME-JWT-must-be-at-least-32-characters-long`,
  `CHANGEME-admin-session-secret-at-least-32-characters` — or sit inside a larger
  value, `ADMIN_LOCAL_CREDENTIALS=engrit CHANGEME`. An equality check passed all
  three, which is exactly backwards: a length rule pushes an operator to keep
  those stubs verbatim rather than invent a long one, so they were the stubs most
  likely to survive into a deployment and the only ones the guard ignored.

  transcription-service had the same empty-key bypass and no guard at all:
  `AuthService.is_authenticated` compared with `==`, so an empty `API_KEY`
  authenticated any caller presenting no key, and the comparison leaked the shared
  prefix length through timing. It now refuses to construct on an empty or
  placeholder key and compares with `hmac.compare_digest`, matching what
  `MetricsAuthService` in the same package already did. (`METRICS_API_KEY` was
  already correct — empty means the route is never registered, which is a genuine
  disabled state rather than an open one.)

  This is defence in depth for one misconfiguration, not two mechanisms for two
  problems: Compose stops the common case early and with the better message, and
  the boot-time assertion covers the paths Compose never sees.

## 0.1.0

### Minor Changes

- Add end-to-end latency metrics on the new architecture.
  - New `@scribear/audio-frame-protocol` package: a versioned, self-describing
    binary frame format (magic + version + TLV fields + trailing CRC-32) with a
    mirrored Python implementation in `transcription_service`, replacing
    fixed-offset framing so client and server can evolve independently.
  - `node-server`'s transcription orchestrator stamps and forwards clock-sync /
    latency events end-to-end through the transcription stream pipeline.
  - `client-webapp` and `kiosk-webapp` surface live latency in the session UI
    (new `latency-badge` component, kiosk/client session services wired to the
    new events).

  See `TOBEREVIEWED.md` for the architectural notes carried over from the
  latency-metrics-v2 rework (PR #124, superseding #67).

### Patch Changes

- Bump `testcontainers` 11 -> 12 (dev-only integration-test dependency) to drop
  the transitive `uuid@10.0.0` pull that was the last live Dependabot alert
  (GHSA-w5hq-g745-h8pq). No production runtime change; `npm audit` now reports 0
  vulnerabilities. Integration suites re-verified: session-manager (308),
  admin-server (19), node-server (17).
