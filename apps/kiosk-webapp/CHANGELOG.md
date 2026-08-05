# @scribear/kiosk-webapp

## 0.3.0

### Minor Changes

- a2f3cdd: The viewer and the kiosk now say which kind of failure happened, and stop
  burning their retry budget on a rate limit in under five seconds.

  **`InvalidResponseBodyError` has consumers.** It was introduced so a caller
  could tell "there was no structured error body at all" from "the body was JSON
  but failed the declared schema", and nothing branched on it, so both rendered
  the same generic fallback.

  Splitting it exactly two ways would have been wrong, though, and the reason is
  worth recording. nginx's `location /api/session-manager/` sets no
  `proxy_intercept_errors` and no `error_page`, so when the upstream is down
  nginx's own 502/503/504 arrive as **undeclared** statuses — which
  `createEndpointClient` short-circuits into a plain `UnexpectedResponseError`
  _before_ it ever tries to parse a body. Under a literal two-way rule, the most
  common infrastructure-down signal in this deployment would have been labelled
  _"this app may be out of date, reload the page"_: advice that cannot help,
  aimed at the wrong party, while the service is simply down. Gateway statuses
  are therefore folded in with `InvalidResponseBodyError` as
  `SERVICE_UNREACHABLE`, and `VERSION_MISMATCH` is reserved for genuine contract
  drift. The same distinction carries into the refresh path, so the terminal
  message after the budget is spent says which of the two occurred.

  **The refresh backoff is rate-limit aware.** `@fastify/rate-limit`'s bundled
  `LocalStore` is a **fixed** window — it resets the whole bucket at
  `iterationStartMs + timeWindow` rather than decaying — so the useful client
  behaviour is to spread retries across roughly one window, not to pace at the
  limit rate. A rate-limited viewer was spending its entire five-attempt budget
  in about 4.5 seconds and going terminal, advising a reload that landed in the
  same overload. Rate-limited retries are now spaced 15 seconds apart, spending
  the same bounded budget over about 60 seconds, which gives the window a real
  chance to roll over. Every other failure cause keeps the fast exponential
  schedule.

  `Retry-After` is deliberately not read — `createEndpointClient` returns
  `{status, data}` and discards headers — and the window is referenced as a
  shipped default rather than scraped, since those numbers now live in
  session-manager's `AppConfig`.

  Also corrects two kiosk comments that blamed `exchange-device-token` for a 429
  it cannot structurally produce: that route has no rate limiter at all.

- c36e5de: Metrics overlays are now opt-in, not always on; translation has one of its own;
  and the kiosk gets both.
  - **Hidden by default.** The latency badge no longer sits over every reader's
    captions. It appears only when the URL fragment asks for it:
    `#metrics=latency`, or `#metrics=all` for every overlay. The value is a
    comma-separated list (`#metrics=latency,foo`) so further overlays can be added
    without another fragment parameter; unknown names are ignored rather than
    rejected, so a link written for a newer build still works on an older one.
  - **`m` toggles.** Pressing `m` shows or hides the overlays at any time — with
    no fragment at all, `m` reveals everything, so a plain link can still be
    diagnosed on the spot. The key is ignored when another handler already claimed
    the event, when a modifier is held, or when focus is in a text field (typing
    `m` into the join-code box types an `m`).
  - Parsing reads the fragment with `URLSearchParams`, so `metrics` coexists with
    other fragment parameters and leaves the existing `#config=<base64>` payload
    the url-config middleware consumes untouched.
  - **The badge itself is now a labelled table** — rows `Pipeline` / `End-To-End`,
    columns `Final` / `Interim`, with the unit named once in the corner cell —
    instead of four bare numbers separated by slashes, and it sits centered along
    the top rather than in the top right, where it covered the header controls.
  - **New `#metrics=translation` overlay.** Rows `Wait` (queue time) / `Translate`
    (the model call) / `Total`, columns `Last` / `Avg` over the same 60-sample
    window the transcription figures use, with a footer carrying the translator
    status, the current backlog, the dropped-caption count, and how many calls
    have been measured. Wait and the call are split because they fail differently:
    wait growing means the model cannot keep pace with the room, the call growing
    means individual requests got slower. Shown whenever the browser can translate
    at all — including with translation off, so the overlay says why there is no
    data rather than disappearing.
  - **Both overlays on the kiosk too.** Same fragment, same `m` key, same cards.
    The kiosk had been receiving the node's latency updates and discarding them
    ("the source device does not display latency") — it now records them, which
    matters because the kiosk is the device whose clock sync makes end-to-end
    latency measurable at all, and the one standing in the room where a lagging
    translation gets noticed.
  - **New `@scribear/metrics-overlay-ui` package.** The fragment parsing, the `m`
    shortcut, the overlay container and the cards live there, presentational and
    store-agnostic like the other UI libraries; each app keeps a thin container
    that wires its own selectors.
  - **Translation service — latency instrumentation.** `TranslationService` now
    emits a `sample` event (queue wait, call duration, captions covered, backlog
    left) after each `translate()` that produced text, and counts dropped captions
    rather than only flagging that some were dropped — the on-screen gap markers
    coalesce, so one ellipsis could stand for a fragment or for a minute of
    speech. Both are mirrored into the store by the live-translation middleware
    and reset when a new session clears the captions.

