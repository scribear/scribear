# PLAN: Demo caption room

Status: **node-server side implemented and tested; Session Manager seeding is
the remaining half.**

Implemented: the utterance fixture
(`src/server/features/demo-room/fixtures/alice-chapter-v.utterances.json` + its
regenerator and JSON Schema), the `DemoCaptionSource` emitter and its loop, the
`DEMO_ROOM_ENABLED` / `DEMO_SESSION_UID` config, DI wiring, the orchestrator's
`registerSyntheticSession`, unit tests (fragment/schedule/loop/fixture/config)
and a WS-level integration test that a client joining the demo session receives
looping interim-then-final captions with no source or Python service. Env vars
are documented in `.env.example` (node-server + session-manager + deployment)
and defaulted off in `deployment/compose.yml`.

Remaining: the Session Manager must seed a joinable session whose `uid` equals
`DEMO_SESSION_UID` (see "Component B" — note the confirmed constraint that
on-demand sessions are open-ended but DB-generate their uid, so a fixed-uid
insert is required, and join codes rotate so the seeder logs the current one).
The rest below is the design as built.

Goal: in **dev and staging only**, a caption room comes up on its own and emits
a never-ending, human-paced caption stream — interim (partial) captions that
arrive first and are then corrected by a final — so the client, kiosk, and
standalone webapps can be exercised end-to-end without a microphone, a source
device, or the Python transcription service running.

Read the two "How it actually works today" sections before the design; the
design is shaped entirely by two facts they establish: **captions fan out per
`sessionUid`, not per room**, and **the wire caption has no speaker field**.

---

## How captions actually reach a browser today

The path, most load-bearing first (all in `apps/node-server` unless noted):

1. A **client** browser opens a WebSocket to
   `…/transcription-stream/:sessionUid/client`
   (`libs/schemas/node-server-schema/…/routes/transcription-stream.schema.ts:123`),
   sends one `auth` message with a session token, and thereafter *only receives*
   `transcript` messages. It never talks to the orchestrator
   (`transcription-stream.service.ts:110-121` subscribes it to the bus and
   nothing else).

2. Transcripts are delivered over an **in-process pub/sub**,
   `EventBusService`, on the channel `transcript:${sessionUid}`
   (`shared/services/event-bus.service.ts`, `events/transcript.events.ts:29`).
   The per-connection service turns each bus event into the wire message:

   ```ts
   // transcription-stream.service.ts:110
   this._eventBusService.subscribe(TranscriptChannel, (transcript) => {
     this.emit('send', {
       type: TranscriptionStreamServerMessageType.TRANSCRIPT,
       final: transcript.final,
       inProgress: transcript.inProgress,
     });
   }, this._sessionUid);
   ```

3. In production the **only** publisher of that channel is the orchestrator,
   relaying the upstream Python service:

   ```ts
   // transcription-orchestrator.service.ts:403
   upstream.on('message', (msg) => {
     this._eventBus.publish(TranscriptChannel,
       { final: msg.final, inProgress: msg.in_progress }, sessionUid);
   });
   ```

**This is the seam the demo exploits.** Anything that publishes to
`TranscriptChannel` for a `sessionUid` reaches every client subscribed to that
session, with zero changes to the client-facing socket, the schema, or the
webapps. The demo does not need audio, a source device, or the Python service —
it needs a publisher.

### The wire caption schema (what a browser gets)

`serverMessage` union member `transcript`
(`…/routes/transcription-stream.schema.ts:62`):

```ts
{ type: "transcript",
  final:      TranscriptFragment | null,
  inProgress: TranscriptFragment | null }
```

`TranscriptFragment` (`…/entities/transcript.schema.ts:10`):

```ts
{ text: string[], starts: number[] | null, ends: number[] | null }
```

Partial vs final is **structural, not a flag**, and the two fields have
different semantics on the client, confirmed in
`libs/store/transcription-content-store/src/transcription-content-slice.ts:238`
(`handleTranscript`):

