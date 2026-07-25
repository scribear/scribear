# Build in the root directory using:
#   docker build -f apps/node-server/Dockerfile .

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

RUN npm run build --workspace=@scribear/node-server

FROM node:${NODE_VERSION}-alpine3.22

RUN apk add --no-cache dumb-init

WORKDIR /app

COPY --from=package-jsons /app/ .

RUN npm ci --omit=dev

COPY --from=build-env /app/apps/node-server/dist/bundle.mjs /app/apps/node-server/dist/bundle.mjs

WORKDIR /app/apps/node-server

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
