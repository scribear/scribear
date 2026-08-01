# Session, scheduling and calendar corner cases

An adversarial regression suite for the session lifecycle, join-code auth, the
auto-session/schedule calendar, and the room/device constraints that guard them.
One node process, real HTTP and real WebSockets against a **running stack** — no
mocks, no test containers, a real wall clock.

Each check is named for the behaviour it pins; each assertion reports PASS/FAIL
individually; the process exits non-zero if anything fails.

## Why

The session/schedule machinery is where this repo's shipped defects have
clustered, and every one of them was invisible to the unit and integration
suites:

| commit    | defect                                                                        |
| --------- | ----------------------------------------------------------------------------- |
| `1bfbc60` | session tokens still issued for **canceled** sessions once their slot arrived |
| `f7b26b6` | join codes exchangeable **before** `valid_start`, doubling a code's life      |
| `16e07c9` | an unknown `transcriptionProviderId` accepted at write time                   |
| `bc37f92` | a session with **no source attached** never told its viewers it had ended     |

They needed a live room, a real clock, and an adversarial input to surface —
`CONTRIBUTING.md`'s "a feature with a 'currently active' notion needs a fixture
that is active now" is the same lesson. This suite is that fixture, generalised:
every check provisions its own room, drives the real routes, and asserts on the
real answer.

## Run

```bash
# Needs the stack up and a built repo (`npm run build`) — the streaming check
# uses the real @scribear/test-audio-source engine.
npm run e2e:sessions
```

```bash
node tools/session-corner-cases/session-corner-cases.mjs \
  --base-url https://localhost:8443 \
  --env-file ../deployment-iso/.env \
  --quick        # skip the two wall-clock checks (~6 min of waiting)
  --no-stream    # skip the one check that costs transcription capacity
  --only cancel  # substring filter on the check name (repeatable)
  --list         # print the check names and exit
  --keep         # leave the provisioned rooms/devices in place
  --json         # machine-readable result on stdout
```

`SESSION_MANAGER_API_KEY` is read from `--env-file`, else `deployment/.env`,
else `../deployment/.env`, else the environment.

A full run takes about **7 minutes**, almost all of it the two `slow` checks
waiting on real join-code and session-start deadlines. `--quick --no-stream`
runs in well under a minute and is the right default while iterating.

Everything a run creates is named `scc-<pid>-<epoch>-*` and torn down in a
`finally` block (rooms first — they cascade sessions, windows, schedules and
memberships, and a device cannot be deleted while it is still its room's
source). Any leftover with that prefix is an orphan from a killed run.

### Reading the output

| line                  | meaning                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `[PASS]`              | the behaviour is what it should be.                                                                                                        |
| `[PASS (pins BUG-n)]` | the behaviour is what it **currently is**, and that is wrong or surprising. See the table below. A _fix_ makes this line FAIL, on purpose. |
| `[FAIL]`              | a regression.                                                                                                                              |

Assertions that pin questionable behaviour pass deliberately. The alternative —
asserting the desired behaviour and shipping a permanently red suite — makes a
real regression indistinguishable from the known backlog, which is how a red
suite stops being read. `tools/admin-scheduling-e2e` took the other route and
has sat at 5/6 ever since.

## Bugs this suite found

### BUG-1 — an auto-session window with equal local times answered 500

`create-auto-session-window` and `update-auto-session-window` had **no
`localStartTime !== localEndTime` pre-check**. `_doCreateSchedule` had one
(`INVALID_LOCAL_TIMES` → `400`, with a sentence naming the problem); the window
path (`_doCreateWindow`) validated only `activeEnd`, so the
`auto_session_windows_local_times_distinct` CHECK fired inside the transaction
and the operator got an opaque `500 INTERNAL_ERROR` for the same typo.

Both window paths now mirror the schedule path exactly:
`400 VALIDATION_ERROR` with `"localStartTime and localEndTime must not be
equal."`. No schema change was needed — `400 VALIDATION_ERROR` is already
declared on every route through `STANDARD_ERROR_REPLIES`, which is also all the
schedule route ever declared for it.

