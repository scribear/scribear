# @scribear/node-server

## 0.3.0

### Minor Changes

- 6f61774: Demo caption room: on by default everywhere, surfaced in the admin console with
  a one-click "open live captions" link, with a bare-`/client` routing fix.
  - **On by default.** `DEMO_ROOM_ENABLED` now defaults to `true` in both the Node
    Server and Session Manager (every environment, including production); set
    `DEMO_ROOM_ENABLED=false` to turn it off. `DEMO_SESSION_UID` is no longer
    plumbed through `deployment/compose.yml` — both services share the same
    built-in default, so neither var needs setting for a working demo room.
  - **Admin dashboard — Demo caption room card.** Shows whether the demo room is
    enabled and whether its seeded session is currently joinable, and — when it is
    — an **Open live captions** button that opens the client webapp straight into
    the looping demo captions with no manual join-code entry. A forcing function
    for exercising the client frontend end-to-end without a mic, source device, or
    transcription service.
  - **Session Manager — `GET /demo-room/status` (admin-key).** Reports
    `{ enabled, sessionUid, active, roomName, joinCode }`, minting/returning a
    currently-valid join code (via the same idempotent `ensureCurrentJoinCode` the
    seeder uses) only when the session is active. Plumbed through the
    session-manager schema + client and proxied by the admin server's gateway with
    the admin API key it already holds; the console builds the same-origin
    `/client/#config=<base64>` deep link the kiosk QR uses.
  - **nginx — route bare `/client`.** A request to `/client` (no trailing slash)
    now 308-redirects to `/client/` (the browser preserves the `#config=...`
    fragment), so deep links resolve regardless of the trailing slash.
  - **Kiosk — fix QR 404.** The QR code defaulted to `${origin}/client` (no
    trailing slash); the reverse proxy only serves `/client/`, so scanned codes
    404'd. Now defaults to `${origin}/client/`.

- 0e7ec83: A credential problem now always answers 401. It could answer 400, including for
  a key that was correct.

  `SERVICE_API_KEY_AUTH_HEADER_SCHEMA` and `ADMIN_API_KEY_AUTH_HEADER_SCHEMA`
  pinned the `Authorization` header to `^Bearer [A-Za-z0-9_-]+$`. Fastify runs
  request validation _before_ the preHandler that checks the key, so that pattern
  decided the status code for credentials the auth hook never saw. A key from
  `openssl rand -base64 32` contains `+`, `/` and `=`, none of which the class
  allowed, so such a deployment got `400 VALIDATION_ERROR` on every call — correct
  key or not — while a merely _wrong_ hex key got 401. Verified live through the
  public origin: `Bearer abc+def/ghi=` → 400, wrong hex key → 401. Which generator
  an operator happened to reach for decided whether their deployment
  authenticated. `openssl rand -hex 32`, which `deployment/UPGRADING.md`
  recommends, dodges it by luck.

  This directly contradicted the reasoning already written beside it, which
  explains that the header is left _optional_ precisely so that missing and wrong
  credentials both answer 401, "which is one thing for a consumer to alert on".

  The pattern is gone. Rejected: widening the class to cover base64, base64url and
  hex (plus `.` for JWT-shaped keys). That shrinks the blast radius without
  removing it — it is still a guess about what an operator's secret manager emits,
  and a guess wrong by one byte still tells someone holding the right credential
  that their _request_ was malformed. There is no encoding these services need the
  key to be in, so there is nothing for a pattern to assert. It costs no security
  either way: the pattern was never the control — the constant-time comparison in
  `ServiceAuthService.isValid` / `AdminAuthService.isValid` is — and those methods
  already reject anything without the `Bearer ` prefix, so removing it only moves
  that answer from 400 to 401. `description` and `examples` keep the OpenAPI
  documentation the pattern was incidentally carrying.

  The admin key path had the same hazard and one worse: session-manager's 32
  admin-key routes declared `authorization` as a _required_ header, so a caller who
  forgot it entirely got `400 must have required properties authorization` while a
  caller who got it wrong got 401 — two alerts for one problem. All 32, plus
  `session-config-stream`, now wrap the header in `Type.Optional`, matching what
  node-server's `/status` already did on purpose. Every one of those routes is
  covered by `adminApiKeyHook`/`serviceApiKeyHook` (verified 32 schema
  declarations against 32 preHandler attachments), so the hook is still the only
  gate.

  Pinned by tests at both levels: unit tests walk every exported route schema in
  both packages and fail if any reintroduces the pattern or makes the header
  required, and integration tests assert 401 — never 400 — for an absent header, a
  base64-shaped key, a non-Bearer value and a wrong key, plus a 200 for a
  _correct_ base64-shaped admin key, which is the case the old pattern broke.

