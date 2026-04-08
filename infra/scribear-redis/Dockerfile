FROM redis:8.6.2-alpine

HEALTHCHECK --interval=5s --timeout=5s --retries=5 \
    CMD redis-cli --no-auth-warning -a "$REDIS_PASSWORD" ping | grep PONG || redis-cli ping | grep PONG
