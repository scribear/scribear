#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-dev}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

# One CUDA image per entry in transcription_service/cuda-variants.json, named
# for the value a deployment puts in TRANSCRIPTION_DEVICE. CI builds the same
# list in parallel (.github/workflows/python-{ci,cd}.yml via the
# transcription-image-matrix action), so the manifest is the only place a CUDA
# version is declared.
#
# These are the slowest, largest images built here. Set CUDA_VARIANTS to a
# subset (space- or comma-separated device names) to build only what you need:
#   CUDA_VARIANTS=cuda128 ./build-containers.sh dev
#   CUDA_VARIANTS=none    ./build-containers.sh dev   # skip them entirely
#
# Resolved before any build runs, so a typo fails in a second rather than after
# every other image has been rebuilt.
CUDA_BUILDS=""
if [ "${CUDA_VARIANTS:-}" != "none" ]; then
  CUDA_BUILDS="$(SELECTED="${CUDA_VARIANTS:-}" python3 - "$ROOT/transcription_service/cuda-variants.json" <<'PY'
import json, os, sys

with open(sys.argv[1], encoding="utf-8") as variants_file:
    variants = json.load(variants_file)

selected = os.environ.get("SELECTED", "").replace(",", " ").split()
if selected:
    known = {variant["device"] for variant in variants}
    unknown = [name for name in selected if name not in known]
    if unknown:
        sys.exit(f"Unknown CUDA_VARIANTS: {' '.join(unknown)} (known: {' '.join(sorted(known))})")
    variants = [variant for variant in variants if variant["device"] in selected]

for variant in variants:
    print(variant["device"], variant["base_image"], sep="\t")
PY
)"
fi

docker build -f "$ROOT/apps/node-server/Dockerfile"       "$ROOT" -t "scribear/node-server:$TAG"
docker build -f "$ROOT/apps/session-manager/Dockerfile"    "$ROOT" -t "scribear/session-manager:$TAG"
docker build -f "$ROOT/apps/client-webapp/Dockerfile"      "$ROOT" -t "scribear/client-webapp:$TAG"
docker build -f "$ROOT/apps/standalone-webapp/Dockerfile"  "$ROOT" -t "scribear/standalone-webapp:$TAG"
docker build -f "$ROOT/apps/kiosk-webapp/Dockerfile"       "$ROOT" -t "scribear/kiosk-webapp:$TAG"
docker build -f "$ROOT/apps/admin-webapp/Dockerfile"       "$ROOT" -t "scribear/admin-webapp:$TAG"
docker build -f "$ROOT/apps/admin-server/Dockerfile"       "$ROOT" -t "scribear/admin-server:$TAG"
docker build -f "$ROOT/apps/monitoring-sidecar/Dockerfile" "$ROOT" -t "scribear/monitoring-sidecar:$TAG"

docker build "$ROOT/infra/scribear-db"    -t "scribear/scribear-db:$TAG"
docker build "$ROOT/infra/scribear-nginx" -t "scribear/scribear-nginx:$TAG"
docker build "$ROOT/infra/scribear-redis" -t "scribear/scribear-redis:$TAG"

docker build -f "$ROOT/transcription_service/Dockerfile_CPU"  "$ROOT/transcription_service" -t "scribear/transcription-service-cpu:$TAG"

if [ -z "$CUDA_BUILDS" ]; then
  echo "Skipping CUDA images"
else
  while IFS=$'\t' read -r device base_image; do
    [ -n "$device" ] || continue
    echo "Building transcription-service-$device from $base_image"
    docker build -f "$ROOT/transcription_service/Dockerfile_CUDA" \
      --build-arg "CUDA_BASE_IMAGE=$base_image" \
      "$ROOT/transcription_service" -t "scribear/transcription-service-$device:$TAG"
  done <<< "$CUDA_BUILDS"
fi
