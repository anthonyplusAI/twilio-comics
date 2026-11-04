#!/usr/bin/env bash
set -euo pipefail
set +x # Key Vault references only; never trace runtime bindings.

# One-time binding for the private inbound app before the web queue cutover.
# The existing generation Job is the reviewed source of non-secret settings
# and Key Vault references. No secret value is copied or printed.
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for command in az jq; do command -v "$command" >/dev/null 2>&1 || die "Install '$command'."; done
: "${SUBSCRIPTION_ID:?Set SUBSCRIPTION_ID to the approved Azure subscription ID}"
EXPECTED_SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98'
[[ "$SUBSCRIPTION_ID" == "$EXPECTED_SUBSCRIPTION_ID" ]] \
  || die "This setup targets subscription $EXPECTED_SUBSCRIPTION_ID."
[[ "${CONFIGURE_INBOUND_CONFIRM:-}" == yes ]] \
  || die 'Set CONFIGURE_INBOUND_CONFIRM=yes after reviewing the private inbound app bindings.'

RESOURCE_GROUP='rg-twilio-comics'
INBOUND_APP='twilio-comics-inbound-v2'
WEB_APP='twilio-comics'
GENERATION_JOB='twilio-comics-generation-v2'
WORKER_IDENTITY='id-twilio-comics-v2-worker'
STORAGE_ACCOUNT='twiliocomicsst1a1d98'
INBOUND_QUEUE='comic-inbound'
INBOUND_POISON_QUEUE='comic-inbound-poison'
VAULT='kv-twilio-comics-1a1d98'
EXPECTED_ENVIRONMENT="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/managedEnvironments/cae-twilio-comics-v2"
PLACEHOLDER_IMAGE='mcr.microsoft.com/dotnet/samples:aspnetapp'

active_subscription="$(az account show --query id --output tsv)" \
  || die 'Sign in to Azure before configuring the inbound worker.'
[[ "$active_subscription" == "$SUBSCRIPTION_ID" ]] \
  || die "Active subscription '$active_subscription' is not '$SUBSCRIPTION_ID'."
worker_id="$(az identity show --name "$WORKER_IDENTITY" --resource-group "$RESOURCE_GROUP" \
  --query id --output tsv)" || die 'The existing worker identity is missing.'
[[ -n "$worker_id" ]] || die 'Azure did not return the worker identity ID.'
inbound_json="$(az containerapp show --name "$INBOUND_APP" --resource-group "$RESOURCE_GROUP" \
  --output json)" || die 'Provision the private inbound app first.'
web_json="$(az containerapp show --name "$WEB_APP" --resource-group "$RESOURCE_GROUP" \
  --output json)" || die 'The public web app is missing.'
generation_json="$(az containerapp job show --name "$GENERATION_JOB" --resource-group "$RESOURCE_GROUP" \
  --output json)" || die 'The generation Job is missing.'

