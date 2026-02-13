# Node Server

The node server is the **data plane** of ScribeAR. It sits between browser clients and the transcription service, bridging audio from kiosks to transcription and fanning out live transcripts to students.

It does **not** create sessions or issue tokens — that is the session manager's job. The node server only **verifies** tokens and manages the real-time audio/transcript pipeline.

```
              ┌───────────────────┐
              │  Session Manager  │
              │      (:8000)      │
              └──┬──────────┬─────┘
                 │ issues    │ issues
                 │ JWTs      │ JWTs
                 ▼            ▼
    ┌─────────────┐      ┌───────────┐
    │    Kiosk     │      │ Student(s)│
    │(audio source)│      │(listeners)│
    └──────┬──────┘      └─────┬─────┘
           │                   │
           │ WS /audio/:id     │ WS /transcription/:id
           │ ?token=<jwt>      │ ?token=<jwt>
           ▼                   ▼
    ┌──────────────────────────────────┐
    │         Node Server (:8001)      │
    │       ┌─────────────────────┐    │
    │       │  RoomManagerService │    │
    │       │  ┌──────┐ ┌──────┐ │    │
    │       │  │Room A│ │Room B│ │    │
    │       │  └──┬───┘ └──────┘ │    │
    │       └─────┼──────────────┘    │
    └─────────────┼───────────────────┘
                  │ WS binary audio + API key auth
                  ▼
         ┌────────────────────┐
         │Transcription Service│
         │   (Docker / GPU)   │
         └────────────────────┘
```

---

## How It Works

### 1. Startup

The entry point (`src/index.ts`) loads environment configuration, creates the Fastify server, registers all plugins and routes, and starts listening.

### 2. A Kiosk Connects (Audio Source)

1. A kiosk obtains a JWT with `scope: "source"` from the session manager.
2. It optionally calls `POST /rooms` on the node server to pre-create a room with transcription config (provider, sample rate, etc.). If this step is skipped, default config is used.
3. The kiosk opens a WebSocket to `/audio/:sessionId?token=<jwt>`.
4. The `authenticateWebsocket` pre-handler extracts and verifies the JWT. If invalid, the connection is rejected with 401.
5. The audio router checks that the token's scope is `"source"` or `"both"`. If not, the socket is closed with code `4003`.
6. `RoomManagerService.setAudioSource()` is called, which:
   - Gets or creates the room for that sessionId.
   - Creates a `TranscriptionStreamClient` using the room's transcription config.
   - Connects to the transcription service via WebSocket, sending an AUTH message (API key) then a CONFIG message (sample rate, channels).
   - Wires up transcript events (`ipTranscription`, `finalTranscription`) to broadcast to all subscribers.
7. As binary audio frames arrive from the kiosk, they are forwarded directly to the transcription service via `forwardAudio()`.

### 3. A Student Connects (Transcript Subscriber)

1. A student obtains a JWT with `scope: "sink"` from the session manager using a join code.
2. The student opens a WebSocket to `/transcription/:sessionId?token=<jwt>`.
3. The same `authenticateWebsocket` hook verifies the JWT. The transcription router checks that the scope is `"sink"` or `"both"`.
4. `RoomManagerService.addSubscriber()` adds the student's socket to the room's subscriber set.
5. Whenever the transcription service emits a result, `RoomManagerService` broadcasts the JSON message to every subscriber with an open socket.

### 4. Transcript Messages

The node server broadcasts two types of JSON messages to subscribers:

- **`ip_transcript`** (in-progress) — interim transcription that may change as more audio arrives.
- **`final_transcript`** — stable transcription that won't change.

Both have the shape: `{ type, text: string[], starts: number[] | null, ends: number[] | null }`.

### 5. Cleanup

- When the kiosk disconnects, the audio source is removed and the transcription client is disconnected. If no subscribers remain, the room is destroyed.
- When a student disconnects, they are removed from the subscriber set. If no source and no subscribers remain, the room is destroyed.
- Rooms are entirely in-memory and do not persist across restarts.

---

## API Reference

### REST Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | None | Returns `{ reqId, status: "ok" }` |
| `POST` | `/rooms` | None | Create a room with transcription config |
| `GET` | `/rooms` | None | List all active rooms |
| `GET` | `/rooms/:sessionId` | None | Get info for a specific room |

#### `POST /rooms` Request Body

