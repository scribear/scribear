---
'@scribear/admin-webapp': minor
---

Add `adminApi.fleet()` and the `useFleet()` hook
(`src/features/dashboard/use-fleet.ts`), the SPA's first consumer of
`GET /api/admin/v1/fleet` and `/fleet/stream` (B1.7 §2.5,
`PLAN-fleet-and-testaudio.md` §B).

The hook seeds from a `fleet()` snapshot, then layers `/fleet/stream` deltas
on top. The stream carries no initial state and never re-seeds itself — every
frame is a plain default SSE `message`, not a named `snapshot`/`delta` pair —
so a (re)connect re-fetches `/fleet` explicitly on the `EventSource`'s `open`
event; that is what makes a dropped connection self-heal instead of quietly
serving a stale snapshot forever.

`FleetSnapshot` and its nested types (`NodeSnapshot`, `SessionSnapshot`,
`TranscriptionHostSnapshot`, `ProviderHealth`, `MergedProvider`,
`SessionStatusEvent`) are restated in `admin-api.ts` rather than imported from
`@scribear/scribear-redis`: that package depends on `ioredis` and has no
browser-safe entry point, so importing it would pull a Node Redis client into
this bundle. Kept in step by eye, the same way transcription-service's Python
side already restates the same TypeScript contract.

Because a session delta carries only two connectivity booleans, not a full
session record, live deltas are exposed as their own `sessionEvents` map
(keyed by `sessionUid`) rather than spliced into `snapshot.sessions` — a
consumer joins the two by `sessionUid` rather than the hook guessing at a
merge.

No UI consumes this yet — the room grid / provider row (plan §B.4) is
follow-up work.
