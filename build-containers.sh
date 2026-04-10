#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-dev}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

docker build -f "$ROOT/apps/node-server/Dockerfile"       "$ROOT" -t "scribear/node-server:$TAG"
docker build -f "$ROOT/apps/session-manager/Dockerfile"    "$ROOT" -t "scribear/session-manager:$TAG"
docker build -f "$ROOT/apps/client-webapp/Dockerfile"      "$ROOT" -t "scribear/client-webapp:$TAG"
docker build -f "$ROOT/apps/standalone-webapp/Dockerfile"  "$ROOT" -t "scribear/standalone-webapp:$TAG"
docker build -f "$ROOT/apps/kiosk-webapp/Dockerfile"       "$ROOT" -t "scribear/kiosk-webapp:$TAG"

docker build "$ROOT/infra/scribear-db"    -t "scribear/scribear-db:$TAG"
docker build "$ROOT/infra/scribear-nginx" -t "scribear/scribear-nginx:$TAG"

docker build -f "$ROOT/transcription_service/Dockerfile_CPU"  "$ROOT/transcription_service" -t "scribear/transcription-service-cpu:$TAG"
docker build -f "$ROOT/transcription_service/Dockerfile_CUDA" "$ROOT/transcription_service" -t "scribear/transcription-service-cuda:$TAG"
