# Room Webapp: Changes to Existing Codebase

This document describes all modifications made to the existing ScribeAR codebase as part of implementing the Room Webapp feature (branch `feature/unified-room-webapp`).

---

## 1. Session Manager — New `GET /device-sessions` Endpoint

**Purpose:** Returns active, upcoming, and recently ended sessions for the authenticated device. Used by the room webapp to populate upcoming sessions on both the touchscreen and large display.

### New Files

- `libs/schemas/session-manager-schema/src/session-management/get-device-sessions.schema.ts`
  — TypeBox schema and route definition for the new endpoint.

### Modified Files

- `libs/schemas/session-manager-schema/src/index.ts`
  — Added export for the new schema.

- `libs/clients/session-manager-client/src/create-session-manager-client.ts`
  — Added `getDeviceSessions` method to the typed client.

- `apps/session-manager/src/server/features/session-management/session-management.router.ts`
  — Registered `GET /api/session-manager/session-management/v1/device-sessions` with `deviceCookieAuthHook`.

- `apps/session-manager/src/server/features/session-management/session-management.controller.ts`
  — Added `getDeviceSessions` handler.

- `apps/session-manager/src/server/features/session-management/session-management.service.ts`
  — Added `getDeviceSessions` service method.

- `apps/session-manager/src/server/features/session-management/session-management.repository.ts`
  — Added Kysely query: sessions filtered by `source_device_id` (from cookie) and `(end_time IS NULL OR end_time > now - 1h)`, ordered by `start_time ASC`.

### Endpoint Details

```
GET /api/session-manager/session-management/v1/device-sessions
Auth: device cookie (device_token)
Response 200: { sessions: Array<{ sessionId, startTime, endTime, isActive }> }
```

- `isActive` is `true` only if `end_time IS NULL AND start_time <= now` (to distinguish from future-scheduled sessions).

---

## 2. Node Server — New `POST /mute-session/:sessionId` Endpoint

**Purpose:** Enables server-side muting by setting a per-session `isMuted` flag in the `TranscriptionServiceManager`. When muted, incoming audio chunks are dropped before forwarding to the transcription service.

This server-side enforcement is required because the room webapp's microphone may be independent of the client device in future deployments.

### New Files

- `libs/schemas/node-server-schema/src/session-streaming/mute-session.schema.ts`
  — TypeBox schema and route definition.

### Modified Files

- `libs/schemas/node-server-schema/src/index.ts`
  — Added export for the new schema.

- `libs/clients/node-server-client/src/create-node-server-client.ts`
  — Added `muteSession` HTTP endpoint client.

- `apps/node-server/src/server/features/session-streaming/session-streaming.router.ts`
  — Registered `POST /api/node-server/session-streaming/v1/mute-session/:sessionId`.

- `apps/node-server/src/server/features/session-streaming/session-streaming.controller.ts`
  — Added `muteSession` HTTP handler with JWT verification (`SEND_AUDIO` scope required) and delegates to `TranscriptionServiceManager.setMuted()`.
  — Added `jwtService` and `transcriptionServiceManager` as constructor dependencies (Awilix auto-injects by name).

- `apps/node-server/src/server/features/session-streaming/transcription-service-manager.ts`
  — Added `isMuted: boolean` to `SessionState` (initialized to `false`).
  — Added `setMuted(sessionId, muted): boolean` public method.
  — Added `!state.isMuted` guard before `wsClient.sendBinary(chunk)` in the audio chunk subscriber.

- `apps/node-server/tests/unit/server/features/session-streaming/session-streaming.controller.test.ts`
  — Updated constructor call to pass 3 args (mock jwtService and transcriptionServiceManager).
  — Added 6 tests for `muteSession` handler (auth cases, 404 case, success case).

- `apps/node-server/tests/unit/server/features/session-streaming/transcription-service-manager.test.ts`
  — Added 4 tests for `setMuted` and the audio-gate behavior.

### Endpoint Details

```
POST /api/node-server/session-streaming/v1/mute-session/:sessionId
Auth: Authorization: Bearer <sessionToken> (requires SEND_AUDIO scope)
Body: { muted: boolean }
Response 200: {}
Response 401: invalid/missing token or wrong scope
Response 404: session not found
```

