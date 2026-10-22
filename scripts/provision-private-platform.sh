#!/usr/bin/env bash
set -euo pipefail

# One-time, repeatable private network foundation. It does not deploy app images,
# create SQL users, change GitHub settings, or move live Twilio webhooks.

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "Install '$1' before running this script."; }

for command in az python3; do require "$command"; done
: "${SUBSCRIPTION_ID:?Set SUBSCRIPTION_ID to the approved Azure subscription ID}"

EXPECTED_SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98'
[[ "$SUBSCRIPTION_ID" == "$EXPECTED_SUBSCRIPTION_ID" ]] \
  || die "This production template targets subscription $EXPECTED_SUBSCRIPTION_ID."

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-twilio-comics}"
LOG_ANALYTICS_WORKSPACE="${LOG_ANALYTICS_WORKSPACE:-law-twilio-comics}"
KEY_VAULT_NAME="${KEY_VAULT_NAME:-kv-twilio-comics-1a1d98}"
ADMIN_SECRET_NAME='postgres-bootstrap-password'
VNET_NAME='vnet-twilio-comics-v2'
VNET_CIDR='10.74.0.0/20'
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$PROJECT_ROOT/infra/private-platform.bicep"
[[ -r "$TEMPLATE" ]] || die "Missing $TEMPLATE."

# Catch a wrong Azure account before any resource mutation.
ACTIVE_SUBSCRIPTION="$(az account show --query id --output tsv)" \
  || die "Sign in with 'az login' and select the approved subscription."
[[ "$ACTIVE_SUBSCRIPTION" == "$SUBSCRIPTION_ID" ]] \
  || die "Active Azure subscription is '$ACTIVE_SUBSCRIPTION'; select '$SUBSCRIPTION_ID' first."

az group show --name "$RESOURCE_GROUP" --output none \
  || die "Resource group '$RESOURCE_GROUP' must already exist."
az monitor log-analytics workspace show --resource-group "$RESOURCE_GROUP" \
  --name "$LOG_ANALYTICS_WORKSPACE" --output none \
  || die "Log Analytics workspace '$LOG_ANALYTICS_WORKSPACE' must already exist."

for provider in Microsoft.Network Microsoft.App Microsoft.DBforPostgreSQL Microsoft.OperationalInsights Microsoft.KeyVault; do
  state="$(az provider show --namespace "$provider" --query registrationState --output tsv)" \
    || die "Cannot inspect resource provider $provider."
  [[ "$state" == Registered ]] \
    || die "Register $provider in subscription $SUBSCRIPTION_ID before provisioning (current state: ${state:-unknown})."
done

# Refuse to reserve the address block if another VNet already uses it. A
# repeat deployment of this template's own VNet is allowed.
TARGET_VNET_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Network/virtualNetworks/$VNET_NAME"
VNET_INVENTORY="$(az network vnet list --query '[].{id:id,prefixes:addressSpace.addressPrefixes}' --output json)" \
  || die 'Cannot inspect existing virtual networks.'
if ! printf '%s\n' "$VNET_INVENTORY" | python3 -c '
import ipaddress
import json
import sys

target_id, target_cidr = sys.argv[1:]
target = ipaddress.ip_network(target_cidr)
for network in json.load(sys.stdin):
    if network.get("id", "").casefold() == target_id.casefold():
        existing_prefixes = network.get("prefixes") or []
        if set(existing_prefixes) != {target_cidr}:
            print(f"Existing target VNet has a different address space: {existing_prefixes}", file=sys.stderr)
            sys.exit(1)
        continue
    for prefix in network.get("prefixes") or []:
        existing = ipaddress.ip_network(prefix)
        if existing.overlaps(target):
            network_id = network.get("id") or "unknown"
            print(f"{target} overlaps existing VNet {network_id} ({existing})", file=sys.stderr)
            sys.exit(1)
' "$TARGET_VNET_ID" "$VNET_CIDR"; then
  die 'Choose a nonoverlapping address range and review the Bicep template before retrying.'
fi

PRIVATE_PLATFORM_MODE="${PRIVATE_PLATFORM_MODE:-deploy}"
[[ "$PRIVATE_PLATFORM_MODE" == deploy || "$PRIVATE_PLATFORM_MODE" == what-if ]] \
  || die 'PRIVATE_PLATFORM_MODE must be deploy or what-if.'

if [[ "$PRIVATE_PLATFORM_MODE" == what-if ]]; then
  # Preview is truly read-only: a throwaway placeholder satisfies the secure
  # parameter without creating a Key Vault or sending a real password.
  umask 077
  PREVIEW_PARAMETERS_FILE="$(mktemp "${TMPDIR:-/tmp}/twilio-comics-private-preview.XXXXXXXX.json")"
  trap 'rm -f "$PREVIEW_PARAMETERS_FILE"' EXIT
  python3 - "$PREVIEW_PARAMETERS_FILE" <<'PY'
