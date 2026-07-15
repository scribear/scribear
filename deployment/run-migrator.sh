#!/bin/bash

# Load environment variables cleanly
if [ -f .env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in \#*|"" ) continue ;; esac
        export "$(echo "$line" | tr -d '\r')"
    done < .env
fi

# Fallback defaults
DB_NAME=${DB_NAME:-scribear}
DB_USER=${DB_USER:-postgres}
DB_PASSWORD=${DB_PASSWORD:-password}
DB_HOST=${DB_HOST:-scribear-db} 

echo "Starting one-shot migration check inside Node 24..."

BACKEND_NET=$(docker network ls --filter name=backend --format "{{.Name}}" | head -n 1)
if [ -z "$BACKEND_NET" ]; then
    echo "❌ Error: Could not find backend network."
    exit 1
fi

# By quoting 'EOF', everything inside passes directly to the container untouched
docker run --rm -i \
  --name scribear-db-migrator \
  --network "$BACKEND_NET" \
  -e DB_HOST="$DB_HOST" \
  -e DB_PORT="5432" \
  -e DB_NAME="$DB_NAME" \
  -e DB_USER="$DB_USER" \
  -e DB_PASSWORD="$DB_PASSWORD" \
  node:24-alpine sh << 'EOF'

apk add --no-cache git postgresql-client
export PGPASSWORD="$DB_PASSWORD"

echo "Checking if database '$DB_NAME' exists..."
DB_EXISTS=$(psql -h "$DB_HOST" -U "$DB_USER" -d template1 -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")

if [ "$DB_EXISTS" = "1" ]; then
  echo "ℹ️ Found database: $DB_NAME"
  FOUND_TABLES=$(psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT table_name FROM information_schema.tables WHERE table_schema='public'")
  
  if [ -n "$FOUND_TABLES" ]; then
    echo "🎉 Tables detected! Database is already configured. Exiting setup..."
    exit 0
  fi
  echo "⚠️ Database exists but has no tables."
else
  echo "⚠️ Database $DB_NAME does not exist."
fi

echo "🚀 Running migrations..."
git clone https://github.com/scribear/scribear.git /scribear
cd /scribear
git checkout staging
npm ci
npm run build --workspace=@scribear/scribear-db
npm run migrate:up --workspace=@scribear/scribear-db
EOF
