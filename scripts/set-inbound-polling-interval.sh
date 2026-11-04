#!/usr/bin/env bash
set -euo pipefail
set +x # ARM responses include container environment bindings.

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for executable in az jq; do
  command -v "$executable" >/dev/null 2>&1 || die "Install '$executable' before deploying."
done

: "${ACA_INBOUND_APP_NAME:?Set ACA_INBOUND_APP_NAME to the private inbound app}"
: "${ACA_RESOURCE_GROUP:?Set ACA_RESOURCE_GROUP to the app resource group}"
: "${ACA_INBOUND_MAX_REPLICAS:?Set ACA_INBOUND_MAX_REPLICAS to the inbound scale limit}"
: "${AZURE_STORAGE_INBOUND_QUEUE_NAME:?Set AZURE_STORAGE_INBOUND_QUEUE_NAME}"
: "${APP_IMAGE:?Set APP_IMAGE to the digest-pinned release image}"
: "${GITHUB_SHA:?Set GITHUB_SHA to the released commit}"

expected_subscription='b001fc6f-ea19-456a-8401-63971a1a1d98'
expected_resource_group='rg-twilio-comics'
expected_app='twilio-comics-inbound-v2'
expected_queue='comic-inbound'
target_poll_seconds=10

[[ "$ACA_INBOUND_APP_NAME" == "$expected_app" &&
   "$ACA_RESOURCE_GROUP" == "$expected_resource_group" &&
   "$ACA_INBOUND_MAX_REPLICAS" == 8 &&
   "$AZURE_STORAGE_INBOUND_QUEUE_NAME" == "$expected_queue" ]] \
  || die 'Inbound scale change must target the approved app, resource group, queue, and replica limit.'
[[ "$APP_IMAGE" =~ ^twiliocomicsacr1a1d98\.azurecr\.io/twilio-comics@sha256:[a-f0-9]{64}$ ]] \
  || die 'APP_IMAGE must be the approved digest-pinned application image.'
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]] \
  || die 'GITHUB_SHA must be a 40-character commit SHA.'

max_polls="${INBOUND_POLLING_MAX_POLLS:-30}"
poll_seconds="${INBOUND_POLLING_POLL_SECONDS:-5}"
[[ "$max_polls" =~ ^[1-9][0-9]*$ ]] && (( max_polls <= 60 )) \
  || die 'INBOUND_POLLING_MAX_POLLS must be between 1 and 60.'
[[ "$poll_seconds" =~ ^[0-9]+$ ]] && (( poll_seconds <= 30 )) \
  || die 'INBOUND_POLLING_POLL_SECONDS must be between 0 and 30.'

subscription_id="$(az account show --query id --output tsv --only-show-errors)" \
  || die 'Azure CLI is not signed in.'
[[ "$subscription_id" == "$expected_subscription" ]] \
  || die 'The Azure CLI is not using the approved Twilio Comics subscription.'
resource_id="/subscriptions/$subscription_id/resourceGroups/$ACA_RESOURCE_GROUP/providers/Microsoft.App/containerApps/$ACA_INBOUND_APP_NAME"
resource_url="https://management.azure.com${resource_id}?api-version=2026-01-01"

umask 077
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/twilio-comics-inbound-scale.XXXXXXXX")"
trap 'rm -rf -- "$temp_dir"' EXIT
before_file="$temp_dir/before.json"
current_file="$temp_dir/current.json"
patch_file="$temp_dir/patch.json"

az rest --method get --url "$resource_url" --output json --only-show-errors > "$before_file" \
  || die "Could not inspect Container App '$ACA_INBOUND_APP_NAME'."

