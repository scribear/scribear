# @scribear/client-webapp

## 0.3.0

### Minor Changes

- 1a26fbd: The viewer stops reporting a healthy room as broken, and stops hammering
  session-manager when it cannot refresh a token.

  **The idle room is not a fault.** Immediately after a successful join to a real
  room with nobody streaming yet, the Node Server correctly reports
  `{transcriptionServiceConnected: false, sourceDeviceConnected: false}` — it only
  dials the Transcription Service once a source registers. `deriveConnectionBanner`
  rendered that as a warning, _"Connection to the transcription service was lost.
  Reconnecting…"_, which never cleared. Every real room looked broken; only the
  hardcoded demo room, whose synthetic status hardcodes both flags true, looked
  healthy.
  - The slice seeded `sessionStatus` with an all-`false` snapshot, which made the
    banner's `sessionStatus === null` escape hatch dead code and put the warning
    up from the instant of a _successful_ join. It is now seeded `null`, so "not
    yet reported" is distinguishable from "reported bad".
  - The banner branches on `sourceDeviceConnected` first: no source is the normal
    idle state of a healthy room, so it is informational — _"Waiting for the
    room's microphone to connect."_ — and deliberately never says "reconnecting".
    Only a down upstream _while a source is connected_ is a fault.
  - `ConnectionStatusSeverity` gains `'info'` (its own icon and a 11.44:1 color
    pairing). Informational is not urgent, so it renders as `role="status"` rather
    than the `role="alert"` warnings and errors keep — interrupting a
    screen-reader user to say "still waiting" is exactly the assertive-live-region
    misuse SC 4.1.3 warns about.

  The banner's full 27-row input cross-product is now pinned as a literal table.

  **Session tokens are decoded correctly.** A ScribeAR session token is not a JWT:
  it is `base64url(payloadJSON).base64url(HMAC)` — two segments, payload first.
  The expiry decoder read `parts[1]`, as a JWT's payload index, so it fed the raw
  signature to `JSON.parse` and returned `null` for every token this system has
  ever issued. Both callers treat `null` as "unknown expiry", so the failure was
  silent and total: no proactive refresh timer was ever armed on any connection,
  and every socket open burned a refresh round-trip before it could send AUTH.

  **Failing refreshes now converge instead of looping.** If that refresh call
  failed, the client returned without sending AUTH at all; the Node Server's 5 s
  watchdog closed the socket 1008 `auth-timeout`; and because the socket had been
  open for those 5 s — longer than the transport's 1 s stable-connection threshold
  — the reconnect backoff reset every cycle. The result was an unbounded ~1 s
  hammer loop against session-manager that the user saw only as "Reconnecting…".
  Refresh now retries with exponential backoff against a consecutive-failure
  budget counted _across_ reconnects, so a reconnect cannot refill it, and
  exhausting it is terminal.

  **There is a terminal connection state.** `SessionConnectionStatus.TERMINAL` is
  entered when a fault cannot be retried away: a 1008 close whose reason can never
  succeed (`missing-scope`, `session-mismatch`), three consecutive 1008 closes for
  any other reason, an exhausted refresh budget, or a stream schema mismatch. This
  aligns the viewer with the kiosk, which already treated 1008 as terminal. The
  session stays `ACTIVE` in TERMINAL, so the captions already on screen survive
  and the Leave button remains available to rejoin with.

  That state is also what finally gives `selectError` a consumer — until now
  "Network error - retrying.", "Failed to refresh session token." and "Session
  stream protocol mismatch." were written to Redux and read by nothing. The field
  is narrowed to "why this session is unrecoverable" and rendered by the banner's
  terminal branch, so every value written there reaches the user.

  **Reload resumes visibly.** `start(stored)` did not emit `sessionIdentity`, so
  after a page reload `clientSessionService.session` stayed `null`, every
  `setConnectionStatus`/`setSessionStatus` early-returned, and a reloaded viewer
  got no banner at all — not even with a dead socket. It now re-announces the
  resumed identity.

  The viewer also gains the `INVALID_REQUEST` branch that the kiosk already has: a
  session whose transcription provider does not exist on this deployment is
  reported as an error naming what an administrator has to fix, not as a retry
  that can never succeed.

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

- 2df4286: Let the client save the transcript as `transcript-YYYYMMDD-HHMMSS.txt`, and add
  an on-device summary as `summary-YYYYMMDD-HHMMSS.txt` — **shipped switched off**
  behind `IS_SUMMARIZATION_ENABLED` in
  `@scribear/transcript-export-store/src/config/feature-flags.ts`.

  The summary code is complete and tested, including a real-browser run of the
  recursive reduction. It is off because the model it needs has never produced a
  single summary on any machine this repo has been developed on, so nobody has
  read its output — and that output lands in a `.txt` that gets mailed on and read
  months later. Switching it off is one line, and the flag's comment carries the
  evidence and the checklist for turning it on. With it off the service reports
  itself unsupported, which the UI already handles by omitting every summary
  control while leaving the transcript download alone.

  **The transcript file is the transcript.** No header, no banner. It is the
  record, and anything prepended would have to be stripped by every downstream
  use; the filename already carries the timestamp. Interim ASR text is excluded,
  so a file saved mid-word never contains a guess the recogniser was about to
  revise.

  **Summarization is recursive, because the model has a context limit.** Chrome's
  summarizer takes about 9216 tokens per call, which a lecture transcript exceeds
  easily. The transcript is split into sections at paragraph and sentence
  boundaries, each section is summarized, the summaries are joined, and the whole
  thing runs again over that shorter text until one call can cover what is left.

  The hazard in that loop is a pass that does not shrink its input — key-point
  summaries of key-point summaries can hold steady or grow, and a naive
  `while (tooLong)` would never terminate while burning the user's battery.
  Progress is therefore checked explicitly: a pass that fails to reduce the text
  stops the loop and returns the section summaries, and the output file says that
  is what happened. A `QuotaExceededError` mid-run halves that section and
  continues rather than failing the whole transcript.

  **That the summary is local is stated three times**, because a user who reads
  only one of them still learns it: on the menu, in the confirmation dialog, and
  as the first thing in the saved file — before the content, since a `.txt` gets
  mailed and read months later by someone who never saw the dialog. The file
  header also records when it was generated, from how many words, and in how many
  sections and passes.

  **Gates.** The summary is confirmed first, and the dialog names the one-time
  ~1.8 GB model download when it is needed, warns that the first run is slow, and
  warns when a long transcript will take minutes. `requestSummary` reaches the
  service synchronously inside the dispatch so it still carries the click's user
  activation, which Chromium requires before a downloading `create()`. The
  transcript download is not gated — saving text costs nothing.

  **The summary controls are absent, not disabled, when the model cannot run.**
  Presence of `self.Summarizer` is not a capability check: the object exists on
  hardware below the Gemini Nano bar, where `availability()` answers
  `"unavailable"` and every `create()` fails with "the service is not running". The
  browser is asked at startup, and the whole summary section is omitted unless it
  says yes.

  Adds `selectTranscriptText` and `selectTranscriptWordCount` to
  `@scribear/transcription-content-store`.

  Pinned by unit tests — including a fake summarizer that enforces Chrome's real
  token quota using the cost measured from the real API — and by
  `npm run e2e:export`, which drives real Chrome and asserts the files that reach
  the disk. The suite opts into the summary machinery explicitly so it keeps
  working while the feature is off; a separate file pins the switched-off path,
  including that nothing probes the browser or touches the model on page load.

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
