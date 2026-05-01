# Scribear CLI

Commands below are run from the repo root unless otherwise noted.

**Webapp**
- `npm run dev --workspace @scribear/webapp` — start the Vite dev server for the webapp.
- `cd apps/webapp && npm run dev` — same as above, from the app folder.

**Session Manager API**
- `npm run dev --workspace @scribear/session-manager` — dev mode with rebuilds and pretty logs.
- `npm run build --workspace @scribear/session-manager` — build the API server.
- `npm run start --workspace @scribear/session-manager` — run the built server.
- `npm run start:dev --workspace @scribear/session-manager` — run the built server with `--dev` and pretty logs.

**Database**
- `npm run migrate:up --workspace @scribear/scribear-db` — run migrations.
- `npm run migrate:down --workspace @scribear/scribear-db` — rollback the last migration.

**Transcription Service (Python)**
- `cd transcription_service && make dev` — start with hot reload and pretty output.
- `cd transcription_service && make start` — start in prod mode.

**Formatting (Prettier)**
- `npm run format` — check formatting across all workspaces.
- `npm run format:fix` — fix formatting across all workspaces.
