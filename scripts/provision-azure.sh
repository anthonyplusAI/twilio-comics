#!/usr/bin/env bash
set -euo pipefail

# One-time Azure foundation for the public app, queue job, and recovery job.
# This script never builds an image or deploys an application revision.

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "Install '$1' before running this script."; }

for command in az gh git jq; do require "$command"; done
: "${SUBSCRIPTION_ID:?Set SUBSCRIPTION_ID to the target Azure subscription ID}"
: "${ACR_NAME:?Set ACR_NAME to the existing or desired globally unique registry name}"
: "${STORAGE_ACCOUNT:?Set STORAGE_ACCOUNT to the existing or desired globally unique storage account name}"

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-twilio-comics}"
LOCATION="${LOCATION:-eastus2}"
LOG_ANALYTICS_WORKSPACE="${LOG_ANALYTICS_WORKSPACE:-law-twilio-comics}"
ACA_ENVIRONMENT="${ACA_ENVIRONMENT:-cae-twilio-comics}"
ACA_NAME="${ACA_NAME:-twilio-comics}"
ACA_JOB_NAME="${ACA_JOB_NAME:-twilio-comics-generation}"
ACA_RECOVERY_JOB_NAME="${ACA_RECOVERY_JOB_NAME:-twilio-comics-recovery}"
BLOB_CONTAINER="${BLOB_CONTAINER:-comics}"
QUEUE_NAME="${QUEUE_NAME:-comic-generation}"
POISON_QUEUE_NAME="${POISON_QUEUE_NAME:-comic-generation-poison}"
WEB_IDENTITY_NAME="${WEB_IDENTITY_NAME:-id-${ACA_NAME}-web}"
WORKER_IDENTITY_NAME="${WORKER_IDENTITY_NAME:-id-${ACA_NAME}-worker}"
PULL_IDENTITY_NAME="${PULL_IDENTITY_NAME:-id-${ACA_NAME}-acr-pull}"
DEPLOY_APP_NAME="${DEPLOY_APP_NAME:-${ACA_NAME}-gha-deploy}"
GITHUB_ENVIRONMENT=production # Must match both Azure-login jobs in deploy.yml.
# The ASP.NET sample serves HTTP on 8080, matching this app's ingress and
# default ACA TCP probes until the production image is deployed.
PLACEHOLDER_IMAGE="mcr.microsoft.com/dotnet/samples:aspnetapp"
TAGS=("created_by=${CREATED_BY:-github-actions}" "managed_by=${MANAGED_BY:-twilio-comics-ci}")

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_URL="$(git -C "$PROJECT_ROOT" remote get-url "${GIT_REMOTE_NAME:-origin}")" \
  || die "The project needs a GitHub origin remote for OIDC."
case "$REMOTE_URL" in
  git@github.com:*) GITHUB_REPOSITORY="${REMOTE_URL#git@github.com:}" ;;
  ssh://git@github.com/*) GITHUB_REPOSITORY="${REMOTE_URL#ssh://git@github.com/}" ;;
  https://github.com/*) GITHUB_REPOSITORY="${REMOTE_URL#https://github.com/}" ;;
  *) die "Expected a github.com Git remote, got '$REMOTE_URL'." ;;
