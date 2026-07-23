---
'@scribear/admin-webapp': minor
---

Add the "Live fleet" panel to the dashboard (`fleet-panel.tsx`,
`fleet-status.ts`), the first UI consumer of `useFleet()` — plan §B.4's
provider row + filterable status grid.

`SessionSnapshot` carries no `roomUid` — node-server's telemetry is
per-session, not per-room, and a session has no durable link back to the room
that opened it. `PLAN-fleet-and-testaudio.md` §B.4's `RoomTelemetry` /
`roomUid` grouping predates the real B1.7 schema and doesn't exist on the
wire, so the grid is session-centric (one card per `sessionUid`) instead.

No writer publishes a canonical per-session status, so `deriveSessionStatus`
computes one from `upstreamState` (`OPEN` → good, `WAITING_RETRY` /
`CONNECTING` / `HANDSHAKING` → warn, `CLOSED` → crit, `IDLE` → idle), refined
by the live `/fleet/stream` connectivity event when one has arrived for that
session — it's more current than what's baked into the last `/fleet`
snapshot.

Filter/sort is client-side over the already-fetched snapshot (status chips,
provider select, text search on `sessionUid`), matching plan §B.3's
`useFilteredRooms` shape but adapted to sessions. Status chip counts are
computed from the unfiltered set so they keep reflecting the whole fleet while
a status filter narrows the grid under them.

No virtualization yet (plan §B.4 flags it for >100 cards) — skipped for now
since nothing currently produces fleet sizes anywhere near that; add it if a
real deployment gets there rather than guessing at the threshold.

Not covered by a test: admin-webapp still has no vitest config / tests/ dir
(same gap `d4fb740` noted).
