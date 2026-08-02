---
'@scribear/admin-webapp': minor
---

"Is the kiosk even plugged in?" is now answerable from the room page and the
device page.

Both pages already knew the answer and declined to say it. `Device.online` and
`Device.lastSeenAt` ride on the one shared `DEVICE_SCHEMA` used by
`get-device`, `list-devices`, and the room-detail route's `RoomDetail.devices`,
so the data was in the browser on every one of these pages already — the
devices *list* rendered it, and the two more specific pages did not. The room's
device table showed only Active/Pending, which is **activation state, not
presence**, and the device detail page — the deepest page in the console —
carried no presence field at all, strictly less information than the list it is
reached from. A dead kiosk and a healthy idle kiosk looked identical from the
room page, which is the page an operator is on when someone reports that a room
has no captions.

Presence now renders on all three surfaces through one shared
`<DevicePresenceChip>`, so they agree on wording, color, and cutoff rather than
growing a third dialect for "online". The cutoff itself is not a client
decision: `online` is derived server-side precisely so every consumer agrees on
it, and the chip only renders it.

Activation state and presence stay side by side and never collapse into each
other — **Active *and* Offline** is a real, important combination (registered,
previously working, currently unplugged) and it is the one an operator most
needs to see. Color follows the severity convention rather than the data's
shape: online is `success`; offline *while activated* is `warning`, because the
device is expected to be reachable and its absence is worth going to check, but
a reboot or a network blip is not terminal; offline while still Pending is
`default`, because a device that was never set up is expected to be absent and
flagging it would be noise.

`lastSeenAt` is always rendered as text, never as color alone — "Never seen" is
kept distinct from "Last seen <time>", so Offline does not read identically
whether the device dropped a minute ago or has never once connected. On the
device detail page the timestamp shows unconditionally rather than only in a
hover tooltip, since the deepest page should not hide a fact behind a mouse.

**Behavior change worth noting on the devices list**: it previously colored
every offline device grey regardless of activation. It now uses the same
active-aware rule as the other two surfaces, so an activated-but-offline device
reads as `warning` there too.
