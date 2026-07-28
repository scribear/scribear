# Every Node image in this repo, as one multi-stage build. Build a specific
# image by its target name, from the repo root:
#
#   docker build --target admin-server -t scribear/admin-server .
#
# The targets are named after the images: admin-server, admin-webapp,
# client-webapp, kiosk-webapp, monitoring-sidecar, node-server, session-manager,
# standalone-webapp, test-audio-generator. .github/node-images.json is the
# authoritative list, and build-containers.sh builds them all.
#
# This used to be nine near-identical apps/*/Dockerfile files. They shared four
# things and drifted on none of them by luck rather than by construction - a
# change to any shared stage was a nine-file edit that was easy to do
# incompletely. Consolidating makes the shared parts single-sourced:
#
#   package-jsons  the manifest-only prune, 9 copies -> 1
#   build-env      `npm ci` plus the source tree, 9 -> 1
#   node-runtime   `npm ci --omit=dev` on alpine, 5 -> 1
#   webapp-runtime the SPA nginx config, 4 -> 1
#
# What is deliberately NOT shared is each image's final stage. The build
# provenance block has to be the last thing in a stage (see the comment on it
# below), so hoisting it into a base would put every image's expensive COPY
# underneath args that change on every commit. Each final stage is therefore
# still written out in full, and reads as its own image.
#
# BuildKit only builds the stages a target actually depends on, so
# `--target node-server` never touches the webapp stages.

ARG NODE_VERSION=24.10.0

# ─────────────────────────────────────────────────────────────────────────────
# Shared build stages
# ─────────────────────────────────────────────────────────────────────────────

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

# Dependencies plus the full source tree. Every per-app build stage below starts
# here, so `npm ci` runs once for the whole file instead of once per image.
FROM node:${NODE_VERSION} AS build-env

WORKDIR /app

COPY --from=package-jsons /app/ .

RUN npm ci

COPY . .

# Production dependencies on the runtime base, shared by every Node service.
FROM node:${NODE_VERSION}-alpine3.22 AS node-runtime

RUN apk add --no-cache dumb-init

WORKDIR /app

COPY --from=package-jsons /app/ .

RUN npm ci --omit=dev

# nginx plus the SPA config, shared by every webapp. The config is identical for
# all four; only the built assets copied over it differ.
FROM nginx:1.29.7-alpine3.23 AS webapp-runtime

WORKDIR /usr/share/nginx/html

RUN cat <<'EOF' > /etc/nginx/conf.d/default.conf
server {
  listen 80;
  server_name _;

  root /usr/share/nginx/html;
  index index.html;

  # SPA fallback: `location /` (not `location *`, which nginx reads as a prefix
  # match on the literal "*" and so never matches, 404-ing every deep link on a
  # hard refresh). try_files serves the file if it exists, else index.html so
  # the client-side router can handle the route.
  location / {
    try_files $uri $uri/ /index.html;
  }

  location = /healthcheck {
    access_log off;
    add_header Content-Type text/plain;
    return 200 'ok';
  }
}
EOF

# Writes the build-info.json a webapp serves in place of the GET /build-info a
# Node service answers. Copied once here; each webapp stage runs it and removes
# it, so it never reaches a published image.
COPY tools/build-info/write-build-info.sh /tmp/write-build-info.sh

# ─────────────────────────────────────────────────────────────────────────────
# Per-app build stages
# ─────────────────────────────────────────────────────────────────────────────

FROM build-env AS build-admin-server
RUN npm run build --workspace=@scribear/admin-server

FROM build-env AS build-admin-webapp
RUN npm run build --workspace=@scribear/admin-webapp

FROM build-env AS build-client-webapp
RUN npm run build --workspace=@scribear/client-webapp

FROM build-env AS build-kiosk-webapp
RUN npm run build --workspace=@scribear/kiosk-webapp

FROM build-env AS build-monitoring-sidecar
RUN npm run build --workspace=@scribear/monitoring-sidecar

FROM build-env AS build-node-server
RUN npm run build --workspace=@scribear/node-server