import json
from pathlib import Path
import sys

payload = {
    '$schema': 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
    'contentVersion': '1.0.0.0',
    'parameters': {'postgresAdminPassword': {'value': 'PreviewOnly0123456789PreviewOnly'}},
}
Path(sys.argv[1]).write_text(json.dumps(payload) + '\n', encoding='utf-8')
PY
  az deployment group what-if \
    --name twilio-comics-private-platform-v2 \
    --resource-group "$RESOURCE_GROUP" \
    --template-file "$TEMPLATE" \
    --parameters "@$PREVIEW_PARAMETERS_FILE" "logAnalyticsWorkspaceName=$LOG_ANALYTICS_WORKSPACE" \
    --mode Incremental \
    --result-format ResourceIdOnly \
    --output json
  exit 0
fi

if [[ "${PROVISION_PRIVATE_PLATFORM_CONFIRM:-}" != yes ]]; then
  die 'Set PROVISION_PRIVATE_PLATFORM_CONFIRM=yes after reviewing this private Azure resource deployment.'
fi

# The tenant requires a deny-by-default vault firewall and purge protection.
# Allow only this operator's public IPv4 address for bootstrap data-plane calls.
# The Container Apps subnet is added after its service endpoint is deployed.
if [[ -z "${OPERATOR_PUBLIC_IPV4:-}" ]]; then
  require curl
  OPERATOR_PUBLIC_IPV4="$(curl -4fsS --max-time 10 https://api.ipify.org)" \
    || die 'Set OPERATOR_PUBLIC_IPV4 to the current public IPv4 address.'
fi
OPERATOR_PUBLIC_IPV4="$(python3 - "$OPERATOR_PUBLIC_IPV4" <<'PY'
import ipaddress
import sys

try:
    address = ipaddress.ip_address(sys.argv[1].strip())
    if address.version != 4 or not address.is_global:
        raise ValueError('expected a globally routable IPv4 address')
except ValueError as error:
    print(f'ERROR: Invalid OPERATOR_PUBLIC_IPV4: {error}', file=sys.stderr)
    sys.exit(1)
print(address)
PY
)" || die 'Correct OPERATOR_PUBLIC_IPV4 and retry.'
printf 'Key Vault bootstrap access is limited to operator IP %s.\n' "$OPERATOR_PUBLIC_IPV4"

# Generate or reuse an administrator password in Key Vault. The new secret is
# written via --file, and a repeat deployment downloads its existing value to a
# temporary owner-only file rather than silently rotating the server password.
umask 077
PASSWORD_FILE="$(mktemp "${TMPDIR:-/tmp}/twilio-comics-pg-password.XXXXXXXX")"
PARAMETERS_FILE="$(mktemp "${TMPDIR:-/tmp}/twilio-comics-private-platform.XXXXXXXX.json")"
trap 'rm -f "$PASSWORD_FILE" "$PARAMETERS_FILE"' EXIT

if ! az keyvault show --name "$KEY_VAULT_NAME" --resource-group "$RESOURCE_GROUP" \
    --output none >/dev/null 2>&1; then
  az keyvault create --name "$KEY_VAULT_NAME" --resource-group "$RESOURCE_GROUP" \
    --location eastus2 --sku standard --enable-rbac-authorization true \
    --retention-days 90 --enable-purge-protection true \
    --public-network-access Enabled --default-action Deny --bypass None \
    --network-acls-ips "$OPERATOR_PUBLIC_IPV4" \
    --tags created_by=github-actions managed_by=twilio-comics-ci \
    --only-show-errors --output none
else
  owner_tag="$(az keyvault show --name "$KEY_VAULT_NAME" --resource-group "$RESOURCE_GROUP" \
    --query tags.managed_by --output tsv)" \
    || die "Cannot inspect Key Vault '$KEY_VAULT_NAME' ownership."
  [[ "$owner_tag" == twilio-comics-ci ]] \
    || die "Existing Key Vault '$KEY_VAULT_NAME' is not tagged as Twilio Comics infrastructure."
  public_network_access="$(az keyvault show --name "$KEY_VAULT_NAME" --resource-group "$RESOURCE_GROUP" \
    --query properties.publicNetworkAccess --output tsv)" \
    || die "Cannot inspect Key Vault '$KEY_VAULT_NAME' network mode."
  [[ "$public_network_access" != Disabled ]] \
    || die "Existing Key Vault '$KEY_VAULT_NAME' has public network access disabled; use a VNet-connected operator path instead of opening it."
  az keyvault update --name "$KEY_VAULT_NAME" --resource-group "$RESOURCE_GROUP" \
    --enable-purge-protection true --default-action Deny --bypass None \
    --only-show-errors --output none
