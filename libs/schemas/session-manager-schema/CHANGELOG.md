# @scribear/session-manager-schema

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

- a000a0a: Seed the monitoring canary's room and device instead of provisioning them by
  hand, and delete `MONITORING_CANARY_DEVICE_TOKEN`.

  The synthetic canary was the last credential in the fleet an operator made by
  hand, and the longest-shipping one. Arming it meant registering a device through
  the admin API, activating it, scraping a `DEVICE_TOKEN` out of a `Set-Cookie`
  header, pasting it into `.env`, then creating a room, attaching the device,
  marking it the source and giving the room a standing schedule. One of those steps
  — which room the device went into — silently decided whether fixture speech could
  reach a live lecture. All of them are now gone.

  **One secret, `CANARY_DEVICE_SECRET`, held by the Session Manager and the
  monitoring sidecar and by nothing else.** At boot the Session Manager
  idempotently seeds, at fixed uids: the room `MONITORING-CANARY`, one activated
  source device in it, and one standing open-ended `ON_DEMAND` session. The
  device's stored credential is `bcrypt(HMAC-SHA256(secret, deviceUid))`, which is
  exactly what the sidecar derives for itself, so no token is ever transmitted,
  pasted or written down. Unset seeds nothing and leaves the canary off, which is
  the state a deployment that never provisioned one is already in.

  This is the scheme `TEST_AUDIO_DEVICE_SECRET` introduced for the operator
  test-audio devices, reusing the same derivation
  (`@scribear/session-manager-schema/test-audio`) rather than growing a second
  implementation of it — a mismatch between two copies is invisible until a device
  fails to authenticate and looks exactly like a wrong secret.

  **A second secret rather than reusing `TEST_AUDIO_DEVICE_SECRET`.** The two gate
  different features and sharing one would tie two unrelated decisions together:
  arming the operator test devices would also start an unattended canary probe
  every few minutes, and retiring them would silently stop monitoring. It would
  also hand a third service the root key every synthetic device's credential is
  derived from — the independence the per-device HMAC exists to provide.

  **The room assignment is enforced, not just documented.** A device token reaches
  only its own device's room, so that binding is the entire safety boundary, and
  making it in code is stronger than an operator making it by hand: the room is
  seeded under a reserved uid no other room can hold, a re-run repairs a drifted
  assignment instead of adding a second one, and room-management now refuses to
  move the device into another room (409 `CANARY_DEVICE_NOT_ASSIGNABLE`) or to hand
  the canary room a different source device (409 `CANARY_ROOM_NOT_ASSIGNABLE`).
  Those guards are the same ones the demo and test-audio rooms carry, and they
  close the same gap: `WOULD_LEAVE_ROOM_WITHOUT_SOURCE` stops covering the moment
  someone deletes the canary room, which is the documented way to retire it, and
  that leaves a roomless device holding a valid credential one `add-device-to-room`
  from a lecture hall. The canary is the sharpest case of it, because it is the
  only synthetic source that streams **unattended**, on a timer, with nobody
  watching a meter.

  The session is a standing open-ended `ON_DEMAND` one rather than
  `autoSessionEnabled`, for the reason the test-audio seeder records:
  `autoSessionEnabled` creates nothing on its own — it is a master switch over a
  room's `auto_session_windows` rows, and with no window there are no slots and no
  session.

  Idempotent by construction: every insert is keyed on a reserved uid, never on a
  name, so two instances starting together cannot duplicate. Tested across three
  boots on one database with every touched table's row count asserted unchanged,
  plus convergence after a deleted room, an ended session, a de-activated device
  and a rotated secret, and the round trip proved end to end against a real server.

  Operators running the canary must replace `MONITORING_CANARY_DEVICE_TOKEN` with
  `MONITORING_CANARY_DEVICE_SECRET` in `.env`; see `deployment/UPGRADING.md`, which
  also covers rotation, retirement ordering, and cleaning up the hand-made device
  this leaves behind.