FROM build-env AS build-session-manager
RUN npm run build --workspace=@scribear/session-manager

FROM build-env AS build-standalone-webapp
RUN npm run build --workspace=@scribear/standalone-webapp

FROM build-env AS build-test-audio-generator
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

# ─────────────────────────────────────────────────────────────────────────────
# admin-server
# ─────────────────────────────────────────────────────────────────────────────

FROM node-runtime AS admin-server

COPY --from=build-admin-server /app/apps/admin-server/dist/bundle.mjs /app/apps/admin-server/dist/bundle.mjs

WORKDIR /app/apps/admin-server

ENV HOST=0.0.0.0
ENV PORT=80

# Build provenance. Baked in here and reported at runtime by GET /build-info,
# which the admin console's Deployment Check aggregates across the whole stack —
# it is how an operator confirms every container came from one commit. Empty
# defaults so a plain `docker build` still works and simply reports "unknown";
# CI and build-containers.sh supply the real values. Last in the stage because
# these change on every commit and nothing expensive may sit below them.
ARG BUILD_COMMIT=""
ARG BUILD_REF=""
ARG BUILD_TIME=""
ARG BUILD_VERSION=""
ARG BUILD_TAGS=""
ARG BUILD_PR=""
ARG BUILD_ORIGIN=""

ENV SCRIBEAR_BUILD_SERVICE=admin-server \
    SCRIBEAR_BUILD_COMMIT=${BUILD_COMMIT} \
    SCRIBEAR_BUILD_REF=${BUILD_REF} \
    SCRIBEAR_BUILD_TIME=${BUILD_TIME} \
    SCRIBEAR_BUILD_VERSION=${BUILD_VERSION} \
    SCRIBEAR_BUILD_TAGS=${BUILD_TAGS} \
    SCRIBEAR_BUILD_PR=${BUILD_PR} \
    SCRIBEAR_BUILD_ORIGIN=${BUILD_ORIGIN}

LABEL org.opencontainers.image.title="scribear/admin-server" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.scribear.build.pull-request="${BUILD_PR}" \
      org.scribear.build.origin="${BUILD_ORIGIN}"

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --start-interval=1s --retries=3 CMD wget -qO- http://127.0.0.1:80/api/admin/v1/probes/liveness || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/bundle.mjs"]

# ─────────────────────────────────────────────────────────────────────────────
# monitoring-sidecar
# ─────────────────────────────────────────────────────────────────────────────

FROM node-runtime AS monitoring-sidecar

COPY --from=build-monitoring-sidecar /app/apps/monitoring-sidecar/dist/bundle.mjs /app/apps/monitoring-sidecar/dist/bundle.mjs

# Fixture audio and its reference transcript for the synthetic canary (A2).
# The canary streams these into a live session, so they ship with the image
# rather than being mounted: a canary whose audio file is missing from the host
# would fail every probe and report a pipeline outage that does not exist.
# ~2.6 MB, and the paths match the CANARY_AUDIO_PATH / CANARY_TRANSCRIPT_PATH
# defaults in app-config.ts.
COPY --from=build-monitoring-sidecar /app/test_audio_files/speech /app/test_audio_files/speech

# The standalone audio meter page (A4). Self-contained and served as-is, so it
# ships as a file rather than being bundled. Lives in the shared
# libs/audio-meter-page/ directory so admin-webapp can serve the same file; the
# path matches the AUDIO_METER_PATH default, relative to the WORKDIR set below.
COPY --from=build-monitoring-sidecar /app/libs/audio-meter-page /app/libs/audio-meter-page

WORKDIR /app/apps/monitoring-sidecar

ENV HOST=0.0.0.0
ENV PORT=80

# Build provenance. Baked in here and reported at runtime by GET /build-info,
# which the admin console's Deployment Check aggregates across the whole stack —
# it is how an operator confirms every container came from one commit. Empty
# defaults so a plain `docker build` still works and reports "unknown" rather
# than failing; CI and build-containers.sh supply the real values. Last in the
# stage because these change on every commit and nothing expensive may sit below
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

