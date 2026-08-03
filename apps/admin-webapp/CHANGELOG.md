# @scribear/admin-webapp

## 0.2.0

### Minor Changes

- c7ba3c2: Extend the admin `/health` rollup to every service, with real timeouts (B1.5).

  The rollup checked only the database and session-manager. It now also checks
  node-server and transcription-service, reading their unauthenticated readiness
  probes concurrently.

  **Fixes a hang.** The session-manager check went through the generated client,
  which issues a bare `fetch` with no `AbortSignal` unless a caller passes one —
  and the health path did not. A hung session-manager could stall the route for
  the OS TCP timeout with an admin waiting on it. Every component now has a hard
  `HEALTH_CHECK_TIMEOUT_SEC` (default 3s).

  **Breaking response shape.** `sessionManager` / `sessionManagerLatencyMs` /
  `database` are replaced by a `components` list of
  `{ name, status, latencyMs, detail? }`. Flat per-service keys meant every new
  dependency needed a server change, an SPA type change and a new hardcoded tile;
  the dashboard and health chip now render from the list. A 503 readiness is now
  reported as `fail` rather than `degraded` — the service answered and said it is
  unhealthy — and the readiness `checks` map, previously discarded, is surfaced as
  the component's `detail`.

  New env: `NODE_SERVER_BASE_URL`, `TRANSCRIPTION_SERVICE_BASE_URL`,
  `HEALTH_CHECK_TIMEOUT_SEC`.

  > **Bump type note.** Recorded as `minor` rather than `major` because the
  > packages are pre-1.0, where the semver convention is that a minor bump
  > carries breaking changes and 1.0.0 is reserved for declaring the API
  > stable. Changesets does not apply that convention itself — a `major`
  > entry here would have taken every package straight to 1.0.0. The breaking
  > changes themselves are unchanged and are described above.

- d9a2f12: Add a Config Check page to the admin console: `GET /api/admin/v1/config-check`
  and an **Admin → Config Check** view that reports this deployment's
  configuration posture and says which findings would be unacceptable in
  production.

  **The problem it solves.** Nothing in the stack tells an operator that their
  admin password is still `CHANGEME`. Boot-time assertions catch the cases that
  are indefensible everywhere, but they cannot catch the ones that are correct in
  a dev container and a compromise in production — a guard that refuses to boot on
  a placeholder password would make local development miserable, and one that
  allows it says nothing at all in production. That gap is where this page lives.

  **Severity is per environment, and every finding carries all three.** A new
  `DEPLOYMENT_ENV` (development | staging | production) selects which standard the
  report is judged against. Each finding also reports its `productionSeverity`
  regardless of where it is evaluated, and the page surfaces the count of findings
  that are critical in production as a banner. That is the part worth having: a
  staging deployment can be entirely green and still be unfit to promote, and
  without this the gap is invisible until it is a production incident.

  `DEPLOYMENT_ENV` is a plain string with an empty default rather than an enum, so
  adding it cannot stop an existing deployment from booting, and a typo is
  reported by the check rather than by a boot failure. Unset infers **production**
  unless the server was started with `--dev`. The asymmetry is deliberate: every
  deployment predating this variable has it unset, and the two mistakes are not
  equivalent. Guessing development would greet a real deployment with a page of
  reassuring green while its admin password was public; guessing production shows
  a developer a few findings they can dismiss in one read, or silence with one
  line in `.env`.

  **Scope, and where it stops.** admin-server can read its own environment and
  nothing else's — no service discloses another's configuration, and adding an
  endpoint that did would be a much larger liability than this page is worth. So
  the checks are of two kinds. Direct ones over admin-server's own variables
  (placeholder secrets, no login method configured, SSO without a group
  restriction, `--dev` outside development — which silently clears `Secure` on the
  session cookie). And _inferences_ from observable behaviour for everything else:
  a reachable-but-empty telemetry backplane means no node-server or
  transcription-service has ever published, which is the only evidence available
  that their `REDIS_URL` was never set. The inferences are phrased as what was
  observed rather than as conclusions about variables this process cannot see.

  **No secret ever reaches the response.** Findings carry a classification and a
  length — never a prefix, suffix, or hash, since a prefix is directly useful and
  a hash of a short secret is a slower way of disclosing it. The route is behind
  `requireSessionHook`, but "authenticated" is not the same as "cleared to read
  every credential in the deployment", and a config report is exactly the kind of
  page that gets screenshotted into a ticket. A unit test asserts that no secret
  value appears anywhere in the serialized findings.

  The rule set is split into a pure `evaluateStaticChecks` and the two async
  checks that need I/O, so the bulk of it is testable by construction — a false
  `ok` here is indistinguishable from a well-configured deployment, which makes
  these the rules most worth testing exhaustively.