- 0141238: Refuse device assignments to the demo caption room, which has no audio path.

  The demo caption room is a purely synthetic emitter — the Node Server publishes
  a looping fixture caption stream onto the demo session's bus channel and nothing
  is ever recorded or transcribed for it — but room management happily accepted a
  device into it, and even accepted one as its **source** device. That is actively
  misleading: an operator would reasonably expect audio from a source device to be
  transcribed, and it never will be.
  - **Session Manager — refused at the service that owns the rule**, not just in
    the admin console, because the admin API key reaches these routes directly
    (`deployment/register-device.sh` and friends do exactly that).
    `add-device-to-room` and `set-source-device` now return **409
    `DEMO_ROOM_NOT_ASSIGNABLE`** when the target room is the demo room, and
    `add-device-to-room`, `set-source-device` and `create-room` return **409
    `DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE`** when the device is the demo room's
    placeholder source — a device that is never activated and can never send audio
    for any room. Both messages say _why_ (no audio path), so the refusal does not
    read as a transient failure. `create-room` cannot recreate the demo room (its
    uid is database-generated), so the placeholder device is the only demo-room
    state it can reach. `remove-device-from-room` is deliberately left unguarded:
    detaching only ever makes a room emptier, and it is the escape hatch for a
    device attached before this existed.
  - **Reserved uids are now shared contract.** `DEMO_ROOM_UID` and
    `DEMO_SOURCE_DEVICE_UID` moved from the Session Manager's demo-room constants
    into `@scribear/session-manager-schema` (re-exported from their old home), so
    the service that enforces the rule and the console that renders it agree on one
    literal. The schema package is now marked `sideEffects: false` so importing a
    constant from it tree-shakes cleanly instead of pulling every route schema and
    typebox into a browser bundle (verified: +0.4 kB on the admin bundle, versus
    +60 kB without it).
  - **Admin console — the controls are disabled, not just refused.** The room
    detail page disables **Add device** and **Set as source** for the demo room and
    explains that its captions come from a fixture, so an operator reads the reason
    instead of discovering it by hitting a 409; **Remove** stays enabled to match
    the server. The kiosk wizard no longer offers the demo room as an existing room
    to join, and the new-room dialog no longer offers the demo placeholder device
    as a source.

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

- 28e03b1: A rate-limited join no longer tells the whole room to do the thing that caused
  it.

  `exchange-join-code` and `refresh-session-token` are rate-limited at 100
  requests / 60 s per client IP — they are the only unauthenticated routes in
  session-manager, so they are the credential-guessing surface. A lecture hall
  behind one campus NAT shares a single client IP and trips that limit
  collectively, which is the normal case, not the attack case.

  429 was deliberately undeclared on both routes, on the theory that a status
  emitted by middleware has no service-owned body. That is not true here: the
  `errorResponseBuilder` in `create-server.ts` throws `HttpError.rateLimited(...)`,
  so the body goes through the base error handler and lands in the canonical
  `ErrorReply` shape like any other thrown error. Undeclared, though,
  `createEndpointClient` reported it as `UnexpectedResponseError`, the client
  collapsed that into `JoinError.UNKNOWN`, and the viewer read **"Unable to join
  session. Please try again."** — an instruction every seat in the room follows at
  the same moment, producing the next round of 429s. The refresh path was worse:
  five failed refreshes terminated the session with "…join again with a new join
  code", and a new join code is exchanged over a rate-limited route too.

  Both routes now declare `429: RATE_LIMITED_REPLY_SCHEMA` (new, exported from
  `@scribear/base-schema`). It is deliberately **not** added to
  `STANDARD_ERROR_REPLIES`: session-manager registers `@fastify/rate-limit` with
  `global: false`, so these two routes are the only ones that can emit a 429, and
  declaring a status a route can never return puts a phantom arm in every caller's
  response union and a phantom entry in the generated OpenAPI. A test pins that
  exhausting one route's window leaves an un-opted-in route answering 401, not 429.

  Client-side, 429 gets its own `JoinError.RATE_LIMITED` with wording that names
  the cause and gives a next action that does not reproduce it:

  > Too many people are joining at once. Wait a minute, then try the same join
  > code again — this clears on its own.

  It renders as `warning`, not `error`, per the severity convention (`warning` =
  transient/self-clearing), and no longer marks the join-code field invalid —
  nothing is wrong with the code that was typed. The refresh path records whether
  its most recent failure was a 429 and, if so, ends with:

  > Too many people are reconnecting at once, so this session could not renew its
  > access. Wait a minute, then reload this page — you do not need a new join
  > code.

  The rate limiter does set a `retry-after` header (in seconds, never larger than
  the window), and there is a test pinning it, but `createEndpointClient` returns
  only status and body — headers are not reachable from a typed endpoint client —
  so nothing in the UI promises the user a specific countdown.