```json
{
  "sessionId": "session_abc123...",
  "transcriptionConfig": {
    "providerKey": "whisper",
    "useSsl": false,
    "sampleRate": 16000,
    "numChannels": 1
  }
}
```

All fields in `transcriptionConfig` are optional — defaults are applied for any omitted fields. Returns `201` with the resolved config, or `409` if the room already exists.

### WebSocket Endpoints

| Endpoint | Auth | Direction | Data Format |
|----------|------|-----------|-------------|
| `/audio/:sessionId?token=<jwt>` | JWT scope `source` or `both` | Client -> Server | Binary audio frames |
| `/transcription/:sessionId?token=<jwt>` | JWT scope `sink` or `both` | Server -> Client | JSON transcript messages |

---

## File-by-File Reference

### Entry Point

| File | Purpose |
|------|---------|
| `src/index.ts` | Application entry point. Loads config, creates the server, registers process-level error handlers, and starts listening on the configured host/port. |

### Configuration

| File | Purpose |
|------|---------|
| `src/app-config/app-config.ts` | Defines and validates all environment variables using `env-schema` with TypeBox. Exposes typed getters for `baseConfig` (port, host, log level, dev mode), `jwtSecret`, `jwtIssuer`, `transcriptionConfig` (service URL + API key), and `sessionManagerUrl`. Development mode is detected via the `--dev` CLI flag. |
| `.env.example` | Template for the required environment variables with comments. |

### Server Setup

| File | Purpose |
|------|---------|
| `src/server/create-server.ts` | Server factory. Creates the base Fastify instance (via `@scribear/base-fastify-server`), then registers plugins in order: CORS, WebSocket support, Swagger (dev only). Registers the DI container, REST routes (healthcheck, rooms), and WebSocket routes (audio, transcription). WebSocket routes are registered directly on the parent instance rather than via `fastify.register()` because `@fastify/websocket`'s `onRoute` hook only fires in the context where the plugin was registered. |

### Plugins