# ─────────────────────────────────────────────────────────────────────────────
# node-server
# ─────────────────────────────────────────────────────────────────────────────

FROM node-runtime AS node-server

COPY --from=build-node-server /app/apps/node-server/dist/bundle.mjs /app/apps/node-server/dist/bundle.mjs

WORKDIR /app/apps/node-server

ENV HOST=0.0.0.0
ENV PORT=80

# Build provenance. Baked in here and reported at runtime by GET /build-info,
# which the admin console's Deployment Check aggregates across the whole stack —
# it is how an operator confirms every container came from one commit. Empty
# defaults so a plain `docker build` still works and reports "unknown" rather
# than failing; CI and build-containers.sh supply the real values. Last in the
# stage because these change on every commit and nothing expensive may sit below
# them.
ARG BUILD_COMMIT=""
ARG BUILD_REF=""
ARG BUILD_TIME=""
ARG BUILD_VERSION=""
ARG BUILD_TAGS=""
ARG BUILD_PR=""
ARG BUILD_ORIGIN=""

ENV SCRIBEAR_BUILD_SERVICE=node-server \
    SCRIBEAR_BUILD_COMMIT=${BUILD_COMMIT} \
    SCRIBEAR_BUILD_REF=${BUILD_REF} \
    SCRIBEAR_BUILD_TIME=${BUILD_TIME} \
    SCRIBEAR_BUILD_VERSION=${BUILD_VERSION} \
    SCRIBEAR_BUILD_TAGS=${BUILD_TAGS} \
    SCRIBEAR_BUILD_PR=${BUILD_PR} \
    SCRIBEAR_BUILD_ORIGIN=${BUILD_ORIGIN}

LABEL org.opencontainers.image.title="scribear/node-server" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.scribear.build.pull-request="${BUILD_PR}" \
      org.scribear.build.origin="${BUILD_ORIGIN}"

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --start-interval=1s --retries=3 CMD wget -qO- http://127.0.0.1:80/api/node-server/v1/probes/liveness || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/bundle.mjs"]

# ─────────────────────────────────────────────────────────────────────────────
# session-manager
# ─────────────────────────────────────────────────────────────────────────────

FROM node-runtime AS session-manager

# bundle.mjs is the server; migrate.mjs is the one-shot schema migrator this
# image doubles as, run by deployment/compose.yml's `db-migrate` service. Both
# come from the same build, which is the point: the schema is applied from the
# same pinned artifact that queries it.
COPY --from=build-session-manager /app/apps/session-manager/dist/bundle.mjs /app/apps/session-manager/dist/bundle.mjs
COPY --from=build-session-manager /app/apps/session-manager/dist/migrate.mjs /app/apps/session-manager/dist/migrate.mjs

WORKDIR /app/apps/session-manager

ENV HOST=0.0.0.0
ENV PORT=80

# Build provenance. Baked in here and reported at runtime by GET /build-info,
# which the admin console's Deployment Check aggregates across the whole stack —
# it is how an operator confirms every container came from one commit. Empty
# defaults so a plain `docker build` still works and simply reports "unknown";
# CI and build-containers.sh supply the real values. Last in the stage because
# these change on every commit and nothing expensive may sit below them.
ARG BUILD_COMMIT=""
ARG BUILD_REF=""
ARG BUILD_TIME=""
ARG BUILD_VERSION=""
ARG BUILD_TAGS=""
ARG BUILD_PR=""
ARG BUILD_ORIGIN=""

ENV SCRIBEAR_BUILD_SERVICE=session-manager \
    SCRIBEAR_BUILD_COMMIT=${BUILD_COMMIT} \
    SCRIBEAR_BUILD_REF=${BUILD_REF} \
    SCRIBEAR_BUILD_TIME=${BUILD_TIME} \
    SCRIBEAR_BUILD_VERSION=${BUILD_VERSION} \
    SCRIBEAR_BUILD_TAGS=${BUILD_TAGS} \
    SCRIBEAR_BUILD_PR=${BUILD_PR} \
    SCRIBEAR_BUILD_ORIGIN=${BUILD_ORIGIN}

