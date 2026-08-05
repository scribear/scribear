# @scribear/admin-server

## 0.3.0

### Minor Changes

- fb7742b: Surface active and live sessions in the admin console.

  Sessions have no status column — "active" is derived from
  `COALESCE(end_override, scheduled_end_time)` — and no admin route read that
  derivation, so the console could not show a room's running session, listed no
  ON_DEMAND/AUTO rows on the scheduling page, and refused a second on-demand
  session with `ANOTHER_SESSION_ACTIVE` while showing nothing that explained the
  conflict.

  Two read routes now expose the repository queries that already existed:
  - `GET /schedule-management/list-sessions?roomUid=&from=&to=` — sessions whose
    effective interval overlaps the range, including the ON_DEMAND and AUTO rows
    that have no parent schedule and so were invisible to list-schedules.
  - `GET /schedule-management/get-active-session/:roomUid` — the room's active
    session, or a `null` 200 body so "nothing is running" stays distinct from
    "room not found" (404).

  Both are mirrored through the session-manager client and the admin BFF
  (`/sessions/list`, `/rooms/:roomUid/active-session`). `listSessionsForRoomInRange`
  and `findActiveSession` now return `ROOM_NOT_FOUND`, matching
  `listSchedulesForRoom`.

  In the console, the room detail page gains an "Active session" card (name,
  type, effective start/end, View and End-early actions, the last hidden for the
  demo room's permanently-active fixture session), and the scheduling page gains
  a Sessions table that polls every 15s while the tab is visible. Its range
  widened to the last 7 days so a session that started before page-load still
  appears.

  Every admin page that prints a timestamp now says which timezone it is
  printing in, in the same place and the same words, via a shared
  `TimezoneNote`. Room-scoped pages (room detail, scheduling, session detail)
  render times in the room's zone rather than the browser's, and when the two
  differ the note escalates to a red warning triangle naming both — the case
  where misreading a schedule has consequences. Pages showing deployment-wide
  times (audit, devices, dashboard, deployment check) state the browser's zone,
  which is the only one in play there.

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

- a2f3cdd: An operator rate-limited by the admin server is no longer told their password
  is wrong.

  admin-server registers `@fastify/rate-limit` with `global: true`, so every
  admin route can answer 429 — and the login route tightens the limit further.
  It already had an `errorResponseBuilder`, so the body was well-formed all
  along; what was wrong was the rendering. The console showed the server's
  log-facing string, _"Too many requests. Please retry after 1 minute."_, at
  `error` severity, in the same red slot as _"Invalid credentials."_ A rate
  limit is transient and self-clearing, and telling someone their sign-in was
  rejected when it was merely deferred is the worst version of that mistake.

  It now renders as a `warning`, says a rate limit is what happened, says nothing
  was changed (the limiter rejects in `onRequest`, before any handler runs), and
  does not imply an automatic retry, because nothing in the console retries.

  `Retry-After` reaches the browser for the first time. It is set as a header,
  which the console cannot read, but `@fastify/rate-limit`'s `context.after` is
  already display copy — `"1 minute"`, `"45 seconds"` — so it moves into
  `details.retryAfter` on the error envelope and the wording can name the actual
  wait.

  **No schema change**, which is the opposite of what this looked like from the
  outside. It would be natural to add 429 to `STANDARD_ERROR_REPLIES`, on the
  grounds that admin-server's `global: true` is the mirror image of
  session-manager's `global: false`. It is not: admin-server declares **no**
  `response` map at all — it is a BFF with its own `{ok, error}` envelope — and
  `admin-webapp` does not use `createEndpointClient`. All 46 spread sites belong
  to session-manager and node-server, both `global: false`, so the change would
  have added an unreachable arm to 46 schemas and done nothing for admin. A note
  in `error-reply.schema.ts` records why, so the next reader does not have to
  re-derive it.

  Along the way, twelve hand-rolled copies of
  `err instanceof ApiError ? err.message : fallback` collapse into one shared
  helper, and `ToastSeverity`'s `'warning'` — which had existed in the type and
  carried a WCAG contrast override in the provider, but which no caller could
  reach — finally has a producer.

- d4c0cd5: The admin console now asks the one service that already knows whether captions
  are working.

  The monitoring sidecar evaluates a set of rules — the synthetic caption canary,
  transcription saturation and worker-death, ASR buffer overflow, auth-failure
  ratio, per-service probe-down, clock skew — and had exactly one consumer:
  Grafana. admin-server called the sidecar once, for `/config-audit`, and the
  console never asked for alerts at all. An operator looking at the dashboard
  during an outage was looking at the one page that could have told them, and it
  was silent.

  `GET /api/admin/v1/alerts` proxies the sidecar's `/api/monitoring/v1/alerts`,
  reusing the existing `MONITORING_SIDECAR_BASE_URL` and health-check timeout —
  no new environment variable, and no new credential, because that sidecar route
  is reachable unauthenticated over the backend network exactly as `/config-audit`
  already is. Evaluation stays pull-based and stateless: the sidecar recomputes on
  every call and sorts worst-first, so "current alerts" is simply what the call
  returns.

  **"No alerts firing" and "we could not ask" are kept unrepresentable as the
  same state**, which is the entire point. The service raises rather than falling
  back to an empty list on every failure path — network error, non-2xx,
  unparseable body, schema-invalid body — and the route answers `503
ALERTS_UNAVAILABLE`. The hook returns a discriminated
  `loading | ok | unavailable` rather than `{alerts: [], error}`, following the
  discipline that `useAsyncList` still needs. An empty green list says every
  monitored rule is currently green; an unreachable sidecar says so in its own
  banner, in as many words, and does not borrow the green state's wording.

  Severity maps `critical → error` and `warning → warning`. The sidecar has no
  `info` tier by construction — a rule appears only while firing, so health is
  the _absence_ of alerts rather than a severity — and each rule already carries
  a `likelyCause` that names both the cause and the remediation, so no separate
  next-action field was needed.

  Accessibility follows the console's established patterns: severity is never
  colour-alone (each alert carries a text chip and an icon), a single
  `aria-live="polite"` rollup announces error/warning counts rather than letting
  a 15-second-polled list re-announce every card, and the unreachable-sidecar
  state uses an assertive `role="alert"` since it is a one-time, action-worthy
  change.

- 6840d43: Admin BFF for the operator test-audio devices: proxy, audit and safety for the
  two synthetic sources, with no device tokens held here.

  `apps/test-audio-generator` runs two synthetic source devices — `good`, which
  plays clean speech at an adjustable level and noise floor, and `fault`, which
  reproduces on demand every audio fault the stack claims to report. It holds
  long-lived device tokens and a soft-realtime send loop, so it is a service of
  its own; this is the admin console's front door to it (PLAN-TestAudioDevices
  §3).
  - **`GET /api/admin/v1/test-audio`** — both devices and their live state, plus
    the BFF's own `available` flag. **`POST /:deviceId/start`**,
    **`POST /:deviceId/stop`**, **`PATCH /:deviceId/params`** — start a bounded
    run, stop it, and retune a _running_ device without restarting the stream.
    `deviceId` is `good` or `fault`, rejected here rather than upstream.
  - **Guarded like `rooms`.** Reads take `requireSessionHook`; every mutation
    takes `requireSessionHook + csrfHook + requireRole('read-write')`. These
    point a synthetic source at a real room, so nothing weaker would do.
  - **Audited by the knob.** Every mutation writes one audit row through
    `auditedMutation`, with the parameters that changed in `paramsSummary` —
    which knob the operator turned, at what setting, for how long, is the entire
    value of the row. `auditedMutation`'s `gateway` is now structural
    (`MutationGateway<TResult>`) so a feature with an upstream of its own audits
    through the same helper rather than a second copy of it.
  - **`TEST_AUDIO_BASE_URL` + `TEST_AUDIO_SERVICE_KEY`, both empty by default.**
    Empty base URL disables the feature: the read answers
    `{ available: false, devices: [] }` at **200**, and mutations answer 503
    `TEST_AUDIO_UNAVAILABLE`. Most deployments never provision these devices, and
    an unprovisioned one should see a disabled panel rather than an error it has
    to rule out — the same shape `REDIS_URL` uses for fleet telemetry. Neither
    variable is required to boot.
  - **The service key never leaves the server.** `TestAudioGatewayService` is the
    only thing that knows where the generator lives and the only place the key is
    used, shaped like `sessionManagerGatewayService`; it injects
    `Authorization: Bearer` itself. The admin session — cookie, CSRF token,
    identity — is never forwarded: the generator authenticates this service, not
    the operator behind it. A generator that rejects the key surfaces as 502
    `BACKEND_MISCONFIGURATION`, never a 401, so an `.env` mistake cannot bounce
    the operator to the login page; an unreachable one surfaces as 503
    `TEST_AUDIO_UNREACHABLE`, and its own 4xx passes through at its own status
    and code.

