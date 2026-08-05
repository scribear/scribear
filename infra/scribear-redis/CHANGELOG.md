# @scribear/scribear-redis

## 0.3.0

## 0.2.0

### Minor Changes

- 78663dc: Add `GET /api/admin/v1/fleet` (B1.7 part 2, fourth of four PRs).

  The first reader of the backplane 2a defined and 2b/2c write to: every live
  Node Server instance and session, every live Transcription Service host, and
  providers merged across the hosts serving them, in one Redis round-trip group
  independent of fleet size. No fan-out to instances.

  A provider's merged status is `down` only when every host serving it is
  `down` — a single host's `down` is a capacity loss, not an outage, per the
  key contract's own doc comment — and `ok` only when every host is. `activeSessions`
  sums across hosts; per-host detail (model, workers, reachability) is kept
  verbatim under `hosts` rather than reduced to a summary, since nothing
  consuming this yet has said what it needs.

  Requires an authed session, like every other admin route exposing
  infrastructure state. Answers 503 `TELEMETRY_UNAVAILABLE` when `REDIS_URL` is
  unset and 503 `TELEMETRY_DEGRADED` on a read failure — never 200 with an
  empty result, which would be indistinguishable from a fleet that is
  genuinely idle. This is a separate, always-optional data path from the
  existing `/health` rollup, which is unaffected.

  `scribear-redis` gains `Static` type exports (`ProviderHealth`,
  `TranscriptionWorker`, `TranscriptionHostSnapshot`) for the transcription-host
  snapshot schemas — this is the first consumer that needs to type a parsed
  value rather than just the schema.

  New env: `REDIS_URL` (admin-server), unset by default.

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

- eec0ab3: Surface, on `GET /providers/health` (and therefore the fleet backplane), which
  session/room a Transcription Service worker is actively processing - not just
  the aggregate `liveJobCount`/`contextIds` it already reported. Part 2 of the
  monitoring dashboard plan's session/room correlation work; Part 1 landed
  `sessionUid`/`roomUid` on the wire into Transcription Service but left them
  unused there.

  Transcription Service (Python, no changeset - no `package.json`) now tracks,
  per worker process, which job is running for which caller-supplied
  `session_uid`/`room_uid` (`WorkerProcessManager.register_job` gained two
  optional params, threaded through `WorkerPool.register_job` and all three
  providers' `register_job` call sites, which already had both in scope from
  Part 1). `serialize_worker` - the one join point shared by `/metrics/status`
  and `/providers/health` - reports it as a new `activeJobs: { jobId, sessionUid,
roomUid }[]` field per worker. Both are `null` when the caller supplied
  neither, matching every other nullable field on this endpoint.

  The Redis telemetry publisher needed no change: it spreads
  `ProviderHealthSnapshotService.snapshot()`'s dict (which already calls
  `serialize_worker`) verbatim into the published record, so `activeJobs`
  reaches the backplane for free. Same for `admin-server`'s `/fleet` reader -
  `FleetTelemetryService` returns `TranscriptionHostSnapshot[]` (workers
  included) unreduced, so no admin-server code changed.

  `@scribear/scribear-redis`'s `TRANSCRIPTION_WORKER_SCHEMA` (the hand-restated
  TypeScript mirror of `serialize_worker`'s shape, necessary because Python
  shares no schema package with the Node apps) gains the matching `activeJobs`
  field, via a new named `ACTIVE_JOB_SCHEMA`. `@scribear/admin-webapp`'s
  `TranscriptionWorker` interface - its own hand-restated mirror, needed because
  the browser bundle can't pull in `@scribear/scribear-redis` (it needs
  `ioredis`) - gains the matching field too, for the same reason `hosts` landed
  in `/fleet` in an earlier change with no consumer yet: nothing in
  `fleet-panel.tsx` renders per-worker/per-job detail today, and this is
  plumbing only, not a UI change. Verified `apps/monitoring-sidecar`'s hand-
  restated `/metrics/status` schema (used only for Prometheus emission, a
  different consumer) tolerates the new field with no change and no test
  regression, since its `Value.Check` does not reject unknown properties.

