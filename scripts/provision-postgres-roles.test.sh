#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/twilio-comics-roles-test.XXXXXXXX")"
trap 'rm -rf "$test_root"' EXIT
mkdir -p "$test_root/bin"

cat > "$test_root/bin/az" <<'AZ_MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$AZ_MOCK_LOG"
argument() {
  local flag="$1"
  shift
  while (($#)); do
    if [[ "$1" == "$flag" ]]; then printf '%s\n' "$2"; return; fi
    shift
  done
  return 1
}

case "${1:-} ${2:-} ${3:-}" in
  'account show '*) printf '%s\n' 'b001fc6f-ea19-456a-8401-63971a1a1d98' ;;
  'containerapp env show')
    cat <<'JSON'
{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.App/managedEnvironments/cae-twilio-comics-v2","properties":{"vnetConfiguration":{"infrastructureSubnetId":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/virtualNetworks/vnet-twilio-comics-v2/subnets/aca-infrastructure"}}}
JSON
    ;;
  'postgres flexible-server show')
    printf '%s\n' '{"network":{"publicNetworkAccess":"Disabled"},"fullyQualifiedDomainName":"twilio-comics-pg-1a1d98.postgres.database.azure.com"}' ;;
  'keyvault show '*)
    printf '%s\n' '{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.KeyVault/vaults/kv-twilio-comics-1a1d98","properties":{"enableRbacAuthorization":true,"enablePurgeProtection":true,"networkAcls":{"defaultAction":"Deny"}}}' ;;
  'acr show '*)
    printf '%s\n' '/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.ContainerRegistry/registries/twiliocomicsacr1a1d98' ;;
  'acr manifest show-metadata')
    artifact="$(argument --name "$@")"
    printf '%s\n' "${artifact##*@}" ;;
  'identity show '*)
    name="$(argument --name "$@")"
    printf '{"id":"/identity/%s","principalId":"principal-%s","clientId":"11111111-1111-1111-1111-111111111111"}\n' "$name" "$name" ;;
  'containerapp show '*)
    printf '%s\n' '{"properties":{"environmentId":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.App/managedEnvironments/cae-twilio-comics-v2","configuration":{"secrets":[]},"template":{"containers":[{"env":[]}]}}}' ;;
  'containerapp job show')
    name="$(argument --name "$@")"
    case "$name" in
      twilio-comics-db-bootstrap-v2|twilio-comics-migrate-v2) exit 1 ;;
      *) printf '%s\n' '{"properties":{"environmentId":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.App/managedEnvironments/cae-twilio-comics-v2","configuration":{"secrets":[]},"template":{"containers":[{"env":[]}]}}}' ;;
    esac ;;
  'role assignment list') printf '%s\n' '[]' ;;
  'role assignment create')
    if [[ "$*" == *'--query id'* ]]; then
      printf '%s\n' '/subscriptions/test/providers/Microsoft.Authorization/roleAssignments/bootstrap-assignment'
    fi ;;
  'containerapp job start')
    printf '%s\n' '{"name":"twilio-comics-db-bootstrap-v2-abc"}' ;;
  'containerapp job execution')
    if [[ "${AZ_MOCK_FAIL_EXECUTION:-}" == 1 ]]; then
      printf '%s\n' '{"properties":{"status":"Failed"}}'
    else
      printf '{"properties":{"status":"Succeeded","template":{"containers":[{"image":"%s"}]}}}\n' "$BOOTSTRAP_IMAGE"
    fi ;;
  *) : ;;
esac
AZ_MOCK
chmod 700 "$test_root/bin/az"

export PATH="$test_root/bin:$PATH"
export AZ_MOCK_LOG="$test_root/az.log"
export SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98'
BOOTSTRAP_IMAGE="twiliocomicsacr1a1d98.azurecr.io/twilio-comics-bootstrap@sha256:$(printf 'a%.0s' {1..64})"
MIGRATION_IMAGE="twiliocomicsacr1a1d98.azurecr.io/twilio-comics-migrate@sha256:$(printf 'b%.0s' {1..64})"
export BOOTSTRAP_IMAGE MIGRATION_IMAGE
export PROVISION_POSTGRES_ROLES_CONFIRM=yes
export ROLE_BOOTSTRAP_POLL_SECONDS=0

bash "$project_root/scripts/provision-postgres-roles.sh" > "$test_root/success.out" 2>&1
grep -Fq 'PostgreSQL role URLs are in Key Vault' "$test_root/success.out"
grep -Fq 'role assignment delete --ids /subscriptions/test/providers/Microsoft.Authorization/roleAssignments/bootstrap-assignment' "$AZ_MOCK_LOG"
grep -Fq 'containerapp secret set --name twilio-comics-v2' "$AZ_MOCK_LOG"
grep -Fq 'containerapp job secret set --name twilio-comics-generation-v2' "$AZ_MOCK_LOG"
grep -Fq 'containerapp job secret set --name twilio-comics-recovery-v2' "$AZ_MOCK_LOG"
grep -Fq 'postgres-comics-runtime-url' "$AZ_MOCK_LOG"
grep -Fq 'postgres-comics-migration-url' "$AZ_MOCK_LOG"
grep -Fq 'id-twilio-comics-v2-web' "$AZ_MOCK_LOG"
grep -Fq 'id-twilio-comics-v2-worker' "$AZ_MOCK_LOG"
grep -Fq 'id-twilio-comics-v2-acr-pull' "$AZ_MOCK_LOG"
if grep -Eq 'DATABASE_URL=postgresql:|postgres-bootstrap-password|id-twilio-comics-web|id-twilio-comics-worker' "$AZ_MOCK_LOG"; then
  printf 'Bootstrap mock saw a credential or V1 identity in Azure CLI arguments\n' >&2
  exit 1
fi

: > "$AZ_MOCK_LOG"
export AZ_MOCK_FAIL_EXECUTION=1
if bash "$project_root/scripts/provision-postgres-roles.sh" > "$test_root/failure.out" 2>&1; then
  printf 'Failed role bootstrap execution unexpectedly succeeded\n' >&2
  exit 1
fi
grep -Fq 'role assignment delete --ids /subscriptions/test/providers/Microsoft.Authorization/roleAssignments/bootstrap-assignment' "$AZ_MOCK_LOG"
if grep -Fq 'containerapp secret set' "$AZ_MOCK_LOG"; then
  printf 'Runtime workloads were wired after the bootstrap Job failed\n' >&2
  exit 1
fi
unset AZ_MOCK_FAIL_EXECUTION

: > "$AZ_MOCK_LOG"
if BOOTSTRAP_IMAGE='mcr.microsoft.com/unreviewed:latest' \
  bash "$project_root/scripts/provision-postgres-roles.sh" > "$test_root/invalid.out" 2>&1; then
  printf 'Unreviewed bootstrap image unexpectedly passed validation\n' >&2
  exit 1
fi
[[ ! -s "$AZ_MOCK_LOG" ]] || { printf 'Azure was called before image validation\n' >&2; exit 1; }

printf 'Azure PostgreSQL role provisioning mock tests passed\n'