- `inProgress` **replaces** the currently displayed partial.
- `final` is **appended** to the finalized log and **clears** the partial.

That is exactly the "guess, then correct it" behavior the demo wants: emit
`inProgress = progresstxt`, later emit `final = spoken`. No new client code.

**There is no speaker field anywhere on the wire.** `roomUid`/`sessionUid` are
connection metadata (the orchestrator forwards `room_uid` *upstream* to Python
at `transcription-orchestrator.service.ts:454`, but it never comes back down and
never tags a caption). Speaker identity has to be carried *inside* `text` — see
"Speaker handling" below.

### How a browser is allowed to join a session

A client cannot connect to an arbitrary `sessionUid`; the socket runs a 5s auth
watchdog and verifies a **session token** (signed with
`SESSION_TOKEN_SIGNING_KEY`) against the URL's `sessionUid`, requiring the
`RECEIVE_TRANSCRIPTIONS` scope (`transcription-stream.auth.ts:7`,
`transcription-stream.controller.ts:66`). Tokens are obtained by exchanging a
**join code** through the Session Manager
(`client-session-service.ts:190`, `sessionAuth.exchangeJoinCode`). Join codes
are minted/rotated by the Session Manager
(`session-auth.service.ts:108`).

So "a room the frontends can join" is really "a **Session Manager session** with
a stable join code, whose `sessionUid` something is publishing captions for."
Both halves are required; a publisher alone is unreachable.

### Session lifecycle & the dev/prod signal

- Sessions are **not** created at node-server startup. Session state is built
  lazily on the first *source* connection (`registerSource` → `_openSession`,
  `transcription-orchestrator.service.ts:175/376`) and torn down at ref-count 0.
  There is no seed data and no pre-existing demo/mock room in runtime code
  (only a test helper, `tests/utils/seed-session.ts`).
- The node server has **no `NODE_ENV`**. "Dev" is a CLI flag,
  `process.argv.includes('--dev')` (`app-config.ts:127`), and there is no
  staging notion at all. Config is env-var driven via `CONFIG_SCHEMA`
  (`app-config.ts:11`). A new explicit flag is therefore cleaner than
  overloading `--dev`, because staging is not `--dev`.

---

## How the Python transcription endpoint produces partials (for fidelity)

Not on the demo's critical path — the demo replaces this service — but it is the
behavior the fixture imitates, so the demo looks like the real thing.

- Endpoint: WebSocket `GET /transcription_stream/{provider_key}`
  (`transcription_service/src/webserver/features/transcription_stream/…`). Client
  sends `auth` → `config` → binary audio; server pushes JSON `transcript`
  messages with the same `{final, in_progress}` shape (snake_case upstream;
  the node boundary renames `in_progress` → `inProgress`).
- Partial vs final is decided by **LocalAgree** (Liu et al. 2020) in
  `shared/utils/local_agree/local_agree.py`: a segment is promoted to `final`
  only once the last *N* Whisper hypotheses agree on it **and** it forms a
  complete sentence; everything committed-but-not-yet-final, plus the newest raw
  hypothesis, is emitted as `in_progress`. The newest hypothesis is the part
  that visibly churns and rewrites itself between frames.

The fixture emulates this at the utterance level: `progresstxt` is a **shorter,
sometimes slightly wrong** hypothesis (heard ~halfway through), and `spoken` is
the corrected final — mirroring "interim churns, final commits."

---

## The fixture (built)