The comparison is on time-of-day, not on the string: `HH:MM` and `HH:MM:SS` are
both accepted on the wire and the database stores either as `TIME`, so a row
written as `08:00` reads back as `08:00:00` and an update merging a request's
`08:00` against it is exactly the collision the CHECK fires on. A string
`===` misses that, which is why the schedule path had the same hole one level
deeper; both are fixed.

Asserted by `equal-local-start-and-end-times-are-refused-on-schedules-and-windows`,
whose update leg deliberately sends `08:00` against a stored `08:00:00`.

### BUG-2 — `activeEnd` inside an occurrence deletes the occurrence instead of clipping it

`inRange` (`schedule-materializer.ts`) rejects an occurrence outright when
`occ.endUtc > schedule.activeEnd`:

```ts
if (schedule.activeEnd && occ.endUtc > schedule.activeEnd) return false;
```

For the shape the admin console actually creates — a daily `00:00–23:59` window
— that means **any** `activeEnd` before `23:59` removes the whole day, not the
tail of it. Two operator-visible consequences, both reproduced by the suite:

1. Creating "auto sessions every day, until 30 minutes from now" produces **no
   auto session at all**, not a 30-minute one.
2. Narrowing a **live** window (`update-auto-session-window` with an `activeEnd`
   later today) **ends the AUTO session that is running right now**. The
   reconciler finds no window occurrence covering the active session's start, so
   it takes the `end_override = now` branch. An operator asking for "stop after
   this afternoon" stops the room mid-lecture.

Minimal reproduction: create an auto-enabled room, a `00:00–23:59` window
backdated a week (so it covers now), confirm `get-active-session` returns an
AUTO session, then

```bash
curl -sk -X POST .../schedule-management/update-auto-session-window \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"windowUid":"<w>","activeEnd":"<now+30min>"}'      # 200 OK
curl -sk .../schedule-management/get-active-session/<room> -H "authorization: Bearer $KEY"
# null
```

Whether clipping or dropping is _correct_ is a product decision — clipping is
what the wording of the field implies and what the reconciler's own
`materializeAutoSessions` does for blocker sessions — but silently ending a live
session is not defensible either way. Pinned by
`an-activeEnd-inside-an-occurrence-drops-the-occurrence-instead-of-clipping-it`.

### BUG-3 — `add-device-to-room` silently demotes a room's source device

`add-device-to-room` **publishes a `409 TOO_MANY_SOURCE_DEVICES` reply that
nothing can produce**: that code is only ever returned by `createRoom`.
`RoomManagementService.addDeviceToRoom` runs no "this room already has a source"
check, and `RoomManagementRepository.addDeviceToRoom` clears `is_source` across
the entire room before inserting when `asSource` is true. So the call succeeds
with `204` and swaps the room's source out from under the operator.

The victim keeps its room membership and its long-lived `DEVICE_TOKEN`, still
sees the session through `my-schedule`, and still gets a session token — with
`["RECEIVE_TRANSCRIPTIONS"]` instead of `["SEND_AUDIO","RECEIVE_TRANSCRIPTIONS"]`.
That is a kiosk that starts, connects, shows a join code, and sends no audio,
with nothing anywhere reporting a fault.

This is precisely the harm `room-management.service.ts` already documents for
the reserved rooms — "Promoting some other device to source silently demotes the
synthetic source, which then still authenticates and still finds the session but
is no longer granted SEND_AUDIO, so the operator sees a device that starts and
sends nothing" — and guards `TEST_AUDIO_ROOM_NOT_ASSIGNABLE` /
`CANARY_ROOM_NOT_ASSIGNABLE` against. Ordinary teaching rooms have no such
guard.

Minimal reproduction:

```bash
# room R with source device D1, live session S; D2 registered and activated, in no room
curl -sk -X POST .../room-management/add-device-to-room -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"roomUid":"R","deviceUid":"D2","asSource":true}'          # 204

curl -sk -X POST .../session-auth/exchange-device-token -H "cookie: DEVICE_TOKEN=<D1>" \
  -H 'content-type: application/json' -d '{"sessionUid":"S"}'
# 200 {"scopes":["RECEIVE_TRANSCRIPTIONS"]}      <- was ["SEND_AUDIO", ...]
```