- 124ad14: Config Check now reports on the four secrets admin-server deliberately never
  holds, without being given any of them.

  `JWT_SECRET`, `NODE_SERVER_KEY`, `NODE_SERVER_SERVICE_KEY` and
  `TRANSCRIPTION_API_KEY` are invisible to admin-server by design, so a
  deployment could sit on all four as `CHANGEME` placeholders with Config Check
  entirely green. The obvious fix — hand admin-server copies so it can check them
  — makes every deployment strictly less secure in order to report on its
  security, and was rejected by the plan's own trust-boundary table.

  Instead the service that already holds all four classifies its own copies.
  node-server's `AppConfig` gains a `secretPlaceholders` getter applying the same
  case-insensitive `CHANGEME` substring rule Config Check already uses, exposed
  as four booleans on its existing authenticated `GET /status`
  (`SECRET_PLACEHOLDERS_SCHEMA`). The monitoring sidecar already polls that
  endpoint with `NODE_SERVER_SERVICE_API_KEY`, so it re-exposes the
  classification on a new `GET /api/monitoring/v1/config-audit` —
  unauthenticated and backend-network-only, the same trust boundary `/metrics`
  and `/probes/readiness` already carry. admin-server reads that over the compose
  network it already uses for the sidecar's build info and translates
  node-server's env var names to the deployment `.env` names. Four booleans move;
  no secret value does, and no service gains a credential it did not already
  have. Verified live with `docker exec admin-server env`.

  Why node-server rather than session-manager or transcription-service, which
  also hold some of these: node-server is the only service that holds **all
  four** and already has an authenticated status endpoint an observability
  consumer polls. So this phase needed no change to either of those services, no
  new env var anywhere, and no `COMPOSE_FILE_VERSION` bump.

  **The new field is deliberately a sibling of `sessions`/`sessionsTruncated` on
  the route response, not part of `STATUS_PROCESS_SCHEMA`.**
  `NODE_SNAPSHOT_SCHEMA` spreads `STATUS_PROCESS_SCHEMA.properties`, so the
  obvious placement would have silently published a secret classification into
  the Redis fleet-telemetry namespace, admin-server's `FleetSnapshot` and the
  fleet dashboard — three more copies to go stale, for data with exactly one
  reader.

  Also deliberately **not** a Prometheus metric. Routing it through `/metrics`
  would gate these findings behind the optional `monitoring` compose profile;
  Prometheus and Grafana are opt-in, and these four secrets are live in every
  deployment. It is a classification, not a measurement.

  **`unavailable` is a first-class answer, never silence.** `AbsoluteStatusPoller`
  gains an `enabled` getter so `nodeServer.status` can distinguish "will never
  poll" (`disabled` — the sidecar has no service key), "has not polled yet"
  (`not-yet-polled`) and the existing `POLL_ERROR_REASONS` from a failed poll.
  Config Check turns any of them into its own
  `secret-placeholder-audit-unavailable` finding (warning; advisory in
  development, matching the four secret findings), so a broken sidecar reads as
  "cannot currently check" and never as a clean bill of health. Admin-server
  validates the whole `/config-audit` body with `Value.Check` against a TypeBox
  schema before dereferencing any field — the same thing
  `NodeStatusPollerService._parseBody` does one hop upstream, so both ends of the
  wire are validated alike. The schema stays open to unknown properties on
  purpose, so a _newer_ sidecar's extra fields still validate and upgrading the
  sidecar first cannot blind Config Check.

  **Known limitation, named in the finding's own remediation text:** a
  placeholder `NODE_SERVER_SERVICE_KEY` can only ever surface as the generic
  `secret-placeholder-audit-unavailable`, never as its own finding. That key
  guards `/status` itself, and node-server's `ServiceAuthService` refuses to
  construct while it contains `CHANGEME` — a deliberate pre-existing fail-closed
  design — so the endpoint 500s before it can self-report on that specific key.
  The deployment still never reads as clean; the operator gets "something is
  wrong with node-server's status auth" rather than the variable's name. Not
  worked around by giving a second service a way past node-server's boot check.