esac
GITHUB_REPOSITORY="${GITHUB_REPOSITORY%.git}"
[[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || die "Cannot derive owner/repo from Git remote '$REMOTE_URL'."
OIDC_SUBJECT="${GITHUB_OIDC_SUBJECT:-repo:${GITHUB_REPOSITORY}:environment:${GITHUB_ENVIRONMENT}}"

az account show --output none >/dev/null 2>&1 || die "Run 'az login' first."
az account set --subscription "$SUBSCRIPTION_ID"
gh auth status >/dev/null 2>&1 || die "Run 'gh auth login' first."
gh api "repos/${GITHUB_REPOSITORY}" --jq .full_name >/dev/null \
  || die "GitHub CLI cannot access ${GITHUB_REPOSITORY}."

printf 'Azure subscription: %s\nResource group: %s (%s)\nGitHub repository: %s\nOIDC subject: %s\n' \
  "$SUBSCRIPTION_ID" "$RESOURCE_GROUP" "$LOCATION" "$GITHUB_REPOSITORY" "$OIDC_SUBJECT"
if [[ "${PROVISION_AZURE_CONFIRM:-}" != yes ]]; then
  [[ -t 0 ]] || die "Set PROVISION_AZURE_CONFIRM=yes when running non-interactively."
  read -r -p 'Provision or reuse these Azure and GitHub resources? [y/N] ' answer
  [[ "$answer" == y || "$answer" == Y ]] || die "Provisioning cancelled."
fi

az extension add --name containerapp --upgrade --only-show-errors
JOB_CREATE_HELP="$(az containerapp job create --help)"
[[ "$JOB_CREATE_HELP" == *--scale-rule-identity* ]] \
  || die "The containerapp Azure CLI extension must support --scale-rule-identity."

for provider in Microsoft.App Microsoft.OperationalInsights Microsoft.Storage \
  Microsoft.ContainerRegistry Microsoft.ManagedIdentity; do
  state="$(az provider show --namespace "$provider" --query registrationState --output tsv)" \
    || die "Cannot inspect Azure resource provider $provider in subscription $SUBSCRIPTION_ID."
  [[ "$state" == Registered ]] \
    || die "Azure resource provider $provider is ${state:-unregistered}. Run 'az provider register --namespace $provider --wait' in subscription $SUBSCRIPTION_ID, then rerun."
done

if ! az group show --name "$RESOURCE_GROUP" --output none >/dev/null 2>&1; then
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --tags "${TAGS[@]}" --output none
fi
RESOURCE_GROUP_ID="$(az group show --name "$RESOURCE_GROUP" --query id --output tsv)"

if ! az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --output none >/dev/null 2>&1; then
  az acr create --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" \
    --sku Basic --admin-enabled false --tags "${TAGS[@]}" --output none
fi
ACR_ID="$(az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query id --output tsv)"
ACR_SERVER="$(az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query loginServer --output tsv)"

if ! az containerapp env show --name "$ACA_ENVIRONMENT" --resource-group "$RESOURCE_GROUP" --output none >/dev/null 2>&1; then
  # ACA would otherwise auto-create an untagged workspace, which tenant policy rejects.
  if ! az monitor log-analytics workspace show --name "$LOG_ANALYTICS_WORKSPACE" \
      --resource-group "$RESOURCE_GROUP" --output none >/dev/null 2>&1; then
    az monitor log-analytics workspace create --name "$LOG_ANALYTICS_WORKSPACE" \
      --resource-group "$RESOURCE_GROUP" --location "$LOCATION" \
      --tags "${TAGS[@]}" --output none
  fi
  LAW_ID="$(az monitor log-analytics workspace show --name "$LOG_ANALYTICS_WORKSPACE" \
    --resource-group "$RESOURCE_GROUP" --query customerId --output tsv)"
  LAW_KEY="$(az monitor log-analytics workspace get-shared-keys --name "$LOG_ANALYTICS_WORKSPACE" \
    --resource-group "$RESOURCE_GROUP" --query primarySharedKey --output tsv)"
  az containerapp env create --name "$ACA_ENVIRONMENT" --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" --logs-destination log-analytics \
    --logs-workspace-id "$LAW_ID" --logs-workspace-key "$LAW_KEY" \
    --tags "${TAGS[@]}" --output none
else
  printf 'Reusing Container Apps environment %s and its existing log destination.\n' "$ACA_ENVIRONMENT"
fi

if ! az storage account show --name "$STORAGE_ACCOUNT" --resource-group "$RESOURCE_GROUP" --output none >/dev/null 2>&1; then
  az storage account create --name "$STORAGE_ACCOUNT" --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" --sku Standard_LRS --kind StorageV2 \
    --min-tls-version TLS1_2 --allow-blob-public-access false \
    --tags "${TAGS[@]}" --output none
fi
STORAGE_ID="$(az storage account show --name "$STORAGE_ACCOUNT" --resource-group "$RESOURCE_GROUP" --query id --output tsv)"

ensure_identity() {
  local name="$1"
  if ! az identity show --name "$name" --resource-group "$RESOURCE_GROUP" --output none >/dev/null 2>&1; then
    az identity create --name "$name" --resource-group "$RESOURCE_GROUP" \
      --location "$LOCATION" --tags "${TAGS[@]}" --output none
  fi
}
ensure_identity "$WEB_IDENTITY_NAME"
ensure_identity "$WORKER_IDENTITY_NAME"
ensure_identity "$PULL_IDENTITY_NAME"

WEB_ID="$(az identity show --name "$WEB_IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --query id --output tsv)"
WEB_PRINCIPAL="$(az identity show --name "$WEB_IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --query principalId --output tsv)"
WEB_CLIENT_ID="$(az identity show --name "$WEB_IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --query clientId --output tsv)"
WORKER_ID="$(az identity show --name "$WORKER_IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --query id --output tsv)"
WORKER_PRINCIPAL="$(az identity show --name "$WORKER_IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --query principalId --output tsv)"
WORKER_CLIENT_ID="$(az identity show --name "$WORKER_IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --query clientId --output tsv)"
PULL_ID="$(az identity show --name "$PULL_IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --query id --output tsv)"
PULL_PRINCIPAL="$(az identity show --name "$PULL_IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --query principalId --output tsv)"

