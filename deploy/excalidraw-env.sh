#!/bin/sh
# Renders the runtime env files (tmpfs under /run, root-only; secrets never
# hit the boot disk) for the systemd units. Ships inside the Docker image and
# is extracted onto the VM on every start, so adding a config var here
# reaches prod via a normal deploy. Same pattern as neml-e.
#
# Two files on purpose: each process only sees the secrets it needs.
#   /run/excalidraw-oauth.env -> oauth2-proxy container
#   /run/excalidraw-caddy.env -> caddy (bearer-token matcher)
set -e
PROJECT=misc-internal
umask 077
get() { gcloud secrets versions access latest --secret="$1" --project="$PROJECT"; }
{
  echo "OAUTH2_PROXY_CLIENT_ID=$(get excalidraw-google-client-id)"
  echo "OAUTH2_PROXY_CLIENT_SECRET=$(get excalidraw-google-client-secret)"
  echo "OAUTH2_PROXY_COOKIE_SECRET=$(get excalidraw-cookie-secret)"
} > /run/excalidraw-oauth.env
# An empty token would turn Caddy's matcher into `Authorization: Bearer ` —
# an unauthenticated path. Refuse to start instead.
TOKEN=$(get excalidraw-api-token)
[ -n "$TOKEN" ] || { echo "excalidraw-api-token is empty" >&2; exit 1; }
{
  echo "API_TOKEN=$TOKEN"
} > /run/excalidraw-caddy.env
