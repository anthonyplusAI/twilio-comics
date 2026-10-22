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
command_after_args() {
  while (($#)); do
    if [[ "$1" == '--args' ]]; then
      (($# >= 3)) || return 1
      printf '%s\n' "$3"
      return
    fi
    shift
  done
  return 1
}
third_after_args() {
  while (($#)); do
    if [[ "$1" == '--args' ]]; then
      (($# >= 4)) || return 1
      printf '%s\n' "$4"
      return
    fi
    shift
  done
  return 1
}
require_explicit_job_command() {
  local name="$1"
  shift
  case "$name" in
    twilio-comics-db-bootstrap-v2)
      if [[ "$(argument --command "$@")" != pnpm ||
            "$(argument --args "$@")" != exec ||
            "$(command_after_args "$@")" != tsx ||
            "$(third_after_args "$@")" != scripts/bootstrap-azure-postgres-roles.ts ]]; then
        printf 'Bootstrap Job must store its reviewed executable and arguments\n' >&2
        exit 98
      fi ;;
    twilio-comics-migrate-v2)
      if [[ "$(argument --command "$@")" != pnpm ||
            "$(argument --args "$@")" != run ||
            "$(command_after_args "$@")" != db:migrate:safe ]]; then
        printf 'Migration Job must store its reviewed executable and arguments\n' >&2
        exit 98
      fi ;;
    *) return ;;
  esac
}

case "${1:-} ${2:-} ${3:-}" in
  'account show '*) printf '%s\n' 'b001fc6f-ea19-456a-8401-63971a1a1d98' ;;
  'containerapp env show')
    cat <<'JSON'
{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.App/managedEnvironments/cae-twilio-comics-v2","properties":{"vnetConfiguration":{"infrastructureSubnetId":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/virtualNetworks/vnet-twilio-comics-v2/subnets/aca-infrastructure"}}}
JSON
    ;;
  'postgres flexible-server show')
    subnet_vnet='vnet-twilio-comics-pg-cus'
    [[ "${AZ_MOCK_BAD_PG_SUBNET:-}" != 1 ]] || subnet_vnet='vnet-twilio-comics-v2'
    printf '{"location":"Central US","sku":{"name":"Standard_B1ms"},"network":{"publicNetworkAccess":"Disabled","delegatedSubnetResourceId":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/virtualNetworks/%s/subnets/postgresql","privateDnsZoneArmResourceId":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/privateDnsZones/twilio-comics.postgres.database.azure.com"},"fullyQualifiedDomainName":"twilio-comics-pg-1a1d98.postgres.database.azure.com"}\n' "$subnet_vnet" ;;
  'network vnet peering')
    source_vnet="$(argument --vnet-name "$@")"
    state='Connected'
    [[ "${AZ_MOCK_PEERING_DISCONNECTED:-}" != 1 ]] || state='Disconnected'
    case "$source_vnet" in
      vnet-twilio-comics-v2) remote_vnet='vnet-twilio-comics-pg-cus' ;;
      vnet-twilio-comics-pg-cus) remote_vnet='vnet-twilio-comics-v2' ;;
      *) exit 91 ;;
    esac
    printf '{"peeringState":"%s","allowVirtualNetworkAccess":true,"remoteVirtualNetwork":{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/virtualNetworks/%s"}}\n' "$state" "$remote_vnet" ;;
  'network private-dns link')
    link="$(argument --name "$@")"
    case "$link" in
      twilio-comics-v2-link) target_vnet='vnet-twilio-comics-v2' ;;
      twilio-comics-pg-cus-link) target_vnet='vnet-twilio-comics-pg-cus' ;;
      *) exit 91 ;;
    esac
    printf '{"registrationEnabled":false,"virtualNetwork":{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.Network/virtualNetworks/%s"}}\n' "$target_vnet" ;;
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
      twilio-comics-db-bootstrap-v2)
        if [[ "${AZ_MOCK_EXISTING_JOBS:-}" == 1 ]]; then
          printf '%s\n' '{"properties":{"environmentId":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.App/managedEnvironments/cae-twilio-comics-v2","configuration":{"triggerType":"Manual","secrets":[]},"template":{"containers":[{"command":[""],"args":[""],"env":[{"name":"AZURE_CLIENT_ID","value":"11111111-1111-1111-1111-111111111111"}]}]}}}'
        else
          exit 1
        fi ;;
      twilio-comics-migrate-v2)
        if [[ "${AZ_MOCK_EXISTING_JOBS:-}" == 1 ]]; then
          printf '%s\n' '{"properties":{"environmentId":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.App/managedEnvironments/cae-twilio-comics-v2","configuration":{"triggerType":"Manual","secrets":[{"name":"migration-database-url","keyVaultUrl":"https://kv-twilio-comics-1a1d98.vault.azure.net/secrets/postgres-comics-migration-url","identity":"/identity/id-twilio-comics-pg-migrate"}]},"template":{"containers":[{"command":[""],"args":[""],"env":[{"name":"DATABASE_URL","secretRef":"migration-database-url"}]}]}}}'
        else
          exit 1
        fi ;;
      *) printf '%s\n' '{"properties":{"environmentId":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.App/managedEnvironments/cae-twilio-comics-v2","configuration":{"secrets":[]},"template":{"containers":[{"env":[]}]}}}' ;;
    esac ;;
  'containerapp job create'|'containerapp job update')
    require_explicit_job_command "$(argument --name "$@")" "$@" ;;
  'role assignment list') printf '%s\n' '[]' ;;
  'role assignment create')
    if [[ "$*" == *'--query id'* ]]; then
      printf '%s\n' '/subscriptions/test/providers/Microsoft.Authorization/roleAssignments/bootstrap-assignment'
    fi ;;
  'containerapp job start')
    # Azure's --image start override produced an execution without the Job's
    # AZURE_CLIENT_ID env even though the stored template included it.
    if [[ " $* " == *' --image '* ]]; then
      printf 'Job start image override discarded the bootstrap environment\n' >&2
      exit 97
    fi
    printf '%s\n' '{"name":"twilio-comics-db-bootstrap-v2-abc"}' ;;
  'containerapp job execution')
    if [[ "${AZ_MOCK_FAIL_EXECUTION:-}" == 1 ]]; then
      printf '%s\n' '{"properties":{"status":"Failed"}}'
    elif [[ -n "${AZ_MOCK_RUNNING_POLLS:-}" ]]; then
      count=0
      if [[ -f "$AZ_MOCK_EXECUTION_COUNT_FILE" ]]; then
        count="$(<"$AZ_MOCK_EXECUTION_COUNT_FILE")"
      fi
      count=$((count + 1))
      printf '%s\n' "$count" > "$AZ_MOCK_EXECUTION_COUNT_FILE"
      if (( count < AZ_MOCK_RUNNING_POLLS )); then
        printf '%s\n' '{"properties":{"status":"Running"}}'
      else
        printf '{"properties":{"status":"Succeeded","template":{"containers":[{"image":"%s"}]}}}\n' "$BOOTSTRAP_IMAGE"
      fi
    else
      printf '{"properties":{"status":"Succeeded","template":{"containers":[{"image":"%s"}]}}}\n' "$BOOTSTRAP_IMAGE"
    fi ;;
  *) : ;;
