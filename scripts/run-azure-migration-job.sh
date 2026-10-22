#!/usr/bin/env bash
set -euo pipefail

: "${ACA_MIGRATION_JOB_NAME:?Set ACA_MIGRATION_JOB_NAME to the manual Container Apps migration Job}"
: "${ACA_RESOURCE_GROUP:?Set ACA_RESOURCE_GROUP to the Job resource group}"
: "${MIGRATION_IMAGE:?Set MIGRATION_IMAGE to a digest-pinned ACR image}"
: "${GITHUB_SHA:?Set GITHUB_SHA to the commit being released}"

if [[ ! "$MIGRATION_IMAGE" =~ ^[a-z0-9]+\.azurecr\.io/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$ ]]; then
  echo "MIGRATION_IMAGE must be a digest-pinned Azure Container Registry image" >&2
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

job_json="$(az containerapp job show \
  --name "$ACA_MIGRATION_JOB_NAME" \
  --resource-group "$ACA_RESOURCE_GROUP" \
  --output json --only-show-errors)"
if ! jq --exit-status '
  .properties.configuration.triggerType == "Manual"
  and ((.properties.template.containers | length) == 1)
  and ([.properties.template.containers[0].env[]?
    | select(.name == "DATABASE_URL" and (.secretRef | type == "string" and length > 0))
  ] | length == 1)
' >/dev/null <<< "$job_json"; then
  echo "Migration Job must be Manual, have one container, and reference DATABASE_URL through an ACA secret" >&2
  exit 1
fi

# The image owns the preflight-then-migrate command. Clear any old placeholder
# command/args; updating --set-env-vars preserves the DATABASE_URL secretref.
az containerapp job update \
  --name "$ACA_MIGRATION_JOB_NAME" \
  --resource-group "$ACA_RESOURCE_GROUP" \
  --image "$MIGRATION_IMAGE" \
  --command "" --args "" \
  --replica-retry-limit 0 \
  --replica-timeout 1800 \
  --parallelism 1 \
  --replica-completion-count 1 \
  --set-env-vars "RELEASE_SHA=$GITHUB_SHA" \
  --output none --only-show-errors

start_json="$(az containerapp job start \
  --name "$ACA_MIGRATION_JOB_NAME" \
  --resource-group "$ACA_RESOURCE_GROUP" \
  --image "$MIGRATION_IMAGE" \
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
