#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin"

if [[ -n "${BICEP_BIN:-}" ]]; then
  DOTNET_BUNDLE_EXTRACT_BASE_DIR="$TEST_ROOT" "$BICEP_BIN" build \
    "$PROJECT_ROOT/infra/private-platform.bicep" \
    --outfile "$TEST_ROOT/private-platform.json"
  python3 - "$TEST_ROOT/private-platform.json" <<'PY'
import json
import sys

template = json.load(open(sys.argv[1], encoding='utf-8'))
assert template['parameters']['postgresAdminPassword']['type'].casefold() == 'securestring'
resources = template['resources']
postgres = next(resource for resource in resources if resource['type'] == 'Microsoft.DBforPostgreSQL/flexibleServers')
environment = next(resource for resource in resources if resource['type'] == 'Microsoft.App/managedEnvironments')
aca_subnet = next(resource for resource in resources if resource['type'] == 'Microsoft.Network/virtualNetworks/subnets' and 'acaSubnetName' in resource['name'])
subnets = [resource for resource in resources if resource['type'] == 'Microsoft.Network/virtualNetworks/subnets']
vnets = [resource for resource in resources if resource['type'] == 'Microsoft.Network/virtualNetworks']
peerings = [resource for resource in resources if resource['type'] == 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings']
dns_links = [resource for resource in resources if resource['type'] == 'Microsoft.Network/privateDnsZones/virtualNetworkLinks']
assert template['parameters']['postgresLocation']['defaultValue'] == 'centralus'
assert template['parameters']['postgresLocation']['allowedValues'] == ['centralus']
assert {tuple(vnet['properties']['addressSpace']['addressPrefixes']) for vnet in vnets} == {
    ('10.74.0.0/20',), ('10.75.0.0/20',),
}
assert {subnet['properties']['addressPrefix'] for subnet in subnets} == {
    '10.74.0.0/23', '10.74.8.0/26', '10.75.0.0/26',
}
assert len(peerings) == 2 and all(peer['properties']['allowVirtualNetworkAccess'] for peer in peerings)
assert len(dns_links) == 2 and all(not link['properties']['registrationEnabled'] for link in dns_links)
assert postgres['sku'] == {'name': 'Standard_B1ms', 'tier': 'Burstable'}
assert postgres['location'] == "[parameters('postgresLocation')]"
assert 'availabilityZone' not in postgres['properties']
assert postgres['properties']['network']['publicNetworkAccess'] == 'Disabled'
assert environment['properties']['vnetConfiguration']['internal'] is False
assert environment['properties']['peerAuthentication']['mtls']['enabled'] is False
assert environment['properties']['peerTrafficConfiguration']['encryption']['enabled'] is False
assert any(endpoint['service'] == 'Microsoft.KeyVault' for endpoint in aca_subnet['properties']['serviceEndpoints'])
assert all(subnet['properties']['privateEndpointNetworkPolicies'] == 'Disabled'
           for subnet in subnets if subnet['properties']['addressPrefix'].startswith('10.74.'))
assert {'postgresVnetId', 'postgresSubnetId', 'acaToPostgresPeeringId', 'postgresToAcaPeeringId',
        'postgresDnsAcaLinkId', 'postgresDnsDbLinkId', 'postgresRegion'} <= set(template['outputs'])
PY
fi

bash -n "$PROJECT_ROOT/scripts/provision-private-platform.sh"

cat > "$TEST_ROOT/bin/az" <<'AZ'
#!/usr/bin/env bash
set -euo pipefail

arg_after() {
  local key="$1" previous='' item
  shift
  for item in "$@"; do
    if [[ "$previous" == "$key" ]]; then printf '%s\n' "$item"; return; fi
    previous="$item"
  done
}

case "$1 $2 ${3:-}" in
  'account show --query') printf '%s\n' "${AZ_TEST_ACCOUNT_ID:-b001fc6f-ea19-456a-8401-63971a1a1d98}" ;;
  'group show --name'|'monitor log-analytics workspace') exit 0 ;;
  'provider show --namespace') printf 'Registered\n' ;;
  'network vnet list')
    if [[ "${AZ_TEST_OVERLAP:-}" == 1 ]]; then
      printf '%s\n' '[{"id":"/subscriptions/other/resourceGroups/other/providers/Microsoft.Network/virtualNetworks/conflict","location":"eastus2","prefixes":["10.74.8.0/24"]}]'
    elif [[ "${AZ_TEST_DB_OVERLAP:-}" == 1 ]]; then
      printf '%s\n' '[{"id":"/subscriptions/other/resourceGroups/other/providers/Microsoft.Network/virtualNetworks/conflict","location":"centralus","prefixes":["10.75.1.0/24"]}]'
    elif [[ "${AZ_TEST_TARGET_DRIFT:-}" == 1 ]]; then
      printf '%s\n' '[{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/virtualNetworks/vnet-twilio-comics-v2","location":"eastus2","prefixes":["10.76.0.0/20"]}]'
    elif [[ "${AZ_TEST_DB_TARGET_DRIFT:-}" == 1 ]]; then
      printf '%s\n' '[{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/virtualNetworks/vnet-twilio-comics-pg-cus","location":"centralus","prefixes":["10.76.0.0/20"]}]'
    elif [[ "${AZ_TEST_DB_REGION_DRIFT:-}" == 1 ]]; then
      printf '%s\n' '[{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/virtualNetworks/vnet-twilio-comics-pg-cus","location":"eastus2","prefixes":["10.75.0.0/20"]}]'
    else
      printf '%s\n' '[{"id":"/subscriptions/other/resourceGroups/other/providers/Microsoft.Network/virtualNetworks/existing","location":"eastus2","prefixes":["10.73.0.0/20"]},{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/virtualNetworks/vnet-twilio-comics-v2","location":"eastus2","prefixes":["10.74.0.0/20"]}]'
    fi ;;
  'network vnet show')
    vnet="$(arg_after --name "$@")"
    case "$vnet" in
      vnet-twilio-comics-v2)
        printf '%s\n' '{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/virtualNetworks/vnet-twilio-comics-v2","location":"eastus2","addressSpace":{"addressPrefixes":["10.74.0.0/20"]}}' ;;
      vnet-twilio-comics-pg-cus)
        printf '%s\n' '{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/virtualNetworks/vnet-twilio-comics-pg-cus","location":"centralus","addressSpace":{"addressPrefixes":["10.75.0.0/20"]}}' ;;
      *) exit 91 ;;
    esac ;;
  'network vnet peering')
    source_vnet="$(arg_after --vnet-name "$@")"
    peering_state='Connected'
    [[ "${AZ_TEST_DISCONNECTED_PEERING:-}" != 1 ]] || peering_state='Disconnected'
    case "$source_vnet" in
      vnet-twilio-comics-v2) remote_vnet='vnet-twilio-comics-pg-cus' ;;
      vnet-twilio-comics-pg-cus) remote_vnet='vnet-twilio-comics-v2' ;;
      *) exit 91 ;;
    esac
    printf '{"peeringState":"%s","allowVirtualNetworkAccess":true,"remoteVirtualNetwork":{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/virtualNetworks/%s"}}\n' "$peering_state" "$remote_vnet" ;;
  'network private-dns link')
    link="$(arg_after --name "$@")"
    case "$link" in
      twilio-comics-v2-link) target_vnet='vnet-twilio-comics-v2' ;;
      twilio-comics-pg-cus-link) target_vnet='vnet-twilio-comics-pg-cus' ;;
      *) exit 91 ;;
    esac
    printf '{"registrationEnabled":false,"virtualNetwork":{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/virtualNetworks/%s"}}\n' "$target_vnet" ;;
  'keyvault show --name')
    [[ -e "$AZ_TEST_VAULT_FILE" ]] || exit 1
    case "$(arg_after --query "$@")" in
      id) printf '/subscriptions/test/resourceGroups/rg-twilio-comics/providers/Microsoft.KeyVault/vaults/kv-twilio-comics-1a1d98\n' ;;
      tags.managed_by) printf 'twilio-comics-ci\n' ;;
      properties.publicNetworkAccess) printf 'Enabled\n' ;;
    esac ;;
  'keyvault create --name')
    [[ "$*" == *'--enable-purge-protection true'* ]]
    [[ "$*" == *'--default-action Deny'* ]]
    [[ "$*" == *'--network-acls-ips 8.8.8.8'* ]]
    touch "$AZ_TEST_VAULT_FILE" "$AZ_TEST_IP_RULE_FILE" ;;
  'keyvault update --name')
    [[ "$*" == *'--enable-purge-protection true'* ]]
    [[ "$*" == *'--default-action Deny'* ]] ;;
  'keyvault network-rule list')
    python3 - "$AZ_TEST_IP_RULE_FILE" "$AZ_TEST_VNET_RULE_FILE" <<'PY'
