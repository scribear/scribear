# @scribear/admin-webapp

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

- d157c8e: "Is the kiosk even plugged in?" is now answerable from the room page and the
  device page.

  Both pages already knew the answer and declined to say it. `Device.online` and
  `Device.lastSeenAt` ride on the one shared `DEVICE_SCHEMA` used by
  `get-device`, `list-devices`, and the room-detail route's `RoomDetail.devices`,
  so the data was in the browser on every one of these pages already — the
  devices _list_ rendered it, and the two more specific pages did not. The room's
  device table showed only Active/Pending, which is **activation state, not
  presence**, and the device detail page — the deepest page in the console —
  carried no presence field at all, strictly less information than the list it is
  reached from. A dead kiosk and a healthy idle kiosk looked identical from the
  room page, which is the page an operator is on when someone reports that a room
  has no captions.

  Presence now renders on all three surfaces through one shared
  `<DevicePresenceChip>`, so they agree on wording, color, and cutoff rather than
  growing a third dialect for "online". The cutoff itself is not a client
  decision: `online` is derived server-side precisely so every consumer agrees on
  it, and the chip only renders it.

  Activation state and presence stay side by side and never collapse into each
  other — **Active _and_ Offline** is a real, important combination (registered,
  previously working, currently unplugged) and it is the one an operator most
  needs to see. Color follows the severity convention rather than the data's
  shape: online is `success`; offline _while activated_ is `warning`, because the
  device is expected to be reachable and its absence is worth going to check, but
  a reboot or a network blip is not terminal; offline while still Pending is
  `default`, because a device that was never set up is expected to be absent and
  flagging it would be noise.

  `lastSeenAt` is always rendered as text, never as color alone — "Never seen" is
  kept distinct from "Last seen <time>", so Offline does not read identically
  whether the device dropped a minute ago or has never once connected. On the
  device detail page the timestamp shows unconditionally rather than only in a
  hover tooltip, since the deepest page should not hide a fact behind a mouse.

  **Behavior change worth noting on the devices list**: it previously colored
  every offline device grey regardless of activation. It now uses the same
  active-aware rule as the other two surfaces, so an activated-but-offline device
  reads as `warning` there too.

- a2f3cdd: The console stops claiming the deployment is empty when it simply could not
  load.

  `useAsyncList`'s catch set `error` but left `items` at `[]`, and every page
  branched `loading ? spinner : items.length === 0 ? "No X found." : rows`. So a
  reload while the backend was down stated, in plain text and permanently, that
  there are **no rooms** — with the only contrary signal a toast that auto-hid
  after five seconds. On the audit page the same shape asserted that nobody had
  done anything.

  Fixed in the hook first, so it cannot come back: the first-page load is a
  discriminated `loading | ok | unavailable`, and `items` exist **only** inside
  `ok`. "No rooms found." is now unreachable from a failure by construction
  rather than by discipline, which is what the plan asked for. The shape
  deliberately matches the alerts hook so the codebase has one idiom. A failed
  _append_ is reported separately and never blanks rows already on screen — the
  mirror image of the original bug.

  `useAsyncData` gains the same union **additively**, because a dozen pages
  outside this change read its existing `data`/`loading`/`error`. That matters
  because only two of the five pages the plan named actually used
  `useAsyncList` — audit and sessions-overview use `useAsyncData`, and fixing
  just the named hook would have left them broken while looking complete.

  A shared `<ErrorState>` replaces the hand-rolled `errorMessage` copies and
  renders cause, next action, and **`requestId`** — which was captured on
  `ApiError` and displayed nowhere, so an operator filing a ticket could not
  quote the correlation id the server had already generated. It is given
  prominence only because the chain was traced end to end:
  `setGenReqId(randomUUID)` → the request-scoped logger's `reqId` → the
  `X-Request-ID` header → the error envelope → the `request_id` audit row → the
  console's own Audit column. It is correctly absent for a network failure,
  where the request never reached a server, and the block is omitted rather than
  rendered blank.

  **Retry appears only when retrying can work.** An expired session gets "sign in
  again"; a wrong `ADMIN_API_KEY` gets "check `ADMIN_API_KEY`". Offering Retry
  there would be advice already known to be wrong — the same defect as "Please
  try again" on a rate limit.

  The plan's own example turned out to be misdiagnosed, and the real bug was
  worse. "No devices assigned to this room." is not reachable from a failed load
  — the page early-returns first — but its `!detail` fallback said **"Room not
  found."** for a network drop, a dead session-manager, a 429 or a bad API key.
  Not "this room is empty" but "this room does not exist". Fixed there instead.

  Four best-effort catches that rendered nothing are also fixed: a failed room
  search now says so instead of reading as "no matches"; the kiosk wizard's step
  3 stops waiting forever behind a spinner and says it cannot tell after three
  consecutive failed polls, noting the activation is recorded on the device and
  nothing is lost; and `health-indicator` distinguishes "Checking…" from
  "Unreachable" instead of showing one grey "Unknown" for both a dead admin
  server and a healthy one with a hung probe.

