# Audio meter cross-check fixtures

`PLAN-AUDIOVIZ.md` §9 asks for one gate above all others:

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

`fixtures.json` is the single expectation table, consumed by three suites:

| Leg | Suite | Asserts |
|---|---|---|
| Publisher | `transcription_service/tests/unit/shared/utils/audio_meter/audio_meter_crosscheck_test.py` | the Python meter reads each fixture within `toleranceDb` |
| Standalone page | `apps/monitoring-sidecar/tests/unit/audio-meter-crosscheck.test.ts` | the shipped page's DSP reads each fixture within `toleranceDb` |
| Render path | `apps/admin-webapp/tests/features/dashboard/audio-render-fidelity.test.tsx` | a given dBFS reaches the screen unchanged, and lands in the status the thresholds define |

A fourth suite, `apps/admin-server/tests/unit/shared/mirrored-constants.test.ts`,
guards the values `admin-webapp` restates by hand across the browser boundary
(it cannot import `@scribear/scribear-redis`, and has no node types on purpose).

Agreement is transitive: both meters are pinned to the same numbers, so they are
pinned to each other, and the third leg carries the publisher's number through
to pixels without distortion.

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
digit. The `clippedTones` fixture pins the positive case, because a rule that
only stops false alarms would be just as wrong as one that only catches them.

This was a producer change, which `PLAN-AUDIOVIZ.md` §11 put out of scope. It was
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
observed in a browser. This gate stops at the two DSP implementations and the
render path — it does not exercise the audio decoder, the frame protocol, the
Redis publisher, `FleetTelemetryService`, or a real browser. A regression in the
transport between `AudioMeter` and the dashboard would pass all three legs.

Closing that last gap needs a compose-level harness that streams a WAV into a
live session and scrapes the rendered dashboard; the monitoring sidecar's
synthetic canary (`CANARY_AUDIO_PATH`) already streams these same files into a
live session and is the natural place to build on. Tracked as outstanding in
`NEXTSTEPS-AUDIOVIZ.md`.

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
agree to the digit. `clippedTones[].expected.clippingPct` therefore also encodes
the sample-rate and frequency it was measured at; changing those changes the
answer.
