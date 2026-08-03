---
'@scribear/admin-webapp': minor
---

The fleet grid can no longer freeze while looking live, and the node
diagnostics the browser was already receiving are finally rendered.

**A frozen fleet says so.** `use-fleet` handled `TELEMETRY_UNAVAILABLE` and let
`TELEMETRY_DEGRADED` fall through, keeping the last good snapshot with no chip,
no toast and no staleness marker — while the only visible chip,
`reconnecting…`, described the SSE stream rather than the poll. An operator
watched a plausible, motionless fleet and believed it was current. Every other
gap in this area *fails to inform*; this one **actively misinforms during an
incident**, which is the exact "looks live but isn't" failure the poll's own
comment says it exists to prevent. It also got worse the day an alerts panel
landed beside it: a correct, green alerts panel lends credibility to a frozen
grid.

The snapshot is kept rather than blanked — mid-incident the last known fleet is
evidence, and an empty grid beside a green alerts panel would read as "nothing
running, nothing wrong" — but the marking is made unmissable and text-bearing,
never colour alone: the heading becomes "Live fleet — last known state", an age
chip reads `not updating · 2m 14s old`, an assertive banner names the cause and
the absolute time of the last successful read and offers a retry, and the grid
itself is fenced with a caption saying everything below is frozen. Severity
follows the age of the *data*, not merely whether a request threw — a hung
request never rejects and a hidden tab pauses the poll, and both used to leave
a stale snapshot looking healthy. It escalates to `error` past three poll
intervals, chosen because `AUDIO_STATS_TTL_MS` is 10 s, so beyond 15 s every
audio reading on screen has certainly expired server-side.

Two smaller honesty fixes come with it: a failed first load no longer renders
"Loading fleet…" over a request that is not coming, and a frozen empty fleet
says "No active sessions **as of 14:03:22** — this is the frozen snapshot"
rather than asserting there are none.

**Node diagnostics are rendered.** `GET /api/node-server/v1/status` publishes
close-code tallies with their `initiator`, auth failures by reason, handshake
totals and provider-key rejects, and shipped all of it to the browser every
five seconds — where `grep "snapshot.nodes"` matched nothing. The findings that
answer a question sit outside the accordion, always visible, each as cause plus
next action: a **signing-key mismatch** between session-manager and node-server
is now named as such, with the variable to compare, gated on "has never
accepted a token" rather than a ratio because these are lifetime totals; a
device acting on a stale schedule and a room pointed at a provider key no host
serves are both newly nameable.

Close codes are grouped by role and every row states `initiator` **in words** —
"the far end closed it" / "node-server closed it" — with a caption explaining
that a server-chosen reason is authoritative while a peer reason collapses to
`other` unless allowlisted, so `other` means *unlabelled*, not a specific
fault. That is what makes "it keeps dropping" distinguishable from "it never
connected".

Deliberately left out: latency series, the upstream-transition matrix,
clock-skew counters, and **any derived rate** — differencing a 5 s poll would
make most windows all-zero, and a wrong rate presented as current is the bug
class this work exists to remove. Every counter is labelled as a total since
process start, with its counting epoch shown.

Also corrects the browser's `NodeSnapshot` mirror, which had drifted from its
producer: `binaryBeforeAuthDropsTotal` and `endedSessionRegistrationsTotal`
were being published and were entirely untyped here. They render as "not
reported" when absent, never as `0` — "this publisher predates the field" is a
different fact from "it counted nothing".