if ! jq --exit-status --arg id "$resource_id" --arg name "$ACA_INBOUND_APP_NAME" \
    --arg image "$APP_IMAGE" --arg release "$GITHUB_SHA" \
    --arg queue "$expected_queue" --arg account 'twiliocomicsst1a1d98' '
  ((.id | ascii_downcase) == ($id | ascii_downcase))
  and .name == $name
  and .type == "Microsoft.App/containerApps"
  and (.location | type == "string" and length > 0)
  and .properties.provisioningState == "Succeeded"
  and (.properties.configuration.activeRevisionsMode // "Single") == "Single"
  and (.properties.configuration.ingress == null or .properties.configuration.ingress == {})
  and (.properties.template.containers | length == 1)
  and .properties.template.containers[0].image == $image
  and ([.properties.template.containers[0].env[]? | select(.name == "RELEASE_SHA")]
    | length == 1 and .[0].value == $release)
  and .properties.template.scale.minReplicas == 1
  and .properties.template.scale.maxReplicas == 8
  and (.properties.template.scale.pollingInterval | IN(10, 30))
  and (.properties.template.scale.rules | length == 1)
  and .properties.template.scale.rules[0].name == "inbound-queue"
  and (
    (.properties.template.scale.rules[0].azureQueue.queueName == $queue
      and .properties.template.scale.rules[0].azureQueue.accountName == $account
      and (.properties.template.scale.rules[0].azureQueue.queueLength | tostring) == "4"
      and (.properties.template.scale.rules[0].azureQueue.identity | type == "string" and length > 0))
    or
    (.properties.template.scale.rules[0].custom.type == "azure-queue"
      and .properties.template.scale.rules[0].custom.metadata.accountName == $account
      and .properties.template.scale.rules[0].custom.metadata.cloud == "AzurePublicCloud"
      and .properties.template.scale.rules[0].custom.metadata.queueName == $queue
      and .properties.template.scale.rules[0].custom.metadata.queueLength == "4"
      and (.properties.template.scale.rules[0].custom.identity | type == "string" and length > 0))
  )
' "$before_file" >/dev/null; then
  die "Container App '$ACA_INBOUND_APP_NAME' has unexpected identity, release, or scale settings; no polling interval was changed."
fi

if jq --exit-status '.properties.template.scale.pollingInterval == 10' "$before_file" >/dev/null; then
  echo "Inbound queue scaler already checks every ${target_poll_seconds}s."
  exit 0
fi

# JSON Merge Patch updates this scalar only. The rule array, managed identity,
# image, and secret references are neither sent nor replaced by the request.
jq --argjson seconds "$target_poll_seconds" '{
  location: .location,
  properties: {template: {scale: {pollingInterval: $seconds}}}
}' "$before_file" > "$patch_file" \
  || die 'Could not build the inbound scale patch.'
az rest --method patch --url "$resource_url" \
  --headers 'Content-Type=application/json' --body "@$patch_file" \
  --output none --only-show-errors \
  || die "Could not set inbound queue polling to ${target_poll_seconds}s."

# ARM can acknowledge an asynchronous PATCH before the revision is visible.
# Compare every other scale field with its prepatch value to detect drift.
for (( attempt = 1; attempt <= max_polls; attempt++ )); do
  if az rest --method get --url "$resource_url" --output json --only-show-errors \
      > "$current_file"; then
    if jq --exit-status --arg id "$resource_id" '
      ((.id | ascii_downcase) == ($id | ascii_downcase))
      and .properties.provisioningState == "Failed"
    ' "$current_file" >/dev/null; then
      die "Container App '$ACA_INBOUND_APP_NAME' failed while changing its queue polling interval."
    fi
    if jq --exit-status --slurpfile before "$before_file" --arg id "$resource_id" \
        --arg image "$APP_IMAGE" --arg release "$GITHUB_SHA" '
      ((.id | ascii_downcase) == ($id | ascii_downcase))
      and .properties.provisioningState == "Succeeded"
      and .properties.template.scale.pollingInterval == 10
      and ((.properties.template.scale | del(.pollingInterval))
        == ($before[0].properties.template.scale | del(.pollingInterval)))
      and .properties.configuration.ingress == $before[0].properties.configuration.ingress
      and (.properties.configuration.activeRevisionsMode // "Single") == "Single"
      and .properties.template.containers[0].image == $image
      and ([.properties.template.containers[0].env[]? | select(.name == "RELEASE_SHA")]
        | length == 1 and .[0].value == $release)
    ' "$current_file" >/dev/null; then
      echo "Inbound queue scaler checks every ${target_poll_seconds}s; release revision readiness is checked next."
      exit 0
    fi
  fi
  if (( attempt < max_polls )); then sleep "$poll_seconds"; fi
done
die "Container App '$ACA_INBOUND_APP_NAME' did not confirm its ${target_poll_seconds}s queue polling interval."
