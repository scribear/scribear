---
'@scribear/transcription-service-schema': minor
'@scribear/node-server-schema': minor
'@scribear/node-server': minor
'@scribear/admin-webapp': minor
---

Thread opaque, nullable `sessionUid`/`roomUid` from Node Server through to
Transcription Service (Part 1 of the monitoring dashboard plan; Part 2 -
actually using them there - is deliberately deferred).

`TRANSCRIPTION_STREAM_SCHEMA`'s `CONFIG` client message gains snake_case
`session_uid`/`room_uid`, matching the wire protocol's existing casing and
the file's own `final_chunk_ids`/`in_progress_chunk_ids` tolerance pattern:
`Type.Optional(Type.Union([Type.String(), Type.Null()]))`, so a
Transcription Service that predates these fields still validates the
message. `TranscriptionOrchestratorService._openSession` sends both, sourced
from the session it already reads (`sessionUid` is its own parameter,
`roomUid` from `Session.roomUid`).

Separately, but for the same reason, Node Server's own outbound `/fleet`
telemetry (`STATUS_SESSION_SCHEMA`, composed by `@scribear/scribear-redis`'s
`SESSION_SNAPSHOT_SCHEMA` - unmodified here, since composition picks the
field up automatically) gains a camelCase `roomUid: string | null`
(optional, so an older Node Server's snapshot still validates), populated
from the same `Session.roomUid` the orchestrator already tracks per open
session.

`admin-webapp` restates the Redis snapshot shape by hand (to keep `ioredis`
out of the browser bundle) and gains the matching `roomUid` field. The fleet
panel's session card now shows the room uid (or "no room"), and the
session-search filter matches against it as well as `sessionUid` - the
actual point of the change, letting an operator find a room by name-ish
identifier instead of only by opaque session uid.

Transcription Service's Python side stores `session_uid`/`room_uid` on the
session/job object for every provider (`WhisperStreamingProvider`,
`DebugProvider`, `LumenGraniteProvider`) but does nothing else with them
yet - no logging, no metrics, no `/providers/health` change. That
service has no `package.json`/changelog, so it isn't listed above.
