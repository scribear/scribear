# PLAN: Demo caption room

> **Update (post-implementation).** The demo room is now **enabled by default**
> in every environment — set `DEMO_ROOM_ENABLED=false` to disable — and
> `DEMO_SESSION_UID` is no longer passed through `deployment/compose.yml` (both
> services use the same built-in default). The "off by default / dev-staging
> only / prod safety" statements below describe the original design and are
> superseded on those points. The admin console also surfaces the room's status
> and a one-click join link. See the **Demo Caption Room** wiki page for current
> usage.
>
> **Update (2026-07-24 rework).** Fixed a staging incident (10 duplicate
> "Demo Room Source" devices from restarts/rolling deploys racing the seeder —
> the device/room inserts had no fixed identity or conflict guard, unlike the
> session insert; see Component B). Also reworked the caption content itself:
> the fixture now covers **Chapters I-VI**, not just Chapter V (extraction of
> the remaining chapters was cut short partway through automated processing
> and left for later); captions no
> longer fold the speaker name into caption text (it broke concatenation —
> see "Speaker handling" below); interim captions now grow roughly **once a
> second** instead of a single midpoint guess; and the speaking rate is now
> **5 words/second**. See "The fixture (built)" and "Speaker handling" below.

Status: **implemented and tested on both services** (node-server emitter +
Session Manager seeding).

Implemented: the utterance fixture
(`src/server/features/demo-room/fixtures/alice-book.utterances.json` + its
regenerator and JSON Schema), the `DemoCaptionSource` emitter and its loop, the
`DEMO_ROOM_ENABLED` / `DEMO_SESSION_UID` config, DI wiring, the orchestrator's
`registerSyntheticSession`, unit tests (fragment/schedule/loop/fixture/config)
and a WS-level integration test that a client joining the demo session receives
looping interim-then-final captions with no source or Python service. Env vars
are documented in `.env.example` (node-server + session-manager + deployment)
and defaulted off in `deployment/compose.yml`. The Session Manager seeds a
joinable session whose `uid` equals `DEMO_SESSION_UID` (see "Component B"),
idempotently across restarts and racing instances.

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
a growing `inProgress` prefix, later emit the complete line as `final`. No new
client code.

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

The emitter approximates this per line: interim captions are a **growing
word-prefix** published roughly once a second while the line is "being
spoken," and the final is the complete, correct line — mirroring "interim
churns (grows), final commits." Unlike the real pipeline, the demo's interim
is always a strict prefix of the correct text (no simulated recognition
errors) — good enough for pacing/UX fidelity without hand-authoring guesses
for an entire novel.

---

## The fixture (built)

