#!/bin/bash
set -e

# Start Docker daemon in background (runs as root)
dockerd --userland-proxy=false --log-level=warn &

# Wait until Docker daemon is ready
timeout=30
until docker info >/dev/null 2>&1; do
  timeout=$((timeout - 1))
  if [ "$timeout" -le 0 ]; then
    echo "ERROR: Docker daemon failed to start" >&2
    exit 1
  fi
  sleep 1
done

# Run claude as the unprivileged claude user, passing all arguments
exec gosu claude claude "$@"
