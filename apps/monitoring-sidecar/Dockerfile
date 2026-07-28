# Build in the root directory using:
#   docker build -f apps/monitoring-sidecar/Dockerfile .

ARG NODE_VERSION=24.10.0

FROM node:${NODE_VERSION} AS package-jsons

WORKDIR /app

COPY . .

# Keep only what `npm ci` reads, so its layer is keyed on dependency changes
# rather than on every source edit. Anything left off this list (a
# .puppeteerrc.cjs, patch files, `file:` dep targets) is dropped silently and
# will not apply to image builds. `! -type d` rather than `-type f` so that
# symlinks are pruned too.
RUN find . ! -type d \
  ! -name "package.json" ! -name "package-lock.json" ! -name ".npmrc" \
  -delete && \
  find . -empty -type d -delete

FROM node:${NODE_VERSION} AS build-env

WORKDIR /app

COPY --from=package-jsons /app/ .

RUN npm ci

COPY . .

RUN npm run build --workspace=@scribear/monitoring-sidecar

FROM node:${NODE_VERSION}-alpine3.22

RUN apk add --no-cache dumb-init

WORKDIR /app

COPY --from=package-jsons /app/ .

RUN npm ci --omit=dev

COPY --from=build-env /app/apps/monitoring-sidecar/dist/bundle.mjs /app/apps/monitoring-sidecar/dist/bundle.mjs

# Fixture audio and its reference transcript for the synthetic canary (A2).
# The canary streams these into a live session, so they ship with the image
# rather than being mounted: a canary whose audio file is missing from the host
# would fail every probe and report a pipeline outage that does not exist.
# ~2.6 MB, and the paths match the CANARY_AUDIO_PATH / CANARY_TRANSCRIPT_PATH
# defaults in app-config.ts.
COPY --from=build-env /app/test_audio_files/speech /app/test_audio_files/speech

# The standalone audio meter page (A4). Self-contained and served as-is, so it
# ships as a file rather than being bundled. Lives in the shared
# libs/audio-meter-page/ directory so admin-webapp can serve the same file; the
# path matches the AUDIO_METER_PATH default, relative to the WORKDIR set below.
COPY --from=build-env /app/libs/audio-meter-page /app/libs/audio-meter-page

WORKDIR /app/apps/monitoring-sidecar

ENV HOST=0.0.0.0
ENV PORT=80

# Build provenance. Baked in here and reported at runtime by GET /build-info,
# which the admin console's Deployment Check aggregates across the whole stack —
# it is how an operator confirms every container came from one commit. Empty
# defaults so a plain `docker build` still works and reports "unknown" rather
# than failing; CI and build-containers.sh supply the real values. Last in the
# file because these change on every commit and nothing expensive may sit below
# them.
ARG BUILD_COMMIT=""
ARG BUILD_REF=""
ARG BUILD_TIME=""
ARG BUILD_VERSION=""
ARG BUILD_TAGS=""
ARG BUILD_PR=""
ARG BUILD_ORIGIN=""

ENV SCRIBEAR_BUILD_SERVICE=monitoring-sidecar \
    SCRIBEAR_BUILD_COMMIT=${BUILD_COMMIT} \
    SCRIBEAR_BUILD_REF=${BUILD_REF} \
    SCRIBEAR_BUILD_TIME=${BUILD_TIME} \
    SCRIBEAR_BUILD_VERSION=${BUILD_VERSION} \
    SCRIBEAR_BUILD_TAGS=${BUILD_TAGS} \
    SCRIBEAR_BUILD_PR=${BUILD_PR} \
    SCRIBEAR_BUILD_ORIGIN=${BUILD_ORIGIN}

LABEL org.opencontainers.image.title="scribear/monitoring-sidecar" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.scribear.build.pull-request="${BUILD_PR}" \
      org.scribear.build.origin="${BUILD_ORIGIN}"

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --start-interval=1s --retries=3 CMD wget -qO- http://127.0.0.1:80/api/monitoring/v1/probes/liveness || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/bundle.mjs"]
