---
'@scribear/node-server-schema': minor
'@scribear/node-server': minor
'@scribear/monitoring-sidecar': minor
---

Tell a source that its session is already over, instead of letting it stream
into a dead one.

A **source** (kiosk or synthetic device) that opened a socket for a session
whose `effectiveEnd` had already passed was never told. `registerSource`
published `SessionEndedChannel` from inside its own `await` — `_openSession`
armed the end timer, found the end in the past, and published synchronously —
while the connection did not subscribe to that channel until the `await`
resolved. The publish landed on an empty channel. The source got `authOk`, no
`sessionEnded`, no close, and went on forwarding audio into a session the server
considered over, holding an upstream transcription connection for as long as the
kiosk kept the socket up. Nothing tore it down: teardown is driven by
`_unregisterSource`, which is driven by a close that never came. `#184` fixed the
viewer half of this and explicitly did not fix this half.

The likeliest real-world trigger is not the operator race but a **stale kiosk
schedule**: `kiosk-service.ts`'s `poll.on('error', () => {})` means the schedule
long-poll can be dead for hours with no signal, and a kiosk acting on a stale
schedule confidently connects to a session that ended long ago.

**Subscriptions now come before registration, for both roles.** The event bus is
synchronous, so anything published during `registerSource` reaches this
connection instead of nobody. This is the ordering the client path had already
been given, with the comment explaining why; sources now get the same rule. The
early-return paths (`_closed` mid-await, orchestrator failure) release those
subscriptions rather than leaving four listeners attached to a dead socket.

**Nothing is written to the socket before `authOk`.** Moving subscriptions above
registration means a bus message can now fire while the connection has not been
told its auth succeeded, and both webapp clients hold their WebSocket handshake
open until it arrives. The service therefore keeps an outbound gate shut until
the controller reports the send (`onAuthAcknowledged`, replacing
`publishCurrentStatus`). Live-stream messages that arrive early are dropped —
`sessionStatus` is superseded by the snapshot sent immediately after `authOk`,
and transcripts have no replay semantics — which is exactly what happened before,
when those subscriptions simply did not exist yet. `sessionEnded` is the one
message that must not be dropped, so it is latched and delivered in protocol
order: `authOk`, then `sessionEnded`, then close 1000.

**No upstream is dialed for a session that is already over.** `_openSession`
used to construct and start the upstream *before* `_armEndTimer` discovered the
end had passed, so an abandoned session took a transcription-service connection
with it. The effective end is now checked the moment the first config surfaces,
and `registerSource` throws `SessionAlreadyEndedError` without dialing anything
and without creating a `SessionState`. That error is distinct from an
orchestrator failure on purpose: an unreachable Session Manager is *broken* and
earns 1011, whereas this session is merely *over* and earns a clean 1000 with
`sessionEnded` — the kiosk already distinguishes those, and collapsing them
would put a finished session into a reconnect loop. Not creating the state also
removes the knock-on: no stale `SessionState` lingers in `_sessions` holding an
upstream, answering `getStatus`, and appearing in `/status` for a session nobody
is serving.

The single-publisher guarantee `#184` established is untouched: the refusal
publishes nothing on the bus, so an end-watch a viewer holds is still the only
thing that announces the end to that session.

**Observability.** A source arriving at a finished session is now counted and
named, because downstream it is otherwise indistinguishable from an ordinary
session end (a `1000 session-ended` close either way) while meaning something
quite different:

- a warn log line, `source registered onto an already-ended session`, carrying
  the `effectiveEnd` the config reported;
- `summary.endedSessionRegistrationsTotal` on `GET /status`, optional on the
  wire so an older publisher does not fail the strict `Value.Check` that the
  Redis fleet snapshot is read back through;
- `scribear_node_ended_session_registrations_total` in the monitoring sidecar,
  which skips the advance rather than recording a zero when the field is absent.
