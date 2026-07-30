# test-audio-generator

Derives the two operator test-audio devices' credentials and runs them.

- **`good`** — clean speech at an adjustable level and noise floor.
- **`fault`** — one knob per audio fault the stack claims to report, all
  independently settable, all defaulting to zero.

An operator drives both from the admin console's Test Audio page, which
talks to admin-server's test-audio BFF, which proxies here. The contract is
`archived-plans/2026-07-27-01-PLAN-TestAudioDevices.md`; §2 is this
service's API.

---

## The safety boundary

**A device token reaches only its own device's room.** Neither device has any
way to name another room — the token is exchanged through session-manager's
`my-schedule` and `exchange-device-token`, both of which are scoped to the
device's own room. So the device-to-room assignment decides, permanently and by
construction, which room synthetic audio can ever reach.

That assignment is the entire safety boundary, and it is the same one the
monitoring sidecar's canary relies on. **Pointing one of these devices at a
teaching room would inject fixture speech into that lecture's live captions,
silently**, with nothing in the stack to notice it.

**It is made in code, and that is stronger than making it by hand.**
session-manager seeds `TEST-AUDIO-GOOD` and `TEST-AUDIO-FAULT`, one source
device in each, under reserved uids that no database-generated uid can collide
with. There is no argument to point at a different room, no `Set-Cookie` header
to scrape, and no `.env` line to paste. Room-management then refuses to move
either device into another room (409 `TEST_AUDIO_DEVICE_NOT_ASSIGNABLE`) or to
give either test room a different source device (409
`TEST_AUDIO_ROOM_NOT_ASSIGNABLE`), so the pairing cannot be undone from the
console either.

**Two rooms, not one.** A room has exactly one source device, and both devices
must be able to run at once.

**Nothing has to be scheduled.** Each seeded room holds one standing, open-ended
`ON_DEMAND` session, so an idle device always has something to attach to. That
session also pins the room: the `sessions_no_overlap` exclusion constraint
models it as `[start, infinity)`, so no schedule, window or on-demand session
can be created in a test-audio room while it stands.

This service holds nothing but `TEST_AUDIO_DEVICE_SECRET`, from which it derives
both device tokens: no `ADMIN_API_KEY` (which would let it create and destroy
sessions in any room) and no `SESSION_TOKEN_SIGNING_KEY` (which would let it
forge a token for any session in the fleet). That restriction is why it is a
service of its own rather than part of admin-server, which deliberately holds
neither kind of credential either.

### How the two sides agree

One function, `deriveTestAudioDeviceToken` in
`@scribear/session-manager-schema/test-audio`, imported by both — not
implemented twice, because two implementations of "the same" derivation drift
and the failure looks exactly like a wrong secret.

```
secret + deviceUid --HMAC-SHA256--> plaintext secret
   session-manager stores  bcrypt(plaintext)
   this service presents   {deviceUid}:{plaintext}
```

Nothing is transmitted between the two services; they agree because they compute
the same function of the same two inputs. An unset secret means both devices
report `configured: false` and session-manager seeds nothing.

---

## API

Internal only, not proxied by nginx, on the `backend` compose network. Base path
`/api/test-audio/v1`.

| Route | Body | Answers |
| --- | --- | --- |
| `GET /devices` | — | `{ devices: DeviceState[] }` |
| `POST /devices/:deviceId/start` | `{ params?, durationSec }` | `DeviceState` |
| `POST /devices/:deviceId/stop` | — | `DeviceState` |
| `PATCH /devices/:deviceId/params` | `Partial<Params>` | `DeviceState` |

`deviceId` is `good` or `fault`.

Every one of them takes `Authorization: Bearer $TEST_AUDIO_SERVICE_KEY`,
**including the read** — it reports which rooms the devices reach and what the
last captions were, and a caller who can read the list is one request away from
starting a device.

The two probes (`/probes/liveness`, `/probes/readiness`) are the only open
routes, because the container's own `HEALTHCHECK` has no key to present. They
report whether the process is up and whether a token is configured, never which
room, which session or what was said.

Bodies are **bare JSON**, not the admin envelope: `TestAudioGatewayService`
wraps successes in `okEnvelope` itself and reads `code`/`message`/`details` off
a 4xx, which is the shape `base-fastify-server`'s error handler already emits.

### Errors the BFF passes through at their own status

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | a knob outside its stated range, a missing `durationSec` |
| 400 | `UNKNOWN_DEVICE_PARAMS` | a knob the addressed device does not have |
| 401 | `UNAUTHORIZED` | missing or wrong service key |
| 409 | `DEVICE_BUSY` | start on an already-running device |
| 422 | `DEVICE_NOT_CONFIGURED` | start on a device with no token |
| 422 | `DURATION_TOO_LONG` | over `TEST_AUDIO_MAX_DURATION_SEC` |

They are 4xx deliberately. The gateway flattens any 5xx to `UPSTREAM_ERROR`, so
a 503 for "no token configured" would reach the operator as an unexplained
backend failure rather than as the one sentence that tells them what to fix.

`UNKNOWN_DEVICE_PARAMS` exists because the route schema is a union of the two
devices' parameter objects and cannot tell which half applies — the device is
named in the path. Without it, `PATCH /devices/good/params {"speedup": 2}` would
validate, clamp away to nothing and answer 200: the operator would turn a knob,
see the request succeed, and watch a meter for an effect that was never going to
arrive.

