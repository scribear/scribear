---
'@scribear/admin-webapp': patch
---

Admin console — **Test audio**: the fault knobs' captions are now measurements
rather than predictions, and four of them said the wrong thing.

`PLAN-TestAudioDevices.md` §2.2 was a table of guesses about what each fault
knob would show up as, written from the code, with the plan itself insisting it
must not be taken on faith. This page rendered those guesses to an operator as
fact. The table has now been turned against a live GPU stack — one device at a
time, 120 s per knob, against a clean baseline on the same stack — and the
captions rewritten from what actually fired. Every number in them comes from a
recorded run (`MEASURED-TestAudio-Faults.md`).

What changed, and what an operator was being told wrongly:

- **Send-rate multiple.** The caption promised
  `scribear_asr_audio_too_fast_total` and the `asr-audio-too-fast` CRITICAL, and
  warned that the run would end in a 1007 disconnect. On a GPU it trips nothing,
  at 2.0× _or_ at the knob's maximum of 3.0× — both ran the full two minutes and
  produced captions to the last frame with the counter flat at zero. The
  rejection fires on buffer _overflow_, so the knob measures the transcription
  service's spare headroom, not the send rate.
- **Wrong-sample-rate WAV header.** Described as a "decode rejection". No decode
  counter moves anywhere: the mismatch closes the upstream socket 1007, node-
  server reconnects, and the next bad frame kills it again — 8 reconnects in
  120 s, the `upstream-churn` CRITICAL, and **zero captions for the whole run**.
  It takes the session out rather than dropping a frame, which the caption now
  says.
- **Repeated frames (stutter).** Moves nothing measurable at all — every counter
  flat and the transcript count equal to baseline. The caption now reports that
  measured absence instead of pointing at `canary-repetition`, which scores the
  monitoring canary's own run in its own room and this device cannot reach.
- **Dropped frames.** Halves the audio as claimed, but does _not_ move VAD
  no-speech: a dropped frame is absent, not silent. The observable is the noise
  floor rising and SNR collapsing.

The five that were right now carry the number they produce — clipping reads back
the knob to four decimal places, corruption moves node-server's decode-drop
counter by exactly the frames corrupted — and three alerts nobody predicted are
named against the knobs that fire them (`asr-falling-behind` under anything that
removes or distorts audio, `asr-buffer-overflow` under silence, `upstream-churn`
under a bad header).

The card's banner no longer tells the operator these are unverified predictions,
because they are not.
