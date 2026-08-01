---
'@scribear/session-manager': patch
---

`exchange-join-code` ignored a join code's `valid_start`, so codes lived up to
ten minutes instead of five.

The route rejected only `validEnd <= now`. But `fetchJoinCodes` pre-mints the
*next* code 60 seconds before the current one expires, with
`validStart = current.validEnd` — a code whose window has not opened yet. With
no `valid_start` check that code was exchangeable the instant it was minted, so
its usable life ran from the mint to the end of its own 5-minute window: nearly
double the intended TTL, and two codes were live at once for the last minute of
every rotation. `_findOrMintCurrentJoinCode` and `fetchJoinCodes` both already
applied `validStart <= now`; only the exchange did not.

A code is now exchangeable only inside `[validStart, validEnd)`, matching those
two. Not-yet-valid answers **404 `JOIN_CODE_NOT_FOUND`**, not 410
`JOIN_CODE_EXPIRED`: 410 GONE asserts the code is permanently finished when it
is in fact about to start working, and a status distinct from "unknown" would
confirm a live-but-unused code to anyone walking the 8-character space and
waiting.

The handoff flow is unaffected, which is the point of the pre-mint. The kiosk
renders only `current` in its QR (`nextJoinCode` is stored but never displayed),
so nothing legitimate ever presents a future code, and the pre-minted code
becomes exchangeable at exactly the instant the previous one expires — there is
no gap, because `validStart == previous.validEnd`.

Tested at the boundary on both sides: `validStart - 1ms` is refused,
`validStart` exactly is accepted. The integration test drives the real handoff —
back-dates the current code into the 60s window, re-fetches to make the server
mint `next`, and asserts `next` is refused while `current` still works, then
that `next` starts working the moment its window opens.
