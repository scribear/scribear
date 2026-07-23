---
'@scribear/scribear-redis': minor
---

Add the TypeScript mirror for B2.1's per-session audio-level telemetry
(`scribe:v1:audio:{sessionUid}`) - the first transcription-service-side,
per-session telemetry to use the fleet backplane B1.7 built. Transcription
Service (Python, no changeset) now runs a real-time audio-level meter
(`AudioMeter`, in `whisper_streaming_job.py`) per Whisper streaming session -
RMS dBFS, peak dBFS, clipping percentage, a silence flag, and a noise-floor
estimate over a 10s rolling window - and replaces the previously-dead-code
`RMSSilenceDetection` call site with it. Readings ride `TranscriptionResult`
back across the worker-process boundary the same way `final_chunk_ids`
already does, and a new push-based publisher, `RedisSessionAudioPublisher`
(distinct from the existing host-level, pull-based `RedisTelemetryPublisher`
- there is no live per-session state in the main process to beat against),
writes them to Redis on each transcription result, throttled to at most one
write per session every 2s.

`@scribear/scribear-redis` gains `AUDIO_LEVEL_STATS_SCHEMA` and
`SESSION_AUDIO_SNAPSHOT_SCHEMA` (`session-audio-snapshot.schema.ts`) - the
hand-restated TypeScript mirror of `AudioLevelStats`, necessary because
Python shares no schema package with the Node apps - plus the matching key
builder (`transcriptionSessionAudioKey`) and index key
(`TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY`) in `telemetry-keys.ts`, and the
publish-interval/TTL constants (`AUDIO_STATS_MIN_PUBLISH_INTERVAL_MS`,
`AUDIO_STATS_TTL_MS`) in `telemetry-timing.ts`. The 2s interval is
provisional - it matches node-server's per-session heartbeat cadence as a
starting point, not independently validated for this payload.

This lands the publisher and schema only, per the plan's explicit staging
(§3.5): no admin-server reader, no SPA consumer. Wiring `GET /fleet` and a
dashboard panel to this key family is deliberately a later, separate change,
once the publisher's real shape has had a chance to prove out - the same
staging B1.7's fleet endpoint/`useFleet()` hook split used, and the corrective
this project already learned once from `PLAN-fleet-and-testaudio.md`'s stale
draft reader.

`transcriptionHost` is a required field, not nullable: `RedisSessionAudioPublisher`
is constructed with the same `transcription_host_id` `RedisTelemetryPublisher`
already reports (`create_webserver.py` has it in scope at both construction
sites), so every publish stamps a real value - there is no case where a
session-audio snapshot exists without one, unlike `roomUid`.