import json
from pathlib import Path
import sys

ip_rule = Path(sys.argv[1]).exists()
vnet_rule = Path(sys.argv[2]).exists()
subnet = '/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/virtualNetworks/vnet-twilio-comics-v2/subnets/aca-infrastructure'
print(json.dumps({
    'ipRules': [{'value': '8.8.8.8/32'}] if ip_rule else [],
    'virtualNetworkRules': [{'id': subnet}] if vnet_rule else [],
}))
PY
    ;;
  'keyvault network-rule add')
    if [[ "$*" == *'--subnet '* ]]; then
      [[ "$(arg_after --subnet "$@")" == */subnets/aca-infrastructure ]]
      touch "$AZ_TEST_VNET_RULE_FILE"
      printf 'vnet\n' >> "$AZ_TEST_RULE_ADDS"
    elif [[ "$*" == *'--ip-address '* ]]; then
      touch "$AZ_TEST_IP_RULE_FILE"
      printf 'ip\n' >> "$AZ_TEST_RULE_ADDS"
    else
      exit 94
    fi ;;
  'ad signed-in-user show') printf 'test-user-object-id\n' ;;
  'role assignment list')
    [[ -e "$AZ_TEST_ROLE_FILE" ]] && printf '1\n' || printf '0\n' ;;
  'role assignment create') touch "$AZ_TEST_ROLE_FILE" ;;
  'keyvault secret list') exit 0 ;;
  'keyvault secret show') [[ -e "$AZ_TEST_SECRET_FILE" ]] ;;
  'keyvault secret set')
    expiration="$(arg_after --expires "$@")"
    [[ -n "$expiration" ]] || {
      printf 'PostgreSQL bootstrap secret needs an expiration\n' >&2
      exit 95
    }
    cp "$(arg_after --file "$@")" "$AZ_TEST_SECRET_FILE"
    printf '%s\n' "$expiration" >> "$AZ_TEST_SECRET_EXPIRATIONS"
    printf 'set\n' >> "$AZ_TEST_SECRET_WRITES" ;;
  'keyvault secret download') cp "$AZ_TEST_SECRET_FILE" "$(arg_after --file "$@")" ;;
  'deployment group what-if')
    printf '%s\n' "$@" > "$AZ_TEST_PREVIEW_LOG"
    [[ "$*" == *'--result-format ResourceIdOnly'* ]] || exit 93
    printf '%s\n' '[]' ;;
  'deployment group create')
    printf '%s\n' "$@" > "$AZ_TEST_ARGUMENT_LOG"
    previous=''
    parameters_file=''
    for argument in "$@"; do
      if [[ "$previous" == --parameters && "$argument" == @* ]]; then
        parameters_file="${argument#@}"
        break
      fi
      previous="$argument"
    done
    [[ -n "$parameters_file" && -f "$parameters_file" ]] || exit 92
    python3 - "$parameters_file" "$AZ_TEST_SECRET_FILE" "$AZ_TEST_ARGUMENT_LOG" <<'PY'
