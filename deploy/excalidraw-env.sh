#!/bin/sh
# Renders /run/excalidraw.env (tmpfs, root-only; secrets never hit disk) for
# the systemd units. Ships inside the Docker image and is extracted onto the
# VM on every start, so adding a config var here reaches prod via a normal
# deploy. Same pattern as neml-e.
set -e
PROJECT=misc-internal
OUT=/run/excalidraw.env
umask 077
get() { gcloud secrets versions access latest --secret="$1" --project="$PROJECT"; }
{
  # oauth2-proxy (browser login, @subsets.com only)
  echo "OAUTH2_PROXY_CLIENT_ID=$(get excalidraw-google-client-id)"
  echo "OAUTH2_PROXY_CLIENT_SECRET=$(get excalidraw-google-client-secret)"
  echo "OAUTH2_PROXY_COOKIE_SECRET=$(get excalidraw-cookie-secret)"
  # Caddy: requests carrying this bearer token (MCP server / CLI) bypass the
  # browser login
  echo "API_TOKEN=$(get excalidraw-api-token)"
} > "$OUT"
