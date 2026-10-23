#!/usr/bin/env bash
set -euo pipefail

# One-time Azure foundation for the web app, queue job, and recovery job.
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
GENERATION_JOB_POLLING_INTERVAL=5
# The migration Job is created later by provision-postgres-roles.sh. A second
# foundation run gives the deployment principal access once that Job exists.
ACA_MIGRATION_JOB_NAME="${ACA_MIGRATION_JOB_NAME:-}"
if [[ -z "$ACA_MIGRATION_JOB_NAME" && "$ACA_NAME" == *-v2 ]]; then
  ACA_MIGRATION_JOB_NAME="${ACA_NAME%-v2}-migrate-v2"
fi
BLOB_CONTAINER="${BLOB_CONTAINER:-comics}"
QUEUE_NAME="${QUEUE_NAME:-comic-generation}"
POISON_QUEUE_NAME="${POISON_QUEUE_NAME:-comic-generation-poison}"
WEB_IDENTITY_NAME="${WEB_IDENTITY_NAME:-id-${ACA_NAME}-web}"
WORKER_IDENTITY_NAME="${WORKER_IDENTITY_NAME:-id-${ACA_NAME}-worker}"
PULL_IDENTITY_NAME="${PULL_IDENTITY_NAME:-id-${ACA_NAME}-acr-pull}"
DEPLOY_APP_NAME="${DEPLOY_APP_NAME:-${ACA_NAME}-gha-deploy}"
GITHUB_ENVIRONMENT=production # Must match both Azure-login jobs in deploy.yml.
# The ASP.NET sample serves HTTP on 8080 behind internal ingress. The release
# workflow publishes ingress only after migrations and the real image are ready.
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

# An interrupted `az containerapp env create` can leave a visible environment
# in Waiting/InProgress for several minutes. Creating its first app before the
# environment reaches Succeeded then fails with ManagedEnvironmentNotProvisioned.
environment_ready=false
environment_read_failures=0
for ((attempt = 1; attempt <= 120; attempt++)); do
  if environment_state="$(az containerapp env show --name "$ACA_ENVIRONMENT" \
    --resource-group "$RESOURCE_GROUP" --query properties.provisioningState --output tsv)"; then
    environment_read_failures=0
  else
    environment_read_failures=$((environment_read_failures + 1))
    ((environment_read_failures < 5)) \
      || die "Cannot read Container Apps environment '$ACA_ENVIRONMENT' provisioning state after five attempts."
    printf 'Retrying Container Apps environment read (%s/5)...\n' "$environment_read_failures"
    sleep "${AZURE_ENV_POLL_SECONDS:-15}"
    continue
  fi
  case "$environment_state" in
    Succeeded)
      environment_ready=true
      break ;;
    Failed|Canceled|Cancelled)
      die "Container Apps environment '$ACA_ENVIRONMENT' finished in state '$environment_state'. Inspect its Azure activity log before rerunning." ;;
  esac
  if ((attempt % 4 == 1)); then
    printf 'Waiting for Container Apps environment %s (state: %s)...\n' \
      "$ACA_ENVIRONMENT" "${environment_state:-unknown}"
  fi
  sleep "${AZURE_ENV_POLL_SECONDS:-15}"
done
[[ "$environment_ready" == true ]] \
  || die "Container Apps environment '$ACA_ENVIRONMENT' did not become ready within 30 minutes."

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
    --ingress internal --target-port 8080 --transport auto \
    --cpu 0.5 --memory 1Gi --min-replicas 0 --max-replicas 2 \
    --scale-rule-name http --scale-rule-http-concurrency 50 \
    --termination-grace-period 240 \
    --user-assigned "$WEB_ID" "$PULL_ID" --env-vars "${WEB_ENV[@]}" \
    --tags "${TAGS[@]}" --output none
