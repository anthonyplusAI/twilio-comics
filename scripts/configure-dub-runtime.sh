#!/usr/bin/env bash
set -euo pipefail
set +x # The Dub key must never appear in shell traces.

# Configure Dub only on the existing V2 generation Job. Run after placing
# DUB_API_KEY=... in an owner-only .env.local (mode 0600), or set
# DUB_API_KEY_FILE to an owner-only file containing just the key.

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "Install '$1' before running this script."; }
for command in az jq python3 pnpm curl cmp; do require "$command"; done

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBSCRIPTION='b001fc6f-ea19-456a-8401-63971a1a1d98'
RESOURCE_GROUP='rg-twilio-comics'
ENVIRONMENT='cae-twilio-comics-v2'
JOB='twilio-comics-generation-v2'
IDENTITY_NAME='id-twilio-comics-v2-worker'
VAULT='kv-twilio-comics-1a1d98'
SECRET='dub-api-key'
DOMAIN='twil.io'
VAULT_ID="/subscriptions/$SUBSCRIPTION/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.KeyVault/vaults/$VAULT"
IDENTITY_ID="/subscriptions/$SUBSCRIPTION/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$IDENTITY_NAME"
ENVIRONMENT_ID="/subscriptions/$SUBSCRIPTION/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/managedEnvironments/$ENVIRONMENT"
JOB_ID="/subscriptions/$SUBSCRIPTION/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/jobs/$JOB"
SECRET_URI="https://${VAULT}.vault.azure.net/secrets/${SECRET}"

umask 077
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/twilio-comics-dub.XXXXXXXX")"
ip_rule_added=0
temporary_officer_assignment=''
operator_ipv4=''
cleanup() {
  local result=$?
  trap - EXIT
  unset DUB_API_KEY || true
  if [[ -n "$temporary_officer_assignment" ]]; then
    if ! az role assignment delete --ids "$temporary_officer_assignment" \
      --subscription "$SUBSCRIPTION" --only-show-errors --output none \
      > "$TEMP_DIR/azure.stdout" 2> "$TEMP_DIR/azure.stderr"; then
      printf 'ERROR: Revoke temporary Key Vault role assignment %s immediately.\n' \
        "$temporary_officer_assignment" >&2
      result=1
    fi
  fi
  if [[ "$ip_rule_added" == 1 ]]; then
    if ! az keyvault network-rule remove --name "$VAULT" \
      --resource-group "$RESOURCE_GROUP" --ip-address "$operator_ipv4" \
      --subscription "$SUBSCRIPTION" --only-show-errors --output none \
      > "$TEMP_DIR/azure.stdout" 2> "$TEMP_DIR/azure.stderr"; then
      printf 'ERROR: Remove the temporary Key Vault firewall rule for %s/32 immediately.\n' \
        "$operator_ipv4" >&2
      result=1
    fi
  fi
  rm -rf -- "$TEMP_DIR"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Parse the file as data; sourcing .env.local would execute arbitrary shell.
python3 - "${DUB_API_KEY_FILE:-$PROJECT_ROOT/.env.local}" "$TEMP_DIR/dub-key" \
  "${DUB_API_KEY_FILE:+key-file}" <<'PY' \
  || die 'Provide an owner-only .env.local with DUB_API_KEY=... or set DUB_API_KEY_FILE.'
import os
from pathlib import Path
import re
import stat
import sys

source, destination, kind = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
try:
    details = source.lstat()
    if not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) != 0o600:
        raise ValueError("the input must be an owner-owned regular file with mode 0600")
    if details.st_size > 1024 * 1024:
        raise ValueError("the input file is too large")
    data = source.read_text(encoding="utf-8")
    if kind == "key-file":
        value = data.removesuffix("\r\n").removesuffix("\n")
    else:
        values = []
        for line in data.splitlines():
            match = re.fullmatch(r"\s*(?:export\s+)?DUB_API_KEY\s*=\s*(.*?)\s*", line)
            if match:
                values.append(match.group(1))
        if len(values) != 1:
            raise ValueError(".env.local must contain exactly one DUB_API_KEY assignment")
        value = values[0]
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
    if not 20 <= len(value) <= 4096 or any(ord(char) < 0x21 or ord(char) > 0x7e for char in value):
        raise ValueError("DUB_API_KEY must be a single printable token of 20–4096 characters")
    destination.write_text(value, encoding="utf-8")