if ! jq --exit-status --arg environment "$EXPECTED_ENVIRONMENT" --arg identity "$worker_id" \
  --arg placeholder "$PLACEHOLDER_IMAGE" '
    ((.properties.environmentId // .properties.managedEnvironmentId // "") | ascii_downcase)
      == ($environment | ascii_downcase)
    and (.properties.configuration.ingress == null or .properties.configuration.ingress == {})
    and .properties.template.scale.minReplicas == 0
    and .properties.template.containers[0].image == $placeholder
    and (.identity.userAssignedIdentities | has($identity))
  ' >/dev/null <<< "$inbound_json"; then
  die "Inbound app must be the private, no ingress, zero-replica placeholder with the worker identity."
fi
if ! jq --exit-status --arg environment "$EXPECTED_ENVIRONMENT" '
  ((.properties.environmentId // .properties.managedEnvironmentId // "") | ascii_downcase)
    == ($environment | ascii_downcase)
  ' >/dev/null <<< "$generation_json"; then
  die 'Generation Job is not in the reviewed private environment.'
fi
if ! jq --exit-status --arg environment "$EXPECTED_ENVIRONMENT" '
  ((.properties.environmentId // .properties.managedEnvironmentId // "") | ascii_downcase)
    == ($environment | ascii_downcase)
  and ([.properties.template.containers[0].env[]? | select(.name == "TWILIO_ENABLED_CHANNELS")]
    | if length == 0 then true
      elif length == 1 then
        (.[0].value | if type == "string" then test("^[a-z, ]*$") else false end)
      else false end)
  ' >/dev/null <<< "$web_json"; then
  die 'The public web app has an invalid TWILIO_ENABLED_CHANNELS setting or is outside the reviewed private environment.'
fi
enabled_channels="$(jq --raw-output '
  [.properties.template.containers[0].env[]? | select(.name == "TWILIO_ENABLED_CHANNELS")][0].value // ""
  ' <<< "$web_json")"
if ! jq --exit-status --arg queue "$INBOUND_QUEUE" --arg poison "$INBOUND_POISON_QUEUE" '
  [.properties.template.containers[0].env[]? | select(.name == "AZURE_STORAGE_QUEUE_NAME")]
    | length == 1 and .[0].value != $queue and .[0].value != $poison
  ' >/dev/null <<< "$generation_json"; then
  die 'The inbound and generation queue names must be distinct.'
fi

for queue in "$INBOUND_QUEUE" "$INBOUND_POISON_QUEUE"; do
  exists="$(az storage queue exists --account-name "$STORAGE_ACCOUNT" --name "$queue" \
    --auth-mode login --query exists --output tsv)" \
    || die "Cannot inspect queue '$queue'."
  case "$exists" in
    true|True|TRUE) ;;
    *) die "Queue '$queue' is missing. Run provision-azure.sh first." ;;
  esac
done

secret_specs=()
require_source_secret() {
  local app_name="$1" vault_name="$2" uri
  uri="https://${VAULT}.vault.azure.net/secrets/${vault_name}"
  if ! jq --exit-status --arg name "$app_name" --arg uri "$uri" --arg identity "$worker_id" \
    '([.properties.configuration.secrets[]? | select(.name == $name)]
       | length == 1 and .[0].keyVaultUrl == $uri
         and (.[0].identity | ascii_downcase) == ($identity | ascii_downcase))' \
    >/dev/null <<< "$generation_json"; then
    die "Generation Job has a missing or non-Key Vault '$app_name' binding."
  fi
  secret_specs+=("${app_name}=keyvaultref:${uri},identityref:${worker_id}")
}
require_source_secret runtime-database-url postgres-comics-runtime-url
require_source_secret media-signing-secret media-signing-secret
require_source_secret openai-api-key openai-api-key
require_source_secret twilio-auth-token twilio-auth-token

env_specs=()
copy_source_env() {
  local name="$1" required="$2" spec
  spec="$(jq --exit-status --raw-output --arg name "$name" '
    [.properties.template.containers[0].env[]? | select(.name == $name)]
      | if length != 1 then empty
        elif .[0].secretRef != null then "\($name)=secretref:\(.[0].secretRef)"
        elif .[0].value != null then "\($name)=\(.[0].value)"
        else empty end
  ' <<< "$generation_json")" || spec=''
  if [[ -z "$spec" ]]; then
    [[ "$required" != required ]] || die "Generation Job is missing '$name'."
    return
  fi
  env_specs+=("$spec")
}
for name in AZURE_CLIENT_ID AZURE_STORAGE_BLOB_ENDPOINT AZURE_STORAGE_QUEUE_ENDPOINT \
    AZURE_STORAGE_CONTAINER_NAME AZURE_STORAGE_QUEUE_NAME AZURE_STORAGE_POISON_QUEUE_NAME \
    DATABASE_URL MEDIA_SIGNING_SECRET OPENAI_API_KEY TWILIO_AUTH_TOKEN \
    TWILIO_ACCOUNT_SID TWILIO_PHONE_NUMBER PUBLIC_BASE_URL; do
  copy_source_env "$name" required
done
for name in OPENAI_TEXT_MODEL; do
  copy_source_env "$name" optional
done
env_specs+=(
  "AZURE_STORAGE_INBOUND_QUEUE_NAME=$INBOUND_QUEUE"
  "AZURE_STORAGE_INBOUND_POISON_QUEUE_NAME=$INBOUND_POISON_QUEUE"
  'WORKER_MODE=inbound'
  'DB_POOL_MAX=2'
  'INBOUND_WORKER_CONCURRENCY=4'
  "TWILIO_ENABLED_CHANNELS=$enabled_channels"
)

# Check every source secret reference before creating any binding. This keeps
# plaintext credentials and unexpected secret names out of the new app.
for spec in "${env_specs[@]}"; do
  [[ "$spec" != *=secretref:* ]] && continue
  ref="${spec#*=secretref:}"
  allowed=false
  for secret_spec in "${secret_specs[@]}"; do
    [[ "${secret_spec%%=*}" != "$ref" ]] || allowed=true
  done
  [[ "$allowed" == true ]] || die "Generation Job has an unexpected Key Vault reference '$ref'."
done

az containerapp secret set --name "$INBOUND_APP" --resource-group "$RESOURCE_GROUP" \
  --secrets "${secret_specs[@]}" --only-show-errors --output none \
  || die 'Could not bind the existing Key Vault references to the inbound app.'
az containerapp update --name "$INBOUND_APP" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "${env_specs[@]}" --only-show-errors --output none \
  || die 'Could not bind the reviewed runtime settings to the inbound app.'

printf 'Private inbound worker runtime bindings are ready. The placeholder remains at zero replicas until release.\n'
