---
'@scribear/session-manager': patch
---

Answer `400` instead of `500` when an auto-session window's `localStartTime`
equals its `localEndTime`.

`_doCreateSchedule` has validated this since it was written and returns
`400 "localStartTime and localEndTime must not be equal."`. `_doCreateWindow`
validated only `activeEnd`, so the identical typo reached the
`auto_session_windows_local_times_distinct` CHECK inside the transaction and
came back as an opaque `500 INTERNAL_ERROR` — on both
`create-auto-session-window` and `update-auto-session-window`. Both window paths
now mirror the schedule path exactly.

**No schema change.** `400 VALIDATION_ERROR` is already declared on every route
through `STANDARD_ERROR_REPLIES`, and that is all the schedule route ever
declared for this: adding an `INVALID_LOCAL_TIMES` reply to the window schemas
would have made the two paths _less_ consistent, not more.

**The comparison is on time of day, not on the string.** `HH:MM` and `HH:MM:SS`
are both accepted on the wire and the database stores either as `TIME`, so a row
written as `08:00` reads back as `08:00:00`. An update merging a request's
`08:00` against that stored value is exactly the collision the CHECK fires on,
and `'08:00:00' === '08:00'` is false — so a literal mirror of the schedule
path's `===` would have left the update route answering 500 for the case an
operator is most likely to hit. The schedule path had the same hole one level
deeper (its `===` caught the obvious typo first) and is fixed with it.

Found by `tools/session-corner-cases`, which pinned the 500 and now asserts the
400, including the `HH:MM` / `HH:MM:SS` form.
