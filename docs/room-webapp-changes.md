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

This app is a new workspace (`apps/room-webapp`) and does not modify any existing workspace. It uses the following existing shared libraries:

- `@scribear/session-manager-client` (activation, event polling, auth, upcoming sessions)
- `@scribear/node-server-client` (audioSource WebSocket, sessionClient WebSocket, muteSession)
- `@scribear/base-api-client`, `@scribear/base-websocket-client`
- `@scribear/session-manager-schema`, `@scribear/node-server-schema`
- `@scribear/redux-remember-store`, `@scribear/app-layout-store`, `@scribear/theme-customization-store`, `@scribear/transcription-content-store`, `@scribear/transcription-display-store`, `@scribear/microphone-store`
- `@scribear/core-ui`, `@scribear/transcription-display-ui`, `@scribear/theme-customization-ui`, `@scribear/microphone-ui`

---

## Known Limitations and Future Work

1. **Display tab reconnection on page refresh**: If the large display tab is refreshed mid-session, it will not reconnect to the `sessionClient` WebSocket until the touchscreen dispatches another `SESSION_STATE_CHANGE` BroadcastChannel message. A future improvement would detect the active session from the persisted Redux state on initialization and auto-reconnect.

2. **Independent microphone support**: The mute button currently sends a mute command to the node server (server-side enforcement). If a separate hardware microphone is used in the future, additional configuration will be needed to point the node server at the correct audio source device.

3. **Session end time on touchscreen**: The "active session controls" display does not currently show the scheduled end time of the session. This data is available via `upcomingSessions` but requires matching the active session ID to the upcoming sessions list, which was deferred.