- fb10587: Add the "Live fleet" panel to the dashboard (`fleet-panel.tsx`,
  `fleet-status.ts`), the first UI consumer of `useFleet()` — plan §B.4's
  provider row + filterable status grid.

  `SessionSnapshot` carries no `roomUid` — node-server's telemetry is
  per-session, not per-room, and a session has no durable link back to the room
  that opened it. `PLAN-fleet-and-testaudio.md` §B.4's `RoomTelemetry` /
  `roomUid` grouping predates the real B1.7 schema and doesn't exist on the
  wire, so the grid is session-centric (one card per `sessionUid`) instead.

  No writer publishes a canonical per-session status, so `deriveSessionStatus`
  computes one from `upstreamState` (`OPEN` → good, `WAITING_RETRY` /
  `CONNECTING` / `HANDSHAKING` → warn, `CLOSED` → crit, `IDLE` → idle), refined
  by the live `/fleet/stream` connectivity event when one has arrived for that
  session — it's more current than what's baked into the last `/fleet`
  snapshot.

  Filter/sort is client-side over the already-fetched snapshot (status chips,
  provider select, text search on `sessionUid`), matching plan §B.3's
  `useFilteredRooms` shape but adapted to sessions. Status chip counts are
  computed from the unfiltered set so they keep reflecting the whole fleet while
  a status filter narrows the grid under them.

  No virtualization yet (plan §B.4 flags it for >100 cards) — skipped for now
  since nothing currently produces fleet sizes anywhere near that; add it if a
  real deployment gets there rather than guessing at the threshold.

  Not covered by a test: admin-webapp still has no vitest config / tests/ dir
  (same gap `d4fb740` noted).

- 90791ec: Add a "Show UUIDs" toggle to the admin webapp.

  Device and room names throughout the app (list and detail pages) are opaque
  without their underlying identifiers, which matters when cross-referencing
  against logs or the API. A toolbar switch, persisted to `localStorage`,
  renders each entity's UUID in muted monospace beneath its name when enabled.
  The devices list also now resolves a device's room UID to the room's display
  name via a lookup fetched once from `GET /rooms`, since `Device` carries no
  room name field.

- d4fb740: Add `adminApi.fleet()` and the `useFleet()` hook
  (`src/features/dashboard/use-fleet.ts`), the SPA's first consumer of
  `GET /api/admin/v1/fleet` and `/fleet/stream` (B1.7 §2.5,
  `PLAN-fleet-and-testaudio.md` §B).

  The hook seeds from a `fleet()` snapshot, then layers `/fleet/stream` deltas
  on top. The stream carries no initial state and never re-seeds itself — every
  frame is a plain default SSE `message`, not a named `snapshot`/`delta` pair —
  so a (re)connect re-fetches `/fleet` explicitly on the `EventSource`'s `open`
  event; that is what makes a dropped connection self-heal instead of quietly
  serving a stale snapshot forever.

  `FleetSnapshot` and its nested types (`NodeSnapshot`, `SessionSnapshot`,
  `TranscriptionHostSnapshot`, `ProviderHealth`, `MergedProvider`,
  `SessionStatusEvent`) are restated in `admin-api.ts` rather than imported from
  `@scribear/scribear-redis`: that package depends on `ioredis` and has no
  browser-safe entry point, so importing it would pull a Node Redis client into
  this bundle. Kept in step by eye, the same way transcription-service's Python
  side already restates the same TypeScript contract.

  Because a session delta carries only two connectivity booleans, not a full
  session record, live deltas are exposed as their own `sessionEvents` map
  (keyed by `sessionUid`) rather than spliced into `snapshot.sessions` — a
  consumer joins the two by `sessionUid` rather than the hook guessing at a
  merge.

  No UI consumes this yet — the room grid / provider row (plan §B.4) is
  follow-up work.

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

- cef5888: Track device `lastSeenAt` and derive online/offline state (B1.6).

  Devices are stamped in the device-token hook, so presence covers every
  device-authenticated route rather than only the schedule long poll. Writes are
  coalesced to at most one per device per `DEVICE_LAST_SEEN_WRITE_INTERVAL_SEC`
  (default 60s) and are fire-and-forget, so a failed write never turns a working
  device request into a 500.

  `Device` gains `lastSeenAt` (nullable) and `online`, derived server-side against
  `DEVICE_ONLINE_TTL_SEC` (default 180s) so every consumer agrees on one cutoff.
  The admin devices list gains a Presence column. Admin-server needs no change —
  its device routes are a generic passthrough.

  New migration `00000011-device-last-seen`. The column is nullable with no
  backfill: NULL means "not heard from since this shipped", which is honest, where
  defaulting to `now()` would have shown the whole fleet as freshly online.

## 0.1.0

### Minor Changes

- b34905f: Add the ScribeAR Admin website foundation (PLAN-ADMIN Phase 0–1).
  - **`apps/admin-server`** — a Fastify Backend-for-Frontend that holds the
    Session Manager admin key server-side and exposes `/api/admin/v1`. Includes:
    a pluggable auth layer (local single-account provider now via
    `ADMIN_LOCAL_CREDENTIALS`, constant-time compare; Azure OIDC stub for later);
    server-side revocable sessions (HttpOnly + Secure + SameSite=Strict signed
    cookie) with a session-bound CSRF token; per-route rate limiting (strict on
    login); a Session Manager gateway that is the single place the admin key is
    used and injected; a consistent `{ ok, data?, error? }` response envelope;
    rooms + devices proxy/task endpoints with read-only/read-write role gating;
    a `/health` rollup; and a Postgres-backed append-only admin audit log
    (own migration + migration-tracking tables).
  - **`apps/admin-webapp`** — a minimal React SPA placeholder (build + healthcheck)
    to be built out in later phases.

  Both workspaces are wired into the monorepo (workspaces auto-discovery,
  tsconfig project references) with unit + integration tests. Deployment
  (compose/nginx/CI) and the full SPA UI land in later phases.