else
  existing_app="$(az containerapp show --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" --output json)"
  if ! jq -e '
    (.properties.configuration.ingress // {}) as $ingress
    | ($ingress.external | type) == "boolean"
      and $ingress.targetPort == 8080
      and (["auto", "http"] | index(($ingress.transport // "auto") | ascii_downcase) != null)
  ' <<< "$existing_app" >/dev/null; then
    die "Existing Container App '$ACA_NAME' must have HTTP ingress on port 8080. Inspect its configuration and choose a different ACA_NAME if necessary."
  fi
  if jq -e --arg image "$PLACEHOLDER_IMAGE" '
    .properties.configuration.ingress.external == true
      and .properties.template.containers[0].image == $image
  ' <<< "$existing_app" >/dev/null; then
    die "Existing Container App '$ACA_NAME' exposes the sample placeholder. Make its ingress internal and scale it to zero before rerunning, or choose a new ACA_NAME."
  fi
fi
ensure_workload_identity app "$ACA_NAME" "$WEB_ID"
ensure_workload_identity app "$ACA_NAME" "$PULL_ID"
ensure_infrastructure_env app "$ACA_NAME" "${WEB_ENV[@]}"
ensure_registry_pull app "$ACA_NAME"

# The placeholder does not expose /api/healthz. It stays private and scaled to
# zero until the real image and runtime configuration are deployed.
if ! az containerapp job show --name "$ACA_JOB_NAME" --resource-group "$RESOURCE_GROUP" --output none >/dev/null 2>&1; then
  az containerapp job create --name "$ACA_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
    --environment "$ACA_ENVIRONMENT" --trigger-type Event \
    --replica-timeout 900 --replica-retry-limit 0 \
    --replica-completion-count 1 --parallelism 1 --polling-interval "$GENERATION_JOB_POLLING_INTERVAL" \
    --min-executions 0 --max-executions 1 \
    --scale-rule-name generation-queue --scale-rule-type azure-queue \
    --scale-rule-metadata "accountName=${STORAGE_ACCOUNT}" 'cloud=AzurePublicCloud' \
      'queueLength=1' "queueName=${QUEUE_NAME}" \
    --scale-rule-identity "$WORKER_ID" \
    --image "$PLACEHOLDER_IMAGE" --cpu 1 --memory 2Gi \
    --command pnpm --args start:worker \
    --mi-user-assigned "$WORKER_ID" "$PULL_ID" --env-vars "${WORKER_ENV[@]}" \
    --tags "${TAGS[@]}" --output none
else
  existing_generation_job="$(az containerapp job show --name "$ACA_JOB_NAME" \
    --resource-group "$RESOURCE_GROUP" --output json)"
  jq -e '.properties.configuration.triggerType == "Event"' \
    <<< "$existing_generation_job" >/dev/null \
    || die "Existing generation Job '$ACA_JOB_NAME' is not event-triggered. Inspect its configuration before rerunning."
  current_polling_interval="$(jq -r \
    '.properties.configuration.eventTriggerConfig.scale.pollingInterval // empty' \
    <<< "$existing_generation_job")"
  if [[ "$current_polling_interval" != "$GENERATION_JOB_POLLING_INTERVAL" ]]; then
    # This flag changes only the event poll cadence; preserve the image, queue
    # rule, scaling limits, secrets, and all other settings on the live Job.
    az containerapp job update --name "$ACA_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
      --polling-interval "$GENERATION_JOB_POLLING_INTERVAL" --output none
  fi
fi
ensure_workload_identity job "$ACA_JOB_NAME" "$WORKER_ID"
ensure_workload_identity job "$ACA_JOB_NAME" "$PULL_ID"
ensure_infrastructure_env job "$ACA_JOB_NAME" "${WORKER_ENV[@]}"
ensure_registry_pull job "$ACA_JOB_NAME"

# A scheduled sweep republishes receipts/jobs left pending after transient
# database or queue failures. Keep the placeholder dormant until deploy.yml
# replaces its image, runtime secrets, and cron schedule with the real worker.
# Otherwise the ASP.NET placeholder would try to run pnpm every five minutes.
if ! az containerapp job show --name "$ACA_RECOVERY_JOB_NAME" --resource-group "$RESOURCE_GROUP" --output none >/dev/null 2>&1; then
  az containerapp job create --name "$ACA_RECOVERY_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
    --environment "$ACA_ENVIRONMENT" --trigger-type Schedule \
    --cron-expression '0 0 1 1 *' \
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
[[ -n "$DEPLOY_PRINCIPAL" ]] || die "Cannot resolve the GitHub deployment principal."

verify_workload_scope() {
  local scope="$1" type="$2" name="$3"
  jq -en --arg actual "$scope" --arg group "$RESOURCE_GROUP_ID" \
    --arg type "$type" --arg name "$name" '
      ($actual | ascii_downcase)
        == (($group + "/providers/Microsoft.App/" + $type + "/" + $name) | ascii_downcase)
    ' >/dev/null
}

# Do not silently change an older principal's assignments. A direct resource
# group Contributor grant would override the narrow workload scopes below.
LEGACY_ASSIGNMENTS="$(az role assignment list --assignee-object-id "$DEPLOY_PRINCIPAL" \
  --scope "$RESOURCE_GROUP_ID" --role Contributor --output json)"
LEGACY_ASSIGNMENT_IDS="$(jq -r --arg scope "$RESOURCE_GROUP_ID" '
  .[] | select((.scope | ascii_downcase) == ($scope | ascii_downcase)) | .id
' <<< "$LEGACY_ASSIGNMENTS")"
[[ -z "$LEGACY_ASSIGNMENT_IDS" ]] \
  || die "The GitHub deployment principal still has direct Contributor access at $RESOURCE_GROUP_ID. Review and revoke that assignment manually, then rerun. This script did not remove it."

# Grant access only to resources that this workflow actually updates. The
# migration Job is created by the PostgreSQL role provisioner, so rerun this
# script after that step to grant its Job-specific role.
WEB_SCOPE="$(az containerapp show --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" --query id --output tsv)"
GENERATION_SCOPE="$(az containerapp job show --name "$ACA_JOB_NAME" --resource-group "$RESOURCE_GROUP" --query id --output tsv)"
RECOVERY_SCOPE="$(az containerapp job show --name "$ACA_RECOVERY_JOB_NAME" --resource-group "$RESOURCE_GROUP" --query id --output tsv)"
verify_workload_scope "$WEB_SCOPE" containerApps "$ACA_NAME" \
  || die "Could not verify the exact Container App resource ID for '$ACA_NAME'."
verify_workload_scope "$GENERATION_SCOPE" jobs "$ACA_JOB_NAME" \
  || die "Could not verify the exact generation Job resource ID for '$ACA_JOB_NAME'."
verify_workload_scope "$RECOVERY_SCOPE" jobs "$ACA_RECOVERY_JOB_NAME" \
  || die "Could not verify the exact recovery Job resource ID for '$ACA_RECOVERY_JOB_NAME'."

ROLE_CREATED=false
assign_role "$DEPLOY_PRINCIPAL" "$ACR_ID" AcrPush
assign_role "$DEPLOY_PRINCIPAL" "$WEB_SCOPE" 'Container Apps Contributor'
assign_role "$DEPLOY_PRINCIPAL" "$GENERATION_SCOPE" 'Container Apps Jobs Contributor'
assign_role "$DEPLOY_PRINCIPAL" "$RECOVERY_SCOPE" 'Container Apps Jobs Contributor'
if [[ -n "$ACA_MIGRATION_JOB_NAME" ]]; then
  if az containerapp job show --name "$ACA_MIGRATION_JOB_NAME" \
      --resource-group "$RESOURCE_GROUP" --output none >/dev/null 2>&1; then
    MIGRATION_SCOPE="$(az containerapp job show --name "$ACA_MIGRATION_JOB_NAME" \
      --resource-group "$RESOURCE_GROUP" --query id --output tsv)"
    verify_workload_scope "$MIGRATION_SCOPE" jobs "$ACA_MIGRATION_JOB_NAME" \
      || die "Could not verify the exact migration Job resource ID for '$ACA_MIGRATION_JOB_NAME'."
    assign_role "$DEPLOY_PRINCIPAL" "$MIGRATION_SCOPE" 'Container Apps Jobs Contributor'
  else
    printf 'Migration Job %s does not exist yet; rerun this script after role bootstrap.\n' \
      "$ACA_MIGRATION_JOB_NAME"
  fi
fi
if [[ "$ROLE_CREATED" == true ]]; then
  printf 'Waiting for scoped deployment RBAC propagation...\n'
  sleep "${AZURE_DEPLOY_RBAC_POLL_SECONDS:-30}"
fi

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
else
  FEDERATED_SUBJECT="$(jq -r '.subject // empty' <<< "$FEDERATED_CURRENT")"
  if [[ -z "${GITHUB_OIDC_SUBJECT:-}" && "$FEDERATED_SUBJECT" != "$OIDC_SUBJECT" ]]; then
    die "Existing '$FEDERATED_NAME' OIDC subject is '${FEDERATED_SUBJECT:-<missing>}', but the derived default is '$OIDC_SUBJECT'. Set GITHUB_OIDC_SUBJECT to the exact GitHub OIDC token 'sub' claim before rerunning. The federated credential was not changed."
  fi
  if ! jq -e --arg subject "$OIDC_SUBJECT" '
    .subject == $subject and .issuer == "https://token.actions.githubusercontent.com"
      and (.audiences | index("api://AzureADTokenExchange") != null)
  ' <<< "$FEDERATED_CURRENT" >/dev/null; then
    az ad app federated-credential update --id "$DEPLOY_APP_ID" \
      --federated-credential-id "$FEDERATED_NAME" \
      --parameters "$FEDERATED_UPDATE_PARAMETERS" --output none
  fi
fi

# Restrict production deployments to main on both first setup and reruns. The
# environment API updates protection rules as well as branch mode, so carry
# existing reviewers and wait timers through a mode change.
ENVIRONMENT_API="repos/${GITHUB_REPOSITORY}/environments/${GITHUB_ENVIRONMENT}"
ENVIRONMENTS_JSON="$(gh api --paginate --slurp "repos/${GITHUB_REPOSITORY}/environments?per_page=100")" \
  || die "Cannot list GitHub environments for ${GITHUB_REPOSITORY}."
jq -e 'type == "array" and length > 0 and all(.[]; (.environments | type) == "array")' \
  <<< "$ENVIRONMENTS_JSON" >/dev/null \
  || die "GitHub returned an unexpected environment list."
ENVIRONMENT_COUNT="$(jq --arg name "$GITHUB_ENVIRONMENT" \
  '[.[].environments[] | select(.name == $name)] | length' <<< "$ENVIRONMENTS_JSON")"
[[ "$ENVIRONMENT_COUNT" == 0 || "$ENVIRONMENT_COUNT" == 1 ]] \
  || die "GitHub returned duplicate '$GITHUB_ENVIRONMENT' environments."
if [[ "$ENVIRONMENT_COUNT" == 1 ]]; then
  ENVIRONMENT_JSON="$(gh api "$ENVIRONMENT_API")" \
    || die "Cannot inspect the existing GitHub '$GITHUB_ENVIRONMENT' environment."
  jq -e --arg name "$GITHUB_ENVIRONMENT" '
    .name == $name and (.protection_rules | type) == "array"
      and (.deployment_branch_policy == null
        or ((.deployment_branch_policy.protected_branches | type) == "boolean"
          and (.deployment_branch_policy.custom_branch_policies | type) == "boolean"))
  ' <<< "$ENVIRONMENT_JSON" >/dev/null \
    || die "GitHub returned an unexpected '$GITHUB_ENVIRONMENT' environment."
else
  ENVIRONMENT_JSON='{"name":"production","protection_rules":[],"deployment_branch_policy":null}'
fi

if ! jq -e '.deployment_branch_policy.protected_branches == false
    and .deployment_branch_policy.custom_branch_policies == true' \
    <<< "$ENVIRONMENT_JSON" >/dev/null; then
  jq -e '
    ([.protection_rules[] | select(.type == "wait_timer")] | length) <= 1
      and ([.protection_rules[] | select(.type == "required_reviewers")] | length) <= 1
      and all(.protection_rules[]; .type == "wait_timer"
        or .type == "required_reviewers" or .type == "branch_policy")
      and all(.protection_rules[] | select(.type == "wait_timer");
        (.wait_timer | type) == "number")
      and all(.protection_rules[] | select(.type == "required_reviewers");
        (.reviewers | type) == "array"
          and all(.reviewers[]; (.type == "User" or .type == "Team")
            and (.reviewer.id | type) == "number"))
  ' <<< "$ENVIRONMENT_JSON" >/dev/null \
    || die "Cannot safely preserve existing GitHub environment protection rules."
  GH_ENV_PARAMETERS="$(jq -c '
    (.protection_rules | map(select(.type == "wait_timer"))) as $wait
    | (.protection_rules | map(select(.type == "required_reviewers"))) as $review
    | {deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}}
      + (if ($wait | length) == 1 then {wait_timer: $wait[0].wait_timer} else {} end)
      + (if ($review | length) == 1 then {
          reviewers: [$review[0].reviewers[] | {type: .type, id: .reviewer.id}],
          prevent_self_review: ($review[0].prevent_self_review // false)
        } else {} end)
  ' <<< "$ENVIRONMENT_JSON")"
  gh api --method PUT "$ENVIRONMENT_API" --input - >/dev/null <<< "$GH_ENV_PARAMETERS" \
    || die "Cannot set GitHub '$GITHUB_ENVIRONMENT' to custom deployment branch policies."
fi

BRANCH_POLICIES_API="${ENVIRONMENT_API}/deployment-branch-policies"
list_branch_policies() {
  gh api --paginate --slurp "${BRANCH_POLICIES_API}?per_page=100"
}
BRANCH_POLICIES_JSON="$(list_branch_policies)" \
  || die "Cannot list GitHub '$GITHUB_ENVIRONMENT' deployment branch policies."
jq -e 'type == "array" and length > 0
  and all(.[]; (.branch_policies | type) == "array")
  and all(.[].branch_policies[]; (.id | type) == "number"
    and (.name | type) == "string"
    and (.type == null or .type == "branch" or .type == "tag"))' \
  <<< "$BRANCH_POLICIES_JSON" >/dev/null \
  || die "GitHub returned an unexpected deployment branch policy list."

if ! jq -e '[.[].branch_policies[] | select(.name == "main"
    and (.type == null or .type == "branch"))] | length > 0' \
    <<< "$BRANCH_POLICIES_JSON" >/dev/null; then
  gh api --method POST "$BRANCH_POLICIES_API" \
    --field name=main --field type=branch >/dev/null \
    || die "Cannot add the GitHub '$GITHUB_ENVIRONMENT' main branch policy."
fi

# Add main before removing broader patterns, so a failed API call never leaves
# the environment open to more branches than it was at the start of this step.
while IFS= read -r policy_id; do
  [[ -n "$policy_id" ]] || continue
  gh api --method DELETE "${BRANCH_POLICIES_API}/${policy_id}" >/dev/null \
    || die "Cannot remove extra GitHub '$GITHUB_ENVIRONMENT' deployment branch policy ${policy_id}."
done < <(jq -r '.[].branch_policies[]
  | select(.name != "main" or (.type != null and .type != "branch")) | .id' \
  <<< "$BRANCH_POLICIES_JSON")

FINAL_ENVIRONMENT_JSON="$(gh api "$ENVIRONMENT_API")" \
  || die "Cannot verify GitHub '$GITHUB_ENVIRONMENT' environment after update."
FINAL_BRANCH_POLICIES_JSON="$(list_branch_policies)" \
  || die "Cannot verify GitHub '$GITHUB_ENVIRONMENT' branch policies after update."
jq -e '.deployment_branch_policy.protected_branches == false
  and .deployment_branch_policy.custom_branch_policies == true' \
  <<< "$FINAL_ENVIRONMENT_JSON" >/dev/null \
  || die "GitHub '$GITHUB_ENVIRONMENT' is not restricted to custom branch policies."
jq -e '[.[].branch_policies[]] as $policies
  | ($policies | length) == 1 and $policies[0].name == "main"
    and ($policies[0].type == null or $policies[0].type == "branch")' \
  <<< "$FINAL_BRANCH_POLICIES_JSON" >/dev/null \
  || die "GitHub '$GITHUB_ENVIRONMENT' must have exactly one main branch policy."

gh variable set ACR_NAME --repo "$GITHUB_REPOSITORY" --body "$ACR_NAME"
gh variable set ACA_NAME --repo "$GITHUB_REPOSITORY" --body "$ACA_NAME"
gh variable set ACA_JOB_NAME --repo "$GITHUB_REPOSITORY" --body "$ACA_JOB_NAME"
gh variable set ACA_RECOVERY_JOB_NAME --repo "$GITHUB_REPOSITORY" --body "$ACA_RECOVERY_JOB_NAME"
if [[ -n "$ACA_MIGRATION_JOB_NAME" ]]; then
  gh variable set ACA_MIGRATION_JOB_NAME --repo "$GITHUB_REPOSITORY" --body "$ACA_MIGRATION_JOB_NAME"
fi
gh variable set ACA_RESOURCE_GROUP --repo "$GITHUB_REPOSITORY" --body "$RESOURCE_GROUP"
TENANT_ID="$(az account show --query tenantId --output tsv)"
gh secret set AZURE_CLIENT_ID --repo "$GITHUB_REPOSITORY" --env "$GITHUB_ENVIRONMENT" --body "$DEPLOY_APP_ID"
gh secret set AZURE_TENANT_ID --repo "$GITHUB_REPOSITORY" --env "$GITHUB_ENVIRONMENT" --body "$TENANT_ID"
gh secret set AZURE_SUBSCRIPTION_ID --repo "$GITHUB_REPOSITORY" --env "$GITHUB_ENVIRONMENT" --body "$SUBSCRIPTION_ID"

cat <<EOF
Azure foundation is ready for ${GITHUB_REPOSITORY}.

Web app:    ${ACA_NAME} (new placeholders have internal ingress, minReplicas=0)
Queue job:   ${ACA_JOB_NAME}
Recovery job: ${ACA_RECOVERY_JOB_NAME}
ACR server:  ${ACR_SERVER}

Rerun this script after the migration Job exists to grant its scoped deploy role.
Set runtime secrets on both Jobs and public URLs from docs/INFRA_SETUP.md before the first deploy.
Store runtime and migration DATABASE_URL values as Azure Container Apps secrets. The
production GitHub environment needs only Azure OIDC identifiers. Set the repository
variable PRODUCTION_RELEASE_READY=true only after the private Azure PostgreSQL server,
migration Job, application secrets, and Twilio sender are configured.
EOF