- 2781c05: Tell a source that its session is already over, instead of letting it stream
  into a dead one.

  A **source** (kiosk or synthetic device) that opened a socket for a session
  whose `effectiveEnd` had already passed was never told. `registerSource`
  published `SessionEndedChannel` from inside its own `await` — `_openSession`
  armed the end timer, found the end in the past, and published synchronously —
  while the connection did not subscribe to that channel until the `await`
  resolved. The publish landed on an empty channel. The source got `authOk`, no
  `sessionEnded`, no close, and went on forwarding audio into a session the server
  considered over, holding an upstream transcription connection for as long as the
  kiosk kept the socket up. Nothing tore it down: teardown is driven by
  `_unregisterSource`, which is driven by a close that never came. `#184` fixed the
  viewer half of this and explicitly did not fix this half.

  The likeliest real-world trigger is not the operator race but a **stale kiosk
  schedule**: `kiosk-service.ts`'s `poll.on('error', () => {})` means the schedule
  long-poll can be dead for hours with no signal, and a kiosk acting on a stale
  schedule confidently connects to a session that ended long ago.

  **Subscriptions now come before registration, for both roles.** The event bus is
  synchronous, so anything published during `registerSource` reaches this
  connection instead of nobody. This is the ordering the client path had already
  been given, with the comment explaining why; sources now get the same rule. The
  early-return paths (`_closed` mid-await, orchestrator failure) release those
  subscriptions rather than leaving four listeners attached to a dead socket.

  **Nothing is written to the socket before `authOk`.** Moving subscriptions above
  registration means a bus message can now fire while the connection has not been
  told its auth succeeded, and both webapp clients hold their WebSocket handshake
  open until it arrives. The service therefore keeps an outbound gate shut until
  the controller reports the send (`onAuthAcknowledged`, replacing
  `publishCurrentStatus`). Live-stream messages that arrive early are dropped —
  `sessionStatus` is superseded by the snapshot sent immediately after `authOk`,
  and transcripts have no replay semantics — which is exactly what happened before,
  when those subscriptions simply did not exist yet. `sessionEnded` is the one
  message that must not be dropped, so it is latched and delivered in protocol
  order: `authOk`, then `sessionEnded`, then close 1000.

  **No upstream is dialed for a session that is already over.** `_openSession`
  used to construct and start the upstream _before_ `_armEndTimer` discovered the
  end had passed, so an abandoned session took a transcription-service connection
  with it. The effective end is now checked the moment the first config surfaces,
  and `registerSource` throws `SessionAlreadyEndedError` without dialing anything
  and without creating a `SessionState`. That error is distinct from an
  orchestrator failure on purpose: an unreachable Session Manager is _broken_ and
  earns 1011, whereas this session is merely _over_ and earns a clean 1000 with
  `sessionEnded` — the kiosk already distinguishes those, and collapsing them
  would put a finished session into a reconnect loop. Not creating the state also
  removes the knock-on: no stale `SessionState` lingers in `_sessions` holding an
  upstream, answering `getStatus`, and appearing in `/status` for a session nobody
  is serving.

  The single-publisher guarantee `#184` established is untouched: the refusal
  publishes nothing on the bus, so an end-watch a viewer holds is still the only
  thing that announces the end to that session.

  **Observability.** A source arriving at a finished session is now counted and
  named, because downstream it is otherwise indistinguishable from an ordinary
  session end (a `1000 session-ended` close either way) while meaning something
  quite different:
  - a warn log line, `source registered onto an already-ended session`, carrying
    the `effectiveEnd` the config reported;
  - `summary.endedSessionRegistrationsTotal` on `GET /status`, optional on the
    wire so an older publisher does not fail the strict `Value.Check` that the
    Redis fleet snapshot is read back through;
  - `scribear_node_ended_session_registrations_total` in the monitoring sidecar,
    which skips the advance rather than recording a zero when the field is absent.

