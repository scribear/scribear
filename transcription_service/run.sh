#!/bin/bash

# Copy the template config if it doesn't exist
if [ ! -f provider_config.json ]; then
  cp provider_config.template.json provider_config.json
  echo "Created provider_config.json from template"
fi

# Run with GPU support, .env file, and config mounted in
# PORT is overridden to 80 inside the container (mapped to 8003 on host)
sudo docker run --gpus all \
  -p 8003:80 \
  --env-file .env \
  -e PORT=80 \
  -v "$(pwd)/provider_config.json:/app/provider_config.json" \
  ts_service