except (OSError, UnicodeError, ValueError) as error:
    print(f"Invalid Dub key input: {error}", file=sys.stderr)
    sys.exit(1)
PY

active_subscription="$(az account show --query id --output tsv --only-show-errors 2>/dev/null)" \
  || die 'Sign in to Azure with az login before configuring Dub.'
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
  and .properties.publicNetworkAccess != "Disabled"
' >/dev/null <<< "$vault_json" \
  || die 'The Key Vault identity or security settings differ from this app.'

identity_json="$(az identity show --name "$IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" \
  --subscription "$SUBSCRIPTION" --output json --only-show-errors)" \
  || die 'The existing V2 worker managed identity could not be inspected.'
jq -e --arg id "$IDENTITY_ID" '
  (.id | ascii_downcase) == ($id | ascii_downcase)
  and (.principalId | type == "string" and length > 0)
' >/dev/null <<< "$identity_json" \
  || die 'The V2 worker managed identity has an unexpected resource ID or principal.'
worker_principal="$(jq -r '.principalId' <<< "$identity_json")"

job_json="$(az containerapp job show --name "$JOB" --resource-group "$RESOURCE_GROUP" \
  --subscription "$SUBSCRIPTION" --output json --only-show-errors)" \
  || die 'The existing V2 generation Job could not be inspected.'
jq -e --arg id "$JOB_ID" --arg environment "$ENVIRONMENT_ID" \
  --arg identity "$IDENTITY_ID" --arg vault "$VAULT" '
  (.id | ascii_downcase) == ($id | ascii_downcase)
  and (.properties.environmentId | ascii_downcase) == ($environment | ascii_downcase)
  and (.identity.userAssignedIdentities | keys | map(ascii_downcase) | index($identity | ascii_downcase) != null)
  and (.properties.template.containers | length == 1)
  and ([.properties.template.containers[0].env[]? | select(.name == "DATABASE_URL")]
    | length == 1 and .[0].secretRef == "runtime-database-url")
  and ([.properties.configuration.secrets[]? | select(.name == "runtime-database-url")]
    | length == 1 and .[0].keyVaultUrl == ("https://" + $vault + ".vault.azure.net/secrets/postgres-comics-runtime-url")
      and (.[0].identity | ascii_downcase) == ($identity | ascii_downcase))
' >/dev/null <<< "$job_json" \
  || die 'The generation Job is not the expected private V2 workload with its runtime database binding.'

# Do not overwrite an inline key, another vault reference, or an existing
# domain/folder binding without an explicit review of that configuration.
jq -e --arg uri "$SECRET_URI" --arg identity "$IDENTITY_ID" --arg domain "$DOMAIN" '
  ([.properties.configuration.secrets[]? | select(.name == "dub-api-key")]
    | length == 0 or (length == 1 and .[0].keyVaultUrl == $uri
      and (.[0].identity | ascii_downcase) == ($identity | ascii_downcase)))
  and ([.properties.template.containers[0].env[]? | select(.name == "DUB_API_KEY")]
    | length == 0 or (length == 1 and .[0].secretRef == "dub-api-key" and .[0].value == null))
  and ([.properties.template.containers[0].env[]? | select(.name == "DUB_DOMAIN")]
    | length == 0 or (length == 1 and .[0].value == $domain))
  and ([.properties.template.containers[0].env[]? | select(.name == "DUB_FOLDER_ID")]
    | length == 0 or (length == 1 and (.[0].value | type == "string") and .[0].secretRef == null))
  and ([.properties.template.containers[0].env[]? | select(.name == "RESULT_MEDIA_PREVIEW_ENABLED")]
    | length <= 1 and (length == 0 or .[0].secretRef == null))
' >/dev/null <<< "$job_json" \
  || die 'The generation Job has a conflicting or unsafe Dub/media setting; review it before rerunning.'

operator_ipv4="${OPERATOR_PUBLIC_IPV4:-}"
if [[ -z "$operator_ipv4" ]]; then
  operator_ipv4="$(curl -4fsS --max-time 10 https://api.ipify.org)" \
    || die 'Could not determine the operator IPv4; set OPERATOR_PUBLIC_IPV4.'
fi
operator_ipv4="$(python3 - "$operator_ipv4" <<'PY'
import ipaddress
import sys

