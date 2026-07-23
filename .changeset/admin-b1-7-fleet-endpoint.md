---
'@scribear/scribear-redis': minor
'@scribear/admin-server': minor
---

Add `GET /api/admin/v1/fleet` (B1.7 part 2, fourth of four PRs).

The first reader of the backplane 2a defined and 2b/2c write to: every live
Node Server instance and session, every live Transcription Service host, and
providers merged across the hosts serving them, in one Redis round-trip group
independent of fleet size. No fan-out to instances.

A provider's merged status is `down` only when every host serving it is
`down` — a single host's `down` is a capacity loss, not an outage, per the
key contract's own doc comment — and `ok` only when every host is. `activeSessions`
sums across hosts; per-host detail (model, workers, reachability) is kept
verbatim under `hosts` rather than reduced to a summary, since nothing
consuming this yet has said what it needs.

Requires an authed session, like every other admin route exposing
infrastructure state. Answers 503 `TELEMETRY_UNAVAILABLE` when `REDIS_URL` is
unset and 503 `TELEMETRY_DEGRADED` on a read failure — never 200 with an
empty result, which would be indistinguishable from a fleet that is
genuinely idle. This is a separate, always-optional data path from the
existing `/health` rollup, which is unaffected.

`scribear-redis` gains `Static` type exports (`ProviderHealth`,
`TranscriptionWorker`, `TranscriptionHostSnapshot`) for the transcription-host
snapshot schemas — this is the first consumer that needs to type a parsed
value rather than just the schema.

New env: `REDIS_URL` (admin-server), unset by default.