- 82888d1: Hardens the Postgres backup service (`db-backup`) from a code review after it
  shipped:
  - Failed off-host pushes (scp/rsync) now retry every cycle until they
    succeed, instead of silently leaving a permanent gap in the offsite backup
    chain when the destination was unreachable for more than one cycle.
  - Every dump is checked with `pg_restore -l` immediately after `pg_dump`
    exits 0 and discarded if it fails — `pg_dump` can exit 0 on an archive
    nothing can actually read back.
  - `pg_dumpall --globals-only` now runs alongside the main dump, covering
    roles that `pg_dump` alone never backed up.
  - New `BACKUP_ENABLED` (default `true`): set to `false` for a deployment on
    managed Postgres with its own backups — `db-backup` idles instead of
    dumping, and Deployment Check reports the choice explicitly (`backup-disabled`)
    instead of `backup-none-found` forever.
  - New `BACKUP_ENCRYPTION_KEY` (empty/off by default): optional GPG AES256
    symmetric encryption for every dump, at rest and offsite. `db-restore`
    decrypts automatically when given a `.gpg` file and the same key.
  - `db-backup`'s healthcheck `start_period` is 30 minutes now, not 2 — long
    enough for a large database's first `pg_dump` to finish before being read
    as a failed container.
  - `BACKUP_INTERVAL_SECONDS`/`BACKUP_RETENTION_DAYS` are validated as positive
    integers on startup rather than failing confusingly (a busy-loop on `0`, a
    crash-loop on anything non-numeric).
  - Corrected a misleading comment claiming `pg_restore --clean --if-exists`
    "overwrites" the target database — it drops and recreates only what the
    dump itself contains.

  `COMPOSE_FILE_VERSION` 11 -> 12, `EXPECTED_COMPOSE_FILE_VERSION` follows, the
  drift guard's sha256 is re-pinned, and `deployment/UPGRADING.md` carries the
  note — including the RPO/WAL-archiving tradeoff and the offsite host's
  trust-on-first-connection behavior, both previously undocumented.

