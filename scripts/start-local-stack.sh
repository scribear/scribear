#!/usr/bin/env bash
# Postgres + Redis (Docker), DB migrate, then transcription + session-manager + node-server + room-displays.
#
# First run: cp local-dev.env.example local-dev.env
#
# Needs: Docker, Node 24+, npm, uv (recommended) or Python 3.12+ for transcription.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_ENV="$REPO_ROOT/local-dev.env"
COMPOSE_FILE="$REPO_ROOT/docker-compose.local.yml"

if [[ ! -f "$COMPOSE_ENV" ]]; then
  echo "Missing $COMPOSE_ENV"
  echo "Run: cp local-dev.env.example local-dev.env"
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "$COMPOSE_ENV"
set +a

USE_DOCKER=1
if [[ "${SKIP_LOCAL_DOCKER:-}" == "1" ]]; then
  USE_DOCKER=0
  echo "SKIP_LOCAL_DOCKER=1: not starting docker-compose.local.yml (use your own Postgres + Redis)."
elif ! command -v docker >/dev/null 2>&1; then
  USE_DOCKER=0
  echo "Docker not found: skipping docker-compose.local.yml (use SKIP_LOCAL_DOCKER=1 explicitly next time, or install Docker for bundled Postgres + Redis)."
fi

if [[ "$USE_DOCKER" == "1" ]]; then
  docker compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV" up -d

  echo "Waiting for Postgres..."
  until docker exec scribear-local-postgres pg_isready -U "${COMPOSE_POSTGRES_USER}" -d "${COMPOSE_POSTGRES_DB}" >/dev/null 2>&1; do
    sleep 1
  done
fi

echo "Running migrations..."
(
  cd "$REPO_ROOT/infra/scribear-db"
  DB_HOST=localhost \
  DB_PORT="${COMPOSE_POSTGRES_PORT:-5432}" \
  DB_NAME="${COMPOSE_POSTGRES_DB}" \
  DB_USER="${COMPOSE_POSTGRES_USER}" \
  DB_PASSWORD="${COMPOSE_POSTGRES_PASSWORD}" \
    npm run migrate:up
) || {
  echo "migrate:up failed — check Postgres is reachable at localhost:${COMPOSE_POSTGRES_PORT:-5432} and credentials in local-dev.env"
  exit 1
}

REDIS_URL="redis://:${COMPOSE_REDIS_PASSWORD}@localhost:${COMPOSE_REDIS_PORT:-6379}"

_env_has_key() {
  [[ -f "$1" ]] && grep -q "^$2=" "$1"
}

bootstrap_sm_env() {
  local f="$REPO_ROOT/apps/session-manager/.env"
  if _env_has_key "$f" REDIS_URL; then
    return 0
  fi
  echo "Writing $f (from local-dev.env)"
  cat >"$f" <<EOF
LOG_LEVEL=info
HOST=0.0.0.0
PORT=8001
API_KEY=${API_KEY}
JWT_SECRET=${JWT_SECRET}
DB_HOST=localhost
DB_PORT=${COMPOSE_POSTGRES_PORT:-5432}
DB_NAME=${COMPOSE_POSTGRES_DB}
DB_USER=${COMPOSE_POSTGRES_USER}
DB_PASSWORD=${COMPOSE_POSTGRES_PASSWORD}
REDIS_URL=${REDIS_URL}
NODE_SERVER_KEY=${NODE_SERVER_KEY}
EOF
}

bootstrap_ns_env() {
  local f="$REPO_ROOT/apps/node-server/.env"
  if _env_has_key "$f" REDIS_URL && _env_has_key "$f" SESSION_MANAGER_ADDRESS; then
    return 0
  fi
  echo "Writing $f (from local-dev.env)"
  cat >"$f" <<EOF
LOG_LEVEL=info
HOST=0.0.0.0
PORT=8002
JWT_SECRET=${JWT_SECRET}
TRANSCRIPTION_SERVICE_ADDRESS=http://localhost:8000
TRANSCRIPTION_SERVICE_API_KEY=${TRANSCRIPTION_API_KEY}
REDIS_URL=${REDIS_URL}
NODE_SERVER_KEY=${NODE_SERVER_KEY}
SESSION_MANAGER_ADDRESS=http://localhost:8001
EOF
}

