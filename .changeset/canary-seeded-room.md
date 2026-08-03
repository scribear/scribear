---
'@scribear/session-manager': minor
'@scribear/session-manager-schema': minor
'@scribear/monitoring-sidecar': minor
---

Seed the monitoring canary's room and device instead of provisioning them by
hand, and delete `MONITORING_CANARY_DEVICE_TOKEN`.

The synthetic canary was the last credential in the fleet an operator made by
hand, and the longest-shipping one. Arming it meant registering a device through
the admin API, activating it, scraping a `DEVICE_TOKEN` out of a `Set-Cookie`
header, pasting it into `.env`, then creating a room, attaching the device,
marking it the source and giving the room a standing schedule. One of those steps
— which room the device went into — silently decided whether fixture speech could
reach a live lecture. All of them are now gone.

**One secret, `CANARY_DEVICE_SECRET`, held by the Session Manager and the
monitoring sidecar and by nothing else.** At boot the Session Manager
idempotently seeds, at fixed uids: the room `MONITORING-CANARY`, one activated
source device in it, and one standing open-ended `ON_DEMAND` session. The
device's stored credential is `bcrypt(HMAC-SHA256(secret, deviceUid))`, which is
exactly what the sidecar derives for itself, so no token is ever transmitted,
pasted or written down. Unset seeds nothing and leaves the canary off, which is
the state a deployment that never provisioned one is already in.

This is the scheme `TEST_AUDIO_DEVICE_SECRET` introduced for the operator
test-audio devices, reusing the same derivation
(`@scribear/session-manager-schema/test-audio`) rather than growing a second
implementation of it — a mismatch between two copies is invisible until a device
fails to authenticate and looks exactly like a wrong secret.

**A second secret rather than reusing `TEST_AUDIO_DEVICE_SECRET`.** The two gate
different features and sharing one would tie two unrelated decisions together:
arming the operator test devices would also start an unattended canary probe
every few minutes, and retiring them would silently stop monitoring. It would
also hand a third service the root key every synthetic device's credential is
derived from — the independence the per-device HMAC exists to provide.

**The room assignment is enforced, not just documented.** A device token reaches
only its own device's room, so that binding is the entire safety boundary, and
making it in code is stronger than an operator making it by hand: the room is
seeded under a reserved uid no other room can hold, a re-run repairs a drifted
assignment instead of adding a second one, and room-management now refuses to
move the device into another room (409 `CANARY_DEVICE_NOT_ASSIGNABLE`) or to hand
the canary room a different source device (409 `CANARY_ROOM_NOT_ASSIGNABLE`).
Those guards are the same ones the demo and test-audio rooms carry, and they
close the same gap: `WOULD_LEAVE_ROOM_WITHOUT_SOURCE` stops covering the moment
someone deletes the canary room, which is the documented way to retire it, and
that leaves a roomless device holding a valid credential one `add-device-to-room`
from a lecture hall. The canary is the sharpest case of it, because it is the
only synthetic source that streams **unattended**, on a timer, with nobody
watching a meter.

The session is a standing open-ended `ON_DEMAND` one rather than
`autoSessionEnabled`, for the reason the test-audio seeder records:
`autoSessionEnabled` creates nothing on its own — it is a master switch over a
room's `auto_session_windows` rows, and with no window there are no slots and no
session.

Idempotent by construction: every insert is keyed on a reserved uid, never on a
name, so two instances starting together cannot duplicate. Tested across three
boots on one database with every touched table's row count asserted unchanged,
plus convergence after a deleted room, an ended session, a de-activated device
and a rotated secret, and the round trip proved end to end against a real server.

Operators running the canary must replace `MONITORING_CANARY_DEVICE_TOKEN` with
`MONITORING_CANARY_DEVICE_SECRET` in `.env`; see `deployment/UPGRADING.md`, which
also covers rotation, retirement ordering, and cleaning up the hand-made device
this leaves behind.
