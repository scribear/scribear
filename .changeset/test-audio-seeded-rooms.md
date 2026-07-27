---
'@scribear/session-manager': minor
'@scribear/session-manager-schema': minor
'@scribear/test-audio-generator': minor
'@scribear/admin-webapp': patch
---

Seed the two operator test-audio rooms instead of provisioning them by hand, and
delete `deployment/provision-test-audio.sh`.

Arming the synthetic audio sources used to mean running a 190-line bash script —
the only one in `deployment/` that needed `jq` — which registered two devices,
activated them, scraped a `DEVICE_TOKEN` out of a `Set-Cookie` header, created
two rooms, printed two `.env` lines to paste, and then told the operator to go
and create a session in each room as well. Every one of those steps is now gone.

**One secret, `TEST_AUDIO_DEVICE_SECRET`, held by the Session Manager and the
generator and by nothing else.** At boot the Session Manager idempotently seeds,
at fixed uids: two rooms (`TEST-AUDIO-GOOD`, `TEST-AUDIO-FAULT`), one source
device in each, and one standing session per room. Each device's stored
credential is `bcrypt(HMAC-SHA256(secret, deviceUid))`. The generator derives the
same value and presents `{deviceUid}:{secret}` — exactly the shape
`DeviceAuthService.encode` produces, so it authenticates through the ordinary
`verify()` path with no special case anywhere in the auth code. Nothing is
transmitted between the two services; they agree because they compute the same
function of the same two inputs.

That function is defined **once**, in
`@scribear/session-manager-schema/test-audio`, and imported by both sides. A new
subpath rather than the package index because the derivation needs `node:crypto`
and the index is in the browser bundles' import graph. Two independent
implementations of "the same" derivation is the class of bug this branch has
already spent a commit fixing: the mismatch is invisible until a device fails to
authenticate, and looks exactly like a wrong secret.

- **Unset seeds nothing**, and both devices report `configured: false` — the same
  inert default as before, and the same shape as `DEMO_ROOM_ENABLED`.
- **Rotation is a restart.** The device row is upserted with `DO UPDATE`, so the
  stored hash is re-written from the current secret on every boot. `DO NOTHING`
  would be wrong here: bcrypt is salted, so the hash cannot be compared against
  the derived secret to detect drift, and a changed secret would leave the old
  hash verifying nothing anyone holds. It also repairs a device someone
  re-registered, which clears `hash` and `active`.
- **The session is where `autoSessionEnabled` would not have worked.** It is only
  a master switch: `reconcileAutoSessions` reads the room's
  `auto_session_windows` and produces nothing when there are none, so turning it
  on alone creates no session ever. A window cannot cover a whole day either —
  `auto_session_windows_local_times_distinct` forbids one that closes where it
  opens — so it would leave a daily gap, churn AUTO rows on every reconcile, and
  cut a run that crossed an occurrence boundary. One open-ended `ON_DEMAND`
  session has none of those properties, and it *pins* the room: the
  `sessions_no_overlap` exclusion constraint models it as `[start, infinity)`, so
  nothing else can be scheduled in a room dedicated to synthetic audio. A session
  someone ends early is re-opened on the next boot, so a test room that has gone
  quiet is fixed by a restart rather than being permanently dead.

**Seeding the room assignment in code is stronger than an operator wiring it by
hand, and that is much of the point.** A device token reaches only its own
device's room, and that binding is the entire safety boundary for these devices —
one of them in a teaching room would transcribe fixture speech into that
lecture's live captions, silently. There is now no argument to point at the wrong
room, no prompt to misanswer, and the rooms are reserved uids that no
database-generated uid can collide with. Room-management refuses to undo it:
`TEST_AUDIO_DEVICE_NOT_ASSIGNABLE` (409) on any attempt to put a seeded source in
another room, and `TEST_AUDIO_ROOM_NOT_ASSIGNABLE` (409) on any attempt to hand a
test room a different source. The existing `WOULD_LEAVE_ROOM_WITHOUT_SOURCE` rule
already blocked the usual route, but stopped covering the moment someone deleted
the test room — the documented way to retire these devices — which left a
roomless device holding a still-valid credential. The seeder also refuses to
adopt a device it finds in some *other* room, logging the room rather than
silently dragging it back, because that is the one state in which synthetic
speech may already be reaching a lecture.

Tested end to end rather than in halves: the generator's derived token is
presented to the real server and must reach the seeded room, find a session
already active in it, and exchange for a token carrying `SEND_AUDIO` — asserting
"a hash was written" and "a string was derived" separately would pass with the
two sides computing different functions. Three consecutive boots leave the row
counts unchanged on `devices`, `rooms`, `room_devices` and `sessions`, and a
deleted room, an ended session, a de-activated device and a rotated secret all
converge on the next boot.
