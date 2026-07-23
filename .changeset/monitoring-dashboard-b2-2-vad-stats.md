---
'@scribear/scribear-redis': minor
---

Add the TypeScript mirror for B2.2's per-session VAD (voice-activity-detection)
statistics, folded into the same `scribe:v1:audio:{sessionUid}` snapshot B2.1's
audio-level meter already publishes to - not a second key. Transcription
Service (Python, no changeset) now accumulates `VadStats` per batch in
`WhisperStreamingProviderJob` (speech-active ratio, segment count, mean
segment duration, speech-to-pause ratio, and a VAD-gated SNR estimate) from
the same speech/silence ranges `_detect_speech_ranges` already computes to
decide what to hand Whisper - no new detection logic. `AudioMeter`'s internal
`_dbfs` helper is renamed to the public `dbfs` and exported, since B2.2's SNR
calculation is the second real caller of the RMS->dB conversion. Corrects the
master plan's original framing ("surface which VAD config is active" -
implying a Silero-vs-faster-whisper comparison): that comparison doesn't
exist in the real code, VAD is Silero-only and faster-whisper's own VAD is
explicitly disabled, so this surfaces one boolean (VAD on/off) plus derived
stats when it's on.

`@scribear/scribear-redis` gains `VAD_STATS_SCHEMA`/`VadStats`
(`session-audio-snapshot.schema.ts`) and adds a required `vadStats` field
(nullable value) to `SESSION_AUDIO_SNAPSHOT_SCHEMA`. Every `VadStats` field
but `vadEnabled` is nullable, and deliberately in two distinct ways: VAD off
means the whole reading is not meaningful (everything but `vadEnabled` is
null); VAD on but no speech found in a given batch is a real, meaningful
zero-valued reading (`speechActiveRatio: 0`, `segmentCount: 0`,
`speechToPauseRatio: 0`), except `meanSegmentDurationSec`/`snrDb`, which stay
null even then (undefined - no segment to average, no signal side to compare
against noise).

Same staging as B2.1: this lands the publisher/schema extension only, no
admin-server reader or SPA consumer - wiring a dashboard panel to `vadStats`
is a later, separate change.
