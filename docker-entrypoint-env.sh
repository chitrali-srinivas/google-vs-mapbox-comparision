#!/bin/sh
set -e

cat > /usr/share/nginx/html/env-config.js <<EOF
window.__APP_CONFIG__ = {
  VITE_GOOGLE_MAPS_API_KEY: "${VITE_GOOGLE_MAPS_API_KEY:-}",
  VITE_MAPBOX_ACCESS_TOKEN: "${VITE_MAPBOX_ACCESS_TOKEN:-}"
};
EOF
