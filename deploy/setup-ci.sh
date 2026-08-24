#!/bin/bash
# One-time setup for GitHub Actions deploys (mirrors neml-e/deploy/setup-ci.sh).
# Idempotent. Needs admin creds on misc-internal.
set -euo pipefail

P=misc-internal
ZONE=europe-west1-b
VM=excalidraw-canvas
REPO=subsets-ai/excalidraw-canvas
SA=excalidraw-deploy@$P.iam.gserviceaccount.com
NUM=$(gcloud projects describe $P --format='value(projectNumber)')
IMAGE=europe-west1-docker.pkg.dev/$P/excalidraw-canvas/canvas

# GitHub OIDC -> GCP, pinned to this repo
gcloud iam workload-identity-pools create excalidraw-github --location=global --project=$P 2>/dev/null || true
gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=excalidraw-github --project=$P \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping='google.subject=assertion.sub,attribute.repository=assertion.repository' \
  --attribute-condition="assertion.repository == \"$REPO\"" 2>/dev/null || true

gcloud iam service-accounts create excalidraw-deploy \
  --display-name='GitHub Actions deployer (excalidraw-canvas)' --project=$P 2>/dev/null || true
gcloud iam service-accounts add-iam-policy-binding $SA --project=$P \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$NUM/locations/global/workloadIdentityPools/excalidraw-github/attribute.repository/$REPO" \
  >/dev/null

# push image + IAP ssh + `sudo systemctl restart` on the VM
for r in artifactregistry.writer compute.viewer compute.osAdminLogin iap.tunnelResourceAccessor; do
  gcloud projects add-iam-policy-binding $P --role=roles/$r \
    --member=serviceAccount:$SA --condition=None -q >/dev/null
done

# SSH to a VM running as the default compute SA requires actAs on it
gcloud iam service-accounts add-iam-policy-binding $NUM-compute@developer.gserviceaccount.com \
  --project=$P --role=roles/iam.serviceAccountUser --member=serviceAccount:$SA >/dev/null

# deploy SA logs in via OS Login
gcloud compute instances add-metadata $VM --zone=$ZONE --project=$P \
  --metadata=enable-oslogin=TRUE

echo "done - set repo vars GCP_PROJECT_ID=$P and"
echo "GCP_WORKLOAD_IDENTITY_PROVIDER=projects/$NUM/locations/global/workloadIdentityPools/excalidraw-github/providers/github"
echo "image: $IMAGE:latest"