- aac2530: Deployment Check's Config Check page reports on `db-backup` (the Postgres
  backup service from compose.yml v10): whether an off-host copy is configured,
  whether a backup has completed at all yet, and whether the newest one has
  gone stale.

  `db-backup` has no HTTP surface to probe the way every other dependency on
  that page is probed — it is a cron loop, not a service — so admin-server
  reads the one channel that exists: a new read-only bind mount of the same
  directory `db-backup` writes its dumps to (`deployment/compose.yml`). The
  staleness threshold mirrors `infra/scribear-db/backup-healthcheck.sh`
  exactly, so this finding and that container's own health status agree.

  `COMPOSE_FILE_VERSION` 10 -> 11, `EXPECTED_COMPOSE_FILE_VERSION` follows, the
  drift guard's sha256 is re-pinned, and `deployment/UPGRADING.md` carries the
  note.

- 1aa8c8d: Config Check grades the local admin password, proves the test-audio key works,
  and flags a public origin nobody outside the building can reach.

  **A one-character admin password used to pass every check green.**
  `ADMIN_LOCAL_CREDENTIALS` had no length or entropy check at all, unlike
  `ADMIN_SESSION_SECRET`. It is a `"<username> <password>"` pair split on the
  _first_ space — so the password may contain spaces, and measuring the raw
  variable would have measured the username too. The parse now mirrors
  `LocalAuthService` exactly, and applies an 8-character floor (NIST SP 800-63B /
  OWASP ASVS L1), deliberately **not** the 32-character bar used for
  `ADMIN_SESSION_SECRET`: that is a machine-generated token, this is a
  human-memorised password, and holding them to one standard would be the wrong
  kind of consistency.

  Working out that format turned up a second gap worth its own finding: a value
  with no space, an empty username, or an empty password causes `LocalAuthService`
  to **silently disable local login at boot**, while the existing
  `localLoginEnabled` flag — a bare `.trim() !== ''` — cannot see it. A deployment
  could have no working login method and no finding saying so.

  **`TEST_AUDIO_SERVICE_KEY` is now live-probed**, as `GRAFANA_ADMIN_PASSWORD`
  already was. A key that is present but _wrong_ was indistinguishable from one
  that works. The probe reuses the existing gateway and calls `listDevices()` — a
  cheap `GET`, no audio job triggered — and keeps three outcomes distinct:
  `401`/`403` is a mismatch (critical outside development); unreachable,
  unparseable or an unexpected status collapse into a `probe-unavailable` warning
  that is **never** critical and never reads as a pass; `2xx` is silence. It skips
  entirely when the key is still a placeholder, so that finding is not buried, and
  so two sides sharing the same placeholder cannot read as "verified".

  **The public-origin check says what it cannot know.** There is no
  `PUBLIC_ORIGIN`-style variable anywhere in this stack — nginx's `server_name` is
  the wildcard `_`, and `join-url.ts` / `kiosk-url.ts` build every join link and QR
  code from `window.location.origin` in the operator's own browser. The only place
  that origin is visible to admin-server is the `Host` header of the request
  asking for the report, so this check is necessarily **request-scoped, not
  deployment-scoped**, and it is deliberately one-directional: it flags origins
  that certainly will not work off-host — loopback, RFC1918, link-local, `.local`,
  a bare single-label hostname — and stays silent on anything else. A normal
  looking FQDN is reported as _not ruled out_, never asserted reachable, because
  admin-server sits inside the backend network and an in-cluster fetch would prove
  almost nothing. The finding's own text states that limit rather than implying a
  confidence it does not have.