| File | Purpose |
|------|---------|
| `src/server/plugins/websocket.ts` | Registers `@fastify/websocket` as a Fastify plugin using `fastify-plugin` (so it's not encapsulated and is available to all routes). |
| `src/server/plugins/swagger.ts` | Registers `@fastify/swagger` and `@fastify/swagger-ui` for OpenAPI documentation at `/api-docs`. Only enabled in development mode. |

### Dependency Injection

| File | Purpose |
|------|---------|
| `src/server/dependency-injection/register-dependencies.ts` | Configures the Awilix DI container. Registers config values as singletons, `JwtService` as scoped (new instance per request), `RoomManagerService` as a singleton (shared state across all requests), and controllers (`HealthcheckController`, `RoomController`) as scoped. Also extends the `@fastify/awilix` type declarations so `req.diScope.resolve()` is fully typed. |
| `src/server/dependency-injection/resolve-handler.ts` | Helper that wraps controller methods for use as Fastify route handlers. It resolves the controller from the request's DI scope and calls the specified method, providing full type safety between controller names and method names. |

### Hooks

| File | Purpose |
|------|---------|
| `src/server/hooks/authenticate-websocket.ts` | Fastify `preHandler` hook for WebSocket routes. Extracts the JWT from the `?token=` query parameter (browsers cannot set custom headers on WebSocket connections), verifies it using `JwtService`, and attaches the decoded payload (`sessionId`, `scope`, optional `sourceId`) to `req.jwtPayload`. Returns `401 Unauthorized` if the token is missing or invalid. Also extends the Fastify request type declaration to include `jwtPayload`. |

### Services

| File | Purpose |
|------|---------|
| `src/server/services/jwt.service.ts` | JWT **verification-only** service. Uses the `jsonwebtoken` library to verify tokens with HS256, checking the signature, issuer, and expiration. Returns a typed result with the decoded `JwtPayload` (sessionId, scope, sourceId) or an error message. Does not issue tokens — that is the session manager's responsibility. |
| `src/server/services/room-manager.service.ts` | The core singleton service that manages the entire room lifecycle. Maintains an in-memory `Map<string, Room>` where each room holds: a `TranscriptionStreamClient` (connection to the transcription service), a source WebSocket (the kiosk), and a set of subscriber WebSockets (students). Key responsibilities: (1) creating rooms with per-session transcription config, (2) connecting to the transcription service when a source joins, (3) forwarding binary audio from kiosk to transcription service, (4) broadcasting transcript JSON to all subscribers, (5) auto-cleaning rooms when all connections close. |

### Features — Audio Ingestion

| File | Purpose |
|------|---------|
| `src/server/features/audio/audio.router.ts` | Registers the `GET /audio/:sessionId` WebSocket route with the `authenticateWebsocket` pre-handler. After authentication, verifies the token scope is `"source"` or `"both"` (rejects with close code `4003` otherwise). Calls `RoomManagerService.setAudioSource()` to register the kiosk and start the transcription pipeline. Listens for binary messages and forwards them via `forwardAudio()`. On socket close, calls `removeAudioSource()`. Enforces one source per room (rejects with code `4001` if a source already exists). |

### Features — Transcript Delivery

| File | Purpose |
|------|---------|
| `src/server/features/transcription/transcription.router.ts` | Registers the `GET /transcription/:sessionId` WebSocket route with the `authenticateWebsocket` pre-handler. After authentication, verifies the token scope is `"sink"` or `"both"` (rejects with close code `4003` otherwise). Calls `RoomManagerService.addSubscriber()` to register the student. On socket close, calls `removeSubscriber()`. The student receives JSON transcript messages pushed by the room manager — no messages are expected from the student. |

### Features — Room Management (REST)

| File | Purpose |
|------|---------|
| `src/server/features/room/room.router.ts` | Registers three REST routes: `POST /rooms` (create room with config), `GET /rooms` (list all), `GET /rooms/:sessionId` (get one). All routes delegate to `RoomController` via the `resolveHandler` helper. |
| `src/server/features/room/room.controller.ts` | Handles room REST endpoints. `createRoom` validates for duplicates (409 if exists) and delegates to `RoomManagerService.createRoom()` with optional `transcriptionConfig`. `listRooms` returns all room info with subscriber counts. `getRoom` returns detailed info for a single room including source status, subscriber count, transcription connection status, and the active transcription config. |

### Features — Healthcheck

| File | Purpose |
|------|---------|
| `src/server/features/healthcheck/healthcheck.router.ts` | Registers `GET /health` and delegates to `HealthcheckController`. |
| `src/server/features/healthcheck/healthcheck.controller.ts` | Returns `{ reqId, status: "ok" }` with a 200 status code. Includes the request ID for tracing. |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LOG_LEVEL` | Yes | — | Log level (`debug`, `info`, `warn`, `error`, `fatal`) |
| `PORT` | Yes | — | Port to listen on (0–65535) |
| `HOST` | Yes | — | Host to bind to (e.g. `0.0.0.0`) |
| `JWT_SECRET` | Yes | — | Shared secret for JWT verification (min 32 chars, **must match session manager**) |
| `JWT_ISSUER` | No | `scribear-session-manager` | Expected JWT issuer (**must match session manager**) |
| `TRANSCRIPTION_SERVICE_URL` | Yes | — | Transcription service address (e.g. `localhost:8003`) |
| `TRANSCRIPTION_API_KEY` | Yes | — | API key for the transcription service (**must match transcription service's `API_KEY`**) |
| `SESSION_MANAGER_URL` | Yes | — | Session manager address (currently unused in code but validated) |

---

## Running

```bash
# Install dependencies (from repo root)
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env — JWT_SECRET must match the session manager

# Development (auto-rebuild + pretty logs)
npm run dev

# Production
npm run build
npm run start
```

The `--dev` flag (used by `start:dev`) enables Swagger documentation at `/api-docs`.

---

## Architecture Patterns

- **Dependency Injection** — Awilix container with scoped (per-request) and singleton lifetimes. Controllers and JwtService are scoped; RoomManagerService is a singleton.
- **Plugin-based** — WebSocket support and Swagger registered as Fastify plugins using `fastify-plugin` for proper encapsulation control.
- **Feature-based file organization** — Each feature (audio, transcription, room, healthcheck) is self-contained with its own router and controller.
- **Separation of concerns** — Routers define routes and delegate to controllers. Controllers handle HTTP concerns and delegate to services. Services contain business logic.
- **Shared libraries** — Uses `@scribear/base-fastify-server` for base server setup (logging, DI, error handling) and `@scribear/transcription-service-client` for the WebSocket client to the transcription service.
