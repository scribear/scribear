FROM nginx:1.29.7-alpine3.23

COPY nginx.conf /etc/nginx/nginx.conf

HEALTHCHECK --interval=5s --timeout=5s --retries=5 \
    CMD wget -qO- http://localhost:80/ || exit 1
