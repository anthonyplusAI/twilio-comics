#!/usr/bin/env bash
set -euo pipefail
set +x # Never trace Azure secret metadata or CLI arguments.

# Browser Studio creates links in the public web app. Copy only the generation
# Job's reviewed Dub references and non-secret settings; never read the API key.
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for command in az jq; do
  command -v "$command" >/dev/null 2>&1 || die "Install '$command' before running this script."
done

: "${SUBSCRIPTION_ID:?Set SUBSCRIPTION_ID to the approved Azure subscription ID}"
SUBSCRIPTION='b001fc6f-ea19-456a-8401-63971a1a1d98'
[[ "$SUBSCRIPTION_ID" == "$SUBSCRIPTION" ]] \
  || die "This Dub web binding targets subscription $SUBSCRIPTION."
[[ "${CONFIGURE_DUB_WEB_CONFIRM:-}" == yes ]] \
  || die 'Set CONFIGURE_DUB_WEB_CONFIRM=yes after reviewing the web Dub binding.'

RESOURCE_GROUP='rg-twilio-comics'
ENVIRONMENT='cae-twilio-comics-v2'
WEB_APP='twilio-comics'
GENERATION_JOB='twilio-comics-generation-v2'
WEB_IDENTITY='id-twilio-comics-v2-web'
WORKER_IDENTITY='id-twilio-comics-v2-worker'
VAULT='kv-twilio-comics-1a1d98'
SECRET='dub-api-key'
EXPECTED_DOMAIN='twil.io'

BASE_ID="/subscriptions/$SUBSCRIPTION/resourceGroups/$RESOURCE_GROUP"
ENVIRONMENT_ID="$BASE_ID/providers/Microsoft.App/managedEnvironments/$ENVIRONMENT"
WEB_APP_ID="$BASE_ID/providers/Microsoft.App/containerApps/$WEB_APP"
GENERATION_JOB_ID="$BASE_ID/providers/Microsoft.App/jobs/$GENERATION_JOB"
WEB_IDENTITY_ID="$BASE_ID/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$WEB_IDENTITY"
WORKER_IDENTITY_ID="$BASE_ID/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$WORKER_IDENTITY"
VAULT_ID="$BASE_ID/providers/Microsoft.KeyVault/vaults/$VAULT"
SECRET_URI="https://${VAULT}.vault.azure.net/secrets/${SECRET}"
SECRET_SCOPE="$VAULT_ID/secrets/$SECRET"

active_subscription="$(az account show --query id --output tsv --only-show-errors 2>/dev/null)" \
  || die 'Sign in to Azure with az login before configuring Browser Studio links.'
[[ "$active_subscription" == "$SUBSCRIPTION" ]] \
  || die "The active Azure subscription must be $SUBSCRIPTION."

vault_json="$(az keyvault show --name "$VAULT" --resource-group "$RESOURCE_GROUP" \
  --subscription "$SUBSCRIPTION" --output json --only-show-errors)" \
  || die 'The existing Twilio Comics Key Vault could not be inspected.'
jq -e --arg id "$VAULT_ID" '
  (.id | ascii_downcase) == ($id | ascii_downcase)
  and .tags.managed_by == "twilio-comics-ci"
  and .properties.enableRbacAuthorization == true
  and .properties.enablePurgeProtection == true
  and .properties.networkAcls.defaultAction == "Deny"
' >/dev/null <<< "$vault_json" \
  || die 'The Key Vault identity or security settings differ from this app.'

web_identity_json="$(az identity show --name "$WEB_IDENTITY" --resource-group "$RESOURCE_GROUP" \
  --subscription "$SUBSCRIPTION" --output json --only-show-errors)" \
  || die 'The existing web managed identity could not be inspected.'
worker_identity_json="$(az identity show --name "$WORKER_IDENTITY" --resource-group "$RESOURCE_GROUP" \
  --subscription "$SUBSCRIPTION" --output json --only-show-errors)" \
  || die 'The existing worker managed identity could not be inspected.'
for spec in "web:$WEB_IDENTITY_ID" "worker:$WORKER_IDENTITY_ID"; do
  kind="${spec%%:*}"
  expected_id="${spec#*:}"
  current="$web_identity_json"
  [[ "$kind" != worker ]] || current="$worker_identity_json"
  jq -e --arg id "$expected_id" '
    (.id | ascii_downcase) == ($id | ascii_downcase)
    and (.principalId | type == "string" and length > 0)
  ' >/dev/null <<< "$current" \
    || die "The $kind managed identity has an unexpected resource ID or principal."
done
web_principal="$(jq -r '.principalId' <<< "$web_identity_json")"

generation_json="$(az containerapp job show --name "$GENERATION_JOB" \
  --resource-group "$RESOURCE_GROUP" --subscription "$SUBSCRIPTION" \
  --output json --only-show-errors)" \
  || die 'The existing generation Job could not be inspected.'