- debb87a: A permanently misconfigured session now says so instead of pretending to
  reconnect.

  The Transcription Service closes the upstream socket with **1007** when it
  rejects what the Node Server sent — in practice a `transcriptionProviderId`
  that is not a key in the deployment's `provider_config.json`, which raises
  `TranscriptionClientError("Invalid Provider Key")`. `_setStatus` special-cased
  only 1013, so 1007 collapsed into the undistinguished
  `transcriptionServiceConnected: false`, the Node Server's reconnect loop
  re-sent the identical config forever, and every viewer sat on "Connection to
  the transcription service was lost. Reconnecting…" — a promise nothing in the
  system could keep, with nothing anywhere naming the cause.

  `TranscriptionServiceDisconnectReason` gains `INVALID_REQUEST =
'invalid-request'`, in the published `node-server-schema` enum and in
  node-server's local mirror (the two carry doc comments telling you to keep them
  in sync; both are updated). The close-code mapping moves into a named
  `closeCodeToDisconnectReason`, which now covers exactly the two closes the
  transcription service makes _deliberately_ — 1013 and 1007 — and leaves every
  other close undistinguished, as before.

  The two reasons stay separate on purpose: `AT_CAPACITY` clears on its own when
  load drops, `INVALID_REQUEST` never clears without an operator. The kiosk banner
  reflects that difference — it is the one branch in `deriveConnectionBanner` that
  is an `error` rather than a `warning`, and it says an administrator has to check
  the session's transcription provider rather than promising a retry.

  The field is `Type.Optional` and the enum only gains a member, so a client built
  against an older schema still validates every message; it simply falls through
  to the generic branch it uses today.

  The client-webapp banner is not in this change — `derive-connection-banner.ts`
  was being restructured concurrently — and landed separately as the mirror of the
  kiosk's branch.

- bc37f92: Tell viewers a session ended even when no source device is attached.

  `registerSource` was the only thing that ever created `SessionState`, and
  `SessionState` was the only thing that fetched a session's config or armed the
  timer that publishes `SessionEndedChannel`. Client-role connections never
  touched the orchestrator at all — so a room whose viewers joined before, or
  without, a kiosk had nobody watching the clock. Nothing published
  `sessionEnded`, nothing closed those sockets 1000, and the viewers sat on stale
  captions until a token refresh happened to come back 401/409 `SESSION_ENDED` —
  bounded only by half the 5-minute token lifetime, up to ~2.5 minutes. Demos and
  any viewers-first room hit this every time.

  Client connections now take out an **end-watch**: a session-config long-poll and
  a timer, and nothing else. In particular it dials **no upstream transcription
  connection** — a viewer must cost the transcription service zero resources,
  which is exactly the fault `e80eea2` was written for (audio-less connections
  registering a job and eating admission capacity). It reuses the same
  `_sessionConfigPollFactory` a session uses, rather than reading the end once, so
  `startSessionEarly` / `endSessionEarly` move it: `endSessionEarly` sets
  `end_override = now`, which arrives as an already-past end and publishes
  immediately — as does a viewer joining a session that is already over.

  The watch is ref-counted, one per session however many viewers share it, and is
  torn down with its long-poll when the last client-role connection leaves.

  **Exactly one publisher.** A session can have two end-timer owners over its
  life — the `SessionState` a source opens and the `SessionEndWatch` its viewers
  hold — so:
  - while a live `SessionState` exists it is authoritative and the watch holds no
    timer at all; `registerSource` stands the watch down, `_unregisterSource`
    hands the timer back when that state is torn down under viewers who outlive
    the kiosk;
  - `_publishSessionEnded` latches _both_ owners whichever one got there first,
    so the source-side teardown that follows a publish cannot re-arm the watch for
    an end that has just passed.

  The latch is per owner and dies with its owner, deliberately: suppressing a
  publish because some earlier owner announced the same end would silently
  reintroduce the bug for anyone who joins late. A duplicate publish is harmless —
  the connection close it drives is idempotent — a missing one is the whole defect.

  A config fetch that fails does **not** close the viewer's socket.
  `registerClient` is synchronous and cannot throw: a source that cannot reach
  Session Manager is useless and rightly gets 1011 `orchestrator-unavailable`, but
  a viewer that cannot is only missing its end signal, and is left exactly as it
  behaved before end-watches existed rather than being disconnected mid-caption.
  The long-poll's own backoff keeps retrying.

