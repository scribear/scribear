FROM nginx:1.29.7-alpine3.23

COPY nginx.conf /etc/nginx/nginx.conf

HEALTHCHECK --interval=5s --timeout=5s --retries=5 \
    CMD wget --no-check-certificate -qO- https://localhost:443/ || exit 1
