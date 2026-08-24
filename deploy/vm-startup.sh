#!/bin/bash
# Self-configuring startup script for the excalidraw-canvas Debian VM.
# Idempotent; runs on every boot. Reads `image-ref` and `domain` from instance
# metadata. Logs to /var/log/excalidraw-startup.log.
#
# Layout on the box (all localhost-bound; Caddy is the only public listener):
#   caddy :443  --bearer token--> canvas :3000
#              --otherwise------> oauth2-proxy :4180 --Google login--> canvas :3000
set -uxo pipefail
exec > /var/log/excalidraw-startup.log 2>&1

META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
IMAGE=$(curl -s -H "Metadata-Flavor: Google" "$META/image-ref")
DOMAIN=$(curl -s -H "Metadata-Flavor: Google" "$META/domain")
OAUTH2_PROXY_IMAGE=quay.io/oauth2-proxy/oauth2-proxy:v7.7.1

# 1. Mount the dedicated data disk (holds rooms/*.json).
DISK=/dev/disk/by-id/google-excalidraw-canvas-data
MNT=/mnt/disks/data
blkid "$DISK" >/dev/null 2>&1 || mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard "$DISK"
mkdir -p "$MNT"
mountpoint -q "$MNT" || mount -o discard,defaults "$DISK" "$MNT"
grep -q "$MNT" /etc/fstab || echo "$DISK $MNT ext4 discard,defaults,nofail 0 2" >> /etc/fstab
# Never let the app boot on an empty boot-disk directory: it would silently
# serve empty rooms and then overwrite the real ones on the next deploy.
mountpoint -q "$MNT" || { echo "FATAL: data disk not mounted at $MNT"; exit 1; }
# The canvas image runs as uid 1001
chown 1001:1001 "$MNT"

# 2. Install docker, gcloud, caddy (each only if missing).
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg apt-transport-https
if ! command -v docker >/dev/null; then apt-get install -y docker.io && systemctl enable --now docker; fi
if ! command -v gcloud >/dev/null; then
  curl -s https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list
  apt-get update && apt-get install -y google-cloud-cli
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

# 3. Let root's docker authenticate to Artifact Registry via the VM service account.
gcloud auth configure-docker europe-west1-docker.pkg.dev -q

# 4. Env sync: lift the env->secret mapping out of the deployed image so it
# always matches the running code (deploy/excalidraw-env.sh in the repo).
cat > /usr/local/bin/excalidraw-sync-env.sh <<'EOS'
#!/bin/sh
set -e
. /etc/excalidraw.image
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
docker run --rm --entrypoint cat "$IMAGE" /app/deploy/excalidraw-env.sh > "$TMP"
[ -s "$TMP" ]
install -m 700 "$TMP" /usr/local/bin/excalidraw-env.sh
EOS
chmod +x /usr/local/bin/excalidraw-sync-env.sh

# 5. Render the Caddyfile from the env file: the bearer token has to be a
# literal in the matcher. Root-only file; regenerated on every unit start.
cat > /usr/local/bin/excalidraw-render-caddy.sh <<EOS
#!/bin/sh
set -e
. /run/excalidraw.env
umask 027
cat > /etc/caddy/Caddyfile <<EOC
$DOMAIN {
	# MCP server / CLI: bearer token, no browser session
	@token header Authorization "Bearer \$API_TOKEN"
	handle @token {
		reverse_proxy 127.0.0.1:3000
	}
	# Everyone else: Google login via oauth2-proxy, which proxies to the canvas
	handle {
		reverse_proxy 127.0.0.1:4180
	}
}
EOC
chgrp caddy /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy
EOS
chmod +x /usr/local/bin/excalidraw-render-caddy.sh

echo "IMAGE=$IMAGE" > /etc/excalidraw.image
echo "DOMAIN=$DOMAIN" >> /etc/excalidraw.image

# 6. systemd units. The canvas unit owns env rendering; the auth unit and
# Caddy follow it.
cat > /etc/systemd/system/excalidraw-canvas.service <<'EOS'
[Unit]
Description=excalidraw-canvas
After=docker.service network-online.target
Requires=docker.service
RequiresMountsFor=/mnt/disks/data
Wants=network-online.target excalidraw-auth.service
[Service]
EnvironmentFile=/etc/excalidraw.image
Restart=always
RestartSec=10
TimeoutStartSec=300
ExecStartPre=-/usr/bin/docker pull ${IMAGE}
ExecStartPre=-/usr/bin/docker rm -f excalidraw-canvas
# Tolerate a failed sync (registry hiccup): the previous mapping still works.
# The unprefixed render below is the hard gate - no env file, no start.
ExecStartPre=-/usr/local/bin/excalidraw-sync-env.sh
ExecStartPre=/usr/local/bin/excalidraw-env.sh
ExecStartPre=/usr/local/bin/excalidraw-render-caddy.sh
# --init so PID 1 forwards SIGTERM: the server flushes rooms to disk on it.
ExecStart=/usr/bin/docker run --name excalidraw-canvas --rm --init \
  -e DATA_DIR=/data -e PORT=3000 -e HOST=0.0.0.0 -e LOG_LEVEL=info \
  -v /mnt/disks/data:/data \
  -p 127.0.0.1:3000:3000 \
  ${IMAGE}
ExecStop=/usr/bin/docker stop -t 30 excalidraw-canvas
[Install]
WantedBy=multi-user.target
EOS

cat > /etc/systemd/system/excalidraw-auth.service <<EOS
[Unit]
Description=excalidraw oauth2-proxy
After=docker.service excalidraw-canvas.service
Requires=docker.service
BindsTo=excalidraw-canvas.service
[Service]
EnvironmentFile=/etc/excalidraw.image
Restart=always
RestartSec=10
ExecStartPre=-/usr/bin/docker rm -f excalidraw-auth
ExecStart=/usr/bin/docker run --name excalidraw-auth --rm --network host \\
  --env-file /run/excalidraw.env \\
  $OAUTH2_PROXY_IMAGE \\
  --provider=google \\
  --email-domain=subsets.com \\
  --redirect-url=https://$DOMAIN/oauth2/callback \\
  --http-address=127.0.0.1:4180 \\
  --upstream=http://127.0.0.1:3000 \\
  --reverse-proxy=true \\
  --cookie-secure=true \\
  --cookie-expire=168h \\
  --cookie-refresh=1h \\
  --skip-provider-button=true \\
  --pass-user-headers=true
ExecStop=/usr/bin/docker stop -t 10 excalidraw-auth
[Install]
WantedBy=multi-user.target
EOS

systemctl daemon-reload
systemctl enable excalidraw-canvas.service excalidraw-auth.service
systemctl restart excalidraw-canvas.service
systemctl restart excalidraw-auth.service
echo "excalidraw-canvas startup complete"
