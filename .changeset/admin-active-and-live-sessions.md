---
'@scribear/session-manager-schema': minor
'@scribear/session-manager-client': minor
'@scribear/session-manager': minor
'@scribear/admin-server': minor
'@scribear/admin-webapp': minor
---

Surface active and live sessions in the admin console.

Sessions have no status column — "active" is derived from
`COALESCE(end_override, scheduled_end_time)` — and no admin route read that
derivation, so the console could not show a room's running session, listed no
ON_DEMAND/AUTO rows on the scheduling page, and refused a second on-demand
session with `ANOTHER_SESSION_ACTIVE` while showing nothing that explained the
conflict.

Two read routes now expose the repository queries that already existed:

- `GET /schedule-management/list-sessions?roomUid=&from=&to=` — sessions whose
  effective interval overlaps the range, including the ON_DEMAND and AUTO rows
  that have no parent schedule and so were invisible to list-schedules.
- `GET /schedule-management/get-active-session/:roomUid` — the room's active
  session, or a `null` 200 body so "nothing is running" stays distinct from
  "room not found" (404).

Both are mirrored through the session-manager client and the admin BFF
(`/sessions/list`, `/rooms/:roomUid/active-session`). `listSessionsForRoomInRange`
and `findActiveSession` now return `ROOM_NOT_FOUND`, matching
`listSchedulesForRoom`.

In the console, the room detail page gains an "Active session" card (name,
type, effective start/end, View and End-early actions, the last hidden for the
demo room's permanently-active fixture session), and the scheduling page gains
a Sessions table that polls every 15s while the tab is visible. Its range
widened to the last 7 days so a session that started before page-load still
appears.
