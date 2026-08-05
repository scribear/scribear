# @scribear/test-audio-source

## 0.3.0

### Patch Changes

- 399c9c9: Count both rails in `clippedFraction`, and cover the DSP and fault engines with
  tests that measure the signal.

  **The bug.** `clippedFraction` asked `sample >= INT16_MAX || sample <= INT16_MIN`,
  which reads as "either rail" and is not. int16 is asymmetric — it runs from
  -32768 to +32767 — while `hardClipToRail` scales by `INT16_MAX / pivot`, so a
  saturated _negative_ peak lands on **-32767** and only reaches -32768 once it is a
  further 1/32767 past the pivot. The comparison against `INT16_MIN` therefore
  skipped nearly every negative clip. On a tone the undercount was small enough to
  look like rounding (0.10 reported against 0.105 actual at `clipPct: 10`); on a
  square wave, where every sample saturates, it reported **0.5 instead of 1.0**.

  That matters because the function's whole job is to predict a number the operator
  will read back off the stack: the transcription service's ingress meter counts
  `|x| >= 0.99` in runs of at least two (`audio_meter.py`, `CLIP_THRESHOLD` /
  `CLIP_MIN_RUN`), under which -32767 is emphatically clipped. A `clipPct` knob
  whose local measurement disagrees with the meter by up to a factor of two is a
  knob that cannot be calibrated. Now a magnitude comparison, which is what "either
  rail" meant all along. No production caller existed yet — the function is exported
  but consumed only from this library's own tests — so nothing downstream moves.

  **A load-bearing comment that said the opposite of what the code does.**
  `applyDcOffset` justified running after clipping with "clipping a biased waveform
  would push the offset back toward zero ... and the knob would silently do less
  than it says". Measured on a half-scale tone at `clipPct: 50`, a requested bias of
  0.25 comes out at **0.18 in the implemented order** and **0.36 in the other** — the
  knob does less than it says in exactly the order the comment defends, and more in
  the one it warns against. The cause is that `hardClipToRail` is a _gain_ rather
  than a ceiling, so a bias applied before it is amplified along with the signal.

  The order is unchanged (erring downward is the better failure for the knob with no
  telemetry behind it) but the docstring now states the real trade-off, including
  the consequence an operator will actually hit: stacking `dcOffset` on `clipPct`
  lifts every negative-rail sample off the rail, so the clipped share the meter
  reports reads _below_ the `clipPct` that was set — at `clipPct: 90` with
  `dcOffset: 0.25`, about 0.47. `FaultEngine.plan`'s ordering comment, which
  repeated the same false rationale, says the same thing.

  **Tests.** 110 unit tests across `pcm`, `rng`, `params`, `effects`, `good-engine`,
  `faults` and `test-audio-stream`, all asserting properties of the output buffer
  rather than that a function was called: gain exact in dB and saturating (checked by
  counting sign flips, which is the wraparound signature); every one of the five
  noise floors within 0.05 dB; brown separated from white by first-difference energy
  ratio, ~2.0 against ~0.01, which is the spectral centroid in a form that needs no
  window or bin bookkeeping; clipping monotone in the knob; DC exact and saturating;
  silence all-zero. The fault knobs are asserted at both ends of every probability —
  0 alters nothing byte-for-byte and draws nothing from the RNG, 100 alters every
  frame — against the real `decodeAudioFrame` for corruption (CRC failure, magic
  intact) and the real `decodeWav` for the bad header. `speedup` is proved to change
  the schedule and nothing else by streaming a run twice under fake timers and
  comparing payloads frame for frame.