Suggested fix: return the already-published `TOO_MANY_SOURCE_DEVICES` when
`asSource` is true and the room has a source, and leave deliberate swaps to
`set-source-device`. Pinned by `a-room-takes-exactly-one-source-device`.

## Questionable-but-current behaviour also pinned

These are not bugs so much as sharp edges. They are pinned so that changing them
is a deliberate act.

### QUIRK-3 — a window starting "now" produces nothing until tomorrow

`inRange` also drops an occurrence whose **start** precedes `activeStart`. A
daily `00:00–23:59` window created at 16:00 with `activeStart = now` loses
today's occurrence (it started at 00:00) and first materializes at tomorrow's
midnight. The admin dialog forces `activeStart` into the future, so an operator
creating "auto sessions, every day, from now" gets nothing for the rest of the
day and no explanation. `tools/demo-e2e` backdates `activeStart` a week for
exactly this reason, with an hour of debugging recorded in its comments.

Pinned by `an-auto-window-must-start-before-the-occurrence-to-cover-today`,
which also asserts the backdated control case does work.

### QUIRK-4 — a schedule beyond a ranged listing is invisible to that range

A schedule starting 120 days out does not appear in a 90-day
`list-schedules?from=&to=` query, and only an unbounded listing shows it. This
is the session-manager half of `SCHEDULE_BEYOND_90_DAY_WINDOW_INVISIBLE`, which
`tools/admin-scheduling-e2e` documents as an accepted limitation of the admin
console.

## What is checked

`--list` prints the current set. As of this commit, **35 checks / 172
assertions**, all green against `bc37f92`, of which 10 pin questionable
behaviour (BUG-1 ×2, BUG-2 ×2, BUG-3 ×3, QUIRK-3 ×2, QUIRK-4 ×1).

### Session lifecycle

- a second on-demand session in a live room is refused — including **five
  simultaneous creates producing exactly one session**, which is what the
  room-row lock in `createOnDemandSession` is for.
- an on-demand session **preempts** the live AUTO one (`end_override = now`,
  and the AUTO session really is over).
- ending a session early tells a viewer **with no source attached** — the
  `bc37f92` regression, asserted as `sessionEnded` **and** close 1000 within
  15 s on a socket that joined with a real join code.
- the same, **while a source is mid-stream** (`stream` tag), where the source's
  `SessionState` owns the end timer instead. Reports SKIP rather than FAIL if
  the transcription service refuses admission — that is a deployment ceiling,
  not a session defect.
