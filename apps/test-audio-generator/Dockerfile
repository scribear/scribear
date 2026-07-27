# Build in the root directory using:
#   docker build -f apps/test-audio-generator/Dockerfile .

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

RUN npm run build --workspace=@scribear/test-audio-generator

# The `longform` clip (PLAN-TestAudioDevices §2.1), built here rather than
# committed: five minutes of 16 kHz mono WAV is ~9.6 MB of derived audio and does
# not belong in git.
#
# It downloads a public-domain recording, and falls back to concatenating the two
# committed fixtures when it cannot — a build host with no egress is a normal
# case, not a failure, and the script says in its output which of the two
# happened. `|| true` is deliberately NOT used: the script already exits 0 for a
# failed download, so a non-zero exit here means it could not produce a clip at
# all, which means the committed fixtures are missing and the image is broken.
#
# This step is an optimization, not a requirement. ClipCatalogService builds the
# clip on first use if it is absent; doing it here only decides who waits.
RUN npm run build:longform --workspace=@scribear/test-audio-generator

FROM node:${NODE_VERSION}-alpine3.22

RUN apk add --no-cache dumb-init

WORKDIR /app

COPY --from=package-jsons /app/ .

RUN npm ci --omit=dev

COPY --from=build-env /app/apps/test-audio-generator/dist/bundle.mjs /app/apps/test-audio-generator/dist/bundle.mjs

# The two committed fixtures, ~2.6 MB. They ship with the image rather than being
# mounted for the same reason the canary's do: a device whose audio file is
# missing from the host would fail every run and report a pipeline fault that does
# not exist. The paths match the TEST_AUDIO_HARVARD_PATH / TEST_AUDIO_APOLLO_PATH
# defaults in app-config.ts.
COPY --from=build-env /app/test_audio_files/speech /app/test_audio_files/speech

# The longform clip built above. A separate COPY from its own directory so that a
# build which fell back still ships a working clip, and so this layer — the only
# large one that changes with the source recording — is cached independently.
COPY --from=build-env /app/test_audio_files/longform /app/test_audio_files/longform

WORKDIR /app/apps/test-audio-generator

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

ENV SCRIBEAR_BUILD_SERVICE=test-audio-generator \
    SCRIBEAR_BUILD_COMMIT=${BUILD_COMMIT} \
    SCRIBEAR_BUILD_REF=${BUILD_REF} \
    SCRIBEAR_BUILD_TIME=${BUILD_TIME} \
    SCRIBEAR_BUILD_VERSION=${BUILD_VERSION} \
    SCRIBEAR_BUILD_TAGS=${BUILD_TAGS} \
    SCRIBEAR_BUILD_PR=${BUILD_PR} \
    SCRIBEAR_BUILD_ORIGIN=${BUILD_ORIGIN}

LABEL org.opencontainers.image.title="scribear/test-audio-generator" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.scribear.build.pull-request="${BUILD_PR}" \
      org.scribear.build.origin="${BUILD_ORIGIN}"

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --start-interval=1s --retries=3 CMD wget -qO- http://127.0.0.1:80/api/test-audio/v1/probes/liveness || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/bundle.mjs"]