fi
KEY_VAULT_ID="$(az keyvault show --name "$KEY_VAULT_NAME" --resource-group "$RESOURCE_GROUP" \
  --query id --output tsv)" || die "Cannot inspect Key Vault '$KEY_VAULT_NAME'."

VAULT_NETWORK_RULES="$(az keyvault network-rule list --name "$KEY_VAULT_NAME" \
  --resource-group "$RESOURCE_GROUP" --output json)" \
  || die "Cannot inspect Key Vault '$KEY_VAULT_NAME' network rules."
if ! printf '%s\n' "$VAULT_NETWORK_RULES" | python3 -c '
import ipaddress
import json
import sys

operator = ipaddress.ip_network(f"{sys.argv[1]}/32")
rules = json.load(sys.stdin).get("ipRules") or []
sys.exit(0 if any(ipaddress.ip_network(rule["value"]) == operator for rule in rules) else 1)
' "$OPERATOR_PUBLIC_IPV4"; then
  az keyvault network-rule add --name "$KEY_VAULT_NAME" \
    --resource-group "$RESOURCE_GROUP" --ip-address "$OPERATOR_PUBLIC_IPV4" \
    --only-show-errors --output none
fi
if [[ -n "${PROVISIONER_OBJECT_ID:-}" ]]; then
  PROVISIONER_PRINCIPAL_TYPE="${PROVISIONER_PRINCIPAL_TYPE:-ServicePrincipal}"
else
  PROVISIONER_OBJECT_ID="$(az ad signed-in-user show --query id --output tsv 2>/dev/null)" \
    || die 'Set PROVISIONER_OBJECT_ID for a service-principal Azure login.'
  PROVISIONER_PRINCIPAL_TYPE=User
fi
role_count="$(az role assignment list --assignee-object-id "$PROVISIONER_OBJECT_ID" \
  --scope "$KEY_VAULT_ID" --role 'Key Vault Secrets Officer' \
  --query 'length(@)' --output tsv)" || die 'Cannot inspect Key Vault access.'
if [[ "$role_count" == 0 ]]; then
  az role assignment create --assignee-object-id "$PROVISIONER_OBJECT_ID" \
    --assignee-principal-type "$PROVISIONER_PRINCIPAL_TYPE" \
    --scope "$KEY_VAULT_ID" --role 'Key Vault Secrets Officer' --output none
fi

# A new RBAC grant takes time to reach the Key Vault data plane.
secret_access_ready=false
for ((attempt = 1; attempt <= 30; attempt++)); do
  if az keyvault secret list --vault-name "$KEY_VAULT_NAME" --output none >/dev/null 2>&1; then
    secret_access_ready=true
    break
  fi
  sleep 10
done
[[ "$secret_access_ready" == true ]] || die "Key Vault secret access did not become ready for '$KEY_VAULT_NAME'."

if az keyvault secret show --vault-name "$KEY_VAULT_NAME" \
    --name "$ADMIN_SECRET_NAME" --output none >/dev/null 2>&1; then
  [[ -z "${POSTGRES_ADMIN_PASSWORD_FILE:-}" ]] \
    || die "Key Vault already has '$ADMIN_SECRET_NAME'; omit POSTGRES_ADMIN_PASSWORD_FILE to reuse it."
  az keyvault secret download --vault-name "$KEY_VAULT_NAME" \
    --name "$ADMIN_SECRET_NAME" --file "$PASSWORD_FILE" \
    --overwrite --only-show-errors --output none
else
  if [[ -n "${POSTGRES_ADMIN_PASSWORD_FILE:-}" ]]; then
    python3 - "$POSTGRES_ADMIN_PASSWORD_FILE" "$PASSWORD_FILE" <<'PY'
from pathlib import Path
import os
import stat
import sys

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
try:
    details = source.stat()
    if not stat.S_ISREG(details.st_mode) or details.st_mode & 0o077:
        raise ValueError('password file must be regular and owner-only (mode 0600)')
    password = source.read_text(encoding='utf-8')
    if password.endswith('\n'):
        password = password[:-1]
    if not 24 <= len(password) <= 128:
        raise ValueError('password must contain 24 to 128 Unicode code points')
    if any(ord(character) < 0x20 or ord(character) == 0x7f or character in '\u2028\u2029' for character in password):
        raise ValueError('password must not contain control or line separator characters')
    destination.write_text(password, encoding='utf-8')
    os.chmod(destination, 0o600)
except (OSError, UnicodeError, ValueError) as error:
    print(f'ERROR: Invalid PostgreSQL password file: {error}', file=sys.stderr)
    sys.exit(1)
PY
  else
    python3 - "$PASSWORD_FILE" <<'PY'
from pathlib import Path
import secrets
import string
import sys

