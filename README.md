# ScribeAR

Self-hosted, real-time transcription. This monorepo (`scribear/scribear`) contains everything behind [ScribeAR](https://scribear.illinois.edu/v/index.html): the speech-to-text service, the proxy/session backend, the Postgres schema, and the client/kiosk/standalone webapps.

Full architecture, protocols, and API reference live in the **[wiki](https://github.com/scribear/scribear/wiki)** — this README is just a map to get you to the right page.

## Repo layout

```
apps/
  client-webapp/       # viewer — joins a session via a join code, receives transcripts
  kiosk-webapp/         # source — the device sending audio for a room, shows a join QR code
  standalone-webapp/    # all-in-one viewer+source app, no kiosk/client split
  node-server/           # proxies kiosk/client websockets to transcription-service
  session-manager/       # devices, rooms, sessions, auth — issues session tokens
  admin-webapp/         # IT admin console SPA (rooms, devices, kiosks) — talks only to admin-server
  admin-server/          # admin BFF — holds the Session Manager admin key, authenticates staff, proxies + audits
infra/
  scribear-db/           # Postgres schema + migrations
  scribear-nginx/        # reverse proxy used in the deployment stack
libs/
  clients/               # typed clients (session-manager, node-server, transcription-service, ...)
  schemas/                # shared request/response schemas
  store/                  # shared Redux slices used by the webapps
  ui/                     # shared React components used by the webapps
transcription_service/   # Python: the actual speech-to-text models (faster-whisper, CPU/CUDA)
deployment/               # Docker Compose stack for running the full system
```

## Start here, by audience

**New here / just curious / thinking about joining** — start at the wiki [Home](https://github.com/scribear/scribear/wiki/Home) page for the full architecture picture, and [`RELEASING.md`](RELEASING.md) for how branches (`staging`/`main`) and releases work.

**Frontend developers** (client-webapp, kiosk-webapp, standalone-webapp, `libs/ui`, `libs/store`) — see the wiki [Developing Frontend](https://github.com/scribear/scribear/wiki/Developing-Frontend) page to get an app running locally, and [Connecting From Frontend](https://github.com/scribear/scribear/wiki/Connecting-From-Frontend) for the session-token/websocket protocol these apps speak.

**Backend developers** (node-server, session-manager, transcription-service, scribear-db) — see [Developing Node Server](https://github.com/scribear/scribear/wiki/Developing-Node-Server), [Developing Session Manager](https://github.com/scribear/scribear/wiki/Developing-Session-Manager), and [Developing Transcription Service](https://github.com/scribear/scribear/wiki/Developing-Transcription-Service), plus the full [Documentation](https://github.com/scribear/scribear/wiki/Documentation) page for the API/protocol/config reference.

**Deployment & production** — see the wiki [Deployment](https://github.com/scribear/scribear/wiki/Deployment) page for the Docker Compose stack, and [`RELEASING.md`](RELEASING.md#container-tags) for how image tags map to branches (`staging` → `staging`/`staging-<sha>`, `main` → `latest`/`v<version>`). **Upgrading an existing deployment — read [`deployment/UPGRADING.md`](deployment/UPGRADING.md) first**: `deployment/.env` is untracked and does not update when you pull, so releases that add a required key will refuse to start until you add it.

**AI coding agents / LLMs** — read this file and [`RELEASING.md`](RELEASING.md) first, then the wiki [Documentation](https://github.com/scribear/scribear/wiki/Documentation) page before making assumptions about API shapes, message protocols, or config — it's the authoritative machine-actionable reference. This is an npm workspace monorepo: `npm install` at the root installs everything, and `npm run build|lint|format|test:unit|test:integration` at the root run across all workspaces (`--workspace <path>` to scope to one). CI/CD is in `.github/workflows/` (`node-ci`/`node-cd`, `python-ci`/`python-cd`) and the composite actions it uses are in `.github/actions/`.

## Full wiki index

* [Home](https://github.com/scribear/scribear/wiki/Home) — architecture overview
* [Deployment](https://github.com/scribear/scribear/wiki/Deployment) — run the full stack with Docker
* [Connecting From Frontend](https://github.com/scribear/scribear/wiki/Connecting-From-Frontend) — session tokens and the node-server websocket protocol
* [Developing Frontend](https://github.com/scribear/scribear/wiki/Developing-Frontend) — client/kiosk/standalone webapps
* [Developing Node Server](https://github.com/scribear/scribear/wiki/Developing-Node-Server)
* [Developing Session Manager](https://github.com/scribear/scribear/wiki/Developing-Session-Manager)
* [Developing Transcription Service](https://github.com/scribear/scribear/wiki/Developing-Transcription-Service)
* [Admin Website](https://github.com/scribear/scribear/wiki/Admin-Website) — operator guide for the IT admin console
* [Developing Admin](https://github.com/scribear/scribear/wiki/Developing-Admin)
* [Documentation](https://github.com/scribear/scribear/wiki/Documentation) — full API/protocol/config reference
* [ScribeAR Multi Tenancy HLD](https://github.com/scribear/scribear/wiki/ScribeAR-Multi-Tenency-HLD) — historical design notes, background only