try:
    address = ipaddress.ip_address(sys.argv[1].strip())
    if address.version != 4 or not address.is_global:
        raise ValueError("expected a globally routable IPv4 address")
except ValueError:
    sys.exit(1)
print(address)
PY
)" || die 'OPERATOR_PUBLIC_IPV4 must be a globally routable IPv4 address.'

rules_json="$(az keyvault network-rule list --name "$VAULT" --resource-group "$RESOURCE_GROUP" \
  --subscription "$SUBSCRIPTION" --output json --only-show-errors)" \
  || die 'Cannot inspect Key Vault firewall rules.'
jq -e '.ipRules | type == "array"' >/dev/null <<< "$rules_json" \
  || die 'Key Vault firewall rule inventory is invalid.'
if ! jq -e --arg ip "$operator_ipv4" '
  any(.ipRules[]; .value == $ip or .value == ($ip + "/32"))
' >/dev/null <<< "$rules_json"; then
  az keyvault network-rule add --name "$VAULT" --resource-group "$RESOURCE_GROUP" \
    --ip-address "$operator_ipv4" --subscription "$SUBSCRIPTION" \
    --only-show-errors --output none \
    > "$TEMP_DIR/azure.stdout" 2> "$TEMP_DIR/azure.stderr" \
    || die 'Could not temporarily allow the operator IPv4 through Key Vault.'
  ip_rule_added=1
fi

list_secrets() {
  az keyvault secret list --vault-name "$VAULT" --subscription "$SUBSCRIPTION" \
    --output json --only-show-errors > "$TEMP_DIR/secret-inventory.json" \
    2> "$TEMP_DIR/azure.stderr"
}
if ! list_secrets; then
  if grep -q 'ForbiddenByFirewall' "$TEMP_DIR/azure.stderr"; then
    die 'Key Vault sees a different operator IPv4; set OPERATOR_PUBLIC_IPV4 to that egress address.'
  fi
  if [[ -n "${PROVISIONER_OBJECT_ID:-}" ]]; then
    operator_principal="$PROVISIONER_OBJECT_ID"
    operator_type="${PROVISIONER_PRINCIPAL_TYPE:-ServicePrincipal}"
  else
    operator_principal="$(az ad signed-in-user show --query id --output tsv --only-show-errors 2>/dev/null)" \
      || die 'Set PROVISIONER_OBJECT_ID for this Azure service-principal login.'
    operator_type=User
  fi
  [[ -n "$operator_principal" && ( "$operator_type" == User || "$operator_type" == ServicePrincipal ) ]] \
    || die 'Operator principal is missing or has an unsupported type.'
  officer_json="$(az role assignment list --assignee-object-id "$operator_principal" \
    --scope "$VAULT_ID" --role 'Key Vault Secrets Officer' \
    --subscription "$SUBSCRIPTION" --output json --only-show-errors)" \
    || die 'Cannot inspect the operator Key Vault role.'
  if ! jq -e --arg scope "$VAULT_ID" '
    any(.[]; (.scope | ascii_downcase) == ($scope | ascii_downcase))
  ' >/dev/null <<< "$officer_json"; then
    temporary_officer_assignment="$(az role assignment create \
      --assignee-object-id "$operator_principal" --assignee-principal-type "$operator_type" \
      --scope "$VAULT_ID" --role 'Key Vault Secrets Officer' \
      --subscription "$SUBSCRIPTION" --query id --output tsv --only-show-errors)" \
      || die 'Could not grant temporary Key Vault secret management to the operator.'
    [[ -n "$temporary_officer_assignment" ]] \
      || die 'Temporary Key Vault role assignment ID was not returned.'
  fi
  access_ready=0
  for ((attempt = 1; attempt <= 30; attempt++)); do
    if list_secrets; then access_ready=1; break; fi
    if ((attempt < 30)); then sleep "${DUB_ROLE_POLL_SECONDS:-5}"; fi
  done
  [[ "$access_ready" == 1 ]] || die 'Key Vault data-plane access did not become ready.'
fi
jq -e 'type == "array"' >/dev/null "$TEMP_DIR/secret-inventory.json" \
  || die 'Key Vault secret inventory was invalid.'

existing_count="$(jq --arg name "$SECRET" '[.[] | select(.name == $name)] | length' \
  "$TEMP_DIR/secret-inventory.json")"
[[ "$existing_count" == 0 || "$existing_count" == 1 ]] \
  || die 'Key Vault returned multiple Dub key secrets.'