LABEL org.opencontainers.image.title="scribear/session-manager" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.scribear.build.pull-request="${BUILD_PR}" \
      org.scribear.build.origin="${BUILD_ORIGIN}"

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --start-interval=1s --retries=3 CMD wget -qO- http://127.0.0.1:80/api/session-manager/v1/probes/liveness || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/bundle.mjs"]

# ─────────────────────────────────────────────────────────────────────────────
# test-audio-generator
# ─────────────────────────────────────────────────────────────────────────────

FROM node-runtime AS test-audio-generator

COPY --from=build-test-audio-generator /app/apps/test-audio-generator/dist/bundle.mjs /app/apps/test-audio-generator/dist/bundle.mjs

# The two committed fixtures, ~2.6 MB. They ship with the image rather than being
# mounted for the same reason the canary's do: a device whose audio file is
# missing from the host would fail every run and report a pipeline fault that does
# not exist. The paths match the TEST_AUDIO_HARVARD_PATH / TEST_AUDIO_APOLLO_PATH
# defaults in app-config.ts.
COPY --from=build-test-audio-generator /app/test_audio_files/speech /app/test_audio_files/speech

# The longform clip built above. A separate COPY from its own directory so that a
# build which fell back still ships a working clip, and so this layer — the only
# large one that changes with the source recording — is cached independently.
COPY --from=build-test-audio-generator /app/test_audio_files/longform /app/test_audio_files/longform

WORKDIR /app/apps/test-audio-generator

ENV HOST=0.0.0.0
ENV PORT=80

# Build provenance. Baked in here and reported at runtime by GET /build-info,
# which the admin console's Deployment Check aggregates across the whole stack —
# it is how an operator confirms every container came from one commit. Empty
# defaults so a plain `docker build` still works and reports "unknown" rather
# than failing; CI and build-containers.sh supply the real values. Last in the
# stage because these change on every commit and nothing expensive may sit below
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

# ─────────────────────────────────────────────────────────────────────────────
# admin-webapp
# ─────────────────────────────────────────────────────────────────────────────

FROM webapp-runtime AS admin-webapp

COPY --from=build-admin-webapp /app/apps/admin-webapp/dist/ ./

# Build provenance. A webapp is static files behind nginx, so there is no
# process to ask: the same document the Node services answer GET /build-info
# with is generated here at image build time and served as a file. The admin
# console's Deployment Check reads it from every container, which is how an
# operator confirms the whole stack came from one commit.
#
# Empty defaults so a plain `docker build` still works and reports "unknown"
# rather than failing; CI and build-containers.sh supply the real values. Last
# in the stage because these change on every commit and nothing expensive may
# sit below them.
ARG BUILD_COMMIT=""
ARG BUILD_REF=""
ARG BUILD_TIME=""
ARG BUILD_VERSION=""
ARG BUILD_TAGS=""
ARG BUILD_PR=""
ARG BUILD_ORIGIN=""

RUN sh /tmp/write-build-info.sh admin-webapp /usr/share/nginx/html/build-info.json \
  && rm /tmp/write-build-info.sh

LABEL org.opencontainers.image.title="scribear/admin-webapp" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.scribear.build.pull-request="${BUILD_PR}" \
      org.scribear.build.origin="${BUILD_ORIGIN}"

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --start-interval=1s --retries=3 CMD wget --quiet --tries=1 --spider http://127.0.0.1/healthcheck || exit 1

# ─────────────────────────────────────────────────────────────────────────────
# client-webapp
# ─────────────────────────────────────────────────────────────────────────────

FROM webapp-runtime AS client-webapp

COPY --from=build-client-webapp /app/apps/client-webapp/dist/ ./

