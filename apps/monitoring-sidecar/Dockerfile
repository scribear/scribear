# Build in the root directory using:
#   docker build -f apps/monitoring-sidecar/Dockerfile .

ARG NODE_VERSION=24.10.0

FROM node:${NODE_VERSION} AS package-jsons

WORKDIR /app

COPY . .

RUN find . -type f ! -name "package*.json" -delete && \
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
# ships as a file rather than being bundled; the path matches the
# AUDIO_METER_PATH default, relative to the WORKDIR set below.
COPY --from=build-env /app/apps/monitoring-sidecar/public /app/apps/monitoring-sidecar/public

WORKDIR /app/apps/monitoring-sidecar

ENV HOST=0.0.0.0
ENV PORT=80

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --start-interval=1s --retries=3 CMD wget -qO- http://127.0.0.1:80/api/monitoring/v1/probes/liveness || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/bundle.mjs"]
