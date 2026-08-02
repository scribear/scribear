---
'@scribear/session-manager': patch
---

Clip a schedule or window occurrence to its active range instead of dropping it.

`inRange` rejected any occurrence that straddled either end of
`[activeStart, activeEnd]`. That reads as the safe conservative choice and is
not: the shape the admin console creates is a daily `00:00–23:59` window, so
**every** occurrence straddles both ends of any active range that does not begin
at midnight and finish at 23:59.

Three operator-visible consequences, all reproduced against a running stack:

- "Auto sessions every day, until 30 minutes from now" materialized **nothing** —
  not a 30-minute session.
- Narrowing a **live** window through `update-auto-session-window` returned 200
  and then **ended the AUTO session that was running right then**: with no window
  occurrence covering the active session's start, the reconciler took its
  `end_override = now` branch. An operator asking to "stop after this afternoon"
  stopped the room mid-lecture.
- The mirror image at the other end: a window with `activeStart = now` produced
  no session covering now, and the first appeared at the next local midnight.
  This is why `tools/demo-e2e` backdates `activeStart` a week (an hour of
  debugging is recorded in its comments) and why the admin dialog forces
  `activeStart` into the future. Neither workaround is needed any more; the
  `demo-e2e` backdate is now harmless rather than load-bearing and is left alone.

Occurrences are now trimmed — `startUtc = max(startUtc, activeStart)`,
`endUtc = min(endUtc, activeEnd)` — which is what the field names imply and what
`materializeAutoSessions` already did when filling a window around a blocking
session. The trim is arithmetic on absolute UTC instants, so a DST-adjusted
occurrence keeps whichever instants `buildOccurrence` resolved; a fall-back
occurrence clipped mid-way still lands on the standard-time instant.

**A residue shorter than 60 s is dropped rather than materialized**, reusing the
existing AUTO-slot floor (now `MIN_SESSION_DURATION_SECONDS`, exported from the
materializer so there is one constant rather than two 60s).

- It applies to **SCHEDULED occurrences too**, not only AUTO. They flow through
  the same materializer, and SCHEDULED occurrences go straight to
  `insertSessions` with no other length check — a zero-length residue would
  violate `sessions_scheduled_end_after_start` and surface as a 500, which is
  the failure mode this release is otherwise removing. AUTO occurrences pass
  through `materializeAutoSessions`, which already applied the same floor to
  every slot, so there the check is belt and braces.
- It applies **only to a clipped residue**, never to an unclipped occurrence. A
  30-second occurrence an operator typed out is a request; a 30-second tail left
  by an `activeEnd` is an artefact, and one nothing can join — the join-code
  handoff window is itself 60 s.

Nothing downstream needed changing, and the knock-on paths are covered by tests:
the window-overlap conflict check and `detectConflict` now compare the ranges
that will actually be written rather than pre-trim ones; `reconcileAutoSessions`
preserves the running AUTO row and moves its end instead of ending it; the
deferred `sessions_no_overlap` exclusion constraint still holds for a clipped
window abutting a SCHEDULED session inside it.

`tools/session-corner-cases`'s fall-back DST check used the old drop behaviour as
its discriminator between the daylight and standard readings of an ambiguous
local time, and was rebuilt around clipping: both schedules now sit wholly inside
the ambiguous hour, so `activeEnd` at the transition instant keeps them under one
reading and clips them out of existence under the other.