- starting a session early moves `effectiveStart` and makes it joinable
  (`not-active` → `ok`, and the room's source gets `SEND_AUDIO`).
- **canceling is terminal once the slot arrives** (`slow`) — the `1bfbc60`
  regression. Cancels a real occurrence while upcoming, waits for the wall clock
  to enter its window, then asserts all four auth paths refuse it.
- uncanceling restores an occurrence — **unless an AUTO session backfilled the
  slot**, where it must be `409 SLOT_NO_LONGER_AVAILABLE` rather than a
  corrupted schedule.
- an ended session refuses its old join code (`409`), its refresh token
  (`409 SESSION_ENDED`) and its device's token exchange.
- the verb/type matrix: AUTO sessions refuse start/end/cancel; ON_DEMAND
  sessions refuse cancel; ending twice is `422 SESSION_NOT_ACTIVE`.
- an auto-enabled room survives two full create → preempt → end → backfill →
  create cycles. This is the shape of the 500 that broke every on-demand session
  in every auto-enabled room and survived 341 integration tests.

### Join codes / auth

- **a join code is exchangeable only inside `[validStart, validEnd)`** (`slow`)
  — the `f7b26b6` regression, driven through the _real_ mint-next path: waits
  into the 60 s handoff window, asserts the kiosk is handed a `next` code
  starting exactly at `current.validEnd`, that exchanging it early is
  `404 JOIN_CODE_NOT_FOUND`, that the old code is `410 JOIN_CODE_EXPIRED` once
  it lapses, and that the handoff code then works.
- unknown / malformed join codes and refresh tokens.
- a session with empty `joinCodeScopes`: `no-join-scopes` on the admin route,
  `409 JOIN_CODE_SCOPES_EMPTY` on the device route — but the source device can
  still exchange its device token, because those scopes govern the anonymous
  path only.
- a device token only works for sessions in its own room (`403`).

### Calendar / scheduling

- a **midnight-wrapping** window materializes a session covering now that ends
  the following day.
- **spring-forward**: on the transition day a `02:00–02:59` and a `02:15–02:45`
  schedule do **not** conflict, because both occurrences vanish into the DST
  gap; `03:30`/`03:45` on that same day do conflict, and the identical `02:xx`
  pair one week later does too. Three legs, so "no conflict" is a positive
  statement rather than an artefact of a misbuilt fixture.
- **fall-back**: ambiguous local times resolve to the **later, standard-time**
  instant. Conflict detection alone cannot see this (local→UTC is strictly
  increasing under either reading, so overlap decisions are identical) — the
  check uses `inRange`'s `activeEnd` test as the discriminator instead: with
  `activeEnd` placed _between_ the two candidate ends both occurrences are
  dropped, and with it past the standard-time end they survive and conflict.
- DST transition instants are **computed from the host ICU database**, not
  hardcoded, so the checks keep working after the dates they were written
  against have passed — a hardcoded `2027-03-14` becomes an
  `INVALID_ACTIVE_START` the moment it is in the past.
- overlapping windows conflict; abutting ones do not.
- ONCE / WEEKLY / BIWEEKLY materialize, and the **BIWEEKLY parity anchor
  survives an update** even when `activeStart` moves (`updateSchedule` closes
  and re-inserts the row, so a dropped anchor would shift every future
  occurrence by a week).
- the horizons: 90-day ranged listing (QUIRK-4), 7-day materialization, and
  `list-sessions` refusing a range over 31 days.
- `activeEnd` mid-occurrence (BUG-2).
- toggling `autoSessionEnabled` off ends the live AUTO session and back on
  resumes from the untouched window.
- deleting a window with a live AUTO session ends it (and is `404` the second
  time); deleting a schedule takes its upcoming sessions with it.

### Rooms / devices

- exactly one source device per room (BUG-3).
- a device cannot belong to two rooms.
- a room's source device cannot be deleted or detached.
- deleting a room with a live session cascades the session and kills its join
  code.
- the reserved demo / canary / test-audio uids are refused for assignment,
  deletion and promotion. These guards run before any existence lookup, so the
  assertions hold whether or not the seeders ran; the test-audio room is
  discovered from `list-rooms` because it exists only when
  `TEST_AUDIO_DEVICE_SECRET` is set.
- an activation code is single-use and advertises a ~5 minute expiry.

### Invalid input

- an unknown `transcriptionProviderId` on **all five** write paths (`16e07c9`),
  including that the message names the deployment's configured providers.
- an invalid timezone (`422`), an empty one, and that the `Etc/UTC` alias
  `Intl.supportedValuesOf` omits is still accepted.
- equal local start/end times on schedules **and** windows, including the
  `HH:MM` vs stored `HH:MM:SS` form a string compare misses (BUG-1).
- malformed vs unknown UUIDs, distinguished per resource.
- `frequency`/`daysOfWeek` disagreement — including `daysOfWeek: []`, which the
  DB CHECK cannot catch (`array_length()` is `NULL` for an empty array, so the
  constraint passes) and the service therefore has to reject itself.

## Known gaps

- **Activation-code expiry** is asserted from the advertised `expiry` timestamp,
  not by waiting five minutes for a code to lapse.
- **Fall-back occurrence duration** is pinned indirectly, through `inRange`.
  Observing the two-hour `00:30–01:30` occurrence directly would need the
  transition inside the 7-day materialization horizon, which is true for a few
  days a year.
- The suite asserts **session-manager and node-server** behaviour. The admin
  console's rendering of any of it is `tools/admin-scheduling-e2e`'s job.
