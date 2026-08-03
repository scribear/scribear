---
'@scribear/session-manager': patch
'@scribear/session-manager-schema': patch
'@scribear/admin-webapp': patch
---

Refuse `add-device-to-room` with `asSource` when the room already has a source,
instead of silently demoting the incumbent.

The route has always published a `409 TOO_MANY_SOURCE_DEVICES` reply that
**nothing could produce** — only `createRoom` emitted that code.
`addDeviceToRoom` ran no "this room already has a source" check, and the
repository clears `is_source` across the whole room before inserting when
`asSource` is true, so the call answered `204` and swapped the room's kiosk out
from under the operator.

The demoted device is not obviously broken, which is the problem. It keeps its
room membership and its long-lived `DEVICE_TOKEN`, still sees the session through
`my-schedule`, and still exchanges its token successfully — for
`["RECEIVE_TRANSCRIPTIONS"]` instead of
`["SEND_AUDIO","RECEIVE_TRANSCRIPTIONS"]`. That is a kiosk that starts, connects,
displays a join code and sends no audio, with nothing anywhere reporting a fault.
It is the exact harm `room-management.service.ts` already documents for the
reserved test-audio and canary rooms and guards `TEST_AUDIO_ROOM_NOT_ASSIGNABLE`
/ `CANARY_ROOM_NOT_ASSIGNABLE` against; ordinary teaching rooms had no guard at
all.

**No schema change**: the 409 was already declared, and now has a producer. The
route description no longer claims that `asSource` replaces the existing source.

**Replacing a source is still supported, as two deliberate calls.** Kiosk
hardware breaks and gets swapped, so refusing outright would be worse than the
bug. `set-source-device` is that flow and already exists: attach with
`asSource: false`, then promote. The refusal's message names it.

**Both admin-console callers now do that**, because both were always swaps: every
room has a source device (`createRoom` requires one and the
`room_devices_ensure_source` trigger keeps one), so the kiosk wizard's "add to an
existing room" and the room detail page's "add as source device" could only ever
have been replacing one. They attach then promote, and both labels now say that
the room's current source is replaced — which the operator previously had no way
to learn, from the UI or from the API.
