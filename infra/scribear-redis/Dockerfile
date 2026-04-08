FROM redis:8.6.2-alpine

HEALTHCHECK --interval=5s --timeout=5s --retries=5 \
    CMD redis-cli ping | grep PONG