ROLE_CREATED=false
assign_role() {
  local principal="$1" scope="$2" role="$3" principal_type="${4:-ServicePrincipal}" count
  count="$(az role assignment list --assignee-object-id "$principal" --scope "$scope" \
    --role "$role" --query 'length(@)' --output tsv)"
  if [[ "$count" == 0 ]]; then
    az role assignment create --assignee-object-id "$principal" \
      --assignee-principal-type "$principal_type" --scope "$scope" \
      --role "$role" --output none
    ROLE_CREATED=true
  fi
}
assign_role "$WEB_PRINCIPAL" "$STORAGE_ID" 'Storage Blob Data Contributor'
assign_role "$WEB_PRINCIPAL" "$STORAGE_ID" 'Storage Queue Data Message Sender'
assign_role "$WORKER_PRINCIPAL" "$STORAGE_ID" 'Storage Blob Data Contributor'
assign_role "$WORKER_PRINCIPAL" "$STORAGE_ID" 'Storage Queue Data Contributor'
assign_role "$PULL_PRINCIPAL" "$ACR_ID" AcrPull

if [[ -n "${PROVISIONER_OBJECT_ID:-}" ]]; then
  PROVISIONER_PRINCIPAL_TYPE="${PROVISIONER_PRINCIPAL_TYPE:-User}"
else
  PROVISIONER_OBJECT_ID="$(az ad signed-in-user show --query id --output tsv 2>/dev/null)" \
    || die "Set PROVISIONER_OBJECT_ID for a service-principal Azure login."
  PROVISIONER_PRINCIPAL_TYPE=User
fi
assign_role "$PROVISIONER_OBJECT_ID" "$STORAGE_ID" 'Storage Blob Data Contributor' "$PROVISIONER_PRINCIPAL_TYPE"
assign_role "$PROVISIONER_OBJECT_ID" "$STORAGE_ID" 'Storage Queue Data Contributor' "$PROVISIONER_PRINCIPAL_TYPE"
if [[ "$ROLE_CREATED" == true ]]; then
  printf 'Waiting for Azure Storage RBAC propagation...\n'
  sleep 30
fi

storage_create_retry() {
  local label="$1" attempt
  shift
  for attempt in 1 2 3 4 5 6; do
    if "$@"; then return 0; fi
    [[ "$attempt" == 6 ]] && die "Could not create or verify $label after RBAC propagation."
    sleep 10
  done
}
storage_create_retry "blob container $BLOB_CONTAINER" \
  az storage container create --account-name "$STORAGE_ACCOUNT" --name "$BLOB_CONTAINER" \
    --public-access off --auth-mode login --output none
