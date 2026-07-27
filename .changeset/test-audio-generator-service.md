---
'@scribear/test-audio-generator': minor
'@scribear/admin-server': patch
---

The service that holds the two operator test-audio devices' tokens and actually
runs them (PLAN-TestAudioDevices §2 and §5).

`libs/test-audio-source` had the streaming engine and `apps/admin-server` had
the audit-proxy, but nothing held the device tokens or ran a send loop. This is
that missing middle: Fastify on `@scribear/base-fastify-server`, Awilix DI, base
path `/api/test-audio/v1`, service-key auth on every control route.

- **`GET /devices`, `POST /:deviceId/start`, `POST /:deviceId/stop`,
  `PATCH /:deviceId/params`** — exactly the four calls
  `TestAudioGatewayService` makes, answering bare JSON rather than the admin
  envelope, because the gateway wraps successes in `okEnvelope` itself and reads
  `code`/`message`/`details` off a 4xx — the shape `base-fastify-server`'s error
  handler already emits.
- **A run manager per device**, holding its engine for the process lifetime.
  `start` claims the device *synchronously*, before any I/O, so a double click
  finds it busy rather than slipping past the check while the first request was
  awaiting a clip load; it answers immediately with `connecting` and does the
  rest in the background. `connecting` and `streaming` are derived from whether
  a frame has reached the wire, so they cannot get out of step with the counter.
- **The auto-stop is unconditional.** A timer is armed before any I/O *and* the
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
  image-build time and *not* committed (~9.6 MB of derived audio). By default a
  download of *Some Mistakes About Economics* (1896) read by Brian Salmons from
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
- **`deployment/provision-test-audio.sh`**, the compose service behind a
  `testaudio` profile (off by default, like watchtower), and the `.env` keys.

**The room assignment is the entire safety boundary.** A device token reaches
only its own device's room — neither device has any way to name another — so the
device-to-room assignment made once at provisioning time decides, permanently
and by construction, which room synthetic audio can ever reach. Pointing one of
these at a teaching room would inject fixture speech into that lecture's live
captions, silently, and nothing at runtime could undo it. That is said in the
service README, `.env.example`, `deployment/.env.example`, `compose.yml`,
`UPGRADING.md` and the provisioning script, which creates two dedicated rooms —
one device each, because a room has exactly one source device and both must run
at once — and refuses to touch a room it did not create.

Realtime pacing is not optional: the transcription service closes the socket
`1007 Client sent audio too quickly` on faster-than-realtime audio. It is a
constraint for `good` and the entire point of `fault`'s `speedup` knob, which
changes the schedule and nothing else so that it trips exactly that path.

admin-server takes `EXPECTED_COMPOSE_FILE_VERSION` to **4** to match the new
service and its variables.