jq -e --arg id "$GENERATION_JOB_ID" --arg environment "$ENVIRONMENT_ID" \
  --arg worker "$WORKER_IDENTITY_ID" --arg uri "$SECRET_URI" \
  --arg domain "$EXPECTED_DOMAIN" '
  (.id | ascii_downcase) == ($id | ascii_downcase)
  and ((.properties.environmentId // .properties.managedEnvironmentId // "") | ascii_downcase)
    == ($environment | ascii_downcase)
  and ([.identity.userAssignedIdentities | keys[]? | ascii_downcase]
    | index($worker | ascii_downcase) != null)
  and (.properties.template.containers | length == 1)
  and ([.properties.configuration.secrets[]? | select(.name == "dub-api-key")]
    | length == 1 and .[0].keyVaultUrl == $uri
      and (.[0].identity | ascii_downcase) == ($worker | ascii_downcase)
      and ((.[0].value // "") == ""))
  and ([.properties.template.containers[0].env[]? | select(.name == "DUB_API_KEY")]
    | length == 1 and .[0].secretRef == "dub-api-key"
      and ((.[0].value // "") == ""))
  and ([.properties.template.containers[0].env[]? | select(.name == "DUB_DOMAIN")]
    | length == 1 and .[0].value == $domain and .[0].secretRef == null)
  and ([.properties.template.containers[0].env[]? | select(.name == "DUB_FOLDER_ID")]
    | length == 1 and (.[0].value | type == "string" and test("^[A-Za-z0-9_-]{1,128}$"))
      and .[0].secretRef == null)
' >/dev/null <<< "$generation_json" \
  || die 'Generation Job Dub settings are incomplete, inline, or not the expected versionless Key Vault reference.'
folder_id="$(jq -r '[.properties.template.containers[0].env[] | select(.name == "DUB_FOLDER_ID")][0].value' \
  <<< "$generation_json")"

web_json="$(az containerapp show --name "$WEB_APP" --resource-group "$RESOURCE_GROUP" \
  --subscription "$SUBSCRIPTION" --output json --only-show-errors)" \
  || die 'The public web app could not be inspected.'

validate_web() {
  local current="$1"
  jq -e --arg id "$WEB_APP_ID" --arg environment "$ENVIRONMENT_ID" \
    --arg identity "$WEB_IDENTITY_ID" --arg vault "$VAULT" '
    (.id | ascii_downcase) == ($id | ascii_downcase)
    and ((.properties.environmentId // .properties.managedEnvironmentId // "") | ascii_downcase)
      == ($environment | ascii_downcase)
    and ([.identity.userAssignedIdentities | keys[]? | ascii_downcase]
      | index($identity | ascii_downcase) != null)
    and (.properties.template.containers | length == 1)
    and ([.properties.template.containers[0].env[]? | select(.name == "DATABASE_URL")]
      | length == 1 and .[0].secretRef == "runtime-database-url")
    and ([.properties.configuration.secrets[]? | select(.name == "runtime-database-url")]
      | length == 1
        and .[0].keyVaultUrl == ("https://" + $vault + ".vault.azure.net/secrets/postgres-comics-runtime-url")
        and (.[0].identity | ascii_downcase) == ($identity | ascii_downcase))
  ' >/dev/null <<< "$current" \
    || die 'The web app is not the expected V2 runtime with its managed identity and database binding.'

  jq -e --arg uri "$SECRET_URI" --arg identity "$WEB_IDENTITY_ID" \
    --arg domain "$EXPECTED_DOMAIN" --arg folder "$folder_id" '
    ([.properties.configuration.secrets[]? | select(.name == "dub-api-key")]
      | length == 0 or (length == 1 and .[0].keyVaultUrl == $uri
        and (.[0].identity | ascii_downcase) == ($identity | ascii_downcase)
        and ((.[0].value // "") == "")))
    and ([.properties.template.containers[0].env[]? | select(.name == "DUB_API_KEY")]
      | length == 0 or (length == 1 and .[0].secretRef == "dub-api-key"
        and ((.[0].value // "") == "")))
    and ([.properties.template.containers[0].env[]? | select(.name == "DUB_DOMAIN")]
      | length == 0 or (length == 1 and .[0].value == $domain and .[0].secretRef == null))
    and ([.properties.template.containers[0].env[]? | select(.name == "DUB_FOLDER_ID")]
      | length == 0 or (length == 1 and .[0].value == $folder and .[0].secretRef == null))
  ' >/dev/null <<< "$current" \
    || die 'The web app has an inline key or a conflicting Dub secret, domain, or folder binding.'
}
validate_web "$web_json"

role_json="$(az role assignment list --assignee-object-id "$web_principal" \
  --scope "$SECRET_SCOPE" --role 'Key Vault Secrets User' \
  --subscription "$SUBSCRIPTION" --output json --only-show-errors)" \
  || die 'Could not inspect the web identity Dub secret role.'
if ! jq -e --arg scope "$SECRET_SCOPE" '
  any(.[]; (.scope | ascii_downcase) == ($scope | ascii_downcase))
' >/dev/null <<< "$role_json"; then
  az role assignment create --assignee-object-id "$web_principal" \
    --assignee-principal-type ServicePrincipal --scope "$SECRET_SCOPE" \
    --role 'Key Vault Secrets User' --subscription "$SUBSCRIPTION" \
    --only-show-errors --output none >/dev/null 2>&1 \
    || die 'Could not grant the web identity read access to only the Dub key secret.'
fi

# Check again after the RBAC operation so a concurrent configuration change is
# rejected before either Container App mutation.
web_json="$(az containerapp show --name "$WEB_APP" --resource-group "$RESOURCE_GROUP" \
  --subscription "$SUBSCRIPTION" --output json --only-show-errors)" \
  || die 'The web app could not be rechecked after the Dub role assignment.'
validate_web "$web_json"

if ! jq -e --arg uri "$SECRET_URI" --arg identity "$WEB_IDENTITY_ID" '
  [.properties.configuration.secrets[]? | select(.name == "dub-api-key")]
    | length == 1 and .[0].keyVaultUrl == $uri
      and (.[0].identity | ascii_downcase) == ($identity | ascii_downcase)
      and ((.[0].value // "") == "")
' >/dev/null <<< "$web_json"; then
  az containerapp secret set --name "$WEB_APP" --resource-group "$RESOURCE_GROUP" \
    --secrets "${SECRET}=keyvaultref:${SECRET_URI},identityref:${WEB_IDENTITY_ID}" \
    --subscription "$SUBSCRIPTION" --only-show-errors --output none >/dev/null 2>&1 \
    || die 'Could not bind the versionless Dub secret to the web app. Retry after Azure RBAC propagates.'
fi

web_json="$(az containerapp show --name "$WEB_APP" --resource-group "$RESOURCE_GROUP" \
  --subscription "$SUBSCRIPTION" --output json --only-show-errors)" \
  || die 'The web app could not be checked after the Dub secret binding.'
validate_web "$web_json"
jq -e --arg uri "$SECRET_URI" --arg identity "$WEB_IDENTITY_ID" '
  [.properties.configuration.secrets[]? | select(.name == "dub-api-key")]
    | length == 1 and .[0].keyVaultUrl == $uri
      and (.[0].identity | ascii_downcase) == ($identity | ascii_downcase)
      and ((.[0].value // "") == "")
' >/dev/null <<< "$web_json" \
  || die 'The web app did not retain the reviewed Dub Key Vault reference.'

if ! jq -e --arg domain "$EXPECTED_DOMAIN" --arg folder "$folder_id" '
  ([.properties.template.containers[0].env[]? | select(.name == "DUB_API_KEY")]
    | length == 1 and .[0].secretRef == "dub-api-key"
      and ((.[0].value // "") == ""))
  and ([.properties.template.containers[0].env[]? | select(.name == "DUB_DOMAIN")]
    | length == 1 and .[0].value == $domain and .[0].secretRef == null)
  and ([.properties.template.containers[0].env[]? | select(.name == "DUB_FOLDER_ID")]
    | length == 1 and .[0].value == $folder and .[0].secretRef == null)
' >/dev/null <<< "$web_json"; then
  az containerapp update --name "$WEB_APP" --resource-group "$RESOURCE_GROUP" \
    --set-env-vars "DUB_API_KEY=secretref:${SECRET}" \
      "DUB_DOMAIN=$EXPECTED_DOMAIN" "DUB_FOLDER_ID=$folder_id" \
    --subscription "$SUBSCRIPTION" --only-show-errors --output none >/dev/null 2>&1 \
    || die 'Could not set the web app Dub environment references.'
fi

final_json="$(az containerapp show --name "$WEB_APP" --resource-group "$RESOURCE_GROUP" \
  --subscription "$SUBSCRIPTION" --output json --only-show-errors)" \
  || die 'Could not verify the web app after configuration.'
validate_web "$final_json"
jq -e --arg uri "$SECRET_URI" --arg identity "$WEB_IDENTITY_ID" \
  --arg domain "$EXPECTED_DOMAIN" --arg folder "$folder_id" '
  ([.properties.configuration.secrets[]? | select(.name == "dub-api-key")]
    | length == 1 and .[0].keyVaultUrl == $uri
      and (.[0].identity | ascii_downcase) == ($identity | ascii_downcase)
      and ((.[0].value // "") == ""))
  and ([.properties.template.containers[0].env[]? | select(.name == "DUB_API_KEY")]
    | length == 1 and .[0].secretRef == "dub-api-key"
      and ((.[0].value // "") == ""))
  and ([.properties.template.containers[0].env[]? | select(.name == "DUB_DOMAIN")]
    | length == 1 and .[0].value == $domain and .[0].secretRef == null)
  and ([.properties.template.containers[0].env[]? | select(.name == "DUB_FOLDER_ID")]
    | length == 1 and .[0].value == $folder and .[0].secretRef == null)
' >/dev/null <<< "$final_json" \
  || die 'The web app Dub binding did not match the reviewed source Job.'
echo 'Browser Studio Dub web binding is complete; the API key is a versionless Key Vault reference.'