import json
import os
import sys

path, secret_file, arguments_file = sys.argv[1:]
assert os.stat(path).st_mode & 0o077 == 0
payload = json.load(open(path, encoding='utf-8'))
secret = open(secret_file, encoding='utf-8').read()
assert payload['parameters']['postgresAdminPassword']['value'] == secret
assert secret not in open(arguments_file, encoding='utf-8').read()
PY
    printf '%s\n' '{}'
    ;;
  'postgres flexible-server show')
    printf '%s\n' '{"location":"Central US","sku":{"name":"Standard_B1ms","tier":"Burstable"},"network":{"publicNetworkAccess":"Disabled","delegatedSubnetResourceId":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/virtualNetworks/vnet-twilio-comics-pg-cus/subnets/postgresql","privateDnsZoneArmResourceId":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/privateDnsZones/twilio-comics.postgres.database.azure.com"}}' ;;
  *) printf 'Unexpected Azure command: %s\n' "$*" >&2; exit 90 ;;
esac
AZ
chmod +x "$TEST_ROOT/bin/az"

AZ_TEST_ARGUMENT_LOG="$TEST_ROOT/azure-arguments"
AZ_TEST_VAULT_FILE="$TEST_ROOT/vault-created"
AZ_TEST_ROLE_FILE="$TEST_ROOT/role-created"
AZ_TEST_SECRET_FILE="$TEST_ROOT/secret-created"
AZ_TEST_SECRET_WRITES="$TEST_ROOT/secret-writes"
AZ_TEST_SECRET_EXPIRATIONS="$TEST_ROOT/secret-expirations"
AZ_TEST_PREVIEW_LOG="$TEST_ROOT/preview-arguments"
AZ_TEST_IP_RULE_FILE="$TEST_ROOT/ip-rule"
AZ_TEST_VNET_RULE_FILE="$TEST_ROOT/vnet-rule"
AZ_TEST_RULE_ADDS="$TEST_ROOT/network-rule-adds"
PASSWORD_FILE="$TEST_ROOT/admin-password"
printf '%s\n' 'a-safe-test-password-of-32-characters' > "$PASSWORD_FILE"
chmod 600 "$PASSWORD_FILE"
export AZ_TEST_ARGUMENT_LOG AZ_TEST_VAULT_FILE AZ_TEST_ROLE_FILE AZ_TEST_SECRET_FILE AZ_TEST_SECRET_WRITES AZ_TEST_SECRET_EXPIRATIONS AZ_TEST_PREVIEW_LOG AZ_TEST_IP_RULE_FILE AZ_TEST_VNET_RULE_FILE AZ_TEST_RULE_ADDS