---

## How a run works

1. `start` **claims the device synchronously**, before any I/O, so a double
   click finds it busy rather than slipping past the check while the first
   request was awaiting a clip load. It answers immediately with `connecting`.
2. In the background: load and slice the clip, find the session active in the
   device's room, mint a session token, open a source socket and a viewer
   socket. Every provisioning failure lives in this window, which is why
   `connecting` is reported separately from `streaming`.
3. Frames go out **paced at realtime**. This is not optional: the transcription
   service closes the socket `1007 Client sent audio too quickly` on
   faster-than-realtime audio. It is a constraint for `good` and the entire
   point of `fault`'s `speedup` knob, which changes the schedule and nothing
   else so that it trips exactly that path and no other.
4. The run **auto-stops at `durationSec`**, unconditionally. A timer is armed
   before any I/O and the same deadline is checked by the send loop every chunk,
   so the run ends on time whether or not the timer fires, and whether or not
   anything is still asking. A forgotten device cannot stream overnight.

`PATCH .../params` retunes a **running** device without restarting the stream —
that is the point of the feature: turn a knob, watch a meter move. A restart
would drop the session and lose what was being watched. On an *idle* device the
same call sets the parameters the next run will start with, so the page's
controls mean the same thing in both states.

The one knob a live retune cannot honour is `good`'s `clip`, because the chunks
are sliced at start; it takes effect on the next run.

State is retained after a run ends — counters, session, last transcript — until
the next start clears it. The operator's run has just finished and "how many
transcripts came back" is the question they are holding.

---

## The `longform` clip

The third clip `good` offers, ~5 minutes, 16 kHz mono 16-bit.

**Why.** The two committed fixtures are 33.6 s and 50 s. Whisper's decoder is
conditioned on its own recent output, so a loop that short walks the same
sentences past the model every half minute — captions start to rhyme with
themselves, and you cannot tell the model's failure mode from the fixture's.

**Not committed.** Five minutes of 16 kHz mono WAV is ~9.6 MB of derived audio.
It is built by `npm run build:longform` at image-build time, and by
`ClipCatalogService` on first use if that never ran — which is the path a local
`npm run dev` always takes.

**What it actually is.** By default, a download of
[*Some Mistakes About Economics* (1896)](https://archive.org/download/RalatEconomicsMistakes/RalatEconomicsMistakes.wav),
read by Brian Salmons for the Ralat Readings collection on archive.org. Public
Domain Mark 1.0, with the item stating that both the recording and the text read
are in the public domain. Single speaker, 7m11s, and already exactly 16 kHz mono
16-bit PCM, so nothing has to be converted. The first 300 s is taken.

LibriVox itself, which the plan suggested, could not be used: it publishes MP3
and Ogg only — a search of the whole `librivoxaudio` collection for WAVE
derivatives returns a single jingle — and there is no audio decoder here, nor
should there be one just for this.

**The fallback**, taken whenever the download is unavailable — no network, a
moved file, `TEST_AUDIO_LONGFORM_URL` set empty — concatenates the two committed
fixtures with 250 ms of silence between segments, in **Thue-Morse order**. That
sequence is *overlap-free*: no block of segments occurs three times in a row
anywhere in it, at any scale. Strict alternation would have reintroduced the
problem one level up, as an 84-second cycle instead of a 34-second one. It is
deterministic, so two deployments that fall back build byte-identical audio and
their captions can still be compared. The build says which of the two it used.

A source that is not already 16 kHz mono 16-bit PCM is **rejected** rather than
converted, and so is one shorter than the target. No resampler is shipped on
purpose: decimating without an anti-alias filter folds everything above 8 kHz
into the speech band, and a clip whose entire job is to be clean reference
speech is the last place to put aliasing.

---

## Configuration

See `.env.example`. The ones that matter:

| Variable | Default | Notes |
| --- | --- | --- |
| `TEST_AUDIO_SERVICE_KEY` | — | Required. The service refuses to start on empty or `CHANGEME`. |
| `TEST_AUDIO_DEVICE_SECRET` | empty | Shared with session-manager. Empty ⇒ both devices `configured: false`, and nothing is seeded. |
| `TEST_AUDIO_MAX_DURATION_SEC` | 1800 | The authoritative cap. |
| `TEST_AUDIO_LONGFORM_URL` | archive.org item | Set empty for an offline build. |
| `TEST_AUDIO_FAULT_CLIP` | `harvard` | `FaultParams` has no clip knob. |
| `TEST_AUDIO_RNG_SEED` | 1 | Fixed, so a reported run reproduces exactly. |

Readiness is **503 until a device credential is configured**, so the common
mistake — deploying the service and forgetting the `.env` line — shows up in
`docker compose ps` rather than only after someone opens the page
and presses a button. It deliberately does not check that a room is assigned or
a session is active: a test room with no session scheduled is a normal resting
state, and failing readiness for it would have the container restart-looping
over an empty calendar.

---

## Testing

```
npm run test:unit --workspace=@scribear/test-audio-generator
npm run test:integration --workspace=@scribear/test-audio-generator
```

The integration suite boots the real server and points both upstreams at a
closed port, so a configured device is genuinely startable and nothing reaches
the network.

**Not yet verified on a live stack.** PLAN §2.2's table of what each fault knob
is expected to trip was written from the code and remains unconfirmed; §6's
last gate is to turn each knob against a running deployment and correct the
table from what actually fired.
