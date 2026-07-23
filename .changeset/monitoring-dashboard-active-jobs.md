---
'@scribear/scribear-redis': minor
'@scribear/admin-webapp': minor
---

Surface, on `GET /providers/health` (and therefore the fleet backplane), which
session/room a Transcription Service worker is actively processing - not just
the aggregate `liveJobCount`/`contextIds` it already reported. Part 2 of the
monitoring dashboard plan's session/room correlation work; Part 1 landed
`sessionUid`/`roomUid` on the wire into Transcription Service but left them
unused there.

Transcription Service (Python, no changeset - no `package.json`) now tracks,
per worker process, which job is running for which caller-supplied
`session_uid`/`room_uid` (`WorkerProcessManager.register_job` gained two
optional params, threaded through `WorkerPool.register_job` and all three
providers' `register_job` call sites, which already had both in scope from
Part 1). `serialize_worker` - the one join point shared by `/metrics/status`
and `/providers/health` - reports it as a new `activeJobs: { jobId, sessionUid,
roomUid }[]` field per worker. Both are `null` when the caller supplied
neither, matching every other nullable field on this endpoint.

The Redis telemetry publisher needed no change: it spreads
`ProviderHealthSnapshotService.snapshot()`'s dict (which already calls
`serialize_worker`) verbatim into the published record, so `activeJobs`
reaches the backplane for free. Same for `admin-server`'s `/fleet` reader -
`FleetTelemetryService` returns `TranscriptionHostSnapshot[]` (workers
included) unreduced, so no admin-server code changed.

`@scribear/scribear-redis`'s `TRANSCRIPTION_WORKER_SCHEMA` (the hand-restated
TypeScript mirror of `serialize_worker`'s shape, necessary because Python
shares no schema package with the Node apps) gains the matching `activeJobs`
field, via a new named `ACTIVE_JOB_SCHEMA`. `@scribear/admin-webapp`'s
`TranscriptionWorker` interface - its own hand-restated mirror, needed because
the browser bundle can't pull in `@scribear/scribear-redis` (it needs
`ioredis`) - gains the matching field too, for the same reason `hosts` landed
in `/fleet` in an earlier change with no consumer yet: nothing in
`fleet-panel.tsx` renders per-worker/per-job detail today, and this is
plumbing only, not a UI change. Verified `apps/monitoring-sidecar`'s hand-
restated `/metrics/status` schema (used only for Prometheus emission, a
different consumer) tolerates the new field with no change and no test
regression, since its `Value.Check` does not reject unknown properties.