---

## 3. Deployment Infrastructure

### Modified Files

- `deployment/compose.yml`
  — Added `room-webapp` service (image `scribear/room-webapp:${IMAGE_TAG:-latest}`, exposed on port 80 via `frontend` network).
  — Added `room-webapp` to nginx `depends_on` (with `service_healthy` condition).

- `infra/scribear-nginx/nginx.conf`
  — Added `upstream room-webapp { server room-webapp:80; }`.
  — Added `location /room/ { proxy_pass http://room-webapp/; ... }` block (no WebSocket needed — room-webapp connects to the node-server API, which is already proxied at `/api/node-server/`).

---

## 4. New App: `apps/room-webapp`

A new React/Vite webapp (`@scribear/room-webapp`) was added to the monorepo. It serves two browser views:

- `/touchscreen` — Touchscreen host controls (activation, mute, display settings)
- `/display` — Large display for participants (transcriptions, join code/QR)

A third route was added later (see §5):

- `/wall-panel` — Compact, hallway-mounted hybrid surface that mixes lightweight instructor control with passer-by join info.

This app is a new workspace (`apps/room-webapp`) and does not modify any existing workspace. It uses the following existing shared libraries:

- `@scribear/session-manager-client` (activation, event polling, auth, upcoming sessions)
- `@scribear/node-server-client` (audioSource WebSocket, sessionClient WebSocket, muteSession)
- `@scribear/base-api-client`, `@scribear/base-websocket-client`
- `@scribear/session-manager-schema`, `@scribear/node-server-schema`
- `@scribear/redux-remember-store`, `@scribear/app-layout-store`, `@scribear/theme-customization-store`, `@scribear/transcription-content-store`, `@scribear/transcription-display-store`, `@scribear/microphone-store`
- `@scribear/core-ui`, `@scribear/transcription-display-ui`, `@scribear/theme-customization-ui`, `@scribear/microphone-ui`

---

## 5. Room Webapp — New `/wall-panel` Route

**Purpose:** A self-contained, wall-mounted surface that can run as the
_only_ screen in a room (no separate `/touchscreen` or `/display` required).
It combines the glanceable bits of `/display` (large join code + QR, live
rolling transcription) with the control a host actually needs at the wall
(mute, at-a-glance schedule). Designed for rooms with a single small
touchscreen at the entrance / podium.

### Layout

The wall panel is a two-pane layout:

```
┌─ header: room • status dot • clock ─────────────────────────────┐
│  ROLLING TRANSCRIPTION [S M L]       │  QR + join code         │
│  + LIVE chip                          │  [ schedule │ mute ]    │
└────────────────────────────────────────┴────────────────────────┘
```

On narrow / portrait viewports (`xs`) the sidebar stacks on top of the
transcription so join info stays above the fold.

### Activation (standalone)

The wall panel reuses the existing `ActivationView` from
`features/touchscreen/components/activation-view.tsx`, so registering a room
from a wall panel uses the same onscreen-keyboard + physical-keyboard flow
as `/touchscreen`. The `MicrophoneModal` is also mounted at the page level,
so the panel can prompt for mic permission on its own — no second device
required to reach a working state.

### Wall-panel source files (`apps/room-webapp/src/features/wall-panel/`)

- `components/wall-panel-page.tsx` — Route top-level: `MicrophoneModal`,
  `ActivationView` when unregistered, else `WallPanelHome`.
- `components/wall-panel-home.tsx` — Single module for the live + idle
  experiences: compact header (room + clock), idle split view (clock/date +
  `ScheduleSessionList`), live split (rolling transcription + sidebar with
  QR/join code, session/schedule + mute tiles, schedule dialog).
- `components/rolling-transcription.tsx` — `TranscriptionDisplayContainer` +
  provider, S/M/L font presets, LIVE chip.
- `components/schedule-session-list.tsx` — Reusable list of upcoming sessions
  (idle pane + dialog).
- `wall-panel-format.ts` — Shared time/date helpers for the panel.
- `hooks/use-now.ts` — Interval-updated timestamp for clocks and countdowns.

Shared util: `apps/room-webapp/src/utils/client-join-url.ts` — builds the
client join URL for QR codes (`/display` and wall-panel both import it).