### Patch Changes

- dc104ab: Deployment Check now shows what each container was built from, so an operator
  can confirm what is actually deployed and running.
  - **Every image is stamped at build time.** `BUILD_COMMIT`, `BUILD_REF`,
    `BUILD_TIME`, `BUILD_VERSION`, `BUILD_TAGS`, `BUILD_PR` and `BUILD_ORIGIN`
    become `SCRIBEAR_BUILD_*` environment variables and OCI image labels
    (`org.opencontainers.image.revision`/`.version`/`.created`, plus
    `org.scribear.build.pull-request`/`.origin`), so `docker inspect` answers the
    same question as the console. The block sits last in every Dockerfile, so
    changing commit invalidates no expensive layer.
  - **Every container reports it.** The four Node services answer
    `GET /build-info` from a route `createBaseServer` registers for them;
    transcription-service answers the same path from FastAPI; the four webapps and
    the reverse proxy serve an identical `build-info.json` generated at image
    build time by `tools/build-info/write-build-info.sh`. All of these are
    reachable only inside the compose network — nginx proxies none of them, and
    the proxy's own document is served on its plain-HTTP listener only, so no
    commit hash is published to the internet.
  - **Admin console — Deployment Check → Deployed versions.**
    `GET /api/admin/v1/deployment-versions` probes every container concurrently
    and renders a table of version, commit, branch, build time and image tags.
    Version skew is the headline: the commit the most containers report is taken
    as the deployment's, and any container that disagrees is named in a warning.
    This is the only place in the console that can see a half-finished upgrade —
    a stale container is a perfectly healthy container, so the health rollup stays
    green throughout.
  - **Old and local builds are distinguished, not blanked.** A container running
    an image from before this release answers 404 and is reported as
    `old image` rather than as unreachable — it is stale, not down.
    `build-containers.sh` stamps the real commit for local builds, marks them
    `origin: local`, and appends `-dirty` when the working tree has uncommitted
    changes; a stack started straight from a checkout (`npm run dev`) reports
    "nothing here was built by CI" instead of a table of blanks.
  - **`scribear-db` and `redis`** appear in the table as `n/a` with the reason:
    neither has an HTTP surface to report a build on.
  - **PR images are published again, named for their target environment.** A
    pull request into `staging` pushes
    `ghcr.io/scribear/<image>:staging-pr<n>`; into `main`,
    `ghcr.io/scribear/<image>:production-pr<n>` — so a reviewer can pull the
    exact build under review rather than rebuilding it, and tell at a glance
    which environment it's a candidate for, without cross-referencing the PR
    on GitHub. The tag moves with the PR head. Set the repository variable
    `PUBLISH_PR_IMAGES` to `false` to switch it off, or `true` to publish for
    every base branch (tagged `<base-branch>-pr<n>`). Fork PRs still build
    without publishing, since their `GITHUB_TOKEN` cannot push.

  Nothing new is required in `deployment/.env`. The six new admin-server base-URL
  variables all default to their compose service names.

- 5605d6b: Clear the open high-severity npm security advisories.
  - **fast-uri** → 3.1.4 / 4.1.1 — host confusion via a literal backslash
    authority delimiter (GHSA-v2hh-gcrm-f6hx). Shipped transitively through
    Fastify by the four server apps listed here.
  - **brace-expansion** → 1.1.16 / 2.1.2 / 5.0.7 — quadratic-complexity DoS.
  - **shell-quote** → 1.9.0 via an `overrides` entry (quadratic DoS in
    `parse()`); `concurrently` pins the vulnerable 1.8.4 and has no fixed release,
    so an override is the only route that does not downgrade concurrently.

  Lockfile / dev-tooling only — no workspace package's own dependencies changed.
  `npm audit` reports 0 vulnerabilities; workspace unit tests and `npm run build`
  pass.

