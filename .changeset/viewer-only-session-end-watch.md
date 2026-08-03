---
'@scribear/node-server': minor
---

Tell viewers a session ended even when no source device is attached.

`registerSource` was the only thing that ever created `SessionState`, and
`SessionState` was the only thing that fetched a session's config or armed the
timer that publishes `SessionEndedChannel`. Client-role connections never
touched the orchestrator at all — so a room whose viewers joined before, or
without, a kiosk had nobody watching the clock. Nothing published
`sessionEnded`, nothing closed those sockets 1000, and the viewers sat on stale
captions until a token refresh happened to come back 401/409 `SESSION_ENDED` —
bounded only by half the 5-minute token lifetime, up to ~2.5 minutes. Demos and
any viewers-first room hit this every time.

Client connections now take out an **end-watch**: a session-config long-poll and
a timer, and nothing else. In particular it dials **no upstream transcription
connection** — a viewer must cost the transcription service zero resources,
which is exactly the fault `e80eea2` was written for (audio-less connections
registering a job and eating admission capacity). It reuses the same
`_sessionConfigPollFactory` a session uses, rather than reading the end once, so
`startSessionEarly` / `endSessionEarly` move it: `endSessionEarly` sets
`end_override = now`, which arrives as an already-past end and publishes
immediately — as does a viewer joining a session that is already over.

The watch is ref-counted, one per session however many viewers share it, and is
torn down with its long-poll when the last client-role connection leaves.

**Exactly one publisher.** A session can have two end-timer owners over its
life — the `SessionState` a source opens and the `SessionEndWatch` its viewers
hold — so:

- while a live `SessionState` exists it is authoritative and the watch holds no
  timer at all; `registerSource` stands the watch down, `_unregisterSource`
  hands the timer back when that state is torn down under viewers who outlive
  the kiosk;
- `_publishSessionEnded` latches *both* owners whichever one got there first,
  so the source-side teardown that follows a publish cannot re-arm the watch for
  an end that has just passed.

The latch is per owner and dies with its owner, deliberately: suppressing a
publish because some earlier owner announced the same end would silently
reintroduce the bug for anyone who joins late. A duplicate publish is harmless —
the connection close it drives is idempotent — a missing one is the whole defect.

A config fetch that fails does **not** close the viewer's socket.
`registerClient` is synchronous and cannot throw: a source that cannot reach
Session Manager is useless and rightly gets 1011 `orchestrator-unavailable`, but
a viewer that cannot is only missing its end signal, and is left exactly as it
behaved before end-watches existed rather than being disconnected mid-caption.
The long-poll's own backoff keeps retrying.