if [[ "$existing_count" == 1 ]]; then
  jq -e --arg name "$SECRET" '
    [.[] | select(.name == $name)] | .[0].attributes.enabled != false
  ' >/dev/null "$TEMP_DIR/secret-inventory.json" \
    || die 'The existing Dub key secret is disabled.'
  az keyvault secret download --vault-name "$VAULT" --name "$SECRET" \
    --file "$TEMP_DIR/existing-key" --overwrite --subscription "$SUBSCRIPTION" \
    --only-show-errors --output none \
    > "$TEMP_DIR/azure.stdout" 2> "$TEMP_DIR/azure.stderr" \
    || die 'Could not read the existing Dub key secret.'
  cmp -s "$TEMP_DIR/dub-key" "$TEMP_DIR/existing-key" \
    || die 'The supplied Dub key differs from Key Vault. Review rotation before changing it.'
fi

# Test workspace access and find/create the named folder before writing a new
# Key Vault version. Only the folder ID is parsed; command output is not echoed.
DUB_API_KEY="$(< "$TEMP_DIR/dub-key")"
if ! (cd "$PROJECT_ROOT" && DUB_API_KEY="$DUB_API_KEY" pnpm --silent dub:setup-folder) \
  > "$TEMP_DIR/dub.stdout" 2> "$TEMP_DIR/dub.stderr"; then
  unset DUB_API_KEY
  die 'Dub folder setup failed. Check that the key has folder permissions in the verified twil.io workspace.'
fi
unset DUB_API_KEY
folder_id="$(python3 - "$TEMP_DIR/dub.stdout" <<'PY'
from pathlib import Path
import re
import sys

lines = Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
matches = [line.removeprefix("DUB_FOLDER_ID=") for line in lines if line.startswith("DUB_FOLDER_ID=")]
if len(matches) != 1 or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", matches[0]):
    sys.exit(1)
print(matches[0])
PY
)" || die 'Dub folder setup did not return one valid folder ID.'
jq -e --arg id "$folder_id" '
  [.properties.template.containers[0].env[]? | select(.name == "DUB_FOLDER_ID")]
    | length == 0 or .[0].value == $id
' >/dev/null <<< "$job_json" \
  || die 'The generation Job has a different Dub folder ID; review it before rerunning.'

expiration_utc="$(python3 - <<'PY'
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc) + timedelta(days=365)).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
)"
if [[ "$existing_count" == 0 ]]; then
  az keyvault secret set --vault-name "$VAULT" --name "$SECRET" \
    --file "$TEMP_DIR/dub-key" --encoding utf-8 \
    --content-type 'Twilio Comics Dub API key' --expires "$expiration_utc" \
    --subscription "$SUBSCRIPTION" --only-show-errors --output none \
    > "$TEMP_DIR/azure.stdout" 2> "$TEMP_DIR/azure.stderr" \
    || die 'Could not store the Dub key in Key Vault.'
else
  existing_expiry="$(jq -r --arg name "$SECRET" '
    [.[] | select(.name == $name)] | .[0].attributes.expires // empty
  ' "$TEMP_DIR/secret-inventory.json")"
  if [[ -z "$existing_expiry" ]]; then
    az keyvault secret set-attributes --vault-name "$VAULT" --name "$SECRET" \
      --expires "$expiration_utc" --subscription "$SUBSCRIPTION" \
      --only-show-errors --output none \
      > "$TEMP_DIR/azure.stdout" 2> "$TEMP_DIR/azure.stderr" \
      || die 'Could not assign the existing Dub key a Key Vault expiry.'
  else
    python3 - "$existing_expiry" <<'PY' \
      || die 'The Dub key in Key Vault is expired or has an invalid expiry; rotate it before continuing.'
from datetime import datetime, timezone
import sys
try:
    expiry = datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
    assert expiry.astimezone(timezone.utc) > datetime.now(timezone.utc)
except (AssertionError, ValueError):
    sys.exit(1)
PY
  fi
fi

az keyvault secret download --vault-name "$VAULT" --name "$SECRET" \
  --file "$TEMP_DIR/verified-key" --overwrite --subscription "$SUBSCRIPTION" \
  --only-show-errors --output none \
  > "$TEMP_DIR/azure.stdout" 2> "$TEMP_DIR/azure.stderr" \
  || die 'Could not verify the stored Dub key.'