esac
AZ_MOCK
chmod 700 "$test_root/bin/az"
cat > "$test_root/bin/sleep" <<'SLEEP_MOCK'
#!/usr/bin/env bash
exit 0
SLEEP_MOCK
chmod 700 "$test_root/bin/sleep"

export PATH="$test_root/bin:$PATH"
export AZ_MOCK_LOG="$test_root/az.log"
export AZ_MOCK_EXECUTION_COUNT_FILE="$test_root/execution-count"
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
grep -Fq 'containerapp job create --name twilio-comics-db-bootstrap-v2' "$AZ_MOCK_LOG"
grep -Fq -- '--replica-timeout 1200' "$AZ_MOCK_LOG"
grep -Fq 'containerapp job create --name twilio-comics-migrate-v2' "$AZ_MOCK_LOG"
if grep -Eq 'DATABASE_URL=postgresql:|postgres-bootstrap-password|id-twilio-comics-web|id-twilio-comics-worker' "$AZ_MOCK_LOG"; then
  printf 'Bootstrap mock saw a credential or V1 identity in Azure CLI arguments\n' >&2
  exit 1
fi

: > "$AZ_MOCK_LOG"
AZ_MOCK_EXISTING_JOBS=1 bash "$project_root/scripts/provision-postgres-roles.sh" \
  > "$test_root/existing-jobs.out" 2>&1
