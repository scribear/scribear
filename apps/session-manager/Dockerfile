# Build in the root directory using:
#   docker build . -f ./apps/session-manager/Dockerfile

ARG NODE_VERSION=24.10.0

FROM node:${NODE_VERSION} AS build-env

WORKDIR /app

# Install dependencies first
# So build can use cached dependency layer if only source code changes
COPY package*.json .

ARG SRC="session-manager"
COPY apps/${SRC}/package*.json apps/${SRC}/
ARG INFRA="scribear-db"
COPY infra/${INFRA}/package*.json infra/${INFRA}/
ARG LIB="base-fastify-server"
COPY libs/${LIB}/package*.json libs/${LIB}/
ARG LIB="base-schema"
COPY libs/${LIB}/package*.json libs/${LIB}/
ARG LIB="session-manager-schema"
COPY libs/${LIB}/package*.json libs/${LIB}/
RUN npm ci

# Copy source code and build
COPY tsconfig.base.json .LIB

ARG SRC="session-manager"
COPY apps/${SRC} apps/${SRC}
ARG INFRA="scribear-db"
COPY infra/${INFRA} infra/${INFRA}
ARG LIB="base-fastify-server"
COPY libs/${LIB} libs/${LIB}
ARG LIB="base-schema"
COPY libs/${LIB} libs/${LIB}
ARG LIB="session-manager-schema"
COPY libs/${LIB} libs/${LIB}

RUN npm run build

FROM node:${NODE_VERSION}-alpine3.22

WORKDIR /app

# Install dependencies first
# So build can use cached dependency layer if only source code changes
# This time, only include production dependencies to keep image small
COPY package*.json .

ARG SRC="session-manager"
COPY apps/${SRC}/package*.json apps/${SRC}/
ARG INFRA="scribear-db"
COPY infra/${INFRA}/package*.json infra/${INFRA}/
ARG LIB="base-fastify-server"
COPY libs/${LIB}/package*.json libs/${LIB}/
ARG LIB="base-schema"
COPY libs/${LIB}/package*.json libs/${LIB}/
ARG LIB="session-manager-schema"
COPY libs/${LIB}/package*.json libs/${LIB}/

RUN npm ci --omit=dev

# Copy the build artifacts from build-env container
ARG SRC="session-manager"
COPY --from=build-env /app/apps/${SRC}/dist/src/ /app/apps/${SRC}/dist/src
ARG INFRA="scribear-db"
COPY --from=build-env /app/infra/${INFRA}/dist/src/ /app/infra/${INFRA}/dist/src/
ARG LIB="base-fastify-server"
COPY --from=build-env /app/libs/${LIB}/dist/src/ /app/libs/${LIB}/dist/src/
ARG LIB="base-schema"
COPY --from=build-env /app/libs/${LIB}/dist/src/ /app/libs/${LIB}/dist/src/
ARG LIB="session-manager-schema"
COPY --from=build-env /app/libs/${LIB}/dist/src/ /app/libs/${LIB}/dist/src/

WORKDIR /app/apps/session-manager

# Ensure server listens on a defined interface and port inside container
# This docker can map this to a real port on the host
ENV HOST=0.0.0.0
ENV PORT=80

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --start-interval=1s --retries=3 CMD curl -f http://localhost:80/healthcheck || exit 1

CMD ["npm", "start"]
