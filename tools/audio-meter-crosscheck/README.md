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

Agreement is transitive: both meters are pinned to the same numbers, so they are
pinned to each other, and the third leg carries the publisher's number through
to pixels without distortion.

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