- 2df4286: Add opt-in translated captions, produced in the browser by Chrome's Translator
  API, to the client and kiosk webapps.

  The transcript is never replaced. Translated text renders in its own panel below
  the original, because machine translation of live speech is unreviewed by anyone
  and the source has to stay available to whoever needs to check what was actually
  said — and it is what a later summarisation pass would run against.

  **Only finalized captions are translated.** Interim ASR output is rewritten
  several times a second; translating it would spend the model's entire throughput
  producing text that is about to be replaced, and would put half-finished
  sentences in front of a reader.

  **The feature is absent, not disabled, on browsers without the API.** A
  `Translator` that is missing means the user has no path forward, so the menu,
  the dialogs and the panel are all omitted. Everything reaching the browser API
  is wrapped: `TranslationService` never throws and never rejects, because it is
  an optional feature layered on top of an accessibility tool and a failure inside
  it must not take the transcript down with it.

  **Gates.** Turning translation on or off is confirmed first, and the
  confirmation states both that the output may contain errors and — when the
  model is not yet on the device — that proceeding starts a one-time download.
  `enable()` is invoked synchronously inside the dispatch so it still carries the
  click's user activation, which Chromium requires before a downloading
  `create()`. A persisted "on" preference auto-resumes **only** when the model is
  already available locally; otherwise translation stays off and the user is asked
  again, so a stored preference cannot silently spend a metered connection on page
  load. The same reasoning keeps `isTranslationEnabled` out of URL config: a link
  must not be able to skip the disclaimer on a reader's behalf.

  **Falling behind is visible, not silent.** Captions that have waited more than
  20 seconds are dropped so the display can catch up with the room, and the loss
  is marked with an ellipsis rather than closing the gap invisibly. A translation
  that does not return within 20 seconds is a failure, not slowness: it is aborted
  and reported as "No translations are available."

  Also adds two props to `TranscriptionDisplayContainer`: `announceUpdates`, so
  the original region stops announcing while the translated one does (two live
  regions carrying the same speech announce it twice and make both unusable), and
  `fillParentHeight`, so the two caption regions divide one viewport instead of
  each claiming all of it.

  Pinned by unit tests against a scriptable fake API, and by
  `npm run e2e:translation`, which runs the real service against real Chrome —
  including real Spanish output, the ellipsis under real backpressure, and the
  20-second timeout.

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

### Patch Changes

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

- 0151047: The long-poll client no longer emits a declared error body as if it were poll
  data.

  `_run()` carried the comment `// status === 200` and checked nothing. It
  skipped 204 and treated _everything else_ in the response slot as a payload.
  That slot is fuller than it looks: `createEndpointClient` returns a declared
  status as a typed **response** with a null error, on purpose, so a 401
  `INVALID_DEVICE_TOKEN` or a 404 `DEVICE_NOT_IN_ROOM` — both declared by
  `my-schedule`, as 401 `INVALID_SERVICE_KEY` and 404 `SESSION_NOT_FOUND` are by
  `session-config-stream` — arrived with `err === null` and went straight out the
  `data` event as `{ code, message }`.

  The consequence was not a missing update; it was a _misleading_ one. node-server
  read `transcriptionProviderId` off a 401 body, got `undefined`, and dialed
  `.../transcription_stream/undefined`; the transcription service refused the
  request and the operator was shown `invalid-request` — sending them to hunt for
  a provider-key misconfiguration that did not exist, when the actual fault was a
  `NODE_SERVER_KEY` mismatch between node-server and session-manager. Two
  unrelated causes collapsed into one wrong answer. On the kiosk the same path
  threw inside the `data` listener (`for (const session of undefined)`), which,
  because the poll loop is a `void`-ed async method, escaped the `while` and left
  the client in `POLLING` with no request in flight and no retry armed:
  permanently silent while `state` still read healthy.

  Any response that is not 200 or 204 is now a failure. It surfaces as
  `LongPollResponseError`, a **subclass** of `UnexpectedResponseError` (the same
  relationship `InvalidResponseBodyError` has), so every existing `instanceof
UnexpectedResponseError` branch and `.status` read keeps working; the subclass
  adds `.code` and `.body` so a consumer can name the cause. Both consumers
  already had `error` handlers that report to a human, so the cause now reaches
  one instead of being laundered.

  No status is treated as terminal, 401 included. Nothing in the fleet re-mints a
  credential on demand — the kiosk's `DEVICE_TOKEN` is replaced only by a human
  re-activating the device, and node-server's service key only by a redeploy — but
  both of those happen _while the client is running_, and a poll that had stopped
  for good would not notice. Backoff caps the cost of waiting at one request per
  30s. Relatedly, `_attempt` is now reset only after a genuine 200/204: resetting
  it before the status check pinned a permanently-failing status (a wrong key
  answering 401 forever) at `initialMs`, so backoff never grew and the client
  retried a hopeless request once a second indefinitely.

  Two adjacent hazards on the same path are closed. A 200 whose body has no
  numeric `versionResponseKey` field now fails into backoff rather than emitting
  with an unmoved cursor — the server answers 200 to that same cursor
  immediately, so the old behaviour was a hot loop with no delay between
  requests. And an exception thrown by a `data` listener is contained and
  re-emitted on `error` instead of killing the poll loop.

  The kiosk now names the two device-specific statuses on the wall banner —
  "Re-activate the device from the admin console" for a 401, "Assign it to a room"
  for a 404 — instead of the generic "The schedule service is failing (HTTP …)",
  which blames the server for a device problem.

## 0.2.0

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
