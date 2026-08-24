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

# 6. First image (CI pushes :latest afterwards). The org policy pins
#    resources to the EU, so Cloud Build needs an EU staging bucket and
#    logs-to-Cloud-Logging (its defaults are US buckets).
IMAGE="$REGION-docker.pkg.dev/$PROJECT/excalidraw-canvas/canvas"
SHA=$(git rev-parse --short HEAD)
gcloud storage buckets create gs://misc-internal-cloudbuild-eu --location="$REGION" --uniform-bucket-level-access 2>/dev/null || true
cat > /tmp/cloudbuild.yaml <<EOC
steps:
- name: gcr.io/cloud-builders/docker
  args: [build, -f, Dockerfile.canvas, -t, "$IMAGE:$SHA", -t, "$IMAGE:latest", .]
images: ["$IMAGE:$SHA", "$IMAGE:latest"]
options:
  logging: CLOUD_LOGGING_ONLY
EOC
gcloud builds submit --region="$REGION" --gcs-source-staging-dir=gs://misc-internal-cloudbuild-eu/source --config /tmp/cloudbuild.yaml .
# Check both tags landed; if only :$SHA did, add :latest
# (`gcloud artifacts docker tags add "$IMAGE:$SHA" "$IMAGE:latest"`).
gcloud artifacts docker tags list "$IMAGE"

# 6b. Network: this project has one VPC per app (no `default`). Mirror neml-e.
gcloud compute networks create excalidraw --subnet-mode=custom
gcloud compute networks subnets create excalidraw --network=excalidraw --region="$REGION" --range=10.20.0.0/24
gcloud compute firewall-rules create excalidraw-allow-web --network=excalidraw --direction=INGRESS \
  --allow=tcp:80,tcp:443 --source-ranges=0.0.0.0/0 --target-tags=https-server
gcloud compute firewall-rules create excalidraw-allow-iap-ssh --network=excalidraw --direction=INGRESS \
  --allow=tcp:22 --source-ranges=35.235.240.0/20

# 7. A dedicated VM service account with NO project roles: it may read
#    exactly these four secrets and pull from exactly this image repo.
#    (The default compute SA is often Editor project-wide; an app compromise
#    would inherit all of it.)
gcloud iam service-accounts create excalidraw-vm --display-name='excalidraw-canvas VM'
VM_SA="excalidraw-vm@$PROJECT.iam.gserviceaccount.com"
for s in excalidraw-google-client-id excalidraw-google-client-secret \
         excalidraw-cookie-secret excalidraw-api-token; do
  gcloud secrets add-iam-policy-binding "$s" --role=roles/secretmanager.secretAccessor \
    --member="serviceAccount:$VM_SA"
done
gcloud artifacts repositories add-iam-policy-binding excalidraw-canvas --location="$REGION" \
  --role=roles/artifactregistry.reader --member="serviceAccount:$VM_SA"

# 8. VM. deploy/vm-startup.sh self-configures the box on every boot.
gcloud compute instances create excalidraw-canvas \
  --zone="$ZONE" --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --network=excalidraw --subnet=excalidraw \
  --service-account="$VM_SA" --scopes=cloud-platform \
  --disk=name=excalidraw-canvas-data,device-name=excalidraw-canvas-data,mode=rw \
  --metadata-from-file=startup-script=deploy/vm-startup.sh \
  --metadata=image-ref="$IMAGE:latest",domain="$DOMAIN" \
  --tags=http-server,https-server

# 9. DNS: A record for $DOMAIN -> the VM's external IP (Caddy needs it for the cert)
gcloud compute instances describe excalidraw-canvas --zone="$ZONE" \
  --format='value(networkInterfaces[0].accessConfigs[0].natIP)'
```

## Security model (read before granting anything)

- **Edge:** Caddy is the only public listener. A request with the bearer token
  goes straight to the canvas (identity headers stripped); anything else goes
  through oauth2-proxy (Google login, `@subsets.com`, `SameSite=Lax` cookie).
  The canvas itself has no auth and is bound to `127.0.0.1`; it rejects
  WebSocket upgrades from other origins (`PUBLIC_ORIGIN`). Presence names come
  from oauth2-proxy's `X-Forwarded-Email` / `-Preferred-Username` (`/api/me`);
  signed-in users can't rename themselves.
- **Shared bearer token = full access to every room** (list / read / write /
  delete). Fine for an internal team; per-user tokens are a follow-up. It sits
  in every engineer's MCP config. Rotate: add a secret version, then
  `sudo systemctl restart excalidraw-canvas` (re-renders env + restarts Caddy).
  Keep Caddy access logs off, or the token would land in them.
- **Blast radius of an app compromise:** containers run read-only, no
  capabilities, on a private docker network with the metadata server
  firewalled (`DOCKER-USER` rule), so they can't mint VM credentials. The VM
  SA (`excalidraw-vm`) can only read the four secrets and pull the image.
- **Deploy identity:** only `refs/heads/main` of `subsets-ai/excalidraw-canvas`
  can assume `excalidraw-deploy`; it can push to the image repo and ssh/sudo
  into this one instance. Anyone with `artifactregistry.writer` on the image
  repo is root-equivalent on the VM (the unit executes `deploy/excalidraw-env.sh`
  from the pulled image as root) — treat that role like VM admin.
- **Secrets never touch the boot disk:** rendered to tmpfs under `/run` on
  every start; Caddy reads the token from its environment.

Until the OAuth secrets have versions and `:latest` exists, the canvas unit
sits in `activating` (retrying every 10 s) — expected on first boot. gcloud on
macOS with Python 3.9 misreports some `artifacts` commands; run it with
`CLOUDSDK_PYTHON=/opt/homebrew/opt/python@3.12/bin/python3.12`.

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

One-time wiring (WIF pool pinned to repo + `main`, `excalidraw-deploy` service
account with instance-scoped roles, OS Login on the VM): run
`deploy/setup-ci.sh` after the VM exists, then set the `GCP_PROJECT_ID` and
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
