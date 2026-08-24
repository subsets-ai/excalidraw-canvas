#!/bin/bash
# One-time setup for GitHub Actions deploys (mirrors neml-e/deploy/setup-ci.sh,
# with the deploy identity scoped down: only pushes from refs/heads/main can
# assume it, and it can only ssh/sudo into THIS instance, not every VM in the
# project). Idempotent. Needs admin creds on misc-internal. Run after the VM
# exists (docs/deploy.md one-time setup).
set -euo pipefail

P=misc-internal
ZONE=europe-west1-b
VM=excalidraw-canvas
REPO=subsets-ai/excalidraw-canvas
SA=excalidraw-deploy@$P.iam.gserviceaccount.com
VM_SA=excalidraw-vm@$P.iam.gserviceaccount.com
NUM=$(gcloud projects describe $P --format='value(projectNumber)')
IMAGE=europe-west1-docker.pkg.dev/$P/excalidraw-canvas/canvas
POOL=excalidraw-github

# GitHub OIDC -> GCP, pinned to this repo AND the main branch: a workflow on
# any other branch can request id-token:write too, so repository alone is not
# enough.
COND="assertion.repository == \"$REPO\" && assertion.ref == \"refs/heads/main\""
MAPPING='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref'
gcloud iam workload-identity-pools create $POOL --location=global --project=$P 2>/dev/null || true
gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=$POOL --project=$P \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="$MAPPING" --attribute-condition="$COND" 2>/dev/null ||
gcloud iam workload-identity-pools providers update-oidc github \
  --location=global --workload-identity-pool=$POOL --project=$P \
  --attribute-mapping="$MAPPING" --attribute-condition="$COND"

gcloud iam service-accounts create excalidraw-deploy \
  --display-name='GitHub Actions deployer (excalidraw-canvas)' --project=$P 2>/dev/null || true
gcloud iam service-accounts add-iam-policy-binding $SA --project=$P \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$NUM/locations/global/workloadIdentityPools/$POOL/attribute.repository/$REPO" \
  >/dev/null

# Push images: writer on this repository only
gcloud artifacts repositories add-iam-policy-binding excalidraw-canvas \
  --location=europe-west1 --project=$P \
  --role=roles/artifactregistry.writer --member=serviceAccount:$SA >/dev/null

# `gcloud compute ssh --tunnel-through-iap` + `sudo systemctl restart` on this
# instance only. compute.viewer stays project-wide (needed to resolve the
# instance); the root-equivalent roles are bound on the instance.
gcloud projects add-iam-policy-binding $P --role=roles/compute.viewer \
  --member=serviceAccount:$SA --condition=None -q >/dev/null
gcloud compute instances add-iam-policy-binding $VM --zone=$ZONE --project=$P \
  --role=roles/compute.osAdminLogin --member=serviceAccount:$SA >/dev/null
# IAP tunnel access is an IAP resource, not instance IAM, and gcloud has no
# per-instance command for it - use the IAP API directly.
INSTANCE_ID=$(gcloud compute instances describe $VM --zone=$ZONE --project=$P --format='value(id)')
IAP_RES="https://iap.googleapis.com/v1/projects/$NUM/iap_tunnel/zones/$ZONE/instances/$INSTANCE_ID"
TOKEN=$(gcloud auth print-access-token)
curl -sf -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}' "$IAP_RES:getIamPolicy" |
python3 -c "
import json, sys
policy = json.load(sys.stdin)
member = 'serviceAccount:$SA'
role = 'roles/iap.tunnelResourceAccessor'
bindings = policy.setdefault('bindings', [])
b = next((b for b in bindings if b['role'] == role), None)
if b is None:
    bindings.append({'role': role, 'members': [member]})
elif member not in b['members']:
    b['members'].append(member)
json.dump({'policy': policy}, sys.stdout)
" |
curl -sf -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @- "$IAP_RES:setIamPolicy" >/dev/null

# SSH to a VM running as excalidraw-vm requires actAs on that SA
gcloud iam service-accounts add-iam-policy-binding $VM_SA \
  --project=$P --role=roles/iam.serviceAccountUser --member=serviceAccount:$SA >/dev/null

# deploy SA logs in via OS Login
gcloud compute instances add-metadata $VM --zone=$ZONE --project=$P \
  --metadata=enable-oslogin=TRUE

echo "done - set repo vars GCP_PROJECT_ID=$P and"
echo "GCP_WORKLOAD_IDENTITY_PROVIDER=projects/$NUM/locations/global/workloadIdentityPools/$POOL/providers/github"
echo "image: $IMAGE:latest"
