FROM postgres:18.3-alpine3.23

ARG PG_CRON_VERSION=1.6.7
ARG PG_CRON_SHA256=d950bc29155f31017567e23a31d268ff672e98276c0e9d062512fb7870351f03

RUN apk add --no-cache \
        build-base \
        clang19 \
        llvm19-dev \
        curl \
    && curl -fsSL "https://github.com/citusdata/pg_cron/archive/refs/tags/v${PG_CRON_VERSION}.tar.gz" \
        -o /tmp/pg_cron.tar.gz \
    && echo "${PG_CRON_SHA256}  /tmp/pg_cron.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/pg_cron.tar.gz -C /tmp \
    && cd "/tmp/pg_cron-${PG_CRON_VERSION}" \
    && make \
    && make install \
    && rm -rf /tmp/pg_cron.tar.gz "/tmp/pg_cron-${PG_CRON_VERSION}" \
    && apk del build-base clang19 llvm19-dev curl

COPY entrypoint.sh /usr/local/bin/scribear-entrypoint.sh
RUN chmod +x /usr/local/bin/scribear-entrypoint.sh
ENTRYPOINT ["scribear-entrypoint.sh"]
CMD []

HEALTHCHECK --interval=5s --timeout=5s --retries=5 \
    CMD pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}"
