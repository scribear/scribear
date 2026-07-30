# Audio meter cross-check fixtures

`archived-plans/2026-07-24-04-PLAN-AUDIOVIZ.md` §9 asks for one gate above
all others:

> drive a session with a known WAV through a real stack and confirm the
> dashboard's dBFS agrees with the standalone meter fed the same file to within a
> stated tolerance. That cross-check between the two surfaces is the single most
> valuable integration test here, because it validates the whole chain from
> `AudioMeter` to pixels.

Two independent implementations compute the numbers an operator reads:

| Surface | Implementation | Language |
|---|---|---|
| Admin dashboard audio strip / session detail | `transcription_service/src/shared/utils/audio_meter/audio_meter.py` | Python |
| Standalone meter page | `<script id="meter-dsp">` in `libs/audio-meter-page/audio-meter.html` | JavaScript |

Both had their own ±0.5 dB tone gates, written independently, against different
fixtures — so nothing established that the two surfaces agree *with each other*.
An operator comparing the dashboard against the standalone meter on the same
room is doing exactly that comparison, and it is the whole point of D4 ("one
instrument, not two dialects").

## How the gate works

`fixtures.json` is the single expectation table, consumed by four suites:

| Leg | Suite | Asserts |
|---|---|---|
| Publisher | `transcription_service/tests/unit/shared/utils/audio_meter/audio_meter_crosscheck_test.py` | the Python meter reads each fixture within `toleranceDb` |
| Standalone page | `apps/monitoring-sidecar/tests/unit/audio-meter-crosscheck.test.ts` | the shipped page's DSP reads each fixture within `toleranceDb` |
| Render path | `apps/admin-webapp/tests/features/dashboard/audio-render-fidelity.test.tsx` | a given dBFS reaches the screen unchanged, is taken from the stage the contract names, and lands in the status the thresholds define |
| Live stack | `transcription_service/tests/integration/transcription_stream/live_stack_crosscheck_test.py` | the WAV excerpt, streamed over a real websocket as SAFP frames into a real webserver, reads as the manifest says in the snapshot that lands in a real Redis |
| node-server hop | `apps/node-server/tests/integration/features/telemetry/audio-crosscheck.test.ts` | the same excerpt, streamed **through node-server** from a source device, reads as the manifest says — and the snapshot is keyed and stamped with the uids node-server forwarded |

A fourth suite, `apps/admin-server/tests/unit/shared/mirrored-constants.test.ts`,
guards the values `admin-webapp` restates by hand across the browser boundary
(it cannot import `@scribear/scribear-redis`, and has no node types on purpose).

Agreement is transitive: both meters are pinned to the same numbers, so they are
pinned to each other, and the third leg carries the publisher's number through
to pixels without distortion.

## The render leg after the stage graph (§12)

`SessionAudioSnapshot` no longer carries one reading. It carries a graph of
measurement points (`stages[]`, each with its own `levels`, `vad` and cumulative
`audioSeconds`), and the dashboard renders the **headline stage** — the
lowest-depth stage that reports levels, because that is the measurement closest
to the source and therefore the one that answers "is the room's audio reaching
us" (`archived-plans/2026-07-24-04-PLAN-AUDIOVIZ.md` §12.6).

Carrying a number faithfully is therefore no longer sufficient: the render path
also has to pick the right one out of several. So the render leg now asserts, in
addition to what it asserted before, that a manifest figure placed at `ingress`
is the figure that reaches the screen **while a deliberately different figure
sits at `asr_input`**. Without that, a regression that read the deepest stage
instead of the shallowest would pass every assertion in this gate — the number on
screen would be a real published number, just the wrong one, and an operator
comparing the dashboard against the standalone meter on the same room would see a
mismatch with no way to tell which surface was wrong.

**`fixtures.json` is unchanged by the reshape, deliberately.** Its field names
(`expected.rmsDbfs`, `expected.clippingPct`, …) are the *fixture table's*
vocabulary for expected DSP values, not the Redis payload's field names, and the
two were never the same thing. Renaming them to follow the payload would break
the publisher and standalone-page legs — which read this file directly and know
nothing about stages — for no gain. The table describes a sample sequence and
what any correct meter must read from it; where in a pipeline that meter sits is
not its business.

One consequence worth stating plainly: because the manifest has no notion of
stages, this gate pins *that the headline choice is made correctly*, not *which
Python measurement point published the number*. A publisher that labelled its
`asr_input` reading `ingress` would satisfy all three legs.

## A divergence this gate found and closed

The first run of this gate found that the two implementations reported
**contradictory clipping for identical audio**:

| | Clean full-scale 1 kHz sine | Hard-clipped sine |
|---|---|---|
| Publisher, before | **12.5 %** — a red "clipping" chip | ~63 % |
| Standalone page | 0 % | ~63 % |

The publisher counted any sample within `CLIP_EPSILON` (1e-4) of full scale, with
no run-length requirement. The page counted only samples at or above `0.99` that
belong to a run of at least 2. At 16 kHz a 1 kHz sine reaches 1.0 at one isolated
sample per crest — its neighbours sit at 0.92 — so the publisher charged 2 samples
in every 16 as clipped, which is 12.5 %, well past the dashboard's 1 % crit
threshold. **Undistorted audio produced a red clipping chip.**

The publisher now uses the page's rule, and the same constants:

```python
CLIP_THRESHOLD = 0.99   # == the page's clipThreshold
CLIP_MIN_RUN = 2        # == the page's clipMinRun
```

The run requirement is the load-bearing part: clipping is a *flat run* at the
rail, and a waveform that merely touches full scale is not clipped. Both now
report 0 % on the clean sine and 62.5 % on a hard-limited one, agreeing to the
digit. The `limitedTones` fixtures pin the positive case and both sides of the
threshold, because a rule that only stops false alarms would be just as wrong as
one that only catches them.

This was a producer change, which
`archived-plans/2026-07-24-04-PLAN-AUDIOVIZ.md` §11 put out of scope. It was
brought into scope deliberately once the gate showed the dashboard was lying
about real rooms.

**Neither meter is the oracle.** The expectations are arithmetic:
`20·log₁₀(√mean(x²))` over the exact sample sequence each fixture defines. For
the WAV that is the decoded `int16 / 32768` samples; for the tones it is
`A·sin(2πfi/fs)` with `A = 10^(dBFS/20)·√2`, which both languages generate
bit-comparably. So a failure means a meter is wrong, not that it disagrees with
its counterpart's opinion.

## What this does *not* cover

The plan asked for a **live stack**: a real session, driven over the wire,
observed in a browser. The live-stack leg now covers the wire as far as Redis —
`encode_audio_frame`/`decode_audio_frame`, the per-chunk decode, the ingress
meter's wiring, stage-graph assembly and the publisher's payload — so a transport
regression between the meter and the published snapshot no longer passes.

It runs on the **debug** provider, which loads no model. That is only possible
because §12 moved metering above the provider; before that a live-stack test
needed a real Whisper, which is why this leg did not exist.

**node-server's hop is now covered too**, by the fifth leg. It runs in
node-server's own integration suite — the only setup that already has both a
real node-server and the shipped Transcription Service image on one network —
and streams the same excerpt from a source device *through* node-server. What
only it can catch: the SAFP frame surviving node-server's decode-and-forward,
and the session/room uids the snapshot is keyed and stamped with, which come
from node-server's CONFIG message and are exactly what `/fleet` joins audio to
sessions on. A node-server forwarding perfect audio under the wrong uid
publishes a snapshot no dashboard can attribute, and no levels-only assertion
would notice — so identity is asserted separately from levels.

Two properties of that leg are worth knowing before editing it:

- **It streams at the real chunk rate, and that is load-bearing.** node-server
  forwards through a `WebSocketClient` that sheds frames once the socket has
  more than 64 KiB buffered, and each 100 ms chunk of 16 kHz PCM16 is ~3.2 KiB.
  The first version streamed in a tight loop and 4.2 s of 20 s arrived: it was
  measuring the backpressure policy, not the meter. A kiosk sends ten chunks a
  second and never builds a buffer, so the test does too.
- **It fails loudly against a stale image.** Before §12 the publisher
  early-returned on `audio_stats is None`, which is always None for `debug`, so
  an image built before the stage graph publishes host telemetry happily and no
  audio telemetry at all. Passing `SCRIBEAR_TRANSCRIPTION_SERVICE_IMAGE=<old>`
  therefore looks like a broken test rather than a stale image, so the leg
  checks for the host key and says which it is.

One hop is left: **a real browser**. `FleetTelemetryService`'s read is covered
separately by admin-server's integration suite against its own real Redis, and
the payload's shape is now pinned across the language boundary by
`tools/telemetry-snapshot-crosscheck/`.

One weakness of the live-stack leg is worth stating, because it was found by
mutation rather than by reasoning: **the speech excerpt cannot detect the meter
being fed a subset of each chunk.** Speech is near enough stationary across
100 ms that halving every chunk moves its RMS and peak by well under
`toleranceDb`, and that mutation passed every assertion the excerpt drives. The
leg therefore carries a second signal whose amplitude alternates *within* the
chunk (`test_every_sample_reaches_the_ingress_meter`), where the same mutation
shifts RMS by ~3 dB. The excerpt pins the values; that signal pins completeness.
Keep both.

The stage graph adds four more things this gate does not cover, all of them real
and none of them expressible against a table of expected DSP values:

- **Depth resolution.** `depth = max(depth(inputs)) + 1`, its dropped-input rule
  and its cycle guard are computed at publish time in Python
  (`audio_stage_graph.py`) and covered by that module's own unit tests. Nothing
  here can see them.
- **Which stage a reading was taken at.** As above: a mislabelled stage id passes.
- **Signal loss.** The per-edge `audioSeconds` comparison and its tolerance are
  pure consumer derivations over counters that no fixture defines, so they are
  pinned by `apps/admin-webapp/tests/features/dashboard/fleet-status.test.ts`
  rather than by this manifest. Putting invented second-counts in `fixtures.json`
  would look like a cross-check while comparing nothing to nothing.
- **Payload validation.** Whether a reshaped field is rejected at the reader (as
  `session-audio-snapshot.schema.ts` claims) or silently renders as `undefined` is
  the reader's business, and the mirrors here are hand-written on purpose.

Closing the browser hop needs a compose-level harness that scrapes the rendered
dashboard. It remains tracked as outstanding in
`archived-plans/2026-07-24-04-NEXTSTEPS-AUDIOVIZ.md`, and the render leg is
already unit covered, which is why the browser was judged the least
valuable rung.

## Running the live-stack leg

It is gated on `REDIS_URL`, the same way the other Redis-backed integration
suites are, and skips when unset:

```
docker run -d --name xcheck-redis -p 6399:6379 redis:8-alpine
cd transcription_service
REDIS_URL=redis://127.0.0.1:6399 .venv/bin/python -m pytest \
  tests/integration/transcription_stream/live_stack_crosscheck_test.py
```

It needs no model and no GPU. Note the publisher throttles to one write per
session per `AUDIO_STATS_MIN_PUBLISH_INTERVAL_MS`, so the suite streams the
excerpt, waits out the throttle, then streams it again: because the metering
window is exactly the excerpt's length, any window over a looped excerpt is a
rotation of it, so RMS and peak are unchanged and the manifest's arithmetic still
applies. Noise floor is deliberately not asserted — it is a percentile over 1 s
sub-windows, whose boundaries a rotation does move.

## Running the node-server hop

It needs no flags — it is part of node-server's integration suite, which already
spins the containers it depends on:

```
npm run test:integration --workspace apps/node-server
```

It does need a Transcription Service image built **from this tree**. The suite
builds one from `transcription_service/Dockerfile_CPU` by default; if you set
`SCRIBEAR_TRANSCRIPTION_SERVICE_IMAGE` to reuse a prebuilt one, make sure it
post-dates the §12 stage graph (it should contain
`src/webserver/features/telemetry/session_audio_tracker.py`). The leg says so in
its failure message rather than leaving you with a bare timeout.

It streams in real time, so the three tests take ~40 s together. Like the
Python leg it needs no model and no GPU.

## Editing the fixtures

Expectations are derived quantities, so do not hand-tune them to make a suite
pass — recompute them from the sample definition. For the WAV excerpt:

```python
import numpy as np, wave
w = wave.open('test_audio_files/speech/harvard_16k_mono.wav')
x = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype(np.float64) / 32768.0
seg = x[:160_000]
print(20 * np.log10(np.sqrt(np.mean(seg**2))), 20 * np.log10(np.max(np.abs(seg))))
```

`toleranceDb` is ±0.5 dB, matching the tolerance both suites already used. It is
deliberately one value in one place: a gate whose tolerance can be loosened per
assertion is not a gate.

`clippingPct` is compared exactly rather than within a tolerance — it is a
counted fraction of samples, not a measurement, so the two implementations should
agree to the digit. `limitedTones[].expected.clippingPct` therefore also encodes
the sample-rate and frequency it was measured at; changing those changes the
answer.