alphabet = string.ascii_letters + string.digits
while True:
    password = ''.join(secrets.choice(alphabet) for _ in range(48))
    if any(ch.islower() for ch in password) and any(ch.isupper() for ch in password) and any(ch.isdigit() for ch in password):
        break
Path(sys.argv[1]).write_text(password, encoding='utf-8')
PY
  fi
  az keyvault secret set --vault-name "$KEY_VAULT_NAME" \
    --name "$ADMIN_SECRET_NAME" --file "$PASSWORD_FILE" --encoding utf-8 \
    --content-type 'Twilio Comics PostgreSQL bootstrap administrator password' \
    --only-show-errors --output none
fi

# Azure CLI receives only a path to a short-lived mode-0600 parameter file.
# The secret never appears in shell history, process arguments, or command output.
python3 - "$PASSWORD_FILE" "$PARAMETERS_FILE" <<'PY'
import json
import os
from pathlib import Path
import stat
import sys

password_file = Path(sys.argv[1])
parameters_file = Path(sys.argv[2])
try:
    file_stat = password_file.stat()
    if not stat.S_ISREG(file_stat.st_mode):
        raise ValueError('password source must be a regular file')
    if file_stat.st_mode & 0o077:
        raise ValueError('password source must be readable only by its owner (mode 0600)')
    password = password_file.read_text(encoding='utf-8')
    if not 24 <= len(password) <= 128:
        raise ValueError('password must contain 24 to 128 Unicode code points')
    if any(ord(character) < 0x20 or ord(character) == 0x7f or character in '\u2028\u2029' for character in password):
        raise ValueError('password must not contain control or line separator characters')
except (OSError, UnicodeError, ValueError) as error:
    print(f'ERROR: Invalid PostgreSQL password file: {error}', file=sys.stderr)
    sys.exit(1)

payload = {
    '$schema': 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
    'contentVersion': '1.0.0.0',
    'parameters': {'postgresAdminPassword': {'value': password}},
}
with parameters_file.open('w', encoding='utf-8') as destination:
    json.dump(payload, destination)
    destination.write('\n')
os.chmod(parameters_file, 0o600)
PY

printf 'Deploying VNet %s, private PostgreSQL, and Container Apps environment into %s.\n' \
  "$VNET_NAME" "$RESOURCE_GROUP"
az deployment group create \
  --name twilio-comics-private-platform-v2 \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$TEMPLATE" \
  --parameters "@$PARAMETERS_FILE" "logAnalyticsWorkspaceName=$LOG_ANALYTICS_WORKSPACE" \
  --mode Incremental \
  --only-show-errors \
  --query properties.outputs \
  --output json

# This subnet has a Microsoft.KeyVault service endpoint in the template. The
# VNet rule lets managed-identity Jobs reach the vault without an open firewall.
ACA_SUBNET_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Network/virtualNetworks/$VNET_NAME/subnets/aca-infrastructure"
VAULT_NETWORK_RULES="$(az keyvault network-rule list --name "$KEY_VAULT_NAME" \
  --resource-group "$RESOURCE_GROUP" --output json)" \
  || die "Cannot inspect Key Vault '$KEY_VAULT_NAME' VNet rules."
if ! printf '%s\n' "$VAULT_NETWORK_RULES" | python3 -c '
import json
import sys

target = sys.argv[1].casefold()
rules = json.load(sys.stdin).get("virtualNetworkRules") or []
sys.exit(0 if any(rule.get("id", "").casefold() == target for rule in rules) else 1)
' "$ACA_SUBNET_ID"; then
  vnet_rule_added=false
  for ((attempt = 1; attempt <= 12; attempt++)); do
    if az keyvault network-rule add --name "$KEY_VAULT_NAME" \
        --resource-group "$RESOURCE_GROUP" --subnet "$ACA_SUBNET_ID" \
        --only-show-errors --output none; then
      vnet_rule_added=true
      break
    fi
    if ((attempt < 12)); then sleep 10; fi
  done
  [[ "$vnet_rule_added" == true ]] \
    || die "Could not allow ACA subnet '$ACA_SUBNET_ID' through the Key Vault firewall. Verify its Microsoft.KeyVault service endpoint and rerun."
fi

public_access="$(az postgres flexible-server show \
  --name twilio-comics-pg-1a1d98 --resource-group "$RESOURCE_GROUP" \
  --query network.publicNetworkAccess --output tsv)" \
  || die 'Deployment returned, but PostgreSQL could not be read back.'
[[ "$public_access" == Disabled ]] \
  || die "PostgreSQL public network access is '${public_access:-unknown}' instead of Disabled."

printf 'Private platform provisioned. Bootstrap password is stored as %s in Key Vault %s. Create separate migration/runtime SQL roles from inside the new VNet before deploying workloads.\n' \
  "$ADMIN_SECRET_NAME" "$KEY_VAULT_NAME"
