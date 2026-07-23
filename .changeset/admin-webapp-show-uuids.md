---
'@scribear/admin-webapp': minor
---

Add a "Show UUIDs" toggle to the admin webapp.

Device and room names throughout the app (list and detail pages) are opaque
without their underlying identifiers, which matters when cross-referencing
against logs or the API. A toolbar switch, persisted to `localStorage`,
renders each entity's UUID in muted monospace beneath its name when enabled.
The devices list also now resolves a device's room UID to the room's display
name via a lookup fetched once from `GET /rooms`, since `Device` carries no
room name field.
