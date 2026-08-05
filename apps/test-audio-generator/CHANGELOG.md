# @scribear/test-audio-generator

## 0.3.0

### Minor Changes

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
