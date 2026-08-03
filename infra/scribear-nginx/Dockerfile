# Build from the repository root using:
#   docker build -f infra/scribear-nginx/Dockerfile .
#
# The root, not this directory: the build provenance step below shares one
# generator with the webapp images (tools/build-info/write-build-info.sh)
# rather than keeping a fifth copy of it here.

FROM nginx:1.29.7-alpine3.23

COPY infra/scribear-nginx/nginx.conf /etc/nginx/nginx.conf

# Permissive defaults for the onsite-only access gate, baked in so the image
# is self-sufficient - nginx.conf's `include` and `location = /extlanding`
# reference these exact paths unconditionally, with no fallback if they're
# absent. Without this, any compose file that doesn't yet know about
# ONSITE_ALLOWLIST_PATH/ONSITE_CONTENT_PATH (found via code review: at least
# five outside this repo don't) gets a nginx that refuses to start at all -
# `nginx -t` fails on a missing include, which is a silent, total breaking
# change to this image's runtime interface, not a gated-access nuance.
# deployment/compose.yml's bind mounts still override these paths for a real
# deployment; this is only the floor under compose files that haven't been
# updated yet.
COPY deployment/onsite/allowlist.default.conf /etc/nginx/onsite/config/allowlist.conf
COPY deployment/onsite/content-default/index.html /usr/share/nginx/onsite/content/index.html

# 127.0.0.1, not localhost: on alpine/busybox "localhost" resolves to ::1 first
# and nginx listens only on IPv4, so localhost gives "connection refused". Hit
# the dedicated /healthz (root "/" returns 404, which wget reads as failure).
HEALTHCHECK --interval=5s --timeout=5s --retries=5 \
    CMD wget --no-check-certificate -qO- https://127.0.0.1:443/healthz || exit 1

# Build provenance. The proxy is nginx serving files, so there is no process to
# ask: the same document the Node services answer GET /build-info with is
# generated here at image build time. nginx.conf serves it from the plain-HTTP
# listener only — see the `location = /build-info.json` block there for why it
# must not be published on 443.
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

RUN sh /tmp/write-build-info.sh scribear-nginx /usr/share/nginx/build-info/build-info.json \
  && rm /tmp/write-build-info.sh

LABEL org.opencontainers.image.title="scribear/scribear-nginx" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.scribear.build.pull-request="${BUILD_PR}" \
      org.scribear.build.origin="${BUILD_ORIGIN}"
