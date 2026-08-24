# Deploy (self-hosted, Google Cloud)

One Debian VM in project `misc-internal` (region `europe-west1`), three
localhost-bound processes fronted by Caddy for automatic HTTPS:

```
browser ──HTTPS──> caddy ──(no bearer)──> oauth2-proxy ──Google login, @subsets.com──> canvas :3000
MCP/CLI ──HTTPS──> caddy ──(Authorization: Bearer <api-token>)──────────────────────> canvas :3000
```

Rooms live as JSON files on a dedicated persistent disk with daily snapshots.
Same shape as `neml-e` (`docs/deploy.md` there); files referenced below live in
`deploy/`.

Why a VM and not Cloud Run: the live canvas is WebSocket fan-out plus in-memory
room state, which wants exactly one long-lived instance.

## One-time setup

```sh
PROJECT=misc-internal
REGION=europe-west1
ZONE=europe-west1-b
DOMAIN=draw.subsets.com
gcloud config set project "$PROJECT"

# 1. APIs
gcloud services enable compute.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com iap.googleapis.com

# 2. Artifact Registry repo for the image
gcloud artifacts repositories create excalidraw-canvas --repository-format=docker --location="$REGION"

# 3. Secrets (org policy pins secret locations to the EU -> user-managed replication)
for s in excalidraw-google-client-id excalidraw-google-client-secret \
         excalidraw-cookie-secret excalidraw-api-token; do
  gcloud secrets create "$s" --replication-policy=user-managed --locations="$REGION" 2>/dev/null || true
done
openssl rand -base64 32 | tr -d '\n' | gcloud secrets versions add excalidraw-cookie-secret --data-file=-
openssl rand -hex 32   | tr -d '\n' | gcloud secrets versions add excalidraw-api-token --data-file=-
# client id/secret: see "Google OAuth" below, then
#   printf '%s' '<id>'     | gcloud secrets versions add excalidraw-google-client-id --data-file=-
#   printf '%s' '<secret>' | gcloud secrets versions add excalidraw-google-client-secret --data-file=-

# 4. Dedicated data disk (survives VM recreation)
gcloud compute disks create excalidraw-canvas-data --size=10GB --type=pd-balanced --zone="$ZONE"

# 5. Daily snapshot schedule
gcloud compute resource-policies create snapshot-schedule excalidraw-daily \
  --region="$REGION" --max-retention-days=14 \
  --daily-schedule --start-time=02:00 --on-source-disk-delete=keep-auto-snapshots
gcloud compute disks add-resource-policies excalidraw-canvas-data --zone="$ZONE" \
  --resource-policies=excalidraw-daily

# 6. First image (CI pushes :latest afterwards)
IMAGE="$REGION-docker.pkg.dev/$PROJECT/excalidraw-canvas/canvas"
gcloud builds submit --tag "$IMAGE:$(git rev-parse --short HEAD)" --config /dev/stdin . <<EOC
steps:
- name: gcr.io/cloud-builders/docker
  args: [build, -f, Dockerfile.canvas, -t, "$IMAGE:$(git rev-parse --short HEAD)", -t, "$IMAGE:latest", .]
images: ["$IMAGE:$(git rev-parse --short HEAD)", "$IMAGE:latest"]
EOC

# 7. VM. Its service account needs secretAccessor + Artifact Registry reader.
#    deploy/vm-startup.sh self-configures the box on every boot.
gcloud compute instances create excalidraw-canvas \
  --zone="$ZONE" --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --disk=name=excalidraw-canvas-data,device-name=excalidraw-canvas-data,mode=rw \
  --metadata-from-file=startup-script=deploy/vm-startup.sh \
  --metadata=image-ref="$IMAGE:latest",domain="$DOMAIN" \
  --tags=http-server,https-server

# 8. DNS: A record for $DOMAIN -> the VM's external IP (Caddy needs it for the cert)
gcloud compute instances describe excalidraw-canvas --zone="$ZONE" \
  --format='value(networkInterfaces[0].accessConfigs[0].natIP)'
```

Grant the VM's default compute service account `roles/secretmanager.secretAccessor`
and `roles/artifactregistry.reader` on the project.

## Google OAuth

Create an OAuth 2.0 Web client in the `subsets-347920` project (Google Auth
Platform > Clients) — the NEML-E client there is the template: redirect URI
`https://draw.subsets.com/oauth2/callback`, basic scopes only. oauth2-proxy
restricts logins to `@subsets.com` (`--email-domain`), so no consent-screen
verification is needed. Store id/secret in the two secrets above.

## CI/CD (GitHub Actions)

`.github/workflows/ci.yml` runs type-check, build and tests on every PR.
`.github/workflows/deploy.yml` runs on push to `main`: tests, then a
`Dockerfile.canvas` build/push to Artifact Registry (`:$(git sha)` + `:latest`),
then `gcloud compute ssh --tunnel-through-iap` to `sudo systemctl restart
excalidraw-canvas` (its ExecStartPre pulls `:latest`; stopping the old
container flushes rooms to disk first).

One-time wiring (WIF pool + `excalidraw-deploy` service account + roles, OS
Login on the VM): run `deploy/setup-ci.sh`, then set the `GCP_PROJECT_ID` and
`GCP_WORKLOAD_IDENTITY_PROVIDER` repo variables it prints. The deploy job is
skipped while `GCP_PROJECT_ID` is unset.

Caveats (inherited from neml-e):

- `deploy/excalidraw-env.sh` (env -> secret mapping) ships inside the image and
  is extracted onto the VM on every unit start, so a new var needs only a
  normal deploy.
- Changes to the rest of `deploy/vm-startup.sh` (systemd units, Caddy,
  oauth2-proxy flags) need `gcloud compute instances add-metadata
  excalidraw-canvas --metadata-from-file=startup-script=deploy/vm-startup.sh`
  + a VM reboot; CI never re-runs the startup script.
- Rollback: `gcloud artifacts docker tags add <image>:<old-sha> <image>:latest`
  + `sudo systemctl restart excalidraw-canvas`.

## Connecting agents

Every engineer's MCP client / CLI points at the shared canvas with the bearer
token and a room:

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "npx",
      "args": ["-y", "github:subsets-ai/excalidraw-canvas"],
      "env": {
        "EXPRESS_SERVER_URL": "https://draw.subsets.com",
        "EXCALIDRAW_API_TOKEN": "<excalidraw-api-token>",
        "EXCALIDRAW_ROOM": "platform-arch",
        "EXCALIDRAW_AGENT_NAME": "Claude (oliver)",
        "EXCALIDRAW_NO_AUTOSTART": "1"
      }
    }
  }
}
```

CLI: `npx -y github:subsets-ai/excalidraw-canvas --url https://draw.subsets.com --room platform-arch describe`
(with `EXCALIDRAW_API_TOKEN` in the environment). Humans open
`https://draw.subsets.com/r/platform-arch`.

## Restore from a snapshot

```sh
gcloud compute disks create excalidraw-canvas-data-restored --source-snapshot=SNAPSHOT --zone="$ZONE"
# stop the unit, swap the disk on the VM, start the unit
```

Rooms are plain JSON (`/mnt/disks/data/rooms/<room>.json`); a single room can
also be restored by copying its file back and restarting the unit.
