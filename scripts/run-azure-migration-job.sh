#!/usr/bin/env bash
set -euo pipefail

: "${ACA_MIGRATION_JOB_NAME:?Set ACA_MIGRATION_JOB_NAME to the manual Container Apps migration Job}"
: "${ACA_RESOURCE_GROUP:?Set ACA_RESOURCE_GROUP to the Job resource group}"
: "${MIGRATION_IMAGE:?Set MIGRATION_IMAGE to a digest-pinned ACR image}"
: "${GITHUB_SHA:?Set GITHUB_SHA to the commit being released}"

expected_subscription='b001fc6f-ea19-456a-8401-63971a1a1d98'
expected_resource_group='rg-twilio-comics'
expected_job='twilio-comics-migrate-v2'
expected_environment='cae-twilio-comics-v2'
expected_identity='id-twilio-comics-pg-migrate'
expected_binding='migration-database-url'
expected_vault_uri='https://kv-twilio-comics-1a1d98.vault.azure.net/secrets/postgres-comics-migration-url'
expected_job_id="/subscriptions/$expected_subscription/resourceGroups/$expected_resource_group/providers/Microsoft.App/jobs/$expected_job"
expected_environment_id="/subscriptions/$expected_subscription/resourceGroups/$expected_resource_group/providers/Microsoft.App/managedEnvironments/$expected_environment"
expected_identity_id="/subscriptions/$expected_subscription/resourceGroups/$expected_resource_group/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$expected_identity"

if [[ "$ACA_MIGRATION_JOB_NAME" != "$expected_job" ||
      "$ACA_RESOURCE_GROUP" != "$expected_resource_group" ]]; then
  echo "Migration release must target the approved V2 Job and resource group" >&2
  exit 1
fi
if [[ ! "$MIGRATION_IMAGE" =~ ^twiliocomicsacr1a1d98\.azurecr\.io/twilio-comics-migrate@sha256:[a-f0-9]{64}$ ]]; then
  echo "MIGRATION_IMAGE must be the digest-pinned migration image in the approved ACR" >&2
  exit 1
fi
if [[ ! "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]]; then
  echo "GITHUB_SHA must be a 40-character commit SHA" >&2
  exit 1
fi

max_polls="${MIGRATION_MAX_POLLS:-210}"
poll_interval="${MIGRATION_POLL_INTERVAL_SECONDS:-10}"
if [[ ! "$max_polls" =~ ^[1-9][0-9]*$ ]] || (( max_polls > 300 )) ||
   [[ ! "$poll_interval" =~ ^[0-9]+$ ]] || (( poll_interval > 60 )); then
  echo "Invalid migration polling limits" >&2
  exit 1
fi
command -v jq >/dev/null || { echo "jq is required to inspect the migration Job" >&2; exit 1; }

active_subscription="$(az account show --query id --output tsv --only-show-errors)" || {
  echo "Could not determine the active Azure subscription" >&2
  exit 1
}
if [[ "$active_subscription" != "$expected_subscription" ]]; then
  echo "Migration release requires the approved Azure subscription" >&2
  exit 1
fi

job_json="$(az containerapp job show \
  --name "$ACA_MIGRATION_JOB_NAME" \
  --resource-group "$ACA_RESOURCE_GROUP" \
  --output json --only-show-errors)"
if ! jq --exit-status \
  --arg job "$expected_job" \
  --arg job_id "$expected_job_id" \
  --arg environment_id "$expected_environment_id" \
  --arg identity_id "$expected_identity_id" \
  --arg binding "$expected_binding" \
  --arg vault_uri "$expected_vault_uri" '
  (.properties.template.containers[0].env // []
    | map(select(.name == "DATABASE_URL"))) as $database_env
  | (.properties.configuration.secrets // []
    | map(select(.name == $binding))) as $database_secrets
  | .name == $job
  and ((.id // "" | ascii_downcase) == ($job_id | ascii_downcase))
  and .properties.configuration.triggerType == "Manual"
  and ((.properties.environmentId // "" | ascii_downcase) == ($environment_id | ascii_downcase))
  and (.properties.template.containers | length) == 1
  and ([.identity.userAssignedIdentities // {} | keys[]
    | select((ascii_downcase) == ($identity_id | ascii_downcase))] | length == 1)
  and (.properties.configuration.secrets | length) == 1
  and ($database_env | length == 1)
  and $database_env[0].secretRef == $binding
  and (($database_env[0].value // "") == "")
  and ($database_secrets | length == 1)
  and $database_secrets[0].keyVaultUrl == $vault_uri
  and (($database_secrets[0].identity // "" | ascii_downcase) == ($identity_id | ascii_downcase))
  and (($database_secrets[0].value // "") == "")
' >/dev/null <<< "$job_json"; then
  echo "Migration Job must be the approved manual V2 Job with its private migration Key Vault binding and assigned identity" >&2
  exit 1
fi

# Azure stores --command "" and --args "" as a literal empty executable.
# The reviewed package script runs preflight then Drizzle; its dash-free CLI
# arguments are accepted by Azure's parser. Preserve the DATABASE_URL secretref.
az containerapp job update \
  --name "$ACA_MIGRATION_JOB_NAME" \
  --resource-group "$ACA_RESOURCE_GROUP" \
  --image "$MIGRATION_IMAGE" \
  --command pnpm --args run db:migrate:safe \
  --replica-retry-limit 0 \
  --replica-timeout 1800 \
  --parallelism 1 \
  --replica-completion-count 1 \
  --set-env-vars "RELEASE_SHA=$GITHUB_SHA" \
  --output none --only-show-errors

start_json="$(az containerapp job start \
  --name "$ACA_MIGRATION_JOB_NAME" \
  --resource-group "$ACA_RESOURCE_GROUP" \
  --output json --only-show-errors)"
execution_name="$(jq --raw-output '.name // empty' <<< "$start_json")"
if [[ ! "$execution_name" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Azure did not return a migration execution name" >&2
  exit 1
fi
echo "Started migration execution $execution_name"

read_failures=0
last_status=""
for (( attempt = 1; attempt <= max_polls; attempt++ )); do
  if ! execution_json="$(az containerapp job execution show \
    --name "$ACA_MIGRATION_JOB_NAME" \
    --resource-group "$ACA_RESOURCE_GROUP" \
    --job-execution-name "$execution_name" \
    --output json --only-show-errors 2>/dev/null)"; then
    read_failures=$((read_failures + 1))
    if (( read_failures >= 12 )); then
      echo "Could not read migration execution $execution_name after repeated attempts" >&2
      exit 1
    fi
    sleep "$poll_interval"
    continue
  fi
  read_failures=0
  status="$(jq --raw-output '.properties.status // empty' <<< "$execution_json")"
  if [[ "$status" != "$last_status" ]] || (( attempt % 6 == 0 )); then
    echo "Migration execution $execution_name: ${status:-pending}"
    last_status="$status"
  fi

  case "$status" in
    Succeeded)
      if ! jq --exit-status --arg image "$MIGRATION_IMAGE" \
        '[.properties.template.containers[]?.image] | index($image) != null' \
        >/dev/null <<< "$execution_json"; then
        echo "Migration execution succeeded with an unexpected image; stopping release" >&2
        exit 1
      fi
      echo "Migration preflight and Drizzle migration succeeded"
      exit 0
      ;;
    Failed|Stopped|Degraded|Canceled|Cancelled)
      echo "Migration execution $execution_name ended in $status; stopping release" >&2
      exit 1
      ;;
  esac
  sleep "$poll_interval"
done

echo "Migration execution $execution_name did not succeed within the release wait window" >&2
exit 1