`fixtures/alice-chapter-v.utterances.json` — the spoken dialogue of *Alice's
Adventures in Wonderland*, **Chapter V, "Advice from a Caterpillar"** (Project
Gutenberg eBook #11, public domain), extracted from `#chap05` up to where
`#chap06` begins. 121 utterances, ~6.7 min per loop, speakers
`caterpillar` (24), `alice` (70, incl. her recital of *"You are old, Father
William"*), `pigeon` (27).

Each utterance is exactly the shape the request asked for:

```json
{ "start": 4.77, "end": 9.10, "speaker": "alice",
  "spoken": "at least I know who I was when I got up this morning,",
  "progresstxt": "at least I know who I was when I got" }
```

- `start`/`end` — seconds on the loop's virtual timeline.
- Long speeches are split into ~2–5 s fragments at ~**3 words/second**
  (`end-start = words/3`, min 1 s). A 0.3 s gap separates fragments of one turn;
  a 0.8 s gap separates turns. Those gaps are the inter-phrase **pauses** — the
  emitter sends nothing during them.
- `progresstxt` is hand-authored per fragment: a truncated guess with occasional
  realistic STT errors that the final corrects — e.g. *chrysalis* →
  "crystal is", *size* → "sighs", *doth* → "does". Very short fragments
  (`"No."`, `"Why?"`) have `progresstxt: ""` → no interim, just a final.

The file carries its Gutenberg attribution in a top-level `source` block, and
`generate-alice-chapter-v.py` (same dir) can regenerate it; the header of both
credits Project Gutenberg. **Regenerating requires no network** — the dialogue
is inlined in the generator.

---

## Design

### One sentence

At boot, **iff a demo flag is set**, the node server starts a `DemoCaptionSource`
that loops the fixture forever and **publishes to `TranscriptChannel` for a
fixed demo `sessionUid`**, while the Session Manager seeds a matching,
open-ended session with a **stable join code** so the webapps can actually join
that `sessionUid`.

### Why publish at the orchestrator seam, not elsewhere

- **Not** a fake source device streaming audio → that needs real audio + real
  Whisper, i.e. the exact thing we're trying to avoid.
- **Not** the Python `debug` provider → still needs a source connection to open
  the session, and puts timing under Python's control.
- Publishing `{final, inProgress}` to `transcript:${demoSessionUid}` is byte-for-
  byte what the orchestrator already does (`…:403`). Client sockets, schema, and
  all three webapps are untouched. This is the smallest honest seam.

### Component A — node-server: `DemoCaptionSource` (new feature `demo-room/`)

A singleton started from `create-server.ts` when the flag is on. It:

1. Loads and validates the fixture once at boot (schema-checked;
   monotonic non-overlapping `start`/`end`; `speaker ∈ {caterpillar,alice,pigeon}`).
2. Runs a **virtual-clock scheduler**. For each utterance `u`, two events:
   - at `u.start + (u.end - u.start) * 0.5` →
     `publish(TranscriptChannel, { final: null, inProgress: frag(u.progresstxt, u) }, DEMO_SESSION_UID)`
     (skipped when `progresstxt === ""`).
   - at `u.end` →
     `publish(TranscriptChannel, { final: frag(u.spoken, u), inProgress: null }, DEMO_SESSION_UID)`.
   The gaps between utterances are dead air (the pauses). After the last
   utterance, wait a short reset (~2 s) and restart at virtual `t=0`. **Infinite
   repeat.**
   - Use a self-correcting timer (compare against a monotonic base, `setTimeout`
     to the next event's absolute deadline) rather than a fixed interval, so the
     loop doesn't drift over hours.
3. Makes the session look *healthy* to a joining client. The controller calls
   `orchestrator.getStatus(sessionUid)` once on connect and renders
   `transcriptionServiceConnected` / `sourceDeviceConnected`
   (`transcription-stream.controller.ts`, then `client-session-service.ts:287`).
   With no real source, a demo session reports "disconnected" and the UI shows
   "waiting for source". Fix: give the orchestrator a
   `registerSyntheticSession(sessionUid)` that installs a status-only entry so
   `getStatus` returns both-true, and have `DemoCaptionSource` also publish
   `SessionStatusChannel {transcriptionServiceConnected:true,
   sourceDeviceConnected:true}` once at start. (Do **not** route the demo session
   through `_openSession` — it must never dial the Python service.)

`frag(text, u)` tokenizes `text` into word tokens (whitespace split, punctuation
kept on the token, matching real fragments' word granularity) and returns
`{ text, starts, ends }`. Recommended: fill `starts`/`ends` with per-token times
spread evenly across the utterance window (`[start, mid]` for interim,
`[mid, end]` for final) so word-timing displays and the latency panel have
something real to show; `null` is an acceptable v1 shortcut.

**Speaker handling (the schema gap).** Because no wire field carries a speaker,
the demo prefixes the speaker onto the first token of each turn's first
fragment, e.g. `text = ["Caterpillar: ", "Who", " are", " you?"]`. This is a
demo-only convention, documented in the source; it is the honest way to make
speaker changes visible given the current protocol. (If per-speaker rendering
ever becomes a real product need, it belongs in the schema, not here — out of
scope.)

### Component B — Session Manager: seed a joinable demo session

Gated by the same flag, at Session Manager boot, idempotently ensure:
`registerDevice` → `createRoom("Demo — Alice in Wonderland")` →
`createOnDemandSession` with `joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS']` (add
`SEND_AUDIO` only if you also want to demo a source), reusing the exact recipe
already proven in `tests/utils/seed-session.ts`. Two demo-specific requirements:

- The session's `uid` must equal the node server's `DEMO_SESSION_UID` (shared
  constant/env on both services — the token is verified against the URL
  `sessionUid`, so they must match).
- The session must be **open-ended / perpetually current** (no near
  `effectiveEnd`), or the orchestrator's end timer / the join path will retire
  it. Confirm `createOnDemandSession` supports an open-ended window; if not, the
  seed re-materializes it, or a small "always-current demo session" affordance is
  added. **(Open question — verify against schedule-management before building.)**
- Publish a **stable, well-known join code** for dev/staging (e.g. `DEMO-ALICE`)
  so the webapps can hardcode/prefill it. Since join codes normally rotate
  (`session-auth.service.ts:108`), this needs either a fixed demo code path or a
  dev endpoint/log line that surfaces the current code at boot.

### Component C — the dev/staging flag

Add `DEMO_ROOM_ENABLED: Type.Boolean({ default: false })` to node-server
`CONFIG_SCHEMA` (`app-config.ts:11`) and an equivalent in the Session Manager
config. Set it **true** in the dev compose / `.env.example` and in the
**staging** deployment manifest under `deployment/`; leave it unset (false) in
production. This keeps prod bytes unreachable by a real user and is independent
of the `--dev` Swagger flag. A shared `DEMO_SESSION_UID` (fixed UUID) is set on
both services in the same environments.

### Emission cadence sanity check

Most fragments are 1–5 s, each producing an interim at its midpoint and a final
at its end — so a browser sees a new caption event **roughly every second**,
punctuated by the 0.3–0.8 s inter-phrase pauses, which is exactly the requested
"every second or so, with intermittent pauses."

---

## Files

New (node-server) — **all built**:
- `src/server/features/demo-room/demo-caption-source.ts` — scheduler + publisher.
- `src/server/features/demo-room/demo-room.constants.ts` — `DEFAULT_DEMO_SESSION_UID`, tail-gap, speaker-prefix labels.
- `src/server/features/demo-room/fixtures/alice-chapter-v.utterances.json` — the fixture.
- `src/server/features/demo-room/fixtures/generate-alice-chapter-v.py` — regenerator (prettier the JSON after regenerating).
- `src/server/features/demo-room/fixtures/alice-chapter-v.utterances.schema.json` — fixture JSON Schema (referenced by `$schema`).
- `tests/unit/features/demo-room/demo-caption-source.test.ts`, `tests/unit/features/demo-room/demo-fixture.test.ts`, `tests/integration/features/demo-room/demo-room.routes.test.ts`.

Changed (node-server) — **all built**:
- `src/app-config/app-config.ts` — `DEMO_ROOM_ENABLED`, `DEMO_SESSION_UID`, `demoRoomConfig`.
- `src/server/create-server.ts` — start/stop `DemoCaptionSource` on onReady/onClose when enabled.
- `src/server/dependency-injection/{app-dependencies,register-dependencies}.ts` — register `demoRoomConfig` + `demoCaptionSource`.
- `src/server/features/transcription-stream/transcription-orchestrator.service.ts`
  — `registerSyntheticSession` + a `_syntheticStatuses` map so `getStatus` reports the demo session healthy without a fake `_sessions` entry.
- `tsconfig.json` — `resolveJsonModule` + a fixtures JSON glob in `include` (esbuild inlines the fixture into `dist/bundle.mjs`).
- `vitest.config.ts` — exclude `**/*.py` from coverage (the generator lives beside the fixture).
- `tests/utils/use-server.ts` — default `demoRoomConfig` (off) so existing integration servers still boot.
- `.env.example` — document the new vars.

Session Manager — **remaining** (see Component B; delegated):
- Config schema + `demoRoomConfig` getter; `.env.example` (vars already documented).
- A boot-time seeder gated on the flag that inserts an open-ended `ON_DEMAND`
  session with `uid === DEMO_SESSION_UID` (fixed-uid insert, since the normal
  create path DB-generates the uid), ensures a current join code, and logs it.

Deployment — **built**:
- `deployment/compose.yml` passes `DEMO_ROOM_ENABLED` (default false) +
  `DEMO_SESSION_UID` to both services; `deployment/.env.example` documents them.
  The repo has a single compose for all environments, so dev/staging enable it
  via their own untracked `.env`; prod never sets it.

---

## Tests

- **Fixture validation (unit):** parses; `start < end`; non-overlapping and
  monotonic; every `speaker` in the allowed set; `spoken` non-empty. (The
  generator already asserts no overlaps — mirror it as a committed test so the
  checked-in JSON can't rot.)
- **Scheduler (unit, fake clock):** for a 2–3 utterance fixture, asserts the
  event order interim(progresstxt)→final(spoken) per utterance; that
  `inProgress` is null on the final and `final` is null on the interim; that
  empty `progresstxt` emits no interim; and that the loop wraps back to `t=0`.
- **Speaker prefix (unit):** first fragment of a turn carries the
  `"Speaker: "` token; continuations do not.
- **Integration:** with the flag on, a client socket authed for
  `DEMO_SESSION_UID` receives `transcript` messages and a healthy
  `sessionStatus`, without any source connection or Python service — the demo's
  whole point, asserted.

---

## Risks & limitations

1. **No speaker field on the wire.** Speaker is folded into `text`. Anything
   wanting structured per-speaker data needs a schema change; explicitly out of
   scope.
2. **Multi-instance.** Client sockets are sticky-routed by `sessionUid`, so a
   joining browser lands on one node instance and sees that instance's loop.
   Every instance runs its own loop, so different instances are **not** phase-
   aligned — acceptable for a demo, but note it (a viewer who reconnects and is
   rerouted may jump in the script).
3. **Stable join code vs rotation.** Join codes normally rotate; a fixed demo
   code is a dev/staging-only affordance and must not leak into prod (the flag
   guards it).
4. **Open-ended session.** The seeded session must not hit `effectiveEnd`.
   Verify `createOnDemandSession` supports this before building (open question
   above).
5. **Prod safety.** The entire feature is unreachable unless `DEMO_ROOM_ENABLED`
   is set; default false on both services. No prod code path publishes to
   `TranscriptChannel` except the real orchestrator.

## Attribution

Source text: *Alice's Adventures in Wonderland* by Lewis Carroll, Chapter V,
**Project Gutenberg eBook #11** — public domain. Attribution is carried in the
fixture's `source` block, in the generator header, and must be repeated in the
`DemoCaptionSource` source file header.