### Modified files (existing)

- `apps/room-webapp/src/app/router.tsx`
  — Registered `{ path: '/wall-panel', element: <WallPanelPage /> }`.

- `apps/room-webapp/src/features/room-provider/stores/room-service-middleware.ts`
  — Renamed local `isTouchscreenTab` check to `isControllerTab` and expanded
  it to accept `/wall-panel` as well as `/touchscreen`. Both routes now own a
  `RoomService` instance; `/display` remains read-only. This allows the wall
  panel to handle its own activation, register mute toggles, and react to
  session events directly.

- `apps/room-webapp/src/features/cross-screen/stores/cross-screen-middleware.ts`
  — Same rename + expansion. `/wall-panel` now both serves snapshots on
  `REQUEST_SNAPSHOT` and mirrors its own actions to other tabs, keeping
  font-size, join code, and session state in sync across all three surfaces.

### Design decisions

- **Fully standalone.** The wall panel is a complete controller — activation,
  mic permission, session events, and mute all happen locally. It can be the
  only surface deployed in a room.
- **Transcription uses the shared rolling container.** Rather than inventing
  a new single-line ticker, the panel reuses
  `@scribear/transcription-display-ui`'s `TranscriptionDisplayContainer`, so
  the rolling-text experience is identical to `/display` and the
  kiosk-webapp, respects the same user preferences
  (`lineHeightMultipler`, `wordSpacingEm`, `targetDisplayLines`,
  `targetVerticalPositionPx`), and inherits auto-scroll + jump-to-bottom.
- **Join code always visible.** Unlike `/display`, which gates the QR on the
  `showJoinCode` toggle, the wall panel always shows the QR + code while a
  session is active, since its primary job is letting passers-by join.
- **Schedule modal.** A square session tile (end time + “tap for schedule”
  when needed) opens the full-day list; the idle view also embeds the same
  list without a modal.
- **S / M / L transcription presets** on the live feed write to
  `display-settings-slice` so `/display` stays in sync via BroadcastChannel.
- **No destructive controls (no End/Extend Session).** These would require
  new session-manager endpoints and were explicitly out of scope for this
  iteration. See §6 below.
- **Responsive layout.** Breakpoints (`xs/sm` → column, `md+` → row) let the
  panel render sensibly in both landscape (hallway mount) and portrait (door
  sign mount) orientations with no code-path branching.

### Tabs co-existing

The wall-panel is a controller tab, just like the touchscreen. Running both
`/touchscreen` and `/wall-panel` simultaneously on the same device will cause
two `RoomService` instances to register against the same device — this is
supported by the session-manager (device registration is idempotent once
activated), but both tabs will then issue identical event polls. In practice
a room deploys one or the other, not both.

---

## Known Limitations and Future Work

1. **Display tab reconnection on page refresh**: If the large display tab is refreshed mid-session, it will not reconnect to the `sessionClient` WebSocket until the touchscreen dispatches another `SESSION_STATE_CHANGE` BroadcastChannel message. A future improvement would detect the active session from the persisted Redux state on initialization and auto-reconnect.

2. **Independent microphone support**: The mute button currently sends a mute command to the node server (server-side enforcement). If a separate hardware microphone is used in the future, additional configuration will be needed to point the node server at the correct audio source device.

3. **Session end time on touchscreen**: The "active session controls" display does not currently show the scheduled end time of the session. This data is available via `upcomingSessions` but requires matching the active session ID to the upcoming sessions list, which was deferred.

4. **Wall-panel: no End / Extend session controls**: The wall-panel's
   control bar intentionally omits "End session early" and "Extend +15 min"
   actions. End-session wiring would plumb the existing
   `sessionManagerClient.endSession(...)` call through a new action in the
   room-service middleware; extend-session would require a new session-manager
   endpoint to mutate a session's `endTime`. Both were left out of scope for
   this iteration.

5. **Wall-panel + touchscreen co-registration**: As described in §5, running
   `/wall-panel` and `/touchscreen` simultaneously results in two parallel
   `RoomService` event polls against the same device. Functional, but wasteful.
   A future improvement would elect a single "leader" controller tab via
   BroadcastChannel and have the other tab go read-only.
