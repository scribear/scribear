# Admin scheduling/session regression checks

Drives a real headless Chromium against a running stack's admin console
(`/admin/`) and pins the behaviours around the room scheduling / session
interface that were found broken or missing. It is a regression scaffold: each
check names the bug it pins, so a fix that changes the behaviour fails loudly
here and the test is updated alongside it.

Unlike `tools/e2e-audio`, this drives the **admin console** (not the kiosk) and
authenticates through its real login flow, then provisions a throwaway device +
room through the admin BFF API before exercising the scheduling UI.

## Why

The scheduling/session review turned up six issues that are invisible to the
existing test suites — three of them ("active session not shown", "on-demand
not on the calendar", "already running with none visible") are operator-facing
and only reproduce against the running SPA. This tool exists so a regression on
any of them is caught before it ships, and so the fix is forced to update the
assertion that captured it.

The companion code change (this commit) fixes five of the six; the sixth
(`SCHEDULE_BEYOND_90_DAY_WINDOW_INVISIBLE`) is documented as an accepted
limitation. The expected baseline after the fix is **5/6 passing**.

## Run

```bash
# Needs the stack up (deployment/compose.yml) and a root `npm install`
# for puppeteer-core + Chrome on PATH (or CHROME_PATH set).
npm run e2e:admin
```

```bash
node tools/admin-scheduling-e2e/admin-scheduling-e2e.mjs \
  --base-url https://localhost \
  --username engrit --password 'engrit-dev-pass-0123' \
  --json            # machine-readable result
  --keep-room       # leave the provisioned room for inspection
```

Credentials default from `deployment/.env` (`ADMIN_LOCAL_CREDENTIALS`); flags
override. Exits non-zero on any failing check.

## What it checks

Each check is named for the **desired** behaviour, so it fails while the bug is
present and passes once fixed.

| Bug | Desired behaviour (passes when fixed) |
| --- | --- |
| `NO_ACTIVE_SESSION_IN_ROOM_VIEW` | The room detail page shows the room's current/active session. |
| `ON_DEMAND_SESSION_NOT_ON_SCHEDULING_PAGE` | The scheduling page lists live on-demand sessions, not just schedule/window definitions. |
| `ALREADY_RUNNING_WITH_NONE_VISIBLE` | When a new on-demand session is blocked by an active one, the page surfaces the blocking session. |
| `NO_ADMIN_SESSION_LIST_ENDPOINT` | An admin BFF route lists sessions / returns a room's active session. |
| `SCHEDULE_BEYOND_90_DAY_WINDOW_INVISIBLE` | A schedule starting >90 days out is not silently clipped from the listing. |
| `NO_AUTO_REFRESH` | The scheduling page reflects server-side session/schedule changes without a manual reload. |

### Current state (after the fix in this commit)

| Bug | Status | Notes |
| --- | --- | --- |
| `NO_ACTIVE_SESSION_IN_ROOM_VIEW` | PASS | Room detail page renders an "Active session" card. |
| `ON_DEMAND_SESSION_NOT_ON_SCHEDULING_PAGE` | PASS | New "Sessions" table lists live rows. |
| `ALREADY_RUNNING_WITH_NONE_VISIBLE` | PASS | The blocking session is visible in the sessions table. |
| `NO_ADMIN_SESSION_LIST_ENDPOINT` | PASS | `GET /sessions/list` and `GET /sessions/active/:roomUid` exist. |
| `SCHEDULE_BEYOND_90_DAY_WINDOW_INVISIBLE` | FAIL | Accepted limitation (see below). |
| `NO_AUTO_REFRESH` | PASS | 15s session-list poll, visibility-gated. |

## The bugs, root cause, and the fix

### Root cause: one architectural gap

All three operator-facing bugs share a single root: **sessions have no `status`
column — "active" is derived from `COALESCE(end_override, scheduled_end_time)`
— and the admin BFF exposed no endpoint to list sessions or fetch a room's
active one.** The repository queries that answer these questions already
existed (`findActiveSession`, `listSessionsForRoomInRange` in
`schedule-management.repository.ts`) but were never wired to an admin route.
The only consumer was the device-auth `my-schedule` long-poll, unreachable from
the admin console.

So an on-demand session — which gets `scheduled_end_time = NULL` when no
following session exists, making it active forever — was invisible and
unblockable from the admin UI. Creating a second one returned
`ANOTHER_SESSION_ACTIVE`, but the operator had no way to see or end the first.

### The fix (five changes, A–F)

**A. Expose session listing + active-session (the keystone).** Two new routes,
mirrored through all four layers exactly as the existing schedule routes are:

```
GET /api/session-manager/v1/schedule-management/list-sessions?roomUid=&from=&to=
GET /api/session-manager/v1/schedule-management/get-active-session/:roomUid
```

- **Schema** (`libs/schemas/session-manager-schema/.../routes/`):
  `list-sessions.schema.ts`, `get-active-session.schema.ts`. The active-session
  route returns `Session | null` (200 with null body when none is active) so a
  caller distinguishes "no active session" from "room not found" (404) without
  inspecting the error code.
- **session-manager**: router registration (admin-key guarded), controller
  handlers (`listSessions`, `getActiveSession`), service methods
  (`findActiveSession`, `listSessionsForRoomInRange` now also return
  `'ROOM_NOT_FOUND'`, mirroring `listSchedulesForRoom`), typed client methods
  (`libs/clients/session-manager-client/`).
- **admin BFF**: thin audited proxies at
  `GET /api/admin/v1/sessions/list` and
  `GET /api/admin/v1/sessions/active/:roomUid`, following the existing
  gateway pattern.
- **admin-webapp client**: `adminApi.listSessions()`, `adminApi.getActiveSession()`.

**B. Show the active session in the room view.** `room-detail-page.tsx` fetches
`getActiveSession` and renders an "Active session" card: name, type chip,
effective start/end, a "View session" link, and an "End early" button (which
reuses the existing `endSessionEarly` endpoint).

**C. List live sessions on the scheduling page.** `room-scheduling-page.tsx`
adds a third `useAsyncData` call to `listSessions` and renders a "Sessions"
table above the on-demand section. Each row shows name, type, an "active" chip
(when currently within its effective window), effective start/end, and a
"View" link. This surfaces the ON_DEMAND and AUTO rows that were previously
invisible (they have no parent schedule, so `listSchedules` never returned
them).

**D. Widen the look-back window.** The scheduling page's range was
`[now, now+90d)` — zero look-back. Changed to `[now-7d, now+90d)` so an active
session that started before page-load still appears. (The session-list query
uses an overlap predicate, not `active_start <= to`, so this primarily governs
sessions; the schedule-definition table keeps its forward 90d view.)

**E. Auto-refresh the scheduling page.** Added a 15s `setInterval` polling
`listSessions`, gated on `document.visibilityState === 'visible'` (the same
pattern `use-fleet.ts` and `use-test-audio.ts` use). Schedules/windows are
slow-moving definitions and still reload only on mutation; the poll covers the
live session rows, which is what changes underneath an operator. A `now` state
is bumped on the same interval so the "active" chip stays current without an
impure `Date.now()` during render (the lint rule the codebase already enforces).

**F. Guard the demo room.** The demo caption room's permanently-active fixture
session (`DEMO_ROOM_UID`) is not a real transcription session. The "End early"
button is hidden for it, mirroring the existing demo-room device controls.

### Accepted limitation: `SCHEDULE_BEYOND_90_DAY_WINDOW_INVISIBLE`

A schedule whose `activeStart` is >90 days out is stored and valid but not
listed on the scheduling page, because the schedule-definition query filters
`active_start <= now+90d`. This is **not fixed**: the materialized session rows
those schedules produce *do* appear via the new sessions endpoint once they
fall within the session-list range (which uses an overlap predicate). Widening
the schedule window further was judged lower-value and is left as a follow-up;
the regression test pins the current behaviour so a future change is deliberate.

## Design notes for reviewers

### Why mirror existing routes rather than reuse `my-schedule`?

The device-facing `my-schedule` endpoint already returns the active + upcoming
sessions for a room. It was tempting to proxy it. We did not, for three reasons:

1. **Auth model.** `my-schedule` is `deviceTokenHook`-authenticated (a kiosk
   device identity), not `adminApiKeyHook`. The admin BFF holds the admin key,
   not a device token; reusing the route would mean inventing a device identity
   for the console or weakening the auth on an existing route.
2. **Semantics.** `my-schedule` is a long-poll keyed on `roomScheduleVersion`,
   returning a 7-day horizon of active+upcoming. The admin console needs a
   range-bounded list (for the calendar) and a point query (for the room
   view) — different shapes.
3. **Surface area.** Two new read routes, each a thin wrapper over an existing
   repository query, is less risk than repurposing a device-facing long-poll.

### Why `Session | null` (200) for active-session, not 404?

A 404 conflates "the room has no active session" (a normal, expected state) with
"the room does not exist" (an error). Returning `null` at 200 lets the UI render
"No session is currently active" without an error path, and reserves 404 for a
genuinely missing room.

### Why poll instead of long-poll / SSE?

The session-manager already has a `roomScheduleVersion`-keyed event bus and
long-poll infrastructure (`my-schedule`, `session-config-stream`). Wiring the
admin BFF to long-poll would be lower-latency and lower-overhead than a 15s
poll. It is also a larger change: a new SSE/long-poll route through the BFF,
an event-bus subscription across what may be multiple session-manager
instances (the bus is in-process today — see `event-bus.service.ts`), and
corresponding client code. A visibility-gated 15s poll is the lower-risk first
step; the regression test pins the behaviour so upgrading to long-poll later
does not silently regress it.

### Why does `listSessionsForRoomInRange` now return `'ROOM_NOT_FOUND'`?

The repository method returned `Session[]` unconditionally. The service method
now checks `roomExists` first and returns `'ROOM_NOT_FOUND'` to match the
established pattern of `listSchedulesForRoom` (which the existing
`listSchedules` controller handler already maps to a 404). This keeps the
controller thin and the error consistent across list endpoints. The one
existing test caller was updated to narrow the type.

### Why not also fix the far-future schedule clip?

The schedule-definition table's 90-day forward window clips schedules with
`activeStart > now+90d`. The session rows those schedules *materialize* are
listed by the new sessions endpoint (overlap predicate) once within range, so
the operator can still see upcoming sessions. The schedule *definition* being
hidden until it enters the window is a narrower gap; widening it touches the
materialization horizon (`MATERIALIZATION_WINDOW_DAYS = 7`) and the conflict
check horizon (`CONFLICT_CHECK_HORIZON_DAYS = 14`), which are separate
concerns. Left as a follow-up rather than bundled here.

## Notes

- Provisioning is unique per run (`pw-<pid>-<epoch>`), so repeated runs never
  collide. The room is deleted on exit (cascades its sessions), unless
  `--keep-room` is set.
- BFF API calls run inside the browser page (`page.evaluate` + `fetch`), so the
  admin session cookie and CSRF token are handled by the browser context after
  login — no separate cookie jar.
- Chrome is auto-detected the same way `tools/e2e-audio` does it: `CHROME_PATH`,
  then the usual system locations.
- The tool uses `puppeteer-core` (already a root devDependency for
  `tools/e2e-audio`), not Playwright, to match the existing tooling convention.

## Files changed by the companion fix

```
libs/schemas/session-manager-schema/src/schedule-management/routes/list-sessions.schema.ts      (new)
libs/schemas/session-manager-schema/src/schedule-management/routes/get-active-session.schema.ts (new)
libs/schemas/session-manager-schema/src/index.ts                                                 (+2 exports)
libs/clients/session-manager-client/src/schedule-management-client.ts                            (+2 methods)
apps/session-manager/src/server/features/schedule-management/schedule-management.router.ts       (+2 routes)
apps/session-manager/src/server/features/schedule-management/schedule-management.controller.ts   (+2 handlers)
apps/session-manager/src/server/features/schedule-management/schedule-management.service.ts      (+2 methods, ROOM_NOT_FOUND)
apps/admin-server/src/server/features/scheduling/scheduling.schema.ts                            (+2 routes)
apps/admin-server/src/server/features/scheduling/scheduling.router.ts                            (+2 routes)
apps/admin-server/src/server/features/scheduling/scheduling.controller.ts                        (+2 handlers)
apps/admin-server/src/server/shared/services/session-manager-gateway.service.ts                  (+2 methods)
apps/admin-webapp/src/lib/admin-api.ts                                                           (+2 methods)
apps/admin-webapp/src/features/rooms/room-detail-page.tsx                                        (active-session card)
apps/admin-webapp/src/features/scheduling/room-scheduling-page.tsx                               (sessions table, poll, look-back)
apps/admin-webapp/tests/features/rooms/room-detail-page.test.tsx                                 (mock stubs)
apps/admin-webapp/tests/features/scheduling/room-scheduling-page.test.tsx                        (mock stubs)
apps/session-manager/tests/integration/features/schedule-management/schedule-management.service.test.ts (ROOM_NOT_FOUND case)
tools/admin-scheduling-e2e/                                                                     (this tool, new)
package.json                                                                                    (e2e:admin script)
```
