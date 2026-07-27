---
'@scribear/session-manager-schema': minor
'@scribear/session-manager-client': patch
'@scribear/session-manager': minor
'@scribear/admin-webapp': minor
---

Refuse device assignments to the demo caption room, which has no audio path.

The demo caption room is a purely synthetic emitter — the Node Server publishes
a looping fixture caption stream onto the demo session's bus channel and nothing
is ever recorded or transcribed for it — but room management happily accepted a
device into it, and even accepted one as its **source** device. That is actively
misleading: an operator would reasonably expect audio from a source device to be
transcribed, and it never will be.

- **Session Manager — refused at the service that owns the rule**, not just in
  the admin console, because the admin API key reaches these routes directly
  (`deployment/register-device.sh` and friends do exactly that).
  `add-device-to-room` and `set-source-device` now return **409
  `DEMO_ROOM_NOT_ASSIGNABLE`** when the target room is the demo room, and
  `add-device-to-room`, `set-source-device` and `create-room` return **409
  `DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE`** when the device is the demo room's
  placeholder source — a device that is never activated and can never send audio
  for any room. Both messages say *why* (no audio path), so the refusal does not
  read as a transient failure. `create-room` cannot recreate the demo room (its
  uid is database-generated), so the placeholder device is the only demo-room
  state it can reach. `remove-device-from-room` is deliberately left unguarded:
  detaching only ever makes a room emptier, and it is the escape hatch for a
  device attached before this existed.
- **Reserved uids are now shared contract.** `DEMO_ROOM_UID` and
  `DEMO_SOURCE_DEVICE_UID` moved from the Session Manager's demo-room constants
  into `@scribear/session-manager-schema` (re-exported from their old home), so
  the service that enforces the rule and the console that renders it agree on one
  literal. The schema package is now marked `sideEffects: false` so importing a
  constant from it tree-shakes cleanly instead of pulling every route schema and
  typebox into a browser bundle (verified: +0.4 kB on the admin bundle, versus
  +60 kB without it).
- **Admin console — the controls are disabled, not just refused.** The room
  detail page disables **Add device** and **Set as source** for the demo room and
  explains that its captions come from a fixture, so an operator reads the reason
  instead of discovering it by hitting a 409; **Remove** stays enabled to match
  the server. The kiosk wizard no longer offers the demo room as an existing room
  to join, and the new-room dialog no longer offers the demo placeholder device
  as a source.
