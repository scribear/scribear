---
'@scribear/monitoring-sidecar': minor
---

Stop disconnecting saturated sessions with "Client sent audio too quickly", and
stop blaming the client for the service's own stall (§3 T2).

**The check never measured what it was named after.** `_decode_audio` raised
`TranscriptionClientError("Client sent audio too quickly.")` whenever
`NPCircularBuffer.append` returned a non-empty tail. There is no clock anywhere
in that function: `extra` is non-empty iff **one** `append` call carries more
samples than the buffer's free space, i.e. iff a single execution batch exceeds
~30 s of audio (the buffer is `2 × max_buffer_len_sec` and force-finalization
purges back down to `max_buffer_len_sec` after every pass, so free space at the
start of a pass is always at least that). A batch is everything that arrived
since the single worker last cycled back to that job under round-robin EDF, so
its size is `client_rate × scheduling_gap` — and the gap is entirely
service-controlled.

A correctly paced client therefore trips this precisely when the *service*
stalls. That is the documented CPU cliff, exactly: 1 session, gap 2.4 s,
survives; 3 sessions, gap 23.0 s, degrades but survives; 6 sessions, gap 45.9 s,
crosses the 30 s line and all six die with zero transcripts — the client's rate
identical in all three. Reaching it on rate alone needs roughly 6x realtime on
CPU and 60x on GPU, which is why the test-audio `speedup` knob measured +0 at
3.0x on a GPU.

**Why the failure was total rather than partial**, and why the fix is "do not
raise" rather than "close more accurately": any job exception permanently kills
the transcription job in `worker_process_manager.py`, independently of and prior
to the socket close in `transcription_stream_controller.py`. There was no
variant of raising that left the session alive. The overrun is now dropped and
counted, in both the whisper-streaming and lumen-granite decode paths (they
share the counter, so they could not diverge on what it means).

**A latent accounting bug had to be fixed in the same change**, because this is
what makes it live. Both providers incremented `_total_decoded_samples`,
`AUDIO_SECONDS_DECODED` and the cumulative `asr_input` stage reading by the
**full** batch, including the samples `append` had just rejected. That was
harmless only because the session died on the spot. The moment sessions survive
an overflow, charging the timeline for audio that never entered the buffer
shifts every subsequent word timestamp by the dropped duration, permanently and
cumulatively. All three now count retained samples only, and the chunk ledger
records the retained span. This is also what finally makes
`audio_stages.py`'s ingress→asr_input gap measure the overflow its comment
always claimed it measured — before the fix that gap was pinned at zero.

**Renamed end to end**, since the old name asserted a cause the metric cannot
observe: `AUDIO_TOO_FAST` / `audio_too_fast_total` →
`audio_dropped_buffer_full`, with a companion
`audio_dropped_buffer_full_seconds` because the event count alone never said how
much audio was lost — the same count/seconds pairing `buffer_overflow` already
has. The chain is Python enum → Python registry →
`GET /metrics/status` (`audioDroppedBufferFullTotal`,
`audioDroppedBufferFullSecondsTotal`) → sidecar schema → sidecar registry
(`scribear_asr_audio_dropped_buffer_full_total`,
`scribear_asr_audio_dropped_buffer_full_seconds_total`). Both new body fields
are **optional**, for the reason the strictness rule already allows and
`asrDroppedPeriodsTotal` already uses: during a rolling upgrade the sidecar polls
a service that still sends the old name, and requiring the new one would turn
every transcription metric into a `malformed` poll. Unlike dropped periods this
needs no support gauge — nothing falls back to a different signal, so "not
reported" and "zero" call for the same behaviour.

**The alert was wrong in all three of its dimensions**, not just its wording.
`asr-audio-too-fast` was CRITICAL, on `PipelineStage.UPLINK`, advising the
operator to "check for a misbehaving or replaying client". It is now
`asr-audio-dropped-buffer-full`, **WARNING**, on **TRANSCRIPTION**:

- **Stage**, because it fires on our own scheduling gap and used to send the
  operator after the one component that was behaving correctly.
- **Severity**, because it no longer disconnects anyone. What remains is
  degradation of the same kind as the force-finalize case beside it in the same
  rule, and the T1 saturation rules already own the CRITICAL for the cause.
- **Threshold stays 0**, deliberately, rather than gaining a tolerance knob:
  unlike force-finalized audio — which is still transcribed, just cut early —
  dropped audio produces no captions at all, so a healthy deployment reads zero
  and any non-zero window deserves a card. The summary now leads with the
  seconds lost rather than a count of sessions "rejected".

Raising the cliff itself — bounded-tail transcription, so an oversized batch
becomes transcribable rather than merely survivable — is deliberately out of
scope and stays tracked in `NEXTSTEPS-CPU-Whisper.md` §4.