- 3a867f9: `upstream node-server` had no balancing directive, so nginx round-robined a
  service whose state is per-process.

  `TranscriptionOrchestratorService`'s own class doc asserts the opposite:
  "Sticky URL routing pins all connections for a given sessionUid to one Node
  Server instance, so the singleton state for a session is always co-located with
  the source connections feeding it." The event bus is in-process, and a session's
  upstream transcription connection lives on whichever instance its _source_
  reached. A viewer routed elsewhere subscribes to a channel nothing publishes on
  and receives no transcripts — no error, no close, no banner, just an empty
  caption view. `docker compose up -d --scale node-server=2` was one word away,
  and nothing about that word looks like it could break captioning.

  The upstream now hashes on `$node_server_session_uid`, a `map` over `$uri` that
  captures the session uid from the shared
  `/api/node-server/v1/transcription-stream/<sessionUid>/{source,client}` prefix —
  which is precisely why the route schema puts the uid in the path: "The session
  UID is carried in the URL so the L7 proxy can sticky-route every connection for
  a session to the same Node Server instance." `$uri` rather than `$request_uri`
  so a trailing query string or an encoded path segment cannot send a second
  connection for one session to a different peer.

  **`consistent` is deliberately absent, and that is a measurement, not a
  preference.** Ketama is the better algorithm here — a peer joining remaps ~1/N
  of sessions instead of most of them — but it is silently ignored when the
  upstream's server is a `resolve` name, which `node-server`'s is. Verified
  against `nginx:1.29.7-alpine3.23` (this image's base) with two backends behind
  one docker network alias, requesting one session uid repeatedly:

  ```
  hash $node_server_session_uid consistent;   ->  B A B A B A B A     (round-robin)
  hash $node_server_session_uid;              ->  B B B B B B B B
  ```

  `nginx -t` passes on both, and at one replica both behave identically — a
  `consistent` version of this fix would have merged green and done nothing. The
  final config was then re-verified verbatim from the repo: two uids held on two
  different peers across 12s and several `valid=5s` re-resolutions, with the
  WebSocket upgrade headers set, and `source` and `client` for the same uid always
  landing together. The cost of plain modulo hashing is that changing the replica
  count re-homes most sessions; that happens on a deploy, when every connection is
  being re-established anyway.

  Three unit tests in node-server read the shipped config — same precedent as
  `nginx-status-not-public.test.ts` — and fail if the `hash` directive is dropped,
  if `consistent` is reintroduced, or if the map stops matching the routes it
  derives from the route definitions. `UPGRADING.md` records that scaling
  node-server past one replica is now supported, and was not before.

- efd1f0b: An unset node-server secret no longer self-reports as healthy.

  `isPlaceholder('')` was `false`, and that function feeds `secretPlaceholders` on
  `GET /status` — the endpoint monitoring-sidecar polls and relays to
  admin-server's Config Check. So an empty `SESSION_TOKEN_SIGNING_KEY`,
  `SESSION_MANAGER_SERVICE_API_KEY` or `TRANSCRIPTION_SERVICE_API_KEY` was
  rendered green on the page whose entire job is to notice exactly that. The env
  schema declares them as bare `Type.String()` with no `minLength`, so an empty
  value boots fine and the false-green was reachable rather than theoretical.

  The fix is a deletion. `isPlaceholderSecret` in `utils/constant-time-equal.ts`
  already treated empty as a placeholder — it was exported, never called, and
  sitting a few files from a local duplicate that had drifted away from it. The
  bug was the copy, not a missing capability.

  Reporting empty _as_ a placeholder, rather than adding a distinct "missing"
  signal, is deliberate. admin-server keeps the two apart because there they have
  different remediations — an empty `ADMIN_SESSION_SECRET` falls back to a random
  per-boot value, which is a different failure from a shared `CHANGEME`. None of
  these four has any such fallback: two are presented directly as bearer
  credentials and one is used directly as an HMAC key, so empty and `CHANGEME`
  are equally guessable and take the identical fix. A tri-state signal would have
  required a new optional field across `node-server-schema`, the sidecar relay and
  Config Check's consumption of it, plus the rolling-upgrade fallback — to tell an
  operator something that does not change what they do.

  The schema change is documentation only: the four field descriptions now say
  "or unset". No shape change, so there is nothing to coordinate on a rolling
  upgrade.

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
  would answer a _missing_ credential with 400 VALIDATION*ERROR while a \_wrong*
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
