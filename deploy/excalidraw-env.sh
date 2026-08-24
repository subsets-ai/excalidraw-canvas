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
# `set -e` does not fire on a failed command substitution inside echo, so
# fetch first and refuse to start on anything empty: a missing OAuth secret
# would silently break login, and an empty token would turn Caddy's matcher
# into `Authorization: Bearer ` — an unauthenticated path.
CLIENT_ID=$(get excalidraw-google-client-id)
CLIENT_SECRET=$(get excalidraw-google-client-secret)
COOKIE_SECRET=$(get excalidraw-cookie-secret)
TOKEN=$(get excalidraw-api-token)
for v in CLIENT_ID CLIENT_SECRET COOKIE_SECRET TOKEN; do
  eval "val=\$$v"
  [ -n "$val" ] || { echo "secret for $v is empty or missing" >&2; exit 1; }
done
{
  echo "OAUTH2_PROXY_CLIENT_ID=$CLIENT_ID"
  echo "OAUTH2_PROXY_CLIENT_SECRET=$CLIENT_SECRET"
  echo "OAUTH2_PROXY_COOKIE_SECRET=$COOKIE_SECRET"
} > /run/excalidraw-oauth.env
{
  echo "API_TOKEN=$TOKEN"
} > /run/excalidraw-caddy.env
