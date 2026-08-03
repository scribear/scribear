---
'@scribear/admin-webapp': minor
---

The console stops claiming the deployment is empty when it simply could not
load.

`useAsyncList`'s catch set `error` but left `items` at `[]`, and every page
branched `loading ? spinner : items.length === 0 ? "No X found." : rows`. So a
reload while the backend was down stated, in plain text and permanently, that
there are **no rooms** — with the only contrary signal a toast that auto-hid
after five seconds. On the audit page the same shape asserted that nobody had
done anything.

Fixed in the hook first, so it cannot come back: the first-page load is a
discriminated `loading | ok | unavailable`, and `items` exist **only** inside
`ok`. "No rooms found." is now unreachable from a failure by construction
rather than by discipline, which is what the plan asked for. The shape
deliberately matches the alerts hook so the codebase has one idiom. A failed
*append* is reported separately and never blanks rows already on screen — the
mirror image of the original bug.

`useAsyncData` gains the same union **additively**, because a dozen pages
outside this change read its existing `data`/`loading`/`error`. That matters
because only two of the five pages the plan named actually used
`useAsyncList` — audit and sessions-overview use `useAsyncData`, and fixing
just the named hook would have left them broken while looking complete.

A shared `<ErrorState>` replaces the hand-rolled `errorMessage` copies and
renders cause, next action, and **`requestId`** — which was captured on
`ApiError` and displayed nowhere, so an operator filing a ticket could not
quote the correlation id the server had already generated. It is given
prominence only because the chain was traced end to end:
`setGenReqId(randomUUID)` → the request-scoped logger's `reqId` → the
`X-Request-ID` header → the error envelope → the `request_id` audit row → the
console's own Audit column. It is correctly absent for a network failure,
where the request never reached a server, and the block is omitted rather than
rendered blank.

**Retry appears only when retrying can work.** An expired session gets "sign in
again"; a wrong `ADMIN_API_KEY` gets "check `ADMIN_API_KEY`". Offering Retry
there would be advice already known to be wrong — the same defect as "Please
try again" on a rate limit.

The plan's own example turned out to be misdiagnosed, and the real bug was
worse. "No devices assigned to this room." is not reachable from a failed load
— the page early-returns first — but its `!detail` fallback said **"Room not
found."** for a network drop, a dead session-manager, a 429 or a bad API key.
Not "this room is empty" but "this room does not exist". Fixed there instead.

Four best-effort catches that rendered nothing are also fixed: a failed room
search now says so instead of reading as "no matches"; the kiosk wizard's step
3 stops waiting forever behind a spinner and says it cannot tell after three
consecutive failed polls, noting the activation is recorded on the device and
nothing is lost; and `health-indicator` distinguishes "Checking…" from
"Unreachable" instead of showing one grey "Unknown" for both a dead admin
server and a healthy one with a hung probe.