grep -Fq 'PostgreSQL role URLs are in Key Vault' "$test_root/existing-jobs.out"
grep -Fq 'containerapp job update --name twilio-comics-db-bootstrap-v2' "$AZ_MOCK_LOG"
grep -Fq -- '--replica-timeout 1200' "$AZ_MOCK_LOG"
grep -Fq 'containerapp job update --name twilio-comics-migrate-v2' "$AZ_MOCK_LOG"
if grep -Eq 'containerapp job create --name (twilio-comics-db-bootstrap-v2|twilio-comics-migrate-v2)' "$AZ_MOCK_LOG"; then
  printf 'Existing role Jobs should be repaired by update, not recreated\n' >&2
  exit 1
fi

: > "$AZ_MOCK_LOG"
if AZ_MOCK_BAD_PG_SUBNET=1 bash "$project_root/scripts/provision-postgres-roles.sh" \
    > "$test_root/bad-pg-network.out" 2>&1; then
  printf 'Bootstrap accepted PostgreSQL on the wrong private subnet\n' >&2
  exit 1
fi
grep -Fq 'reviewed private Central US B1ms server' "$test_root/bad-pg-network.out"
if grep -Fq 'role assignment create' "$AZ_MOCK_LOG"; then
  printf 'Bootstrap granted Azure roles after PostgreSQL subnet validation failed\n' >&2
  exit 1
fi

: > "$AZ_MOCK_LOG"
if AZ_MOCK_PEERING_DISCONNECTED=1 bash "$project_root/scripts/provision-postgres-roles.sh" \
    > "$test_root/disconnected-peering.out" 2>&1; then
  printf 'Bootstrap accepted a disconnected private network peering\n' >&2
  exit 1
fi
grep -Fq 'not connected to its intended VNet' "$test_root/disconnected-peering.out"
if grep -Fq 'role assignment create' "$AZ_MOCK_LOG"; then
  printf 'Bootstrap granted Azure roles after peering validation failed\n' >&2
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
rm -f "$AZ_MOCK_EXECUTION_COUNT_FILE"
AZ_MOCK_RUNNING_POLLS=125 ROLE_BOOTSTRAP_POLL_SECONDS=10 \
  bash "$project_root/scripts/provision-postgres-roles.sh" \
  > "$test_root/long-running.out" 2>&1
grep -Fq 'PostgreSQL role URLs are in Key Vault' "$test_root/long-running.out"
[[ "$(<"$AZ_MOCK_EXECUTION_COUNT_FILE")" == 125 ]] || {
  printf 'Host stopped polling before the 20-minute Job could complete\n' >&2
  exit 1
}

: > "$AZ_MOCK_LOG"
if BOOTSTRAP_IMAGE='mcr.microsoft.com/unreviewed:latest' \
  bash "$project_root/scripts/provision-postgres-roles.sh" > "$test_root/invalid.out" 2>&1; then
  printf 'Unreviewed bootstrap image unexpectedly passed validation\n' >&2
  exit 1
fi
[[ ! -s "$AZ_MOCK_LOG" ]] || { printf 'Azure was called before image validation\n' >&2; exit 1; }

printf 'Azure PostgreSQL role provisioning mock tests passed\n'
