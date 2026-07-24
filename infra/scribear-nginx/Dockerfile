FROM nginx:1.29.7-alpine3.23

COPY nginx.conf /etc/nginx/nginx.conf

# 127.0.0.1, not localhost: on alpine/busybox "localhost" resolves to ::1 first
# and nginx listens only on IPv4, so localhost gives "connection refused". Hit
# the dedicated /healthz (root "/" returns 404, which wget reads as failure).
HEALTHCHECK --interval=5s --timeout=5s --retries=5 \
    CMD wget --no-check-certificate -qO- https://127.0.0.1:443/healthz || exit 1