run_provision() {
  PATH="$TEST_ROOT/bin:$PATH" \
  SUBSCRIPTION_ID=b001fc6f-ea19-456a-8401-63971a1a1d98 \
  OPERATOR_PUBLIC_IPV4="${OPERATOR_PUBLIC_IPV4:-8.8.8.8}" \
  PROVISION_PRIVATE_PLATFORM_CONFIRM=yes \
  TMPDIR="$TEST_ROOT" \
  bash "$PROJECT_ROOT/scripts/provision-private-platform.sh"
}

PRIVATE_PLATFORM_MODE=what-if run_provision > "$TEST_ROOT/preview-output"
[[ -s "$AZ_TEST_PREVIEW_LOG" && ! -e "$AZ_TEST_VAULT_FILE" ]]
[[ ! -e "$AZ_TEST_SECRET_FILE" && ! -e "$AZ_TEST_ARGUMENT_LOG" ]]

run_provision > "$TEST_ROOT/success-output"
[[ -s "$AZ_TEST_ARGUMENT_LOG" ]]
[[ -s "$AZ_TEST_SECRET_FILE" && -e "$AZ_TEST_VAULT_FILE" ]]
[[ -e "$AZ_TEST_VNET_RULE_FILE" ]]
[[ "$(cat "$AZ_TEST_RULE_ADDS")" == vnet ]]
parameters_file="$(awk '$0 == "--parameters" { getline; if (substr($0, 1, 1) == "@") { print substr($0, 2); exit } }' "$AZ_TEST_ARGUMENT_LOG")"
[[ -n "$parameters_file" && ! -e "$parameters_file" ]]
[[ "$(wc -l < "$AZ_TEST_SECRET_WRITES")" == 1 ]]
python3 - "$AZ_TEST_SECRET_EXPIRATIONS" <<'PY'
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

