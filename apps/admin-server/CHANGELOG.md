# @scribear/admin-server

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

### Patch Changes

- Updated dependencies [78663dc]
- Updated dependencies [a46b976]
- Updated dependencies [eec0ab3]
- Updated dependencies [a4c65bf]
- Updated dependencies [8d0fc4d]
- Updated dependencies [7562c6b]
- Updated dependencies [5977be2]
  - @scribear/scribear-redis@0.2.0

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

### Patch Changes

- Bump `testcontainers` 11 -> 12 (dev-only integration-test dependency) to drop
  the transitive `uuid@10.0.0` pull that was the last live Dependabot alert
  (GHSA-w5hq-g745-h8pq). No production runtime change; `npm audit` now reports 0
  vulnerabilities. Integration suites re-verified: session-manager (308),
  admin-server (19), node-server (17).