cmp -s "$TEMP_DIR/dub-key" "$TEMP_DIR/verified-key" \
  || die 'The Key Vault Dub key did not match the supplied key.'

scope="$VAULT_ID/secrets/$SECRET"
reader_json="$(az role assignment list --assignee-object-id "$worker_principal" \
  --scope "$scope" --role 'Key Vault Secrets User' \
  --subscription "$SUBSCRIPTION" --output json --only-show-errors)" \
  || die 'Could not inspect the V2 worker Dub secret role.'
if ! jq -e --arg scope "$scope" '
  any(.[]; (.scope | ascii_downcase) == ($scope | ascii_downcase))
' >/dev/null <<< "$reader_json"; then
  az role assignment create --assignee-object-id "$worker_principal" \
    --assignee-principal-type ServicePrincipal --scope "$scope" \
    --role 'Key Vault Secrets User' --subscription "$SUBSCRIPTION" \
    --only-show-errors --output none \
    > "$TEMP_DIR/azure.stdout" 2> "$TEMP_DIR/azure.stderr" \
    || die 'Could not grant the V2 worker read access to the Dub key secret.'
fi

if ! jq -e --arg uri "$SECRET_URI" --arg identity "$IDENTITY_ID" '
  [.properties.configuration.secrets[]? | select(.name == "dub-api-key")]
    | length == 1 and .[0].keyVaultUrl == $uri
      and (.[0].identity | ascii_downcase) == ($identity | ascii_downcase)
' >/dev/null <<< "$job_json"; then
  az containerapp job secret set --name "$JOB" --resource-group "$RESOURCE_GROUP" \
    --secrets "${SECRET}=keyvaultref:${SECRET_URI},identityref:${IDENTITY_ID}" \
    --subscription "$SUBSCRIPTION" --only-show-errors --output none \
    > "$TEMP_DIR/azure.stdout" 2> "$TEMP_DIR/azure.stderr" \
    || die 'Could not bind the versionless Dub Key Vault secret to the generation Job. Retry after Azure RBAC propagates.'
fi

az containerapp job update --name "$JOB" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars 'DUB_API_KEY=secretref:dub-api-key' "DUB_DOMAIN=$DOMAIN" \
    "DUB_FOLDER_ID=$folder_id" 'RESULT_MEDIA_PREVIEW_ENABLED=false' \
  --subscription "$SUBSCRIPTION" --only-show-errors --output none \
  > "$TEMP_DIR/azure.stdout" 2> "$TEMP_DIR/azure.stderr" \
  || die 'Could not set the generation Job Dub environment variables.'

final_json="$(az containerapp job show --name "$JOB" --resource-group "$RESOURCE_GROUP" \
  --subscription "$SUBSCRIPTION" --output json --only-show-errors)" \
  || die 'Could not verify the generation Job after configuration.'
jq -e --arg uri "$SECRET_URI" --arg identity "$IDENTITY_ID" \
  --arg domain "$DOMAIN" --arg folder "$folder_id" '
  ([.properties.configuration.secrets[]? | select(.name == "dub-api-key")]
    | length == 1 and .[0].keyVaultUrl == $uri
      and (.[0].identity | ascii_downcase) == ($identity | ascii_downcase))
  and ([.properties.template.containers[0].env[]? | select(.name == "DUB_API_KEY")]
    | length == 1 and .[0].secretRef == "dub-api-key" and .[0].value == null)
  and ([.properties.template.containers[0].env[]? | select(.name == "DUB_DOMAIN")]
    | length == 1 and .[0].value == $domain)
  and ([.properties.template.containers[0].env[]? | select(.name == "DUB_FOLDER_ID")]
    | length == 1 and .[0].value == $folder)
  and ([.properties.template.containers[0].env[]? | select(.name == "RESULT_MEDIA_PREVIEW_ENABLED")]
    | length == 1 and .[0].value == "false")
' >/dev/null <<< "$final_json" \
  || die 'The generation Job did not retain the expected Dub configuration.'
bash "$PROJECT_ROOT/scripts/check-aca-dub-config.sh" <<< "$final_json" >/dev/null \
  || die 'The deployment Dub preflight rejected the generation Job configuration.'

printf 'Dub configured on %s with domain %s and folder %s. Outbound comic previews are off.\n' \
  "$JOB" "$DOMAIN" "$folder_id"