- a2f3cdd: The fleet grid can no longer freeze while looking live, and the node
  diagnostics the browser was already receiving are finally rendered.

  **A frozen fleet says so.** `use-fleet` handled `TELEMETRY_UNAVAILABLE` and let
  `TELEMETRY_DEGRADED` fall through, keeping the last good snapshot with no chip,
  no toast and no staleness marker — while the only visible chip,
  `reconnecting…`, described the SSE stream rather than the poll. An operator
  watched a plausible, motionless fleet and believed it was current. Every other
  gap in this area _fails to inform_; this one **actively misinforms during an
  incident**, which is the exact "looks live but isn't" failure the poll's own
  comment says it exists to prevent. It also got worse the day an alerts panel
  landed beside it: a correct, green alerts panel lends credibility to a frozen
  grid.

  The snapshot is kept rather than blanked — mid-incident the last known fleet is
  evidence, and an empty grid beside a green alerts panel would read as "nothing
  running, nothing wrong" — but the marking is made unmissable and text-bearing,
  never colour alone: the heading becomes "Live fleet — last known state", an age
  chip reads `not updating · 2m 14s old`, an assertive banner names the cause and
  the absolute time of the last successful read and offers a retry, and the grid
  itself is fenced with a caption saying everything below is frozen. Severity
  follows the age of the _data_, not merely whether a request threw — a hung
  request never rejects and a hidden tab pauses the poll, and both used to leave
  a stale snapshot looking healthy. It escalates to `error` past three poll
  intervals, chosen because `AUDIO_STATS_TTL_MS` is 10 s, so beyond 15 s every
  audio reading on screen has certainly expired server-side.

  Two smaller honesty fixes come with it: a failed first load no longer renders
  "Loading fleet…" over a request that is not coming, and a frozen empty fleet
  says "No active sessions **as of 14:03:22** — this is the frozen snapshot"
  rather than asserting there are none.

  **Node diagnostics are rendered.** `GET /api/node-server/v1/status` publishes
  close-code tallies with their `initiator`, auth failures by reason, handshake
  totals and provider-key rejects, and shipped all of it to the browser every
  five seconds — where `grep "snapshot.nodes"` matched nothing. The findings that
  answer a question sit outside the accordion, always visible, each as cause plus
  next action: a **signing-key mismatch** between session-manager and node-server
  is now named as such, with the variable to compare, gated on "has never
  accepted a token" rather than a ratio because these are lifetime totals; a
  device acting on a stale schedule and a room pointed at a provider key no host
  serves are both newly nameable.

  Close codes are grouped by role and every row states `initiator` **in words** —
  "the far end closed it" / "node-server closed it" — with a caption explaining
  that a server-chosen reason is authoritative while a peer reason collapses to
  `other` unless allowlisted, so `other` means _unlabelled_, not a specific
  fault. That is what makes "it keeps dropping" distinguishable from "it never
  connected".

  Deliberately left out: latency series, the upstream-transition matrix,
  clock-skew counters, and **any derived rate** — differencing a 5 s poll would
  make most windows all-zero, and a wrong rate presented as current is the bug
  class this work exists to remove. Every counter is labelled as a total since
  process start, with its counting epoch shown.

  Also corrects the browser's `NodeSnapshot` mirror, which had drifted from its
  producer: `binaryBeforeAuthDropsTotal` and `endedSessionRegistrationsTotal`
  were being published and were entirely untyped here. They render as "not
  reported" when absent, never as `0` — "this publisher predates the field" is a
  different fact from "it counted nothing".

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

