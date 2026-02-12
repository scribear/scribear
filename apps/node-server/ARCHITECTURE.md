# Node Server — Architecture & Flow

## System Overview

```
              ┌───────────────────┐
              │  Session Manager  │
              │      :8000        │
              └──┬──────────┬─────┘
                 │ issues    │ issues
                 │ JWTs      │ JWTs
                 ▼            ▼
    ┌─────────────┐      ┌───────────┐
    │    Kiosk     │      │ Student(s)│
    │(audio source)│      │           │
    └──────┬──────┘      └─────┬─────┘
           │                   │
           │ WS /audio/:id     │ WS /transcription/:id
           │ ?token=<jwt>      │ ?token=<jwt>
           ▼                   ▼
    ┌──────────────────────────────────┐
    │         Node Server :8001        │
    │  ┌────────────────────────────┐  │
    │  │     RoomManagerService     │  │
    │  │  ┌──────┐ ┌────────────┐  │  │
    │  │  │ Room │ │ Room       │  │  │
    │  │  └──┬───┘ └────────────┘  │  │
    │  └─────┼─────────────────────┘  │
    └────────┼────────────────────────┘
             │ WS binary audio
             ▼
    ┌────────────────────┐
    │Transcription Service│
    │    (Docker/GPU)     │
    └────────────────────┘
```

**Session Manager** = control plane (creates sessions, issues JWTs)
**Node Server** = data plane (bridges audio → transcription, fans out results)

---

## Authentication Flow

Session Manager issues JWTs with a `scope` field. Node Server verifies them using a **shared secret** — it never issues tokens itself.

| Scope    | Can connect to              | Purpose                     |
|----------|-----------------------------|-----------------------------|
| `source` | `/audio/:sessionId`         | Kiosk sending audio         |
| `sink`   | `/transcription/:sessionId` | Student receiving transcripts|
| `both`   | Either endpoint             | Full access                 |

**WebSocket auth** uses a `?token=` query parameter (browsers can't set headers on WS connections). See `src/server/hooks/authenticate-websocket.ts`.

---

## Room Lifecycle

Rooms are **created lazily** — no explicit "create room" API needed.

```
Step 1: Create session
   Kiosk ──POST /api/v1/session/create──> Session Manager
           Body: {
             sessionLength: 3600,           // duration in seconds (60–86400)
             audioSourceSecret: "secret...", // min 16 chars, gets hashed
             enableJoinCode: true,           // optional, generates join code
             maxClients: 0                   // optional, 0 = unlimited
           }
   Kiosk <── { sessionId, joinCode?, expiresAt } ──

Step 2: Get tokens (two ways to authenticate)
   // Option A: Kiosk uses sessionId + audioSourceSecret
   Kiosk   ──POST /api/v1/session/token──> Session Manager
             Body: { sessionId, audioSourceSecret, scope: "source" }
   Kiosk   <── { token, expiresIn, sessionId, scope } ──

   // Option B: Student uses joinCode
   Student ──POST /api/v1/session/token──> Session Manager
             Body: { joinCode, scope: "sink" }
   Student <── { token, expiresIn, sessionId, scope } ──

Step 3: Connect to Node Server
   Kiosk   ──WS /audio/{sessionId}?token=<jwt>──> Node Server
            (Room auto-created, TranscriptionStreamClient connects to TS)

   Student ──WS /transcription/{sessionId}?token=<jwt>──> Node Server
            (Student added to room.subscribers)

Step 4: Streaming
   Kiosk   ──binary audio frames──> Node Server ──forward──> Transcription Service
   Transcription Service ──{ type:"ip_transcript", text, starts, ends }──> Node Server
   Node Server ──fan out JSON──> Student 1, Student 2, ...

Step 5: Cleanup
   Kiosk disconnects   → source removed, TranscriptionStreamClient disconnected
   Student disconnects  → subscriber removed
   Last one out         → room destroyed automatically
```

---

## REST API

| Method | Endpoint             | Auth | Description                                  |
|--------|----------------------|------|----------------------------------------------|
| `GET`  | `/health`            | None | Health check                                 |
| `GET`  | `/rooms`             | None | List all active rooms                        |
| `GET`  | `/rooms/:sessionId`  | None | Get room info (subscriber count, source status) |

## WebSocket API

| Endpoint                            | Auth                       | Direction       | Data Format             |
|-------------------------------------|----------------------------|-----------------|-------------------------|
| `/audio/:sessionId?token=`          | JWT, scope `source`/`both` | Client → Server | Binary audio frames     |
| `/transcription/:sessionId?token=`  | JWT, scope `sink`/`both`   | Server → Client | JSON transcript messages|

### Transcript message format

```json
{
  "type": "ip_transcript or final_transcript",
  "text": ["word1", "word2"],
  "starts": [0.5, 1.2],
  "ends": [0.8, 1.5]
}
```

---

## Key Files

| File | Role |
|------|------|
| `src/server/services/room-manager.service.ts` | Core singleton — manages rooms, bridges audio to transcription, fan-out |
| `src/server/services/jwt.service.ts` | Verifies JWTs from session-manager |
| `src/server/hooks/authenticate-websocket.ts` | WS pre-handler extracting `?token=` and verifying |
| `src/server/features/audio/audio.router.ts` | Kiosk audio ingestion WebSocket |
| `src/server/features/transcription/transcription.router.ts` | Student transcript delivery WebSocket |
| `src/server/features/room/room.router.ts` | REST endpoints for room info |
| `src/server/dependency-injection/register-dependencies.ts` | Awilix DI container setup |
| `src/server/create-server.ts` | Server factory — registers plugins and routes |
| `src/app-config/app-config.ts` | Environment config via env-schema |

---

## Running Locally

```bash
# 1. Start transcription service (Docker with CUDA)
cd transcription_service
sudo docker build . -t ts_service -f Dockerfile_CUDA
sudo docker run --gpus all -p 8080:8080 ts_service

# 2. Start session manager
cd apps/session-manager
cp .env.example .env   # edit JWT_SECRET
npm run build && npm run start:dev

# 3. Start node server
cd apps/node-server
cp .env.example .env   # use SAME JWT_SECRET as session-manager
npm run build && npm run start:dev
```

**IMPORTANT:** `JWT_SECRET` must be identical between session-manager and node-server for token verification to work.
