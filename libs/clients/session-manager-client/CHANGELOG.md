# @scribear/session-manager-client

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

## 0.2.0

## 0.1.0