# Build provenance. A webapp is static files behind nginx, so there is no
# process to ask: the same document the Node services answer GET /build-info
# with is generated here at image build time and served as a file. The admin
# console's Deployment Check reads it from every container, which is how an
# operator confirms the whole stack came from one commit.
#
# Empty defaults so a plain `docker build` still works and reports "unknown"
# rather than failing; CI and build-containers.sh supply the real values. Last
# in the stage because these change on every commit and nothing expensive may
# sit below them.
ARG BUILD_COMMIT=""
ARG BUILD_REF=""
ARG BUILD_TIME=""
ARG BUILD_VERSION=""
ARG BUILD_TAGS=""
ARG BUILD_PR=""
ARG BUILD_ORIGIN=""

RUN sh /tmp/write-build-info.sh client-webapp /usr/share/nginx/html/build-info.json \
  && rm /tmp/write-build-info.sh

LABEL org.opencontainers.image.title="scribear/client-webapp" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.scribear.build.pull-request="${BUILD_PR}" \
      org.scribear.build.origin="${BUILD_ORIGIN}"

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --start-interval=1s --retries=3 CMD wget --quiet --tries=1 --spider http://127.0.0.1/healthcheck || exit 1

# ─────────────────────────────────────────────────────────────────────────────
# kiosk-webapp
# ─────────────────────────────────────────────────────────────────────────────

FROM webapp-runtime AS kiosk-webapp

COPY --from=build-kiosk-webapp /app/apps/kiosk-webapp/dist/ ./

# Build provenance. A webapp is static files behind nginx, so there is no
# process to ask: the same document the Node services answer GET /build-info
# with is generated here at image build time and served as a file. The admin
# console's Deployment Check reads it from every container, which is how an
# operator confirms the whole stack came from one commit.
#
# Empty defaults so a plain `docker build` still works and reports "unknown"
# rather than failing; CI and build-containers.sh supply the real values. Last
# in the stage because these change on every commit and nothing expensive may
# sit below them.
ARG BUILD_COMMIT=""
ARG BUILD_REF=""
ARG BUILD_TIME=""
ARG BUILD_VERSION=""
ARG BUILD_TAGS=""
ARG BUILD_PR=""
ARG BUILD_ORIGIN=""

RUN sh /tmp/write-build-info.sh kiosk-webapp /usr/share/nginx/html/build-info.json \
  && rm /tmp/write-build-info.sh

LABEL org.opencontainers.image.title="scribear/kiosk-webapp" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.scribear.build.pull-request="${BUILD_PR}" \
      org.scribear.build.origin="${BUILD_ORIGIN}"

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --start-interval=1s --retries=3 CMD wget --quiet --tries=1 --spider http://127.0.0.1/healthcheck || exit 1

# ─────────────────────────────────────────────────────────────────────────────
# standalone-webapp
# ─────────────────────────────────────────────────────────────────────────────

FROM webapp-runtime AS standalone-webapp

COPY --from=build-standalone-webapp /app/apps/standalone-webapp/dist/ ./

# Build provenance. A webapp is static files behind nginx, so there is no
# process to ask: the same document the Node services answer GET /build-info
# with is generated here at image build time and served as a file. The admin
# console's Deployment Check reads it from every container, which is how an
# operator confirms the whole stack came from one commit.
#
# Empty defaults so a plain `docker build` still works and reports "unknown"
# rather than failing; CI and build-containers.sh supply the real values. Last
# in the stage because these change on every commit and nothing expensive may
# sit below them.
ARG BUILD_COMMIT=""
ARG BUILD_REF=""
ARG BUILD_TIME=""
ARG BUILD_VERSION=""
ARG BUILD_TAGS=""
ARG BUILD_PR=""
ARG BUILD_ORIGIN=""

RUN sh /tmp/write-build-info.sh standalone-webapp /usr/share/nginx/html/build-info.json \
  && rm /tmp/write-build-info.sh

LABEL org.opencontainers.image.title="scribear/standalone-webapp" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.scribear.build.pull-request="${BUILD_PR}" \
      org.scribear.build.origin="${BUILD_ORIGIN}"

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --start-interval=1s --retries=3 CMD wget --quiet --tries=1 --spider http://127.0.0.1/healthcheck || exit 1
