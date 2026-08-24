#!/bin/bash
# Store a downloaded Google OAuth client JSON (client_secret_*.json) into
# Secret Manager for the canvas VM. Values go straight from the file to
# gcloud; nothing is printed. Usage: deploy/store-oauth-client.sh [path.json]
set -euo pipefail
P=misc-internal
F=${1:-$(ls -t ~/Downloads/client_secret_*.json 2>/dev/null | head -1)}
[ -n "${F:-}" ] && [ -f "$F" ] || { echo "no client_secret_*.json found in ~/Downloads (pass the path)"; exit 1; }
field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['web'][sys.argv[2]], end='')" "$F" "$1"; }
export CLOUDSDK_PYTHON=${CLOUDSDK_PYTHON:-/opt/homebrew/opt/python@3.12/bin/python3.12}
field client_id     | gcloud secrets versions add excalidraw-google-client-id     --data-file=- --project=$P
field client_secret | gcloud secrets versions add excalidraw-google-client-secret --data-file=- --project=$P
echo "stored from $F — now delete it: rm \"$F\""
