#!/usr/bin/env bash
set -euo pipefail
set +x # The ARM container array can include environment values.

# The Container Apps PATCH endpoint uses JSON Merge Patch. An array is replaced
# as a unit, so copy every existing container before changing the web probe.
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for command in az jq; do
  command -v "$command" >/dev/null 2>&1 || die "Install '$command' before deploying."
done
: "${ACA_NAME:?Set ACA_NAME to the web Container App}"
: "${ACA_RESOURCE_GROUP:?Set ACA_RESOURCE_GROUP to the web resource group}"
[[ "$ACA_NAME" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] \
  || die 'ACA_NAME is not a valid project Container App name.'
[[ "$ACA_RESOURCE_GROUP" =~ ^[A-Za-z0-9._-]+$ ]] \
  || die 'ACA_RESOURCE_GROUP contains unsupported characters.'

max_polls="${READY_PROBE_MAX_POLLS:-30}"
poll_seconds="${READY_PROBE_POLL_SECONDS:-5}"
if [[ ! "$max_polls" =~ ^[1-9][0-9]*$ ]] || (( max_polls > 60 )); then
  die 'READY_PROBE_MAX_POLLS must be between 1 and 60.'
fi
if [[ ! "$poll_seconds" =~ ^[0-9]+$ ]] || (( poll_seconds > 30 )); then
  die 'READY_PROBE_POLL_SECONDS must be between 0 and 30.'
fi

subscription_id="$(az account show --query id --output tsv --only-show-errors)" \
  || die 'Azure CLI is not signed in.'
[[ "$subscription_id" == 'b001fc6f-ea19-456a-8401-63971a1a1d98' ]] \
  || die 'The Azure CLI is not using the approved Twilio Comics subscription.'
resource_id="/subscriptions/$subscription_id/resourceGroups/$ACA_RESOURCE_GROUP/providers/Microsoft.App/containerApps/$ACA_NAME"
resource_url="https://management.azure.com${resource_id}?api-version=2025-07-01"

umask 077
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/twilio-comics-ready-probe.XXXXXXXX")"
trap 'rm -rf -- "$temp_dir"' EXIT
current_file="$temp_dir/current.json"
patch_file="$temp_dir/patch.json"

az rest --method get --url "$resource_url" --output json --only-show-errors > "$current_file" \
  || die "Could not inspect Container App '$ACA_NAME'."
if ! jq --exit-status --arg id "$resource_id" --arg name "$ACA_NAME" '
  ((.id | ascii_downcase) == ($id | ascii_downcase))
  and .name == $name
  and .type == "Microsoft.App/containerApps"
  and (.location | type == "string" and length > 0)
  and .properties.provisioningState == "Succeeded"
  and (.properties.configuration.activeRevisionsMode // "Single") == "Single"
  and (.properties.configuration.ingress.external | type == "boolean")
  and .properties.configuration.ingress.targetPort == 8080
  and ((.properties.configuration.ingress.transport // "auto") | ascii_downcase | IN("auto", "http"))
  and (.properties.template.containers | type == "array" and length > 0)
  and all(.properties.template.containers[]; (.name | type == "string" and length > 0) and (.image | type == "string" and length > 0))
  and ((.properties.template.containers[0].probes == null) or (.properties.template.containers[0].probes | type == "array"))
  and ([.properties.template.containers[0].probes[]? | select(.type == "Readiness")] | length <= 1)
' "$current_file" >/dev/null; then
  die "Container App '$ACA_NAME' has unexpected state; no readiness probe was changed."
fi

# The sample image does not serve /api/readyz. It must stay private at zero
# replicas while this template-only change prepares the first real release.
if jq --exit-status --arg image 'mcr.microsoft.com/dotnet/samples:aspnetapp' '
  .properties.template.containers[0].image == $image
  and (.properties.configuration.ingress.external == true
       or .properties.template.scale.minReplicas != 0)
' "$current_file" >/dev/null; then
  die 'The sample placeholder must have private ingress and zero minimum replicas.'
fi

readiness_probe='{"type":"Readiness","httpGet":{"path":"/api/readyz","port":8080},"initialDelaySeconds":10,"periodSeconds":5,"timeoutSeconds":5,"successThreshold":1,"failureThreshold":48}'

if jq --exit-status --argjson probe "$readiness_probe" '
  any(.properties.template.containers[0].probes[]?; .type == "Readiness" and . == $probe)
' "$current_file" >/dev/null; then
  echo "Container App '$ACA_NAME' already has the HTTP readiness probe."
  exit 0
fi

jq --argjson probe "$readiness_probe" '{
  location: .location,
  properties: {
    template: {
      containers: (.properties.template.containers
        | .[0].probes = ((.[0].probes // [] | map(select(.type != "Readiness"))) + [$probe]))
    }
  }
}' "$current_file" > "$patch_file" \
  || die 'Could not build a safe readiness probe patch.'

az rest --method patch --url "$resource_url" \
  --headers 'Content-Type=application/json' --body "@$patch_file" \
  --output none --only-show-errors \
  || die "Could not patch the readiness probe on '$ACA_NAME'."

# ARM can acknowledge an asynchronous PATCH before the template is visible.
# Require the exact intended container array and a completed provisioning state
# before allowing the workflow to deploy or publish a revision.
for (( attempt = 1; attempt <= max_polls; attempt++ )); do
  if az rest --method get --url "$resource_url" --output json --only-show-errors \
      > "$current_file"; then
    if jq --exit-status --arg id "$resource_id" '
      ((.id | ascii_downcase) == ($id | ascii_downcase))
      and .properties.provisioningState == "Failed"
    ' "$current_file" >/dev/null; then
      die "Container App '$ACA_NAME' failed while applying the readiness probe."
    fi
    if jq --exit-status --slurpfile patch "$patch_file" --arg id "$resource_id" '
      ((.id | ascii_downcase) == ($id | ascii_downcase))
      and .properties.provisioningState == "Succeeded"
      and .properties.template.containers == $patch[0].properties.template.containers
    ' "$current_file" >/dev/null; then
      echo "Container App '$ACA_NAME' has the HTTP /api/readyz readiness probe."
      exit 0
    fi
  fi
  if (( attempt < max_polls )); then sleep "$poll_seconds"; fi
done
die "Container App '$ACA_NAME' did not confirm the readiness probe; stopping deployment."
