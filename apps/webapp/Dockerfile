# Build in the root directory using:
#   docker build . -f ./apps/webapp/Dockerfile

ARG NODE_VERSION=24.10.0
ARG NGINX_VERSION=1.29.0

FROM node:${NODE_VERSION} AS build-env

WORKDIR /app

# Install dependencies first so source-only changes can reuse cache.
COPY package*.json ./
COPY apps/webapp/package*.json apps/webapp/
COPY libs/clients/base-api-client/package*.json libs/clients/base-api-client/
COPY libs/schemas/base-schema/package*.json libs/schemas/base-schema/
COPY libs/clients/base-websocket-client/package*.json libs/clients/base-websocket-client/
COPY libs/clients/node-server-client/package*.json libs/clients/node-server-client/
COPY libs/schemas/node-server-schema/package*.json libs/schemas/node-server-schema/
COPY libs/clients/session-manager-client/package*.json libs/clients/session-manager-client/
COPY libs/schemas/session-manager-schema/package*.json libs/schemas/session-manager-schema/
COPY libs/clients/transcription-service-client/package*.json libs/clients/transcription-service-client/
COPY libs/schemas/transcription-service-schema/package*.json libs/schemas/transcription-service-schema/
RUN npm ci

# Copy source and build the webapp workspace.
COPY tsconfig.base.json ./
COPY apps/webapp apps/webapp
COPY libs/clients/base-api-client libs/clients/base-api-client
COPY libs/schemas/base-schema libs/schemas/base-schema
COPY libs/clients/base-websocket-client libs/clients/base-websocket-client
COPY libs/clients/node-server-client libs/clients/node-server-client
COPY libs/schemas/node-server-schema libs/schemas/node-server-schema
COPY libs/clients/session-manager-client libs/clients/session-manager-client
COPY libs/schemas/session-manager-schema libs/schemas/session-manager-schema
COPY libs/clients/transcription-service-client libs/clients/transcription-service-client
COPY libs/schemas/transcription-service-schema libs/schemas/transcription-service-schema
RUN npm run build --workspace @scribear/webapp

FROM nginx:${NGINX_VERSION}-alpine3.22

WORKDIR /usr/share/nginx/html

# Configure Nginx for SPA fallback and a lightweight health endpoint.
RUN cat <<'EOF' > /etc/nginx/conf.d/default.conf
server {
  listen 80;
  server_name _;

  root /usr/share/nginx/html;
  index index.html;

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

COPY --from=build-env /app/apps/webapp/dist/ ./

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --start-interval=1s --retries=3 CMD wget --quiet --tries=1 --spider http://127.0.0.1/healthcheck || exit 1