storage_create_retry "queue $QUEUE_NAME" \
  az storage queue create --account-name "$STORAGE_ACCOUNT" --name "$QUEUE_NAME" \
    --auth-mode login --output none
storage_create_retry "queue $POISON_QUEUE_NAME" \
  az storage queue create --account-name "$STORAGE_ACCOUNT" --name "$POISON_QUEUE_NAME" \
    --auth-mode login --output none

WEB_ENV=(
  "AZURE_CLIENT_ID=$WEB_CLIENT_ID"
  "AZURE_STORAGE_BLOB_ENDPOINT=https://${STORAGE_ACCOUNT}.blob.core.windows.net"
  "AZURE_STORAGE_QUEUE_ENDPOINT=https://${STORAGE_ACCOUNT}.queue.core.windows.net"
  "AZURE_STORAGE_CONTAINER_NAME=$BLOB_CONTAINER"
  "AZURE_STORAGE_QUEUE_NAME=$QUEUE_NAME"
  "AZURE_STORAGE_POISON_QUEUE_NAME=$POISON_QUEUE_NAME"
)
WORKER_ENV=(
  "AZURE_CLIENT_ID=$WORKER_CLIENT_ID"
  "AZURE_STORAGE_BLOB_ENDPOINT=https://${STORAGE_ACCOUNT}.blob.core.windows.net"
  "AZURE_STORAGE_QUEUE_ENDPOINT=https://${STORAGE_ACCOUNT}.queue.core.windows.net"
  "AZURE_STORAGE_CONTAINER_NAME=$BLOB_CONTAINER"
  "AZURE_STORAGE_QUEUE_NAME=$QUEUE_NAME"
  "AZURE_STORAGE_POISON_QUEUE_NAME=$POISON_QUEUE_NAME"
)
RECOVERY_ENV=("${WORKER_ENV[@]}" 'RECOVERY_MODE=1')

