# @scribear/session-manager

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

- 25f06fd: Recalibrate the session-auth rate limits, and add the anti-guessing control the
  old limit was pretending to be.

  `exchange-join-code` and `refresh-session-token` were limited at a hard-coded
  100 requests / 60 s per client IP. That number was set as if it were a
  credential-guessing defence, and it is not one: join codes are 8 characters from
  a 36-character alphabet (~2.8×10¹² possibilities) rotating every 5 minutes, and
  refresh tokens are 256-bit secrets checked against the database, so brute force
  is hopeless at 100/min and equally hopeless at 100,000/min. What it did instead
  was fire on ordinary traffic. Session tokens live 5 minutes and the client
  refreshes at 50% of remaining lifetime, so each viewer refreshes about every
  150 s; `N` viewers behind one NAT produce `N/150` refreshes per second, which
  crosses `100/60 s` at **N ≈ 250**. A 250-seat hall behind one campus NAT was
  429ing continuously in steady state with nobody doing anything unusual, and
  `exchange-join-code` tripped earlier still.

  The limits now live in `AppConfig` (`SESSION_AUTH_RATE_LIMIT_*`), as
  admin-server's already do, with the calibration argument written down beside
  them:
  - **`refresh-session-token`: 1,000 / 60 s.** Covers ~2,500 viewers behind one
    egress IP in steady state. Raised rather than exempted, because this is the
    most expensive unauthenticated call in the service — one bcrypt cost-12
    compare, measured at 154 ms of libuv threadpool, against a service-wide
    ceiling of ~25 compares/s with the default 4-thread pool — and because a
    single client has already been seen hammering it in an unbounded ~1 s loop
    (the reason `REFRESH_MAX_CONSECUTIVE_FAILURES` exists in client-webapp).
    1,000 / 60 s is ~17× that runaway rate and ~2.5× the largest lecture hall.
  - **`exchange-join-code`: 600 / 60 s.** A generous volumetric cap: a 1,000-seat
    hall can join inside ~100 s without touching it, while 600 _successful_ joins
    a minute is ~1.5 of the 4 bcrypt threads held by one source.
  - **New: 100 failed exchanges / 60 s.** The actual anti-guessing control, and
    the operator's signal that guessing is happening (blocks are logged with the
    client IP).

  The failed-attempt cap is keyed on the **client IP, never on the submitted join
  code** — keying a limiter on the credential being guessed hands the guesser a
  fresh bucket per guess, which is worse than having no limiter. It counts only
  404 `JOIN_CODE_NOT_FOUND`; a successful join never spends from it, so a full
  hall cannot lock itself out by joining normally. `@fastify/rate-limit` cannot do
  outcome-conditional counting through `config.rateLimit`, so this uses
  `fastify.createRateLimit()` (v11's manual API): a `preHandler` peeks with
  `{ increment: false }` and an `onSend` hook charges with `{ increment: true }`
  only on a 404. `onSend` rather than `onResponse`, so a burst of concurrent
  guesses cannot all clear the peek before any of them is charged.

  410 `JOIN_CODE_EXPIRED` is deliberately **not** charged: a guesser essentially
  never produces one, whereas a stale code left on a projector makes a whole room
  produce one at the same instant, and charging that would lock the room out of
  joining even after the display is fixed.

  The 429 declarations and user-facing wording added alongside them are unchanged
  and remain accurate. Because the limits are now config, the rate-limit
  integration suite configures a tiny limit instead of spending 100 real requests
  per route to reach a hard-coded ceiling and then leaving both routes limited for
  the remainder of a real 60-second window.

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

- ccd76c1: Clip a schedule or window occurrence to its active range instead of dropping it.

  `inRange` rejected any occurrence that straddled either end of
  `[activeStart, activeEnd]`. That reads as the safe conservative choice and is
  not: the shape the admin console creates is a daily `00:00–23:59` window, so
  **every** occurrence straddles both ends of any active range that does not begin
  at midnight and finish at 23:59.

  Three operator-visible consequences, all reproduced against a running stack:
  - "Auto sessions every day, until 30 minutes from now" materialized **nothing** —
    not a 30-minute session.
  - Narrowing a **live** window through `update-auto-session-window` returned 200
    and then **ended the AUTO session that was running right then**: with no window
    occurrence covering the active session's start, the reconciler took its
    `end_override = now` branch. An operator asking to "stop after this afternoon"
    stopped the room mid-lecture.
  - The mirror image at the other end: a window with `activeStart = now` produced
    no session covering now, and the first appeared at the next local midnight.
    This is why `tools/demo-e2e` backdates `activeStart` a week (an hour of
    debugging is recorded in its comments) and why the admin dialog forces
    `activeStart` into the future. Neither workaround is needed any more; the
    `demo-e2e` backdate is now harmless rather than load-bearing and is left alone.

  Occurrences are now trimmed — `startUtc = max(startUtc, activeStart)`,
  `endUtc = min(endUtc, activeEnd)` — which is what the field names imply and what
  `materializeAutoSessions` already did when filling a window around a blocking
  session. The trim is arithmetic on absolute UTC instants, so a DST-adjusted
  occurrence keeps whichever instants `buildOccurrence` resolved; a fall-back
  occurrence clipped mid-way still lands on the standard-time instant.

  **A residue shorter than 60 s is dropped rather than materialized**, reusing the
  existing AUTO-slot floor (now `MIN_SESSION_DURATION_SECONDS`, exported from the
  materializer so there is one constant rather than two 60s).
  - It applies to **SCHEDULED occurrences too**, not only AUTO. They flow through
    the same materializer, and SCHEDULED occurrences go straight to
    `insertSessions` with no other length check — a zero-length residue would
    violate `sessions_scheduled_end_after_start` and surface as a 500, which is
    the failure mode this release is otherwise removing. AUTO occurrences pass
    through `materializeAutoSessions`, which already applied the same floor to
    every slot, so there the check is belt and braces.
  - It applies **only to a clipped residue**, never to an unclipped occurrence. A
    30-second occurrence an operator typed out is a request; a 30-second tail left
    by an `activeEnd` is an artefact, and one nothing can join — the join-code
    handoff window is itself 60 s.

  Nothing downstream needed changing, and the knock-on paths are covered by tests:
  the window-overlap conflict check and `detectConflict` now compare the ranges
  that will actually be written rather than pre-trim ones; `reconcileAutoSessions`
  preserves the running AUTO row and moves its end instead of ending it; the
  deferred `sessions_no_overlap` exclusion constraint still holds for a clipped
  window abutting a SCHEDULED session inside it.

  `tools/session-corner-cases`'s fall-back DST check used the old drop behaviour as
  its discriminator between the daylight and standard readings of an ambiguous
  local time, and was rebuilt around clipping: both schedules now sit wholly inside
  the ambiguous hour, so `activeEnd` at the transition instant keeps them under one
  reading and clips them out of existence under the other.

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

- f7b26b6: `exchange-join-code` ignored a join code's `valid_start`, so codes lived up to
  ten minutes instead of five.

  The route rejected only `validEnd <= now`. But `fetchJoinCodes` pre-mints the
  _next_ code 60 seconds before the current one expires, with
  `validStart = current.validEnd` — a code whose window has not opened yet. With
  no `valid_start` check that code was exchangeable the instant it was minted, so
  its usable life ran from the mint to the end of its own 5-minute window: nearly
  double the intended TTL, and two codes were live at once for the last minute of
  every rotation. `_findOrMintCurrentJoinCode` and `fetchJoinCodes` both already
  applied `validStart <= now`; only the exchange did not.

  A code is now exchangeable only inside `[validStart, validEnd)`, matching those
  two. Not-yet-valid answers **404 `JOIN_CODE_NOT_FOUND`**, not 410
  `JOIN_CODE_EXPIRED`: 410 GONE asserts the code is permanently finished when it
  is in fact about to start working, and a status distinct from "unknown" would
  confirm a live-but-unused code to anyone walking the 8-character space and
  waiting.

  The handoff flow is unaffected, which is the point of the pre-mint. The kiosk
  renders only `current` in its QR (`nextJoinCode` is stored but never displayed),
  so nothing legitimate ever presents a future code, and the pre-minted code
  becomes exchangeable at exactly the instant the previous one expires — there is
  no gap, because `validStart == previous.validEnd`.

  Tested at the boundary on both sides: `validStart - 1ms` is refused,
  `validStart` exactly is accepted. The integration test drives the real handoff —
  back-dates the current code into the 60s window, re-fetches to make the server
  mint `next`, and asserts `next` is refused while `current` still works, then
  that `next` starts working the moment its window opens.

- 1bfbc60: A canceled session still minted session tokens.

  `findSessionForAuth` selected `uid`, `room_uid`, `join_code_scopes`,
  `effective_start` and `effective_end` — but not `canceled_at`, and
  `SessionAuthRow` had no such field. Every "is this session live?" decision in
  `session-auth` therefore read start/end only, and cancellation moves neither.

  That is not a theoretical gap. `cancel-session` accepts only _upcoming_
  `SCHEDULED` occurrences, so every canceled row starts out in the future and
  time then catches up to its slot. From that moment the session's effective
  window covers now, `isSessionCurrentlyActive` says yes, and
  `exchange-join-code`, `exchange-device-token`, `refresh-session-token`,
  `fetch-join-code` and `admin-fetch-join-code` all hand out credentials for a
  session an operator canceled — including `SEND_AUDIO` to the room's source
  kiosk. Meanwhile `findActiveSession`, `my-schedule` and the `sessions_no_overlap`
  exclusion constraint (narrowed by migration `00000012` to
  `WHERE canceled_at IS NULL`) all correctly treat the row as gone, so the room
  reads as free while its auth surface reads as live.

  `canceled_at` is now selected and carried on `SessionAuthRow`, and cancellation
  is terminal on every path. No wire contract changed; each route answers with a
  status it already declared:
  - `exchange-join-code`, `exchange-device-token`, `admin-fetch-join-code` —
    `isSessionCurrentlyActive` returns false, so 409
    `SESSION_NOT_CURRENTLY_ACTIVE` (and `status: "not-active"` for the admin
    route, which reports rather than errors).
  - `refresh-session-token` — `isSessionEnded` returns true, so 409
    `SESSION_ENDED`. This is the path that matters most: a viewer's refresh token
    outlives every short-lived session token, so without it cancellation never
    actually removes access.
  - `fetch-join-code` — 404 `SESSION_NOT_FOUND`. Devices are never told about a
    canceled session by `my-schedule`, so this route does not confirm one exists
    either; it also mints no code, since a code outlives the request.

  Pinned at both levels. The unit tests drive a canceled-but-live `SessionAuthRow`
  through all five paths and assert nothing is signed or persisted. The
  integration tests cancel through the real `cancel-session` endpoint — pushing
  the occurrence forward to satisfy its "still upcoming" precondition, then
  restoring the window to simulate the passage of time — so the row under test is
  produced by the product code, not by the test. All five fail against the old
  behaviour.

- 64a2a70: Fix cursor pagination repeating rows created inside the same millisecond.

  `_listByCreatedAt` filtered on `date_trunc('milliseconds', created_at)` but
  ordered on the raw column. `created_at` is a `timestamptz` and keeps
  microseconds, while the cursor round-trips through a JS `Date` and an ISO-8601
  string and can only ever name a millisecond — so for rows sharing a
  millisecond the ordering and the filter disagreed about which side of the
  cursor a row fell on. A row ordered into page N by its microseconds could
  still satisfy the `uid` tiebreak and be returned again on page N+1.

  Both the device and room repositories now order on the same truncated
  expression their cursor predicate uses. This was the cause of the
  intermittent `list-devices` / `list-rooms` pagination test failures; both
  suites gained a regression test that forces the collision rather than waiting
  for it.

- 860d098: Answer `400` instead of `500` when an auto-session window's `localStartTime`
  equals its `localEndTime`.

  `_doCreateSchedule` has validated this since it was written and returns
  `400 "localStartTime and localEndTime must not be equal."`. `_doCreateWindow`
  validated only `activeEnd`, so the identical typo reached the
  `auto_session_windows_local_times_distinct` CHECK inside the transaction and
  came back as an opaque `500 INTERNAL_ERROR` — on both
  `create-auto-session-window` and `update-auto-session-window`. Both window paths
  now mirror the schedule path exactly.

  **No schema change.** `400 VALIDATION_ERROR` is already declared on every route
  through `STANDARD_ERROR_REPLIES`, and that is all the schedule route ever
  declared for this: adding an `INVALID_LOCAL_TIMES` reply to the window schemas
  would have made the two paths _less_ consistent, not more.

  **The comparison is on time of day, not on the string.** `HH:MM` and `HH:MM:SS`
  are both accepted on the wire and the database stores either as `TIME`, so a row
  written as `08:00` reads back as `08:00:00`. An update merging a request's
  `08:00` against that stored value is exactly the collision the CHECK fires on,
  and `'08:00:00' === '08:00'` is false — so a literal mirror of the schedule
  path's `===` would have left the update route answering 500 for the case an
  operator is most likely to hit. The schedule path had the same hole one level
  deeper (its `===` caught the obvious typo first) and is fixed with it.

  Found by `tools/session-corner-cases`, which pinned the 500 and now asserts the
  400, including the `HH:MM` / `HH:MM:SS` form.

- Updated dependencies [82888d1]
- Updated dependencies [ff6516c]
- Updated dependencies [bca3d13]
  - @scribear/scribear-db@0.3.0

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

### Patch Changes

- b34905f: Harden Session Manager credential handling (admin website Phase 6):
  - Compare the admin and service API keys in constant time
    (`crypto.timingSafeEqual` over HMAC digests) instead of `===`, closing a
    timing side-channel.
  - Refuse to start when `ADMIN_API_KEY` / `SESSION_MANAGER_SERVICE_API_KEY` is
    still the literal placeholder `CHANGEME`.
  - Rate-limit the two unauthenticated credential-exchange routes
    (`exchange-join-code`, `refresh-session-token`) per client IP via
    `@fastify/rate-limit` (long-poll, probe, and admin/service routes are
    intentionally not limited). `trustProxy` is enabled so the limit keys on the
    real client IP behind nginx.

  No change to the wire contract.

- Bump `testcontainers` 11 -> 12 (dev-only integration-test dependency) to drop
  the transitive `uuid@10.0.0` pull that was the last live Dependabot alert
  (GHSA-w5hq-g745-h8pq). No production runtime change; `npm audit` now reports 0
  vulnerabilities. Integration suites re-verified: session-manager (308),
  admin-server (19), node-server (17).