- f4a68f8: Config Check reports secrets that are unset (not merely placeholder), proves
  two cross-service keys actually agree, and names a down monitoring sidecar as
  its own fault.

  **Unset secrets were invisible.** `isPlaceholder('')` is `false` and the
  placeholder loop skipped everything that was not a placeholder, so an empty
  `ADMIN_API_KEY` or `DB_PASSWORD` produced no finding at all — silence
  indistinguishable from a well-configured deployment. `describeSecret` had
  carried a `'not set'` branch that nothing could reach. Both now have their own
  findings, kept separate from the placeholder table because "not set" and "still
  the example value" have different consequences and want different sentences.
  `ADMIN_SESSION_SECRET` is excluded: it already had a dedicated missing-check
  saying something more specific. `TEST_AUDIO_SERVICE_KEY` is excluded too, on
  the grounds that its peer fails closed and names the variable itself, and that
  whether the two agree is answerable by calling the generator rather than by
  comparing a string here.

  **Two non-placeholder keys that simply differ used to read green.** Nothing
  verified that two services holding the same shared secret hold the _same_
  value, and a placeholder audit cannot see this class of fault at all — it is
  what a container recreated after an `.env` change, next to one that was not,
  looks like. Two pairs are now proved, by the only mechanism the deployment
  actually has: a party holding one copy presents it to the party holding the
  other, and the rejection is the proof.
  - `node-server-service-key-mismatch` — the sidecar polls node-server's
    `/status` every interval with its `NODE_SERVER_SERVICE_API_KEY`, and a 401
    becomes the `unauthorized` poll reason that `/config-audit` already relayed.
    That string was previously reported as one more way of _not knowing_, when it
    is the opposite: a proof about two configuration values. A rejection really
    is proof rather than a guess, because both other explanations are closed off
    — node-server refuses to construct with an empty or `CHANGEME` inbound key,
    and the sidecar does not poll at all with an empty one.
  - `session-manager-admin-key-mismatch` — admin-server already presents
    `SESSION_MANAGER_API_KEY` to session-manager on every page of the console, so
    asking an admin-key-protected route and reading the status _is_ the
    comparison. Its own check rather than a branch of the schema-version read
    that makes the same call, because that one runs only after `dbClient.ping()`
    succeeds — a deployment with both faults is exactly the one that needs to be
    told they are separate. Silent when the key is unset (`admin-api-key-missing`
    is the better sentence) and when session-manager does not answer at all
    (`services-unreachable` already says so; only an actual 401/403 is evidence
    about a key).

  No secret is moved to make either comparison, and no service is handed a
  credential it did not already hold.

  **`TRANSCRIPTION_API_KEY`, `NODE_SERVER_KEY` and `JWT_SECRET` remain
  unverifiable at config time, deliberately and not by oversight.** Each is held
  only by the two services that use it; neither exercises it until a real session
  starts; and none reports the outcome when it does — a rejected
  `TRANSCRIPTION_API_KEY` closes the upstream socket 1008 "Authentication Failed"
  and node-server records only a generic upstream flap. Closing that gap needs a
  new self-report from node-server, not another check here, and it is not faked
  with an inference this page cannot stand behind. The class docblock says so
  where the next reader will look.

  **A down monitoring sidecar is now its own finding.** It was previously
  inferable only as a side effect of `secret-placeholder-audit-unavailable`,
  which named the wrong subject — an operator read "could not check
  node-server-held secrets" and went to look at node-server, which was fine. The
  sidecar is a core service that nothing else on this page covers (it is
  deliberately absent from the health rollup's probe targets), and when it is
  down the console's alerts panel goes blank at the same moment for the same
  reason. `monitoring-sidecar-unreachable` enumerates what went _unchecked_
  rather than leaving it implied — including the `NODE_SERVER_SERVICE_KEY` pair
  above, which it is the sole source of evidence for. Sidecar down must never
  read as "the keys agree". A sidecar that answers with a body Config Check
  cannot parse or does not recognise keeps the existing
  `secret-placeholder-audit-unavailable`: that is version skew, not an outage.

- 124ad14: Config Check reports two more placeholder secrets, and whether the monitoring
  profile is actually working rather than merely switched on.

  `TEST_AUDIO_SERVICE_KEY` and a placeholder password inside `ADMIN_REDIS_URL`
  are both in admin-server's own environment and were simply never checked.
  `TEST_AUDIO_SERVICE_KEY` is unconditional rather than gated on
  `TEST_AUDIO_BASE_URL` being set, because that variable defaults to the in-stack
  service and the generator refuses to start on an empty or `CHANGEME` key — the
  secret is live by default, unlike the off-by-default telemetry gate.
  `ADMIN_REDIS_URL` reuses the existing `redisUrlHasPassword` convention where an
  unparseable URL returns false rather than flagging, deferring that case to the
  reachability check. A placeholder Redis password therefore produces _two_
  findings — `redis-url-placeholder-password` and `telemetry-unreachable` — and
  that is correct rather than duplicated: one is a static fact about the URL
  string, the other is what the deployment actually observes.

  The monitoring checks close a gap the `monitoring` compose profile opened:
  turning it on and having it silently not work looked identical to having it
  work. Config Check now verifies Prometheus is reachable **and** lists the
  `scribear_sidecar` scrape target as up (a reachable Prometheus scraping nothing
  is the failure that leaves every Grafana panel empty), that Grafana is
  reachable, and that Grafana no longer accepts the `admin`/`CHANGEME` default
  login. That last one is a probe rather than a credential — it attempts exactly
  the well-known default against an authenticated route and reports whether it
  succeeded — so admin-server never needs `GRAFANA_ADMIN_PASSWORD`.

  Leaving monitoring off is itself reported (`monitoring-not-configured`, warning
  in staging/production, advisory in development) rather than staying silent: a
  fleet-health dashboard is worth nudging toward once a deployment is more than a
  throwaway container. New env: `ADMIN_GRAFANA_BASE_URL`,
  `ADMIN_PROMETHEUS_BASE_URL`, both empty by default and deliberately not
  `:?`-guarded in `compose.yml` — an unset value must never block the stack from
  starting. `COMPOSE_FILE_VERSION` bumped 5→6 for them, which is this repo's
  established trigger for new env vars on an existing always-running service; the
  prior monitoring-dashboard release's `UPGRADING.md` entry was titled
  "(compose.yml v6)" without ever bumping the constant, and that header is
  corrected here so it does not collide.

  All findings use a new `'monitoring'` `CheckCategory`, so the subsystem groups
  under one chip rather than splitting across `'monitoring'` and `'secrets'`.

  **Removed before shipping: a Grafana dashboard-provisioning check.** It was
  implemented and then deleted after live testing showed it fired even when the
  dashboard genuinely was provisioned. `GET /api/dashboards/uid/...` requires
  Grafana auth, and the only credential this check is permitted to try is the
  well-known default — so it could succeed only on deployments that have _not_
  secured Grafana, making it a guaranteed false positive on every properly
  secured one. Not routed around by giving admin-server a real Grafana
  credential (that trades a report for the security it reports on) or by enabling
  anonymous access. `_checkGrafana` carries a doc-comment saying so.

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

- c0d2475: Deployment Check now notices when a stack is running an out-of-date
  `deployment/compose.yml`.

  `compose.yml` is not part of any image, so `docker compose pull` never updates
  it: a deployment could run this month's images against last month's file —
  missing services, missing environment variables, changed wiring — with every
  container reporting green. Nothing in the stack could see it, and nothing could
  be made to: reading the file from a container would mean mounting the Docker
  socket (root-equivalent host access, for the one service on the public path) or
  bind-mounting the file itself, which cannot work, because the stale compose file
  is precisely the one that lacks the mount.
  - **`compose.yml` carries its own version.** `COMPOSE_FILE_VERSION` is a plain
    literal in the `admin-server` service's `environment:`, deliberately not a
    `${...}` interpolation from `.env`: the point is the identity of the file, and
    an `.env` carried over from an older release is exactly the thing that goes
    stale. Nothing to add to `.env`, and it is not `:?`-guarded — it changes what
    is _reported_, never what runs, so it cannot stop a stack from starting.
  - **admin-server compares it against the value baked into its image.**
    `GET /api/admin/v1/deployment-versions` gains a `composeFile` section:
    `match`, `stale` (the file is older than the images), `ahead` (the images are
    older than the file) and `unknown` (the file predates this check, so it is at
    least that old). `stale` and `ahead` are separate because the remedy differs —
    copy a file, or pull images — and `unknown` is separate from both because it
    is the absence of a measurement rather than a measured mismatch.
  - **Deployment Check → Deployed versions** shows it as one more row beside the
    containers, with an icon and a word rather than a colour, plus a banner naming
    the fix whenever the file and the images disagree.
  - **A unit test fails if the version stops being maintained.** It asserts the
    literal matches admin-server's constant and pins the sha256 of
    `deployment/compose.yml`, so any change to that file forces an author to
    decide whether operators must redeploy for it — a version nobody remembers to
    bump reports a match that was never verified.

- ff6516c: Database migrations now run as part of `docker compose up -d` instead of a
  separate script someone has to remember to run.
  - **`db-migrate` compose job.** A new one-shot service in `compose.yml`,
    built from the same image and `IMAGE_TAG` as `session-manager`, running a
    second entry point (`dist/migrate.mjs`) that applies whatever migrations
    are pending and exits. `session-manager` and `admin-server` both
    `depends_on: db-migrate: {condition: service_completed_successfully}`, so
    the schema is always current before either service starts, and a failed
    migration means neither starts. `run-migrator.sh` is now a thin wrapper
    around the same job (`docker compose run --rm db-migrate`), for applying
    migrations on their own — and, unlike before, it works against an external
    Postgres, since the job reads only the `DB_*` variables. The old script
    cloned `staging` from GitHub into a throwaway container and exited 0 the
    moment the database had _any_ table, so in practice it only ever migrated
    a virgin database — every upgrade after the first silently applied
    nothing.
  - **Migrations are bundled, not globbed.** `infra/scribear-db` registers its
    migrations in a static list (`src/migration-registry.ts`) rather than
    kysely's `FileMigrationProvider`, so they can ship inside a service image
    instead of requiring a source checkout. It also exports `readSchemaState()`
    for comparing applied migrations against expected ones, plus
    `MIGRATION_NAMES` and `LATEST_MIGRATION`. The migration table is still
    `kysely_migration`, so no existing database needs special handling.
  - **Readiness reports the schema separately.** `GET
/api/session-manager/v1/probes/readiness` now returns 503 with
    `checks: {database: 'ok'|'fail', schema: 'ok'|'fail'}`.
    `schema: 'fail'` means this build ships migrations the database has not
    applied yet. A database _ahead_ of the build — what a rollback looks like —
    is deliberately not a failure. The service goes ready on its own once the
    schema catches up, no restart needed.
  - **New route: `GET /api/session-manager/v1/database/schema`.**
    Admin-API-key protected. Reports `{initialized, applied, expected, pending,
unknown, upToDate, latestApplied, latestExpected}`.
  - **Config Check findings.** The admin console can now raise
    `schema-never-migrated`, `schema-migrations-pending`,
    `schema-ahead-of-containers`, `schema-version-skew` (session-manager and
    admin-server built against different schema versions — mixed `IMAGE_TAG`s),
    and `schema-version-unreadable`.

  No new environment variables and no change to the database schema itself —
  no new migration in this release.

### Patch Changes

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

- 3bf85ca: The monitoring sidecar now selects the `asrDutyRatio` alert threshold per
  provider based on the inference device the transcription service reports,
  instead of using one global GPU-calibrated number for every deployment.

  A GPU provider keeps the existing 0.45 default. A CPU provider gets 0.7 — the
  value that was previously a manual `.env` override every CPU deployment had to
  discover for itself. A healthy CPU stack running `small`/4 measured 0.471,
  sitting exactly on the GPU alarm; the shipped `base` template measures 0.173.
  One global threshold cannot serve hardware an order of magnitude apart.

  The transcription service now reports `providerDevice` on `/metrics/status`
  (alongside `providerJobPeriodMs`), using the same reported-then-fallback
  shape: the sidecar prefers it, falls back to the GPU default for a service too
  old to send it (rolling upgrade), and a provider with no local device (`debug`,
  `lumen_granite`) is omitted from the map.

  The flat operator override `MONITORING_ASR_DUTY_RATIO` still wins over both
  per-device defaults, preserving the existing escape hatch. A new env var
  `MONITORING_ASR_DUTY_RATIO_CPU` (default 0.7) lets an operator tune the CPU
  default without affecting GPU providers.

- bca3d13: Periodic Postgres backups ship with the stack, as a `db-backup` service
  reusing the `scribear-db` image rather than a host script and crontab an
  operator has to set up and keep in sync on every box separately.

  `db-backup` pg_dumps `DB_NAME` on a schedule (default every four hours),
  keeps a rolling local retention window, and can optionally push each dump
  off the host over scp or rsync-over-ssh. It reaches Postgres over the
  `backend` network with the same `DB_HOST`/`DB_USER`/`DB_PASSWORD` every other
  service in `deployment/compose.yml` already uses — no `docker exec`, no
  Docker socket. It does not use the `pg_cron` extension already loaded into
  the same image: `pg_cron` schedules SQL run _by_ Postgres, and has no way to
  shell out to the external `pg_dump` client that actually produces a dump.

  A profile-gated `db-restore` service ships alongside it for restore drills
  and the real thing — never started by `up -d`.

  `COMPOSE_FILE_VERSION` 9 -> 10, `EXPECTED_COMPOSE_FILE_VERSION` follows, the
  drift guard's sha256 is re-pinned, and `deployment/UPGRADING.md` carries the
  note.

- 44b0383: The service that holds the two operator test-audio devices' credentials and
  actually runs them (PLAN-TestAudioDevices §2 and §5).

  `libs/test-audio-source` had the streaming engine and `apps/admin-server` had
  the audit-proxy, but nothing held the device credentials or ran a send loop. This is
  that missing middle: Fastify on `@scribear/base-fastify-server`, Awilix DI, base
  path `/api/test-audio/v1`, service-key auth on every control route.
  - **`GET /devices`, `POST /:deviceId/start`, `POST /:deviceId/stop`,
    `PATCH /:deviceId/params`** — exactly the four calls
    `TestAudioGatewayService` makes, answering bare JSON rather than the admin
    envelope, because the gateway wraps successes in `okEnvelope` itself and reads
    `code`/`message`/`details` off a 4xx — the shape `base-fastify-server`'s error
    handler already emits.
  - **A run manager per device**, holding its engine for the process lifetime.
    `start` claims the device _synchronously_, before any I/O, so a double click
    finds it busy rather than slipping past the check while the first request was
    awaiting a clip load; it answers immediately with `connecting` and does the
    rest in the background. `connecting` and `streaming` are derived from whether
    a frame has reached the wire, so they cannot get out of step with the counter.
  - **The auto-stop is unconditional.** A timer is armed before any I/O _and_ the
    same deadline is checked by the send loop every chunk, so a run ends on time
    whether or not the timer fires and whether or not anything is still asking.
    `TEST_AUDIO_MAX_DURATION_SEC` (1800) is the authoritative cap; admin-server's
    schema deliberately rejects only absurd values so that lowering this is obeyed
    rather than contradicted. A forgotten device cannot stream overnight, and the
    auto-stop survives the BFF going away.
  - **`PATCH .../params` retunes without restarting the stream** — the point of
    the feature. On an idle device the same call sets what the next run starts
    with, so the page's controls mean the same thing in both states. A knob the
    addressed device does not have is a 400 `UNKNOWN_DEVICE_PARAMS` rather than a
    200: the route schema is a union of the two devices' parameter objects and
    cannot tell which half applies, because the device is named in the path —
    without the check, `PATCH /devices/good/params {"speedup": 2}` would validate,
    clamp away to nothing and succeed, and the operator would watch a meter for an
    effect that was never going to arrive.
  - **Failures are 4xx with their own codes** — `DEVICE_BUSY` (409),
    `DEVICE_NOT_CONFIGURED` (422), `DURATION_TOO_LONG` (422, naming the cap) —
    because the gateway flattens any 5xx to `UPSTREAM_ERROR`, and "no token
    configured" must reach the operator as the one sentence that tells them what
    to fix.
  - **The `longform` clip** `params.ts` names, ~5 minutes at 16 kHz mono, built at
    image-build time and _not_ committed (~9.6 MB of derived audio). By default a
    download of _Some Mistakes About Economics_ (1896) read by Brian Salmons from
    archive.org — Public Domain Mark 1.0, single speaker, already exactly 16 kHz
    mono 16-bit PCM so nothing has to be converted. LibriVox itself, which the
    plan suggested, could not be used: it publishes MP3 and Ogg only, and there is
    no audio decoder here. The fallback concatenates the two committed fixtures in
    **Thue-Morse order**, which is overlap-free — no block of segments repeats
    three times in a row at any scale, where strict alternation would just move
    the repetition problem from a 34-second cycle to an 84-second one. It is
    deterministic, so two deployments that fall back build byte-identical audio.
    A source that is not already the right format is rejected rather than
    resampled: decimating without an anti-alias filter would fold everything above
    8 kHz into the speech band of a clip whose whole job is to be clean speech.
  - **The service refuses to start on an empty or `CHANGEME` service key**, and
    resolves the auth service eagerly at startup rather than on first request. An
    empty configured key matches the empty credential an unauthenticated caller
    presents as `Authorization: Bearer `, and compose substitutes a blank string
    for an unset variable — so an auth bypass is exactly what "not set" would
    otherwise mean on a service that can put audio into a live lecture. Its guard
    is an `onRequest` hook rather than node-server's `preHandler`, since body
    parsing and validation run between the two and an unauthenticated caller
    should not be told the shape of the body it failed to send.
  - **The compose service and the `.env` keys.** The two devices are seeded by
    the Session Manager rather than provisioned by hand — see the companion
    changeset — so the only key here is `TEST_AUDIO_DEVICE_SECRET`, which this
    service and the Session Manager share and from which both derive the same
    per-device credential.

  **The room assignment is the entire safety boundary.** A device token reaches
  only its own device's room — neither device has any way to name another — so the
  device-to-room assignment decides, permanently and by construction, which room
  synthetic audio can ever reach. Pointing one of these at a teaching room would
  inject fixture speech into that lecture's live captions, silently. That is said
  in the service README, `.env.example`, `deployment/.env.example`, `compose.yml`
  and `UPGRADING.md`. The assignment itself is made in code, under reserved uids,
  by the Session Manager's seeder — two dedicated rooms, one device each, because
  a room has exactly one source device and both must run at once.

  Realtime pacing is not optional: the transcription service closes the socket
  `1007 Client sent audio too quickly` on faster-than-realtime audio. It is a
  constraint for `good` and the entire point of `fault`'s `speedup` knob, which
  changes the schedule and nothing else so that it trips exactly that path.

  admin-server takes `EXPECTED_COMPOSE_FILE_VERSION` to **4** to match the new
  service and its variables.

- 0f54c3d: The capacity estimator's three tuning knobs are reachable from `.env`, which
  they were documented as being and were not.

  `transcription_service`'s config has read `TARGET_BUSY`, `MIN_SESSIONS` and
  `MAX_SESSIONS` from its environment since they were added, with a comment saying
  they are "reachable from `.env` on purpose" and naming the regret they exist to
  avoid — a previous set of tuning numbers that lived only as compose-file edits,
  which every deployment had to rediscover and hand-set. But none of the three
  appeared in `deployment/compose.yml`, `deployment/.env.example` or
  `deployment/UPGRADING.md`, so a compose operator's only route to them was
  editing the compose file. The same regret, one indirection along.

  `compose.yml` now passes all three, `.env.example` documents them, and
  `UPGRADING.md` carries the operator note:
  - **`TRANSCRIPTION_TARGET_BUSY`** (`0.85`) — the fraction of a worker the
    estimated ceiling aims to keep busy.
  - **`TRANSCRIPTION_MIN_SESSIONS`** (`1`) — the floor under that ceiling, so one
    noisy window cannot report a worker's capacity as zero.
  - **`TRANSCRIPTION_MAX_SESSIONS`** (empty) — the operator's hard pin. It wins
    over the floor _and_ over warm-up, so it applies from the first request rather
    than after a measurement it has already overruled.

  All three default to the values already in use, so a stock deployment behaves
  identically. The estimate remains observe-only — these change what is
  _reported_, not who gets captions.

  An empty `MAX_SESSIONS` is now read as "unset". Compose has no way to omit an
  environment key, so a stock stack sends the empty string, which `int | None`
  refuses to parse — without the coercion the container would fail to boot for
  everyone who copied the new file, turning an optional knob into a required one.
  The coercion is narrow on purpose: `MAX_SESSIONS=lots` still stops the service,
  because auto-tuning silently under a value an operator believed was a hard pin is
  a misconfiguration with no symptom to find.

  `compose.yml` bumps to **v9**, `EXPECTED_COMPOSE_FILE_VERSION` follows, and the
  drift guard's pinned hash is re-pinned.

- 16e07c9: A `transcriptionProviderId` naming no configured provider is now rejected when
  it is typed, not when a room full of people tries to use it.

  The field was free-text `Type.String()` on five write paths — `create-schedule`,
  `update-schedule`, `create-auto-session-window`, `update-auto-session-window`
  and `create-on-demand-session` — and nothing checked it. An unknown key made
  transcription-service raise `TranscriptionClientError("Invalid Provider Key")`
  and close the **upstream** socket 1007, node-server retried a permanently
  unsatisfiable request forever, and every viewer of that room saw only the
  generic reconnecting banner. Nothing in the stack named the cause; the typo was
  made once, by an operator, at a keyboard.

  Session Manager now validates against `TRANSCRIPTION_PROVIDER_IDS`, a
  comma-separated env var defaulting to the set in
  `provider_config.template.json` (`debug`, `whisper`, `lumen_granite`,
  `crisper_whisper`), so a stock deployment needs no new configuration. A key
  outside it answers **400 `VALIDATION_ERROR`** — already declared on every one of
  those routes via `STANDARD_ERROR_REPLIES`, and the same answer those routes
  already give for `INVALID_ACTIVE_END` and friends, so no wire contract changes —
  with a message naming the accepted keys, because the operator cannot see the
  deployment's provider set from the console.

  Three designs were considered:
  - **A live lookup** against transcription-service's `/providers/health`.
    Rejected: it needs `METRICS_API_KEY`, a credential session-manager does not
    have and should not acquire (it otherwise never talks to transcription-service
    at all), and it would make creating a session fail whenever
    transcription-service is unreachable — a worse failure than the one being
    fixed.
  - **A fixed union in the published schema.** Rejected: `provider_config.json`
    is operator-editable deployment config, so a hardcoded enum would reject a
    provider an operator legitimately added and accept one they removed. That is
    the same mistake as pinning the `Authorization` header to a character class
    and guessing what an operator's secret manager emits.
  - **Deployment configuration**, which is what shipped. It is wrong loudly in
    both directions: too narrow and a create fails immediately with the accepted
    keys in the message; too wide and behaviour is exactly what it is today, which
    the new `invalid-request` disconnect reason now surfaces to the viewer anyway.

  `SHIPPED_TRANSCRIPTION_PROVIDER_IDS` and `TRANSCRIPTION_PROVIDER_ID_SCHEMA` are
  exported from `@scribear/session-manager-schema` so the default and the OpenAPI
  documentation come from one place; the wire type is still a plain string.

  `compose.yml` gains the variable next to the `provider_config.json` mount and
  bumps to **v8** (`EXPECTED_COMPOSE_FILE_VERSION` follows), with the operator
  note in `UPGRADING.md`: if you have edited `provider_config.json`, the two files
  now have to agree.

  Ten tests, five per level, one per write path, all failing against the old
  behaviour — plus one that walks every shipped id and asserts it is accepted,
  which is as much a guard on the comma-splitting as on the check.

- Updated dependencies [82888d1]
- Updated dependencies [ff6516c]
- Updated dependencies [bca3d13]
  - @scribear/scribear-db@0.3.0
  - @scribear/scribear-redis@0.3.0

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