# Fill missing infrastructure variables on adopted workloads; never silently
# redirect an existing workload to a different storage account or identity.
ensure_infrastructure_env() {
  local kind="$1" name="$2" current binding key wanted found
  shift 2
  local missing=()
  if [[ "$kind" == app ]]; then
    current="$(az containerapp show --name "$name" --resource-group "$RESOURCE_GROUP" --output json)"
  else
    current="$(az containerapp job show --name "$name" --resource-group "$RESOURCE_GROUP" --output json)"
  fi
  for binding in "$@"; do
    key="${binding%%=*}"
    wanted="${binding#*=}"
    found="$(jq -r --arg key "$key" '
      (.properties.template.containers[0].env // [] | map(select(.name == $key)) | .[0]) as $item
      | if $item == null then "__absent__"
        elif $item.secretRef != null then "__secret_ref__"
        else ($item.value // "") end' <<< "$current")"
    if [[ "$found" == __absent__ ]]; then
      missing+=("$binding")
    elif [[ "$found" != "$wanted" ]]; then
      die "$kind '$name' has a different $key. Resolve it before rerunning provisioning."
    fi
  done
  if ((${#missing[@]} > 0)); then
    if [[ "$kind" == app ]]; then
      az containerapp update --name "$name" --resource-group "$RESOURCE_GROUP" \
        --set-env-vars "${missing[@]}" --output none
    else
      az containerapp job update --name "$name" --resource-group "$RESOURCE_GROUP" \
        --set-env-vars "${missing[@]}" --output none
    fi
  fi
}

ensure_workload_identity() {
  local kind="$1" name="$2" identity_id="$3" current
  if [[ "$kind" == app ]]; then
    current="$(az containerapp show --name "$name" --resource-group "$RESOURCE_GROUP" --output json)"
  else
    current="$(az containerapp job show --name "$name" --resource-group "$RESOURCE_GROUP" --output json)"
  fi
  if ! jq -e --arg id "$identity_id" '(.identity.userAssignedIdentities // {}) | has($id)' \
      <<< "$current" >/dev/null; then
    if [[ "$kind" == app ]]; then
      az containerapp identity assign --name "$name" --resource-group "$RESOURCE_GROUP" \
        --user-assigned "$identity_id" --output none
    else
      az containerapp job identity assign --name "$name" --resource-group "$RESOURCE_GROUP" \
        --user-assigned "$identity_id" --output none
    fi
  fi
}

ensure_registry_pull() {
  local kind="$1" name="$2" current
  if [[ "$kind" == app ]]; then
    current="$(az containerapp show --name "$name" --resource-group "$RESOURCE_GROUP" --output json)"
  else
    current="$(az containerapp job show --name "$name" --resource-group "$RESOURCE_GROUP" --output json)"
  fi
  if ! jq -e --arg server "$ACR_SERVER" --arg id "$PULL_ID" '
      (.properties.configuration.registries // [] | map(select(.server == $server and .identity == $id)) | length) > 0
    ' <<< "$current" >/dev/null; then
    if [[ "$kind" == app ]]; then
      az containerapp registry set --name "$name" --resource-group "$RESOURCE_GROUP" \
        --server "$ACR_SERVER" --identity "$PULL_ID" --output none
    else
      az containerapp job registry set --name "$name" --resource-group "$RESOURCE_GROUP" \
        --server "$ACR_SERVER" --identity "$PULL_ID" --output none
    fi
  fi
}

if ! az containerapp show --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" --output none >/dev/null 2>&1; then
  az containerapp create --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" \
    --environment "$ACA_ENVIRONMENT" --image "$PLACEHOLDER_IMAGE" \
    --ingress external --target-port 8080 --transport auto \
    --cpu 0.5 --memory 1Gi --min-replicas 1 --max-replicas 2 \
    --scale-rule-name http --scale-rule-http-concurrency 50 \
    --termination-grace-period 240 \
    --user-assigned "$WEB_ID" "$PULL_ID" --env-vars "${WEB_ENV[@]}" \
    --tags "${TAGS[@]}" --output none
else
  existing_app="$(az containerapp show --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" --output json)"
  if ! jq -e '
    (.properties.configuration.ingress // {}) as $ingress
    | $ingress.external == true
      and $ingress.targetPort == 8080
      and (["auto", "http"] | index(($ingress.transport // "auto") | ascii_downcase) != null)
  ' <<< "$existing_app" >/dev/null; then
    die "Existing Container App '$ACA_NAME' must have external HTTP ingress on port 8080. Align ingress with 'az containerapp ingress update --name $ACA_NAME --resource-group $RESOURCE_GROUP --type external --target-port 8080 --transport auto' when its image listens on port 8080, or choose a new ACA_NAME."
  fi
fi
ensure_workload_identity app "$ACA_NAME" "$WEB_ID"
ensure_workload_identity app "$ACA_NAME" "$PULL_ID"
ensure_infrastructure_env app "$ACA_NAME" "${WEB_ENV[@]}"
ensure_registry_pull app "$ACA_NAME"

# The placeholder does not expose /api/healthz. ACA's default ingress TCP
# startup/readiness/liveness probes keep it healthy until the real image ships.
if ! az containerapp job show --name "$ACA_JOB_NAME" --resource-group "$RESOURCE_GROUP" --output none >/dev/null 2>&1; then
  az containerapp job create --name "$ACA_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
    --environment "$ACA_ENVIRONMENT" --trigger-type Event \
    --replica-timeout 900 --replica-retry-limit 0 \
    --replica-completion-count 1 --parallelism 1 --polling-interval 15 \
    --min-executions 0 --max-executions 1 \
    --scale-rule-name generation-queue --scale-rule-type azure-queue \
    --scale-rule-metadata "accountName=${STORAGE_ACCOUNT}" 'cloud=AzurePublicCloud' \
      'queueLength=1' "queueName=${QUEUE_NAME}" \
    --scale-rule-identity "$WORKER_ID" \
    --image "$PLACEHOLDER_IMAGE" --cpu 1 --memory 2Gi \
    --command pnpm --args start:worker \
    --mi-user-assigned "$WORKER_ID" "$PULL_ID" --env-vars "${WORKER_ENV[@]}" \
    --tags "${TAGS[@]}" --output none
fi
ensure_workload_identity job "$ACA_JOB_NAME" "$WORKER_ID"
ensure_workload_identity job "$ACA_JOB_NAME" "$PULL_ID"
ensure_infrastructure_env job "$ACA_JOB_NAME" "${WORKER_ENV[@]}"
ensure_registry_pull job "$ACA_JOB_NAME"

# A scheduled sweep republishes receipts/jobs left pending after transient
# database or queue failures. It uses the same workload identities and storage
# configuration as the event-driven worker, with RECOVERY_MODE selecting the
# bounded recovery path in worker/index.ts.
if ! az containerapp job show --name "$ACA_RECOVERY_JOB_NAME" --resource-group "$RESOURCE_GROUP" --output none >/dev/null 2>&1; then
  az containerapp job create --name "$ACA_RECOVERY_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
    --environment "$ACA_ENVIRONMENT" --trigger-type Schedule \
    --cron-expression '*/5 * * * *' \
    --replica-timeout 900 --replica-retry-limit 0 \
    --replica-completion-count 1 --parallelism 1 \
    --image "$PLACEHOLDER_IMAGE" --cpu 1 --memory 2Gi \
    --command pnpm --args start:worker \
    --mi-user-assigned "$WORKER_ID" "$PULL_ID" --env-vars "${RECOVERY_ENV[@]}" \
    --tags "${TAGS[@]}" --output none
fi
ensure_workload_identity job "$ACA_RECOVERY_JOB_NAME" "$WORKER_ID"
ensure_workload_identity job "$ACA_RECOVERY_JOB_NAME" "$PULL_ID"
ensure_infrastructure_env job "$ACA_RECOVERY_JOB_NAME" "${RECOVERY_ENV[@]}"
ensure_registry_pull job "$ACA_RECOVERY_JOB_NAME"

# GitHub Actions uses an environment on both Azure-login jobs, so its OIDC
# subject is environment-based even when the workflow runs on main.
if [[ -n "${AZURE_DEPLOY_APP_ID:-}" ]]; then
  DEPLOY_APP_ID="$AZURE_DEPLOY_APP_ID"
  az ad app show --id "$DEPLOY_APP_ID" --output none >/dev/null
else
  MATCHING_APPS="$(az ad app list --display-name "$DEPLOY_APP_NAME" --output json \
    | jq --arg name "$DEPLOY_APP_NAME" '[.[] | select(.displayName == $name) | .appId]')"
  case "$(jq 'length' <<< "$MATCHING_APPS")" in
    0) DEPLOY_APP_ID="$(az ad app create --display-name "$DEPLOY_APP_NAME" --query appId --output tsv)" ;;
    1) DEPLOY_APP_ID="$(jq -r '.[0]' <<< "$MATCHING_APPS")" ;;
    *) die "Multiple Entra apps are named '$DEPLOY_APP_NAME'; set AZURE_DEPLOY_APP_ID." ;;
  esac
fi
if ! az ad sp show --id "$DEPLOY_APP_ID" --output none >/dev/null 2>&1; then
  az ad sp create --id "$DEPLOY_APP_ID" --output none
fi
DEPLOY_PRINCIPAL="$(az ad sp show --id "$DEPLOY_APP_ID" --query id --output tsv)"
assign_role "$DEPLOY_PRINCIPAL" "$ACR_ID" AcrPush
assign_role "$DEPLOY_PRINCIPAL" "$RESOURCE_GROUP_ID" Contributor

FEDERATED_NAME=gha-production
FEDERATED_JSON="$(az ad app federated-credential list --id "$DEPLOY_APP_ID" --output json)"
FEDERATED_CURRENT="$(jq -c --arg name "$FEDERATED_NAME" \
  '[.[] | select(.name == $name)] | .[0] // empty' <<< "$FEDERATED_JSON")"
FEDERATED_PARAMETERS="$(jq -n --arg name "$FEDERATED_NAME" --arg subject "$OIDC_SUBJECT" '{
  name: $name,
  issuer: "https://token.actions.githubusercontent.com",
  subject: $subject,
  audiences: ["api://AzureADTokenExchange"]
}')"
FEDERATED_UPDATE_PARAMETERS="$(jq -n --arg subject "$OIDC_SUBJECT" '{
  issuer: "https://token.actions.githubusercontent.com",
  subject: $subject,
  audiences: ["api://AzureADTokenExchange"]
}')"
if [[ -z "$FEDERATED_CURRENT" ]]; then
  az ad app federated-credential create --id "$DEPLOY_APP_ID" \
    --parameters "$FEDERATED_PARAMETERS" --output none
elif ! jq -e --arg subject "$OIDC_SUBJECT" '
    .subject == $subject and .issuer == "https://token.actions.githubusercontent.com"
      and (.audiences | index("api://AzureADTokenExchange") != null)
  ' <<< "$FEDERATED_CURRENT" >/dev/null; then
  az ad app federated-credential update --id "$DEPLOY_APP_ID" \
    --federated-credential-id "$FEDERATED_NAME" \
    --parameters "$FEDERATED_UPDATE_PARAMETERS" --output none
fi

# A missing environment is created with a main-only deployment branch policy.
# Existing environment reviewers and protection settings are never replaced.
ENVIRONMENT_API="repos/${GITHUB_REPOSITORY}/environments/${GITHUB_ENVIRONMENT}"
if ! gh api "$ENVIRONMENT_API" >/dev/null 2>&1; then
  GH_ENV_PARAMETERS='{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
  gh api --method PUT "$ENVIRONMENT_API" --input - >/dev/null <<< "$GH_ENV_PARAMETERS"
  gh api --method POST "${ENVIRONMENT_API}/deployment-branch-policies" \
    --field name=main >/dev/null
fi

gh variable set ACR_NAME --repo "$GITHUB_REPOSITORY" --body "$ACR_NAME"
gh variable set ACA_NAME --repo "$GITHUB_REPOSITORY" --body "$ACA_NAME"
gh variable set ACA_JOB_NAME --repo "$GITHUB_REPOSITORY" --body "$ACA_JOB_NAME"
gh variable set ACA_RECOVERY_JOB_NAME --repo "$GITHUB_REPOSITORY" --body "$ACA_RECOVERY_JOB_NAME"
gh variable set ACA_RESOURCE_GROUP --repo "$GITHUB_REPOSITORY" --body "$RESOURCE_GROUP"
TENANT_ID="$(az account show --query tenantId --output tsv)"
gh secret set AZURE_CLIENT_ID --repo "$GITHUB_REPOSITORY" --env "$GITHUB_ENVIRONMENT" --body "$DEPLOY_APP_ID"
gh secret set AZURE_TENANT_ID --repo "$GITHUB_REPOSITORY" --env "$GITHUB_ENVIRONMENT" --body "$TENANT_ID"
gh secret set AZURE_SUBSCRIPTION_ID --repo "$GITHUB_REPOSITORY" --env "$GITHUB_ENVIRONMENT" --body "$SUBSCRIPTION_ID"

cat <<EOF
Azure foundation is ready for ${GITHUB_REPOSITORY}.

Public app:  ${ACA_NAME}
Queue job:   ${ACA_JOB_NAME}
Recovery job: ${ACA_RECOVERY_JOB_NAME}
ACR server:  ${ACR_SERVER}

Set runtime secrets on both Jobs and public URLs from docs/INFRA_SETUP.md before the first deploy.
Set DATABASE_URL in the GitHub production environment for Drizzle migrations.
EOF
