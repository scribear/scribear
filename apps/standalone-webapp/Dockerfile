# Build in the root directory using:
#   docker build -f apps/standalone-webapp/Dockerfile .

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

RUN npm run build --workspace=@scribear/standalone-webapp

FROM nginx:1.29.7-alpine3.23

WORKDIR /usr/share/nginx/html

RUN cat <<'EOF' > /etc/nginx/conf.d/default.conf
server {
  listen 80;
  server_name _;

  root /usr/share/nginx/html;
  index index.html;

  location * {
    try_files $uri $uri/ /index.html;
  }

  location = /healthcheck {
    access_log off;
    add_header Content-Type text/plain;
    return 200 'ok';
  }
}
EOF

COPY --from=build-env /app/apps/standalone-webapp/dist/ ./

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --start-interval=1s --retries=3 CMD wget --quiet --tries=1 --spider http://127.0.0.1/healthcheck || exit 1