bootstrap_ts_env() {
  local f="$REPO_ROOT/transcription_service/.env"
  local port_val=""
  [[ -f "$f" ]] && port_val="$(grep '^PORT=' "$f" | head -1 | cut -d= -f2 | tr -d ' \r')"
  if [[ "$port_val" == "8000" ]] && _env_has_key "$f" API_KEY && ! grep -q '^API_KEY=CHANGEME' "$f" 2>/dev/null; then
    return 0
  fi
  echo "Writing $f (from local-dev.env)"
  cat >"$f" <<EOF
LOG_LEVEL=info
HOST=0.0.0.0
PORT=8000
API_KEY=${TRANSCRIPTION_API_KEY}
WS_INIT_TIMEOUT_SEC=2.5
PROVIDER_CONFIG_PATH=./provider_config.json
EOF
}

bootstrap_db_tooling_env() {
  local f="$REPO_ROOT/infra/scribear-db/.env"
  if _env_has_key "$f" DB_PASSWORD; then
    return 0
  fi
  echo "Writing $f (from local-dev.env)"
  cat >"$f" <<EOF
DB_HOST=localhost
DB_PORT=${COMPOSE_POSTGRES_PORT:-5432}
DB_NAME=${COMPOSE_POSTGRES_DB}
DB_USER=${COMPOSE_POSTGRES_USER}
DB_PASSWORD=${COMPOSE_POSTGRES_PASSWORD}
EOF
}

bootstrap_room_displays_env() {
  local f="$REPO_ROOT/apps/room-displays/.env"
  if _env_has_key "$f" VITE_SESSION_MANAGER_API_KEY; then
    return 0
  fi
  echo "Writing $f (from local-dev.env)"
  cat >"$f" <<EOF
VITE_SESSION_MANAGER_API_KEY=${API_KEY}
EOF
}

bootstrap_db_tooling_env
bootstrap_sm_env
bootstrap_ns_env
bootstrap_ts_env
bootstrap_room_displays_env

if ! command -v npx >/dev/null 2>&1; then
  echo "npx not found"
  exit 1
fi

if command -v uv >/dev/null 2>&1; then
  TS_CMD="cd $REPO_ROOT/transcription_service && uv run python -m src.index --dev"
elif command -v python3 >/dev/null 2>&1; then
  TS_VENV="$REPO_ROOT/transcription_service/.venv"
  ts_pip_install() {
    "$TS_VENV/bin/pip" install -U pip
    # silero-vad-cpu needs torch from PyTorch CPU index (same as uv config in pyproject.toml)
    "$TS_VENV/bin/pip" install \
      --extra-index-url https://download.pytorch.org/whl/cpu \
      -e "$REPO_ROOT/transcription_service[faster-whisper,silero-vad-cpu]"
  }
  if [[ ! -x "$TS_VENV/bin/python" ]]; then
    echo "Transcription: creating $TS_VENV and installing deps (whisper + silero CPU)..."
    python3 -m venv "$TS_VENV"
    ts_pip_install
  elif ! "$TS_VENV/bin/python" -c "import uvicorn, faster_whisper, torch" >/dev/null 2>&1; then
    echo "Transcription: syncing venv deps..."
    ts_pip_install
  fi
  TS_CMD="cd $REPO_ROOT/transcription_service && $TS_VENV/bin/python -m src.index --dev"
else
  echo "Install uv (https://docs.astral.sh/uv/) or Python 3.12+ for the transcription service."
  exit 1
fi

echo ""
echo "URLs:"
echo "  Room host:     http://localhost:3004/host"
echo "  Room display:  http://localhost:3004/display"
echo ""

exec npx concurrently -k \
  --names "ts,sm,ns,fe" \
  --prefix-colors "magenta,blue,green,yellow" \
  "$TS_CMD" \
  "npm run dev --workspace @scribear/session-manager" \
  "npm run dev --workspace @scribear/node-server" \
  "npm run dev --workspace @scribear/room-displays"