- cc2f8b2: Seed the two operator test-audio rooms instead of provisioning them by hand, and
  delete `deployment/provision-test-audio.sh`.

  Arming the synthetic audio sources used to mean running a 190-line bash script —
  the only one in `deployment/` that needed `jq` — which registered two devices,
  activated them, scraped a `DEVICE_TOKEN` out of a `Set-Cookie` header, created
  two rooms, printed two `.env` lines to paste, and then told the operator to go
  and create a session in each room as well. Every one of those steps is now gone.

  **One secret, `TEST_AUDIO_DEVICE_SECRET`, held by the Session Manager and the
  generator and by nothing else.** At boot the Session Manager idempotently seeds,
  at fixed uids: two rooms (`TEST-AUDIO-GOOD`, `TEST-AUDIO-FAULT`), one source
  device in each, and one standing session per room. Each device's stored
  credential is `bcrypt(HMAC-SHA256(secret, deviceUid))`. The generator derives the
  same value and presents `{deviceUid}:{secret}` — exactly the shape
  `DeviceAuthService.encode` produces, so it authenticates through the ordinary
  `verify()` path with no special case anywhere in the auth code. Nothing is
  transmitted between the two services; they agree because they compute the same
  function of the same two inputs.

  That function is defined **once**, in
  `@scribear/session-manager-schema/test-audio`, and imported by both sides. A new
  subpath rather than the package index because the derivation needs `node:crypto`
  and the index is in the browser bundles' import graph. Two independent
  implementations of "the same" derivation is the class of bug this branch has
  already spent a commit fixing: the mismatch is invisible until a device fails to
  authenticate, and looks exactly like a wrong secret.
  - **Unset seeds nothing**, and both devices report `configured: false` — the same
    inert default as before, and the same shape as `DEMO_ROOM_ENABLED`.
  - **Rotation is a restart.** The device row is upserted with `DO UPDATE`, so the
    stored hash is re-written from the current secret on every boot. `DO NOTHING`
    would be wrong here: bcrypt is salted, so the hash cannot be compared against
    the derived secret to detect drift, and a changed secret would leave the old
    hash verifying nothing anyone holds. It also repairs a device someone
    re-registered, which clears `hash` and `active`.
  - **The session is where `autoSessionEnabled` would not have worked.** It is only
    a master switch: `reconcileAutoSessions` reads the room's
    `auto_session_windows` and produces nothing when there are none, so turning it
    on alone creates no session ever. A window cannot cover a whole day either —
    `auto_session_windows_local_times_distinct` forbids one that closes where it
    opens — so it would leave a daily gap, churn AUTO rows on every reconcile, and
    cut a run that crossed an occurrence boundary. One open-ended `ON_DEMAND`
    session has none of those properties, and it _pins_ the room: the
    `sessions_no_overlap` exclusion constraint models it as `[start, infinity)`, so
    nothing else can be scheduled in a room dedicated to synthetic audio. A session
    someone ends early is re-opened on the next boot, so a test room that has gone
    quiet is fixed by a restart rather than being permanently dead.

  **Seeding the room assignment in code is stronger than an operator wiring it by
  hand, and that is much of the point.** A device token reaches only its own
  device's room, and that binding is the entire safety boundary for these devices —
  one of them in a teaching room would transcribe fixture speech into that
  lecture's live captions, silently. There is now no argument to point at the wrong
  room, no prompt to misanswer, and the rooms are reserved uids that no
  database-generated uid can collide with. Room-management refuses to undo it:
  `TEST_AUDIO_DEVICE_NOT_ASSIGNABLE` (409) on any attempt to put a seeded source in
  another room, and `TEST_AUDIO_ROOM_NOT_ASSIGNABLE` (409) on any attempt to hand a
  test room a different source. The existing `WOULD_LEAVE_ROOM_WITHOUT_SOURCE` rule
  already blocked the usual route, but stopped covering the moment someone deleted
  the test room — the documented way to retire these devices — which left a
  roomless device holding a still-valid credential. The seeder also refuses to
  adopt a device it finds in some _other_ room, logging the room rather than
  silently dragging it back, because that is the one state in which synthetic
  speech may already be reaching a lecture.

  Tested end to end rather than in halves: the generator's derived token is
  presented to the real server and must reach the seeded room, find a session
  already active in it, and exchange for a token carrying `SEND_AUDIO` — asserting
  "a hash was written" and "a string was derived" separately would pass with the
  two sides computing different functions. Three consecutive boots leave the row
  counts unchanged on `devices`, `rooms`, `room_devices` and `sessions`, and a
  deleted room, an ended session, a de-activated device and a rotated secret all
  converge on the next boot.

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

