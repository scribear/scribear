---
'@scribear/session-manager-schema': minor
'@scribear/session-manager-client': minor
'@scribear/session-manager': minor
'@scribear/node-server': minor
'@scribear/admin-server': minor
'@scribear/admin-webapp': minor
'@scribear/kiosk-webapp': patch
'@scribear/scribear-nginx': patch
---

Demo caption room: on by default everywhere, surfaced in the admin console with
a one-click "open live captions" link, with a bare-`/client` routing fix.

- **On by default.** `DEMO_ROOM_ENABLED` now defaults to `true` in both the Node
  Server and Session Manager (every environment, including production); set
  `DEMO_ROOM_ENABLED=false` to turn it off. `DEMO_SESSION_UID` is no longer
  plumbed through `deployment/compose.yml` — both services share the same
  built-in default, so neither var needs setting for a working demo room.
- **Admin dashboard — Demo caption room card.** Shows whether the demo room is
  enabled and whether its seeded session is currently joinable, and — when it is
  — an **Open live captions** button that opens the client webapp straight into
  the looping demo captions with no manual join-code entry. A forcing function
  for exercising the client frontend end-to-end without a mic, source device, or
  transcription service.
- **Session Manager — `GET /demo-room/status` (admin-key).** Reports
  `{ enabled, sessionUid, active, roomName, joinCode }`, minting/returning a
  currently-valid join code (via the same idempotent `ensureCurrentJoinCode` the
  seeder uses) only when the session is active. Plumbed through the
  session-manager schema + client and proxied by the admin server's gateway with
  the admin API key it already holds; the console builds the same-origin
  `/client/#config=<base64>` deep link the kiosk QR uses.
- **nginx — route bare `/client`.** A request to `/client` (no trailing slash)
  now 308-redirects to `/client/` (the browser preserves the `#config=...`
  fragment), so deep links resolve regardless of the trailing slash.
- **Kiosk — fix QR 404.** The QR code defaulted to `${origin}/client` (no
  trailing slash); the reverse proxy only serves `/client/`, so scanned codes
  404'd. Now defaults to `${origin}/client/`.
