# Build in the root directory using:
#   docker build -f apps/session-manager/Dockerfile .

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

RUN npm run build --workspace=@scribear/session-manager

FROM node:${NODE_VERSION}-alpine3.22

WORKDIR /app

COPY --from=package-jsons /app/ .

RUN npm ci --omit=dev

COPY --from=build-env /app/apps/session-manager/dist/bundle.mjs /app/apps/session-manager/dist/bundle.mjs

WORKDIR /app/apps/session-manager

ENV HOST=0.0.0.0
ENV PORT=80

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --start-interval=1s --retries=3 CMD wget -qO- http://127.0.0.1:80/api/session-manager/healthcheck/v1 || exit 1

CMD ["node", "dist/bundle.mjs"]