### Patch Changes

- 3bcd24f: Refuse `add-device-to-room` with `asSource` when the room already has a source,
  instead of silently demoting the incumbent.

  The route has always published a `409 TOO_MANY_SOURCE_DEVICES` reply that
  **nothing could produce** — only `createRoom` emitted that code.
  `addDeviceToRoom` ran no "this room already has a source" check, and the
  repository clears `is_source` across the whole room before inserting when
  `asSource` is true, so the call answered `204` and swapped the room's kiosk out
  from under the operator.

  The demoted device is not obviously broken, which is the problem. It keeps its
  room membership and its long-lived `DEVICE_TOKEN`, still sees the session through
  `my-schedule`, and still exchanges its token successfully — for
  `["RECEIVE_TRANSCRIPTIONS"]` instead of
  `["SEND_AUDIO","RECEIVE_TRANSCRIPTIONS"]`. That is a kiosk that starts, connects,
  displays a join code and sends no audio, with nothing anywhere reporting a fault.
  It is the exact harm `room-management.service.ts` already documents for the
  reserved test-audio and canary rooms and guards `TEST_AUDIO_ROOM_NOT_ASSIGNABLE`
  / `CANARY_ROOM_NOT_ASSIGNABLE` against; ordinary teaching rooms had no guard at
  all.

  **No schema change**: the 409 was already declared, and now has a producer. The
  route description no longer claims that `asSource` replaces the existing source.

  **Replacing a source is still supported, as two deliberate calls.** Kiosk
  hardware breaks and gets swapped, so refusing outright would be worse than the
  bug. `set-source-device` is that flow and already exists: attach with
  `asSource: false`, then promote. The refusal's message names it.

  **Both admin-console callers now do that**, because both were always swaps: every
  room has a source device (`createRoom` requires one and the
  `room_devices_ensure_source` trigger keeps one), so the kiosk wizard's "add to an
  existing room" and the room detail page's "add as source device" could only ever
  have been replacing one. They attach then promote, and both labels now say that
  the room's current source is replaced — which the operator previously had no way
  to learn, from the UI or from the API.

## 0.2.0

### Minor Changes

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
