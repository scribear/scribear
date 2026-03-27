# Build in the root directory using:
#   docker build . -f ./apps/webapp/Dockerfile

ARG NODE_VERSION=24.10.0
ARG NGINX_VERSION=1.29.0

FROM node:${NODE_VERSION} AS build-env

WORKDIR /app

# Install dependencies first so source-only changes can reuse cache.
COPY package*.json ./
COPY apps/webapp/package*.json apps/webapp/
COPY libs/base-api-client/package*.json libs/base-api-client/
COPY libs/base-schema/package*.json libs/base-schema/
COPY libs/base-websocket-client/package*.json libs/base-websocket-client/
COPY libs/node-server-client/package*.json libs/node-server-client/
COPY libs/node-server-schema/package*.json libs/node-server-schema/
COPY libs/session-manager-client/package*.json libs/session-manager-client/
COPY libs/session-manager-schema/package*.json libs/session-manager-schema/
COPY libs/transcription-service-client/package*.json libs/transcription-service-client/
COPY libs/transcription-service-schema/package*.json libs/transcription-service-schema/
RUN npm ci

# Copy source and build the webapp workspace.
COPY tsconfig.base.json ./
COPY apps/webapp apps/webapp
COPY libs/base-api-client libs/base-api-client
COPY libs/base-schema libs/base-schema
COPY libs/base-websocket-client libs/base-websocket-client
COPY libs/node-server-client libs/node-server-client
COPY libs/node-server-schema libs/node-server-schema
COPY libs/session-manager-client libs/session-manager-client
COPY libs/session-manager-schema libs/session-manager-schema
COPY libs/transcription-service-client libs/transcription-service-client
COPY libs/transcription-service-schema libs/transcription-service-schema
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