expirations = Path(sys.argv[1]).read_text(encoding='utf-8').splitlines()
assert len(expirations) == 1
expiration = datetime.strptime(expirations[0], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
assert timedelta(days=364) < expiration - datetime.now(timezone.utc) <= timedelta(days=365)
PY

# Deployment readback must reject a peering that has not connected yet.
set +e
AZ_TEST_DISCONNECTED_PEERING=1 run_provision > "$TEST_ROOT/disconnected-peering-output" 2>&1
status=$?
set -e
[[ "$status" == 1 ]]
grep -q 'not connected to its intended peer' "$TEST_ROOT/disconnected-peering-output"

# Rerunning must use the existing Key Vault secret and avoid a second write.
run_provision > "$TEST_ROOT/repeat-output"
[[ "$(wc -l < "$AZ_TEST_SECRET_WRITES")" == 1 ]]
[[ "$(wc -l < "$AZ_TEST_SECRET_EXPIRATIONS")" == 1 ]]
[[ "$(cat "$AZ_TEST_RULE_ADDS")" == vnet ]]

# A protected operator file may end with one LF. Key Vault and the ARM secure
# parameter must receive the exact same normalized bytes, including punctuation.
rm -f "$AZ_TEST_SECRET_FILE"
printf '%s\n' 'a-Safe!Test#Password_WithPunct+2026' > "$PASSWORD_FILE"
POSTGRES_ADMIN_PASSWORD_FILE="$PASSWORD_FILE" run_provision > "$TEST_ROOT/operator-file-output"
python3 - "$AZ_TEST_SECRET_FILE" <<'PY'
from pathlib import Path
import sys

assert Path(sys.argv[1]).read_bytes() == b'a-Safe!Test#Password_WithPunct+2026'
PY
[[ "$(wc -l < "$AZ_TEST_SECRET_WRITES")" == 2 ]]
[[ "$(wc -l < "$AZ_TEST_SECRET_EXPIRATIONS")" == 2 ]]

# A manually changed vault secret with a newline must fail before ARM deploys.
# Trimming it here would make PostgreSQL and Key Vault disagree again.
printf '%s\n' 'a-Safe!Test#Password_WithPunct+2026' > "$AZ_TEST_SECRET_FILE"
rm -f "$AZ_TEST_ARGUMENT_LOG"
set +e
run_provision > "$TEST_ROOT/invalid-vault-secret-output" 2>&1
status=$?
set -e
[[ "$status" == 1 && ! -e "$AZ_TEST_ARGUMENT_LOG" ]]
grep -q 'control or line separator characters' "$TEST_ROOT/invalid-vault-secret-output"

rm -f "$AZ_TEST_ARGUMENT_LOG"
set +e
AZ_TEST_ACCOUNT_ID=wrong-subscription run_provision > "$TEST_ROOT/wrong-subscription-output" 2>&1
status=$?
set -e
[[ "$status" == 1 && ! -e "$AZ_TEST_ARGUMENT_LOG" ]]
grep -q 'Active Azure subscription' "$TEST_ROOT/wrong-subscription-output"

set +e
AZ_TEST_OVERLAP=1 run_provision > "$TEST_ROOT/overlap-output" 2>&1
status=$?
set -e
[[ "$status" == 1 && ! -e "$AZ_TEST_ARGUMENT_LOG" ]]
grep -q 'overlaps existing VNet' "$TEST_ROOT/overlap-output"

set +e
AZ_TEST_DB_OVERLAP=1 run_provision > "$TEST_ROOT/db-overlap-output" 2>&1
status=$?
set -e
[[ "$status" == 1 && ! -e "$AZ_TEST_ARGUMENT_LOG" ]]
grep -q '10.75.0.0/20 overlaps existing VNet' "$TEST_ROOT/db-overlap-output"

set +e
AZ_TEST_TARGET_DRIFT=1 run_provision > "$TEST_ROOT/drift-output" 2>&1
status=$?
set -e
[[ "$status" == 1 && ! -e "$AZ_TEST_ARGUMENT_LOG" ]]
grep -q 'different address space' "$TEST_ROOT/drift-output"

set +e
AZ_TEST_DB_TARGET_DRIFT=1 run_provision > "$TEST_ROOT/db-drift-output" 2>&1
status=$?
set -e
[[ "$status" == 1 && ! -e "$AZ_TEST_ARGUMENT_LOG" ]]
grep -q 'different address space' "$TEST_ROOT/db-drift-output"

set +e
AZ_TEST_DB_REGION_DRIFT=1 run_provision > "$TEST_ROOT/db-region-drift-output" 2>&1
status=$?
set -e
[[ "$status" == 1 && ! -e "$AZ_TEST_ARGUMENT_LOG" ]]
grep -q 'wrong region' "$TEST_ROOT/db-region-drift-output"

set +e
OPERATOR_PUBLIC_IPV4=10.0.0.1 run_provision > "$TEST_ROOT/invalid-ip-output" 2>&1
status=$?
set -e
[[ "$status" == 1 && ! -e "$AZ_TEST_ARGUMENT_LOG" ]]
grep -q 'globally routable IPv4' "$TEST_ROOT/invalid-ip-output"

chmod 644 "$PASSWORD_FILE"
rm -f "$AZ_TEST_SECRET_FILE"
set +e
POSTGRES_ADMIN_PASSWORD_FILE="$PASSWORD_FILE" run_provision > "$TEST_ROOT/insecure-password-output" 2>&1
status=$?
set -e
[[ "$status" == 1 && ! -e "$AZ_TEST_ARGUMENT_LOG" ]]
grep -q 'owner-only (mode 0600)' "$TEST_ROOT/insecure-password-output"

printf 'Azure private platform template and preflight mocks passed.\n'
