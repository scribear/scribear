# Build in the root directory using:
#   docker build -f apps/admin-webapp/Dockerfile .

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

RUN npm run build --workspace=@scribear/admin-webapp

FROM nginx:1.29.7-alpine3.23

WORKDIR /usr/share/nginx/html

RUN cat <<'EOF' > /etc/nginx/conf.d/default.conf
server {
  listen 80;
  server_name _;

  root /usr/share/nginx/html;
  index index.html;

  # SPA fallback: `location /` (not `location *`, which nginx reads as a prefix
  # match on the literal "*" and so never matches, 404-ing every deep link like
  # /admin/audit on a hard refresh). try_files serves the file if it exists,
  # else index.html so the client-side router can handle the route.
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

COPY --from=build-env /app/apps/admin-webapp/dist/ ./

# Build provenance. A webapp is static files behind nginx, so there is no
# process to ask: the same document the Node services answer GET /build-info
# with is generated here at image build time and served as a file. The admin
# console's Deployment Check reads it from every container, which is how an
# operator confirms the whole stack came from one commit.
#
# Empty defaults so a plain `docker build` still works and reports "unknown"
# rather than failing; CI and build-containers.sh supply the real values. Last
# in the file because these change on every commit and nothing expensive may
# sit below them.
COPY tools/build-info/write-build-info.sh /tmp/write-build-info.sh

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