- 6840d43: Admin console — **Test audio**: two synthetic source devices an operator can
  point at a test room and parameterize live, so an alert can be seen before it
  matters (`PLAN-TestAudioDevices.md` §4).
  - **Two cards, one per device.** The _good source_ plays clean speech with a
    clip selector, a gain slider whose ends are labelled with what they mean
    (−40 dB is below the ingress meter's silence floor, +20 dB is hard clipping),
    a noise-type toggle and five fixed noise-floor levels. The _fault source_
    carries one slider per fault — clipping, stutter, drops, send-rate multiple,
    digital silence, DC bias, corrupt frames, bad WAV headers and clock skew —
    each captioned with what it is expected to trip, so the page doubles as the
    documentation for §2.2's table rather than sending the reader to the plan.
  - **The captions name real identifiers, and say when there are none.** Every
    metric and alert id printed on the page was checked against the sidecar's
    alert rules and metrics registry: the metric names carry the `scribear_`
    prefix the plan's table omits, `dcOffset` has no telemetry measuring it
    anywhere and says so, and `stutterPct` is captioned against caption
    repetition because node-server does not count duplicate chunk ids.
  - **Live retune.** Changing a control on a running device `PATCH`es the knob
    that moved — the stream and its session survive, which is the point of
    turning a knob and watching a meter. On an idle device the same change is
    local state, applied at start. The device list polls every 3 s while the tab
    is visible and refreshes immediately on becoming visible again.
  - **A deployment that never provisioned the devices sees an explanation**, not
    an error: the page names `TEST_AUDIO_BASE_URL` and the provisioning script
    instead of raising a toast, and a device with no token reports why it cannot
    be started. The page also states the safety boundary up front — a device
    token only reaches sessions in its own device's room, so neither source can
    stream into a teaching room.
  - Every control has an accessible name that distinguishes the two sources, the
    sliders carry unit-bearing `getAriaValueText`, the run state is the only
    live region (the counters move every poll and would be unusable if
    announced), and the page is covered by a `jest-axe` assertion.

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

- 9f65f0b: Register/re-register device dialogs now show a full, clickable kiosk URL with
  its own copy button, instead of a bare `/kiosk` path.
  - **Built from the page's own origin.** `On the kiosk browser, open /kiosk and
enter this code.` becomes a real link to
    `${window.location.origin}/kiosk` — read from the browser at render time,
    never a hardcoded scheme/port and never anything sourced from config. The
    admin console and the kiosk are served from the same reverse-proxy origin,
    so this is correct by construction in every deployment (a non-default port,
    plain HTTP on a local network, whatever the operator is actually looking
    at). The link opens in a new tab (`target="_blank"`, with a visually-hidden
    "(opens in a new tab)" suffix so its accessible name says so, matching the
    existing `OpensInNewTab` convention used elsewhere in the console).
  - **A second copy button, unambiguously for the URL.** The activation code
    already has its own "Copy activation code" button
    (`ActivationCodeDisplay`); the new "Copy kiosk URL" button sits next to the
    link and copies that instead, so the operator can hand either value to
    whoever is at the kiosk without retyping it. `Copied`/confirmation reaches a
    screen reader through the existing toast (`useToast()`, an assertive
    `role="alert"` Snackbar), not only the eye.
  - **Degrades when `navigator.clipboard` doesn't exist.** The Clipboard API
    requires a secure context, and this console is reachable over plain HTTP in
    local deployments — calling `.writeText` on a missing API would throw
    outright. Both that case and an actual write rejection now show a toast
    telling the operator to select the link and copy it by hand; the link text
    itself is always plain, selectable DOM, so nothing is lost either way.
  - Fixed in both places the copy appears: `RegisterDeviceDialog`
    (`devices-list-page.tsx`) and `ReregisterResultDialog`
    (`device-detail-page.tsx`), sharing one `KioskUrlInstructions` component so
    the two can't drift.

- 64a2a70: Stop MUI's subtitle variants emitting stray `<h6>` elements (WCAG 2.1 AA,
  `heading-order`).

  MUI's `Typography` maps the `subtitle1` and `subtitle2` _variants_ to an `h6`
  _element_ via its default `variantMapping`, whether or not the text is a
  heading, and this repo has no `variantMapping` override. Any decorative small
  text therefore entered the document outline at level 6.
  - Session-calendar column labels are labels, not sections, and landed at `h6`
    under a page whose last heading is `h2`. They render as text now; the grid
    contributes no headings at all.
  - The visualizer drawer's panel title is in a shared UI library that cannot
    know its host's heading levels, so any fixed level is a violation in some
    host. It renders as text rather than guessing.
  - The Documentation and Deployment Check pages set `variant="h5"` without
    `component`, so each had an `h5` as its top heading and no `h1` at all —
    every other page in the console uses `variant="h5" component="h1"`. Their
    card and finding titles are real subsections and now say so with
    `component="h2"`, which is also how a screen-reader user moves between them.

- df361c5: Admin console — **Test audio**: the fault knobs' captions are now measurements
  rather than predictions, and four of them said the wrong thing.

  `PLAN-TestAudioDevices.md` §2.2 was a table of guesses about what each fault
  knob would show up as, written from the code, with the plan itself insisting it
  must not be taken on faith. This page rendered those guesses to an operator as
  fact. The table has now been turned against a live GPU stack — one device at a
  time, 120 s per knob, against a clean baseline on the same stack — and the
  captions rewritten from what actually fired. Every number in them comes from a
  recorded run (`MEASURED-TestAudio-Faults.md`).

  What changed, and what an operator was being told wrongly:
  - **Send-rate multiple.** The caption promised
    `scribear_asr_audio_too_fast_total` and the `asr-audio-too-fast` CRITICAL, and
    warned that the run would end in a 1007 disconnect. On a GPU it trips nothing,
    at 2.0× _or_ at the knob's maximum of 3.0× — both ran the full two minutes and
    produced captions to the last frame with the counter flat at zero. The
    rejection fires on buffer _overflow_, so the knob measures the transcription
    service's spare headroom, not the send rate.
  - **Wrong-sample-rate WAV header.** Described as a "decode rejection". No decode
    counter moves anywhere: the mismatch closes the upstream socket 1007, node-
    server reconnects, and the next bad frame kills it again — 8 reconnects in
    120 s, the `upstream-churn` CRITICAL, and **zero captions for the whole run**.
    It takes the session out rather than dropping a frame, which the caption now
    says.
  - **Repeated frames (stutter).** Moves nothing measurable at all — every counter
    flat and the transcript count equal to baseline. The caption now reports that
    measured absence instead of pointing at `canary-repetition`, which scores the
    monitoring canary's own run in its own room and this device cannot reach.
  - **Dropped frames.** Halves the audio as claimed, but does _not_ move VAD
    no-speech: a dropped frame is absent, not silent. The observable is the noise
    floor rising and SNR collapsing.

  The five that were right now carry the number they produce — clipping reads back
  the knob to four decimal places, corruption moves node-server's decode-drop
  counter by exactly the frames corrupted — and three alerts nobody predicted are
  named against the knobs that fire them (`asr-falling-behind` under anything that
  removes or distorts audio, `asr-buffer-overflow` under silence, `upstream-churn`
  under a bad header).

  The card's banner no longer tells the operator these are unverified predictions,
  because they are not.

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

- 3b77300: A transcription session no longer takes a worker's job slot until it actually
  sends audio — and the capacity estimate on the fleet view drops sharply as a
  result.

  **The bug.** A session registered its worker-pool job as part of its own
  construction, at CONFIG time. So a client that connected, configured, and then
  streamed nothing occupied a worker identically to one transcribing a lecture: it
  counted toward `live_job_count`, and the worker ran an empty batch for it every
  period. Enough idle connections could refuse a genuinely busy worker's next real
  session — or refuse each other — with no relationship to transcription load at
  all. Observed as flaky refusals nobody could tie to usage.

  Registration now happens on a session's own first `handle_audio_chunk` (each
  provider's `_ensure_job`). An audio-less connection registers nothing and is a
  claim on nothing. `TranscriptionProviderRegistry.create_session` therefore
  **never raises `TranscriptionCapacityError`** any more; a refusal surfaces from
  the audio path instead and still closes **1013**, which the node server already
  reads as "refused" rather than "crashed".

  **Admission enforcement stays off, deliberately.** `create_webserver` passes no
  estimator to the provider registry, so the estimator observes, records and
  publishes but nothing is ever refused. The fix above is unambiguously correct on
  its own, but it also _lowers_ the measured ceiling and by a wide margin: idle
  registered jobs used to run an empty batch every period, adding a distinct
  `job_id` to the estimator's window and inflating the `sessions` denominator of
  `cost_per_session = busy / sessions` while contributing nothing to the numerator.
  A live box measured `estimatedCapacitySessions: 50` under that inflation; with it
  removed, one whisper stream that keeps the single worker busy for half of each
  5000 ms period gives `N* = 1`. Shipping enforcement in the same change as the fix
  that moved the number would mean enforcing a ceiling nobody has watched under
  real load, and a wrong refusal is invisible to the user and unrecoverable for
  that session. So: measure in shadow mode first, on
  `/metrics/status`, `/providers/health` and **Dashboard → fleet view**, then
  decide.

  **Expect the fleet view's "estimated capacity" to fall.** That is the inflation
  going away, not capacity being lost. Nothing is refused either before or after.

  The register/ask/undo sequence is now one implementation on
  `TranscriptionSessionInterface` rather than three call sites. Only
  `whisper-streaming` wrapped `check_admission` in the deregistration a refusal has
  to undo; `debug` and `lumen_granite` called it bare, which was safe only for as
  long as neither of them overrode `admission_worker_id` — an invariant asserted in
  three docstrings and enforced nowhere, where the failure would have been a job
  registered forever against a session no client ever received.

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
