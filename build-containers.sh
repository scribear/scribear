#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-dev}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

# Build provenance, stamped into every image below and reported by its
# /build-info surface, which the admin console's Deployment Check aggregates.
# CI computes the same set in .github/actions/resolve-container-tags.
#
# Worth doing for a local build and not only in CI: the alternative is a table
# of "unknown", which tells an operator nothing and — worse — looks identical
# whether the stack was built here or is simply failing to report. With this,
# a locally-built stack names its real commit and says plainly that it came
# from a machine rather than a published build.
#
# Everything here degrades rather than fails. Building from a tarball with no
# .git, or with git absent entirely, leaves the fields empty and the images
# report "unknown" — the same as they would have without this block.
BUILD_COMMIT=""
BUILD_REF=""
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  BUILD_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  BUILD_REF="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

  # The `git describe --dirty` convention. This is the field that matters most
  # in a local build: an image built from a modified working tree contains code
  # that exists nowhere else, so its commit names a commit it does not hold.
  # Carried on the commit rather than as an arg of its own so that
  # `docker inspect`'s revision label says so too.
  if [ -n "$BUILD_COMMIT" ] && [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
    BUILD_COMMIT="${BUILD_COMMIT}-dirty"
  fi
fi

BUILD_ARGS=(
  --build-arg "BUILD_COMMIT=$BUILD_COMMIT"
  --build-arg "BUILD_REF=$BUILD_REF"
  --build-arg "BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%S+00:00)"
  # The tag this script was asked for. Unlike CI, nothing is published, so this
  # is the local image's name rather than a registry tag - but it is what a
  # deployment puts in IMAGE_TAG, which is the question being answered.
  --build-arg "BUILD_TAGS=$TAG"
  --build-arg "BUILD_PR="
  --build-arg "BUILD_ORIGIN=local"
)

# The version each image reports, from the same file CI reads for it (see
# `version_file` in .github/node-images.json). Per image rather than once per
# run: the root package.json is the private monorepo root at 0.0.0, and
# stamping that into all eleven images would report a version that looks real
# and is not. Unreadable leaves it empty, which reports as "unknown".
image_version() {
  local dir="$1"
  if [ -f "$dir/package.json" ]; then
    node -p "require('$dir/package.json').version" 2>/dev/null || true
  elif [ -f "$dir/pyproject.toml" ]; then
    python3 -c "import sys, tomllib; print(tomllib.load(open(sys.argv[1], 'rb'))['project']['version'])" \
      "$dir/pyproject.toml" 2>/dev/null || true
  fi
}

# `docker build` with this run's provenance and the image's own version.
# Everything after the workspace directory is passed to docker untouched.
build_image() {
  local workspace="$1"
  shift
  docker build "${BUILD_ARGS[@]}" \
    --build-arg "BUILD_VERSION=$(image_version "$workspace")" \
    "$@"
}

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

build_image "$ROOT/apps/node-server"        -f "$ROOT/Dockerfile" --target node-server        "$ROOT" -t "scribear/node-server:$TAG"
build_image "$ROOT/apps/session-manager"    -f "$ROOT/Dockerfile" --target session-manager    "$ROOT" -t "scribear/session-manager:$TAG"
build_image "$ROOT/apps/client-webapp"      -f "$ROOT/Dockerfile" --target client-webapp      "$ROOT" -t "scribear/client-webapp:$TAG"
build_image "$ROOT/apps/standalone-webapp"  -f "$ROOT/Dockerfile" --target standalone-webapp  "$ROOT" -t "scribear/standalone-webapp:$TAG"
build_image "$ROOT/apps/kiosk-webapp"       -f "$ROOT/Dockerfile" --target kiosk-webapp       "$ROOT" -t "scribear/kiosk-webapp:$TAG"
build_image "$ROOT/apps/admin-webapp"       -f "$ROOT/Dockerfile" --target admin-webapp       "$ROOT" -t "scribear/admin-webapp:$TAG"
build_image "$ROOT/apps/admin-server"       -f "$ROOT/Dockerfile" --target admin-server       "$ROOT" -t "scribear/admin-server:$TAG"
build_image "$ROOT/apps/monitoring-sidecar" -f "$ROOT/Dockerfile" --target monitoring-sidecar "$ROOT" -t "scribear/monitoring-sidecar:$TAG"
# Off by default in compose (the `testaudio` profile), but still built: an
# operator who switches the profile on must not also have to build an image.
# Note this one reaches the network during its build, to fetch the public-domain
# longform clip; it falls back to the committed fixtures and still succeeds when
# it cannot.
build_image "$ROOT/apps/test-audio-generator" -f "$ROOT/Dockerfile" --target test-audio-generator "$ROOT" -t "scribear/test-audio-generator:$TAG"

# scribear-db and scribear-redis are the two images with no build provenance:
# Postgres and Redis have no HTTP surface to report it on, so the admin
# console lists them as "not reported" rather than pretending otherwise.
docker build "$ROOT/infra/scribear-db"    -t "scribear/scribear-db:$TAG"
docker build "$ROOT/infra/scribear-redis" -t "scribear/scribear-redis:$TAG"

# From the repository root, unlike its two neighbours above: it shares the
# webapps' build-info generator (tools/build-info) rather than keeping a copy,
# so it needs a context that can reach it.
build_image "$ROOT/infra/scribear-nginx" -f "$ROOT/infra/scribear-nginx/Dockerfile" "$ROOT" -t "scribear/scribear-nginx:$TAG"

build_image "$ROOT/transcription_service" -f "$ROOT/transcription_service/Dockerfile_CPU"  "$ROOT/transcription_service" -t "scribear/transcription-service-cpu:$TAG"

if [ -z "$CUDA_BUILDS" ]; then
  echo "Skipping CUDA images"
else
  while IFS=$'\t' read -r device base_image; do
    [ -n "$device" ] || continue
    echo "Building transcription-service-$device from $base_image"
    build_image "$ROOT/transcription_service" -f "$ROOT/transcription_service/Dockerfile_CUDA" \
      --build-arg "CUDA_BASE_IMAGE=$base_image" \
      "$ROOT/transcription_service" -t "scribear/transcription-service-$device:$TAG"
  done <<< "$CUDA_BUILDS"
fi