- a4c65bf: Add the TypeScript mirror for B2.1's per-session audio-level telemetry
  (`scribe:v1:audio:{sessionUid}`) - the first transcription-service-side,
  per-session telemetry to use the fleet backplane B1.7 built. Transcription
  Service (Python, no changeset) now runs a real-time audio-level meter
  (`AudioMeter`, in `whisper_streaming_job.py`) per Whisper streaming session -
  RMS dBFS, peak dBFS, clipping percentage, a silence flag, and a noise-floor
  estimate over a 10s rolling window - and replaces the previously-dead-code
  `RMSSilenceDetection` call site with it. Readings ride `TranscriptionResult`
  back across the worker-process boundary the same way `final_chunk_ids`
  already does, and a new push-based publisher, `RedisSessionAudioPublisher`
  (distinct from the existing host-level, pull-based `RedisTelemetryPublisher`
  - there is no live per-session state in the main process to beat against),
    writes them to Redis on each transcription result, throttled to at most one
    write per session every 2s.

  `@scribear/scribear-redis` gains `AUDIO_LEVEL_STATS_SCHEMA` and
  `SESSION_AUDIO_SNAPSHOT_SCHEMA` (`session-audio-snapshot.schema.ts`) - the
  hand-restated TypeScript mirror of `AudioLevelStats`, necessary because
  Python shares no schema package with the Node apps - plus the matching key
  builder (`transcriptionSessionAudioKey`) and index key
  (`TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY`) in `telemetry-keys.ts`, and the
  publish-interval/TTL constants (`AUDIO_STATS_MIN_PUBLISH_INTERVAL_MS`,
  `AUDIO_STATS_TTL_MS`) in `telemetry-timing.ts`. The 2s interval is
  provisional - it matches node-server's per-session heartbeat cadence as a
  starting point, not independently validated for this payload.

  This lands the publisher and schema only, per the plan's explicit staging
  (§3.5): no admin-server reader, no SPA consumer. Wiring `GET /fleet` and a
  dashboard panel to this key family is deliberately a later, separate change,
  once the publisher's real shape has had a chance to prove out - the same
  staging B1.7's fleet endpoint/`useFleet()` hook split used, and the corrective
  this project already learned once from `PLAN-fleet-and-testaudio.md`'s stale
  draft reader.

  `transcriptionHost` is a required field, not nullable: `RedisSessionAudioPublisher`
  is constructed with the same `transcription_host_id` `RedisTelemetryPublisher`
  already reports (`create_webserver.py` has it in scope at both construction
  sites), so every publish stamps a real value - there is no case where a
  session-audio snapshot exists without one, unlike `roomUid`.

- 8d0fc4d: Add the TypeScript mirror for B2.2's per-session VAD (voice-activity-detection)
  statistics, folded into the same `scribe:v1:audio:{sessionUid}` snapshot B2.1's
  audio-level meter already publishes to - not a second key. Transcription
  Service (Python, no changeset) now accumulates `VadStats` per batch in
  `WhisperStreamingProviderJob` (speech-active ratio, segment count, mean
  segment duration, speech-to-pause ratio, and a VAD-gated SNR estimate) from
  the same speech/silence ranges `_detect_speech_ranges` already computes to
  decide what to hand Whisper - no new detection logic. `AudioMeter`'s internal
  `_dbfs` helper is renamed to the public `dbfs` and exported, since B2.2's SNR
  calculation is the second real caller of the RMS->dB conversion. Corrects the
  master plan's original framing ("surface which VAD config is active" -
  implying a Silero-vs-faster-whisper comparison): that comparison doesn't
  exist in the real code, VAD is Silero-only and faster-whisper's own VAD is
  explicitly disabled, so this surfaces one boolean (VAD on/off) plus derived
  stats when it's on.

  `@scribear/scribear-redis` gains `VAD_STATS_SCHEMA`/`VadStats`
  (`session-audio-snapshot.schema.ts`) and adds a required `vadStats` field
  (nullable value) to `SESSION_AUDIO_SNAPSHOT_SCHEMA`. Every `VadStats` field
  but `vadEnabled` is nullable, and deliberately in two distinct ways: VAD off
  means the whole reading is not meaningful (everything but `vadEnabled` is
  null); VAD on but no speech found in a given batch is a real, meaningful
  zero-valued reading (`speechActiveRatio: 0`, `segmentCount: 0`,
  `speechToPauseRatio: 0`), except `meanSegmentDurationSec`/`snrDb`, which stay
  null even then (undefined - no segment to average, no signal side to compare
  against noise).

  Same staging as B2.1: this lands the publisher/schema extension only, no
  admin-server reader or SPA consumer - wiring a dashboard panel to `vadStats`
  is a later, separate change.

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