`fixtures/alice-book.utterances.json` — the spoken dialogue of *Alice's
Adventures in Wonderland* (Project Gutenberg eBook #11, public domain),
**Chapters I-VI** (up from just Chapter V; extending through the rest of the
book - Chapters VII-XII - is a follow-up, not yet done). Only lines actually
spoken aloud by a character are included (excludes narration, silent
thought/"said to herself" asides, and non-dialogue quoted text like the
"DRINK ME" label) — see the generator's extraction criteria in its header for
the exact rules.

Each entry is a speaker **turn** — consecutive same-speaker dialogue,
uninterrupted by another speaker — made of one or more spoken **lines**:

```json
{ "speaker": "alice",
  "lines": [
    "I—I hardly know, sir, just at present—",
    "at least I know who I was when I got up this morning,",
    "but I think I must have been changed several times since then."
  ] }
```

Unlike the original Chapter-V-only fixture, **no timing is stored in the
file**: `start`/`end`/`wordsPerSecond`/`progresstxt` are gone. Timing (words/
second, inter-line/turn pauses, interim-caption cadence) is computed at
**runtime** from the constants in `demo-room.constants.ts`
(`DEMO_WORDS_PER_SECOND = 5`, `DEMO_GAP_WITHIN_TURN_SECONDS = 0.3`,
`DEMO_GAP_BETWEEN_TURNS_SECONDS = 0.8`,
`DEMO_INTERIM_INTERVAL_SECONDS = 1`), so there's one source of truth for
pacing instead of it drifting between the generator and the emitter, and the
rate can be tuned without regenerating the fixture.

The file carries its Gutenberg attribution in a top-level `source` block, and
`generate-alice-book.py` (same dir) can regenerate it; the header of both
credits Project Gutenberg. **Regenerating requires no network** — the dialogue
is inlined in the generator's `TURNS` list.

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

1. Loads the fixture once at boot (trusted, not re-validated at runtime — see
   the fixture-invariant unit test instead).
2. Runs a **virtual-clock scheduler**, `buildDemoSchedule`. For each turn's
   each line `l` (word count `n`, duration `d = max(1, n / DEMO_WORDS_PER_SECOND)`
   starting at virtual time `start`):
   - every `DEMO_INTERIM_INTERVAL_SECONDS` (1s) within `[start, start+d)` →
     `publish(TranscriptChannel, { final: null, inProgress: frag(prefixOf(l, tick)) }, DEMO_SESSION_UID)`,
     where `prefixOf` is a growing word-prefix of `l` proportional to elapsed
     time — simulating a live transcript filling in. Lines shorter than one
     interim interval (short exclamations, the common case) get no interim,
     matching how a real transcript has nothing to correct for a one-beat line.
   - at `start + d` →
     `publish(TranscriptChannel, { final: frag(l), inProgress: null }, DEMO_SESSION_UID)`.
   The gaps between lines/turns are dead air (the pauses:
   `DEMO_GAP_WITHIN_TURN_SECONDS` / `DEMO_GAP_BETWEEN_TURNS_SECONDS`). After the
   last turn, wait a short reset (`DEMO_LOOP_TAIL_GAP_MS`) and restart at
   virtual `t=0`. **Infinite repeat.**
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

`frag(text)` tokenizes `text` into word tokens (whitespace split, punctuation
kept on the token, matching real fragments' word granularity) and returns
`{ text, starts, ends }`, with per-token times spread evenly across the
line's current window. **Every token, including the first, carries a leading
space** (`buildFragment`'s `leadingSpace` param, default `true`): the client
concatenates `finalizedTranscription` sequences back-to-back with **no
separator** (`transcription-content-slice.ts` `selectFinalizedText`), so
without a leading space on each fragment, consecutive finals run together —
e.g. `"...since then!Alice: ..."` was an observed bug. The one exception is
the very first fragment ever published in a run, which has nothing before it
to separate from.

**Speaker handling (the schema gap).** No wire field carries a speaker, and
unlike the original design, the demo does **not** fold it into the caption
text either — an earlier version prefixed `"Caterpillar: "` onto the first
token of a turn, but that read as noisy caption content and interacted badly
with the leading-space fix above. Speaker is tracked only at schedule-build
time (each fixture turn carries `speaker`), for future use (e.g. logging), and
is simply dropped when a fragment is built. (If per-speaker rendering ever
becomes a real product need, it belongs in the wire schema, not here — out of
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

Interim captions are generated every `DEMO_INTERIM_INTERVAL_SECONDS` (1s)
while a line is "being spoken," each a longer word-prefix than the last, plus
a final when the line completes — so a browser sees a new caption event **at
least once a second** for any line long enough to have one, punctuated by the
0.3–0.8 s inter-phrase pauses. Short lines (well under 1s at 5 words/sec) skip
the interim and go straight to a final, which is also realistic — there's
nothing for a real transcript to "grow" on a one- or two-word exclamation.

---

## Files

New (node-server) — **all built**:
- `src/server/features/demo-room/demo-caption-source.ts` — scheduler + publisher.
- `src/server/features/demo-room/demo-room.constants.ts` — `DEFAULT_DEMO_SESSION_UID`, tail-gap, and the pacing constants (`DEMO_WORDS_PER_SECOND`, `DEMO_GAP_WITHIN_TURN_SECONDS`, `DEMO_GAP_BETWEEN_TURNS_SECONDS`, `DEMO_INTERIM_INTERVAL_SECONDS`).
- `src/server/features/demo-room/fixtures/alice-book.utterances.json` — the fixture (Chapters I-VI, dialogue-only, no timing stored).
- `src/server/features/demo-room/fixtures/generate-alice-book.py` — regenerator (prettier the JSON after regenerating).
- `src/server/features/demo-room/fixtures/alice-book.utterances.schema.json` — fixture JSON Schema (referenced by `$schema`).
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

Session Manager — **built** (see Component B):
- Config schema + `demoRoomConfig` getter; `.env.example` (vars documented).
- `DemoRoomSeeder`, a boot-time seeder gated on the flag that idempotently
  inserts the placeholder device, room, and an open-ended `ON_DEMAND` session
  with `uid === DEMO_SESSION_UID` (all three at fixed uids with
  `ON CONFLICT (uid) DO NOTHING`, since the normal create paths DB-generate
  uids), ensures a current join code, and logs it. The device/room fixed-uid
  idempotency was added in the 2026-07-24 rework, fixing a staging incident
  where restarts/racing instances each created their own placeholder
  device+room (only the session insert was originally conflict-safe).

Deployment — **built**:
- `deployment/compose.yml` passes `DEMO_ROOM_ENABLED` (default false) +
  `DEMO_SESSION_UID` to both services; `deployment/.env.example` documents them.
  The repo has a single compose for all environments, so dev/staging enable it
  via their own untracked `.env`; prod never sets it.

---

## Tests

- **Fixture validation (unit):** parses; `turnCount`/`lineCount` match the
  arrays; every turn has a non-empty speaker and non-empty lines; no two
  adjacent turns share a speaker (would mean a turn wasn't merged); Gutenberg
  attribution present. (Checked-in JSON, so it can't rot.)
- **Scheduler (unit, fake clock):** for small fixtures, asserts interim events
  are a strict growing word-prefix of the following final; that `inProgress`
  is null on the final and `final` is null on interims; that a line shorter
  than one interim interval emits no interim (min 1s duration floor at 5
  words/sec skips it); and that the loop wraps back to `t=0`.
- **No speaker leakage (unit):** caption text for any fragment never contains
  a speaker label, regardless of turn changes.
- **Leading-space join safety (unit):** concatenating every final's text
  back-to-back (as the client does, with no separator) across a turn/speaker
  change never merges two words.
- **Integration:** with the flag on, a client socket authed for
  `DEMO_SESSION_UID` receives `transcript` messages and a healthy
  `sessionStatus`, without any source connection or Python service — the demo's
  whole point, asserted.

---

## Risks & limitations

1. **No speaker field on the wire.** Speaker is tracked at schedule-build time
   only and dropped when captions are built - never shown to a viewer.
   Anything wanting structured/visible per-speaker data needs a schema change;
   explicitly out of scope.
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

Source text: *Alice's Adventures in Wonderland* by Lewis Carroll, Chapters
I-VI, **Project Gutenberg eBook #11** — public domain. Attribution is carried
in the fixture's `source` block, in the generator header, and must be
repeated in the `DemoCaptionSource` source file header.
