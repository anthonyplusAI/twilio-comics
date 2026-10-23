#!/usr/bin/env bash
set -euo pipefail
set +x # Never trace credential-file operations.

# One-time SQL role bootstrap and workload wiring. The operator's Azure CLI
# seeds role URLs in Key Vault through owner-only files; the private Job reads
# those URLs and the administrator password with temporary, read-only access.
# No database credential is passed through a command argument or environment.

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "Install '$1' before running this script."; }

for command in az jq python3; do require "$command"; done
: "${SUBSCRIPTION_ID:?Set SUBSCRIPTION_ID to the approved Azure subscription ID}"
: "${BOOTSTRAP_IMAGE:?Set BOOTSTRAP_IMAGE to the reviewed, digest-pinned bootstrap image}"
: "${MIGRATION_IMAGE:?Set MIGRATION_IMAGE to the digest-pinned Drizzle migration image}"

EXPECTED_SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98'
[[ "$SUBSCRIPTION_ID" == "$EXPECTED_SUBSCRIPTION_ID" ]] \
  || die "This private database setup targets subscription $EXPECTED_SUBSCRIPTION_ID."
[[ "${PROVISION_POSTGRES_ROLES_CONFIRM:-}" == yes ]] \
  || die 'Set PROVISION_POSTGRES_ROLES_CONFIRM=yes after reviewing the role Job and workload changes.'

RESOURCE_GROUP='rg-twilio-comics'
ACA_ENVIRONMENT='cae-twilio-comics-v2'
WEB_APP='twilio-comics-v2'
GENERATION_JOB='twilio-comics-generation-v2'
RECOVERY_JOB='twilio-comics-recovery-v2'
MIGRATION_JOB='twilio-comics-migrate-v2'
BOOTSTRAP_JOB='twilio-comics-db-bootstrap-v2'
SERVER='twilio-comics-pg-1a1d98'
POSTGRES_FQDN="${SERVER}.postgres.database.azure.com"
ACA_VNET='vnet-twilio-comics-v2'
POSTGRES_VNET='vnet-twilio-comics-pg-cus'
ACA_VNET_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Network/virtualNetworks/$ACA_VNET"
POSTGRES_VNET_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Network/virtualNetworks/$POSTGRES_VNET"
POSTGRES_SUBNET_ID="$POSTGRES_VNET_ID/subnets/postgresql"
POSTGRES_DNS_ZONE='twilio-comics.postgres.database.azure.com'
POSTGRES_DNS_ZONE_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Network/privateDnsZones/$POSTGRES_DNS_ZONE"
VAULT='kv-twilio-comics-1a1d98'
RUNTIME_SECRET='postgres-comics-runtime-url'
MIGRATION_SECRET='postgres-comics-migration-url'
RUNTIME_APP_SECRET='runtime-database-url'
MIGRATION_APP_SECRET='migration-database-url'
WEB_IDENTITY='id-twilio-comics-v2-web'
WORKER_IDENTITY='id-twilio-comics-v2-worker'
PULL_IDENTITY='id-twilio-comics-v2-acr-pull'
MIGRATION_IDENTITY='id-twilio-comics-pg-migrate'
BOOTSTRAP_IDENTITY='id-twilio-comics-pg-bootstrap'
ACR_NAME='twiliocomicsacr1a1d98'
ACR_SERVER="${ACR_NAME}.azurecr.io"
TAGS=(created_by=github-actions managed_by=twilio-comics-ci)

[[ "$BOOTSTRAP_IMAGE" =~ ^twiliocomicsacr1a1d98\.azurecr\.io/twilio-comics-bootstrap@sha256:[a-f0-9]{64}$ ]] \
  || die 'BOOTSTRAP_IMAGE must be a digest-pinned twilio-comics-bootstrap image in the approved ACR.'
[[ "$MIGRATION_IMAGE" =~ ^twiliocomicsacr1a1d98\.azurecr\.io/twilio-comics-migrate@sha256:[a-f0-9]{64}$ ]] \
  || die 'MIGRATION_IMAGE must be a digest-pinned twilio-comics-migrate image in the approved ACR.'

active_subscription="$(az account show --query id --output tsv)" \
  || die 'Sign in to Azure before provisioning PostgreSQL roles.'
[[ "$active_subscription" == "$SUBSCRIPTION_ID" ]] \
  || die "Active subscription '$active_subscription' is not '$SUBSCRIPTION_ID'."

environment_json="$(az containerapp env show --name "$ACA_ENVIRONMENT" \
  --resource-group "$RESOURCE_GROUP" --output json)" \
  || die 'The V2 private Container Apps environment is missing.'
EXPECTED_SUBNET="$ACA_VNET_ID/subnets/aca-infrastructure"
if ! jq --exit-status --arg subnet "$EXPECTED_SUBNET" \
  '(.properties.vnetConfiguration.infrastructureSubnetId // "" | ascii_downcase) == ($subnet | ascii_downcase)' \
  >/dev/null <<< "$environment_json"; then
  die 'The V2 Container Apps environment is not attached to the expected private VNet subnet.'
fi
ENVIRONMENT_ID="$(jq -r '.id' <<< "$environment_json")"

server_json="$(az postgres flexible-server show --name "$SERVER" \
  --resource-group "$RESOURCE_GROUP" --output json)" \
  || die 'The private PostgreSQL Flexible Server is missing.'
if ! jq --exit-status --arg fqdn "$POSTGRES_FQDN" \
    --arg subnet "$POSTGRES_SUBNET_ID" --arg zone "$POSTGRES_DNS_ZONE_ID" '
  .network.publicNetworkAccess == "Disabled"
  and .fullyQualifiedDomainName == $fqdn
  and .sku.name == "Standard_B1ms"
  and ((.location // "" | ascii_downcase | gsub(" "; "")) == "centralus")
  and ((.network.delegatedSubnetResourceId // "" | ascii_downcase) == ($subnet | ascii_downcase))
  and ((.network.privateDnsZoneArmResourceId // "" | ascii_downcase) == ($zone | ascii_downcase))
  ' \
  >/dev/null <<< "$server_json"; then
  die 'PostgreSQL must be the reviewed private Central US B1ms server with the expected FQDN and DNS zone.'
fi

require_peering() {
  local source_vnet="$1" peering_name="$2" remote_vnet_id="$3" peering_json
  peering_json="$(az network vnet peering show --resource-group "$RESOURCE_GROUP" \
    --vnet-name "$source_vnet" --name "$peering_name" --output json)" \
    || die "Private network peering '$peering_name' is missing."
  if ! jq --exit-status --arg remote "$remote_vnet_id" '
    .peeringState == "Connected"
    and .allowVirtualNetworkAccess == true
    and ((.remoteVirtualNetwork.id // "" | ascii_downcase) == ($remote | ascii_downcase))
  ' >/dev/null <<< "$peering_json"; then
    die "Private network peering '$peering_name' is not connected to its intended VNet."
  fi
}
require_peering "$ACA_VNET" aca-to-postgres-centralus "$POSTGRES_VNET_ID"
require_peering "$POSTGRES_VNET" postgres-to-aca-eastus2 "$ACA_VNET_ID"

require_dns_link() {
  local link_name="$1" vnet_id="$2" link_json
  link_json="$(az network private-dns link vnet show --resource-group "$RESOURCE_GROUP" \
    --zone-name "$POSTGRES_DNS_ZONE" --name "$link_name" --output json)" \
    || die "PostgreSQL private DNS link '$link_name' is missing."
  if ! jq --exit-status --arg vnet "$vnet_id" '
    .registrationEnabled == false
    and ((.virtualNetwork.id // "" | ascii_downcase) == ($vnet | ascii_downcase))
  ' >/dev/null <<< "$link_json"; then
    die "PostgreSQL private DNS link '$link_name' targets the wrong VNet."
  fi
}
require_dns_link twilio-comics-v2-link "$ACA_VNET_ID"
require_dns_link twilio-comics-pg-cus-link "$POSTGRES_VNET_ID"

vault_json="$(az keyvault show --name "$VAULT" --resource-group "$RESOURCE_GROUP" --output json)" \
  || die 'The private Key Vault is missing.'
if ! jq --exit-status '.properties.enableRbacAuthorization == true and .properties.enablePurgeProtection == true and .properties.networkAcls.defaultAction == "Deny"' \
  >/dev/null <<< "$vault_json"; then
  die 'Key Vault must use RBAC, purge protection, and a deny-by-default firewall.'
fi
VAULT_ID="$(jq -r '.id' <<< "$vault_json")"
ACR_ID="$(az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query id --output tsv)" \
  || die 'The approved ACR is missing.'

for image in "$BOOTSTRAP_IMAGE" "$MIGRATION_IMAGE"; do
  artifact="${image#"${ACR_SERVER}"/}"
  digest="$(az acr manifest show-metadata --registry "$ACR_NAME" --name "$artifact" \
    --query digest --output tsv --only-show-errors)" \
    || die "The image manifest for $artifact is not available in ACR."
  [[ "$digest" == "${image##*@}" ]] \
    || die "The image digest for $artifact did not match the requested digest."
done

identity_json() {
  az identity show --name "$1" --resource-group "$RESOURCE_GROUP" --output json
}
ensure_identity() {
  local name="$1"
  if ! identity_json "$name" >/dev/null 2>&1; then
    az identity create --name "$name" --resource-group "$RESOURCE_GROUP" \
      --location eastus2 --tags "${TAGS[@]}" --only-show-errors --output none
  fi
}

# The runtime and ACR pull identities belong to the V2 placeholders. Do not
# give the V1 placeholder identities access to either database credential.
WEB_IDENTITY_JSON="$(identity_json "$WEB_IDENTITY")" \
  || die "Create V2 workload identity '$WEB_IDENTITY' first."
WORKER_IDENTITY_JSON="$(identity_json "$WORKER_IDENTITY")" \
  || die "Create V2 workload identity '$WORKER_IDENTITY' first."
PULL_IDENTITY_JSON="$(identity_json "$PULL_IDENTITY")" \
  || die "Create V2 pull identity '$PULL_IDENTITY' first."
WEB_ID="$(jq -r '.id' <<< "$WEB_IDENTITY_JSON")"
WEB_PRINCIPAL="$(jq -r '.principalId' <<< "$WEB_IDENTITY_JSON")"
WORKER_ID="$(jq -r '.id' <<< "$WORKER_IDENTITY_JSON")"
WORKER_PRINCIPAL="$(jq -r '.principalId' <<< "$WORKER_IDENTITY_JSON")"
PULL_ID="$(jq -r '.id' <<< "$PULL_IDENTITY_JSON")"
PULL_PRINCIPAL="$(jq -r '.principalId' <<< "$PULL_IDENTITY_JSON")"

for workload in "$WEB_APP" "$GENERATION_JOB" "$RECOVERY_JOB"; do
  if [[ "$workload" == "$WEB_APP" ]]; then
    workload_json="$(az containerapp show --name "$workload" --resource-group "$RESOURCE_GROUP" --output json)" \
      || die "Create V2 Container App '$workload' before wiring database secrets."
  else
    workload_json="$(az containerapp job show --name "$workload" --resource-group "$RESOURCE_GROUP" --output json)" \
      || die "Create V2 Container Apps Job '$workload' before wiring database secrets."
  fi
  if ! jq --exit-status --arg env "$ENVIRONMENT_ID" \
    '(.properties.environmentId // "" | ascii_downcase) == ($env | ascii_downcase)' \
    >/dev/null <<< "$workload_json"; then
    die "Workload '$workload' does not belong to the private V2 environment."
  fi
  if ! jq --exit-status --arg binding "$RUNTIME_APP_SECRET" '
    [.properties.template.containers[0].env[]? | select(.name == "DATABASE_URL")]
    | length == 0 or (length == 1 and .[0].secretRef == $binding)
  ' >/dev/null <<< "$workload_json"; then
    die "Workload '$workload' has a conflicting DATABASE_URL binding; review it before provisioning."
  fi
done

ensure_identity "$BOOTSTRAP_IDENTITY"
ensure_identity "$MIGRATION_IDENTITY"
BOOT_IDENTITY_JSON="$(identity_json "$BOOTSTRAP_IDENTITY")"
MIG_IDENTITY_JSON="$(identity_json "$MIGRATION_IDENTITY")"
BOOT_ID="$(jq -r '.id' <<< "$BOOT_IDENTITY_JSON")"
BOOT_PRINCIPAL="$(jq -r '.principalId' <<< "$BOOT_IDENTITY_JSON")"
BOOT_CLIENT_ID="$(jq -r '.clientId' <<< "$BOOT_IDENTITY_JSON")"
MIG_ID="$(jq -r '.id' <<< "$MIG_IDENTITY_JSON")"
MIG_PRINCIPAL="$(jq -r '.principalId' <<< "$MIG_IDENTITY_JSON")"

# The V2 pull identity alone receives AcrPull; neither SQL identity needs it.
ensure_role_assignment() {
  local principal="$1" scope="$2" role="$3" existing
  existing="$(az role assignment list --assignee-object-id "$principal" \
    --scope "$scope" --role "$role" --output json)" \
    || die "Cannot inspect $role for managed identity $principal."
  if ! jq --exit-status --arg scope "$scope" \
    '[.[] | select((.scope | ascii_downcase) == ($scope | ascii_downcase))] | length > 0' \
    >/dev/null <<< "$existing"; then
    az role assignment create --assignee-object-id "$principal" \
      --assignee-principal-type ServicePrincipal --scope "$scope" \
      --role "$role" --only-show-errors --output none
  fi
}
ensure_role_assignment "$PULL_PRINCIPAL" "$ACR_ID" AcrPull

# The bootstrap identity needs only secret-scoped read access. Refuse to seed
# credentials while a vault-wide write grant from an earlier run remains.
for broad_role in 'Key Vault Secrets Officer' 'Key Vault Administrator'; do
  broad_assignments="$(az role assignment list --assignee-object-id "$BOOT_PRINCIPAL" \
    --scope "$VAULT_ID" --role "$broad_role" --output json)" \
    || die 'Cannot inspect bootstrap identity Key Vault write grants.'
  if jq --exit-status --arg scope "$VAULT_ID" '
    any(.[]; (.scope | ascii_downcase) == ($scope | ascii_downcase))
  ' >/dev/null <<< "$broad_assignments"; then
    die "Bootstrap identity still has '$broad_role' on the vault; revoke it before retrying."
  fi
done

# The host CLI operator has Key Vault Secrets Officer. Keep the generated or
# downloaded credentials only in this owner-only directory until both secret
# values have been verified in Key Vault, then remove the files before the Job.
umask 077
ROLE_SECRET_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/twilio-comics-role-urls.XXXXXXXX")" \
  || die 'Could not create an owner-only temporary directory for PostgreSQL URLs.'
BOOTSTRAP_READ_ASSIGNMENT_IDS=()
cleanup_bootstrap_access() {
  local previous_status=$?
  trap - EXIT
  if [[ -n "${ROLE_SECRET_TEMP_DIR:-}" ]]; then
    if ! rm -rf -- "$ROLE_SECRET_TEMP_DIR"; then
      printf 'ERROR: Could not remove temporary PostgreSQL URL files.\n' >&2
      previous_status=1
    fi
  fi
  local assignment_id
  if ((${#BOOTSTRAP_READ_ASSIGNMENT_IDS[@]} > 0)); then
    for assignment_id in "${BOOTSTRAP_READ_ASSIGNMENT_IDS[@]}"; do
      if ! az role assignment delete --ids "$assignment_id" \
        --only-show-errors --output none; then
        printf 'ERROR: Could not revoke temporary Key Vault Secrets User from %s. Revoke assignment %s immediately.\n' \
          "$BOOTSTRAP_IDENTITY" "$assignment_id" >&2
        previous_status=1
      fi
    done
  fi
  exit "$previous_status"
}
trap cleanup_bootstrap_access EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

secret_metadata="$(az keyvault secret list --vault-name "$VAULT" \
  --output json --only-show-errors)" \
  || die 'Cannot inspect existing PostgreSQL URL secrets in Key Vault.'
if ! jq --exit-status 'type == "array"' >/dev/null <<< "$secret_metadata"; then
  die 'Key Vault did not return a secret metadata list.'
fi
secret_exists_in_metadata() {
  jq --exit-status --arg name "$1" '
    any(.[]; .name == $name or ((.id // "") | test("/secrets/" + $name + "(/|$)")))
  ' >/dev/null <<< "$secret_metadata"
}

validate_role_url_file() {
  python3 - "$1" "$POSTGRES_FQDN" "$2" <<'PY'
from pathlib import Path
import re
import sys
from urllib.parse import parse_qsl, unquote, urlsplit

role, host, filename = sys.argv[1:]
try:
    value = Path(filename).read_text(encoding="utf-8")
    if not value.startswith("postgresql://") or any(character.isspace() or ord(character) < 0x20 or ord(character) == 0x7f for character in value):
        raise ValueError("invalid URL characters")
    url = urlsplit(value)
    password = unquote(url.password or "")
    if (
        url.scheme != "postgresql"
        or url.hostname != host
        or url.port is not None
        or url.netloc.endswith(":")
        or url.netloc.count("@") != 1
        or url.username != role
        or url.path != "/twilio_comics"
        or url.fragment
        or parse_qsl(url.query, keep_blank_values=True, strict_parsing=True) != [("sslmode", "verify-full")]
        or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", password)
    ):
        raise ValueError("unexpected role, server, database, TLS mode, or password format")
except (OSError, UnicodeError, ValueError):
    print(f"ERROR: Existing {role} Key Vault URL is invalid; review it before retrying.", file=sys.stderr)
    sys.exit(1)
PY
}

create_role_url_file() {
  python3 - "$1" "$POSTGRES_FQDN" "$2" <<'PY'
from pathlib import Path
from urllib.parse import quote, urlunsplit
import base64
import os
import secrets
import sys

role, host, filename = sys.argv[1:]
password = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=").decode("ascii")
netloc = f"{role}:{quote(password, safe='')}@{host}"
value = urlunsplit(("postgresql", netloc, "/twilio_comics", "sslmode=verify-full", ""))
path = Path(filename)
path.write_text(value, encoding="utf-8")
os.chmod(path, 0o600)
PY
}

load_existing_role_url() {
  local secret_name="$1" role="$2" file="$ROLE_SECRET_TEMP_DIR/$1"
  if secret_exists_in_metadata "$secret_name"; then
    az keyvault secret download --vault-name "$VAULT" --name "$secret_name" \
      --file "$file" --overwrite --only-show-errors --output none \
      || die "Cannot read existing Key Vault secret '$secret_name'."
    chmod 600 "$file"
    validate_role_url_file "$role" "$file" \
      || die "Existing Key Vault URL '$secret_name' is invalid; no role password was rotated."
    return 0
  fi
  return 1
}

migration_url_exists=false
runtime_url_exists=false
if load_existing_role_url "$MIGRATION_SECRET" comics_migrator; then migration_url_exists=true; fi
if load_existing_role_url "$RUNTIME_SECRET" comics_runtime; then runtime_url_exists=true; fi

seed_missing_role_url() {
  local secret_name="$1" role="$2" file="$ROLE_SECRET_TEMP_DIR/$1"
  # A second metadata read catches another operator's completed seed between
  # our initial inventory and this write. Reuse that value rather than rotate.
  secret_metadata="$(az keyvault secret list --vault-name "$VAULT" \
    --output json --only-show-errors)" \
    || die 'Cannot recheck PostgreSQL URL secrets before writing.'
  jq --exit-status 'type == "array"' >/dev/null <<< "$secret_metadata" \
    || die 'Key Vault did not return a secret metadata list before writing.'
  if load_existing_role_url "$secret_name" "$role"; then
    return 0
  fi
  create_role_url_file "$role" "$file" \
    || die "Could not generate '$secret_name' in an owner-only file."
  validate_role_url_file "$role" "$file" \
    || die "Generated '$secret_name' failed URL validation."
  local expires_at
  expires_at="$(python3 - <<'PY'
from datetime import datetime, timedelta, timezone

print((datetime.now(timezone.utc) + timedelta(days=365)).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
)" || die "Could not calculate '$secret_name' Key Vault expiration."
  az keyvault secret set --vault-name "$VAULT" --name "$secret_name" \
    --file "$file" --encoding utf-8 --content-type 'application/x-postgresql-url' \
    --expires "$expires_at" \
    --only-show-errors --output none \
    || die "Could not store '$secret_name' in Key Vault."
}
if [[ "$migration_url_exists" == false ]]; then
  seed_missing_role_url "$MIGRATION_SECRET" comics_migrator
fi
if [[ "$runtime_url_exists" == false ]]; then
  seed_missing_role_url "$RUNTIME_SECRET" comics_runtime
fi

# Fetch and validate both stored values before starting the private SQL Job.
# A partial seed is safe to retry: an existing URL is preserved, never rotated.
for role_spec in "$MIGRATION_SECRET:comics_migrator" "$RUNTIME_SECRET:comics_runtime"; do
  secret_name="${role_spec%%:*}"
  role="${role_spec##*:}"
  verified_file="$ROLE_SECRET_TEMP_DIR/verified-$secret_name"
  az keyvault secret download --vault-name "$VAULT" --name "$secret_name" \
    --file "$verified_file" --overwrite --only-show-errors --output none \
    || die "Cannot verify stored Key Vault secret '$secret_name'."
  chmod 600 "$verified_file"
  validate_role_url_file "$role" "$verified_file" \
    || die "Stored Key Vault URL '$secret_name' failed verification."
  cmp -s "$ROLE_SECRET_TEMP_DIR/$secret_name" "$verified_file" \
    || die "Stored Key Vault URL '$secret_name' changed during bootstrap preparation."
done
rm -rf -- "$ROLE_SECRET_TEMP_DIR" \
  || die 'Could not remove temporary PostgreSQL URL files before Job start.'
ROLE_SECRET_TEMP_DIR=''

# The bootstrap identity reads only its administrator password and the two
# preseeded URL secrets. Every temporary grant is revoked on exit.
grant_temporary_bootstrap_reader() {
  local scope="$VAULT_ID/secrets/$1" assignments assignment_id
  assignments="$(az role assignment list --assignee-object-id "$BOOT_PRINCIPAL" \
    --scope "$scope" --role 'Key Vault Secrets User' --output json)" \
    || die 'Cannot inspect bootstrap identity secret read grants.'
  assignment_id="$(jq -r --arg scope "$scope" '
    [.[] | select((.scope | ascii_downcase) == ($scope | ascii_downcase)) | .id][0] // empty
  ' <<< "$assignments")"
  if [[ -z "$assignment_id" ]]; then
    assignment_id="$(az role assignment create --assignee-object-id "$BOOT_PRINCIPAL" \
      --assignee-principal-type ServicePrincipal --scope "$scope" \
      --role 'Key Vault Secrets User' --query id --output tsv --only-show-errors)" \
      || die "Cannot grant temporary Key Vault read access for '$1'."
  fi
  [[ -n "$assignment_id" ]] || die "Temporary read assignment for '$1' was not returned."
  BOOTSTRAP_READ_ASSIGNMENT_IDS+=("$assignment_id")
}
grant_temporary_bootstrap_reader postgres-bootstrap-password
grant_temporary_bootstrap_reader "$MIGRATION_SECRET"
grant_temporary_bootstrap_reader "$RUNTIME_SECRET"

# Always store an executable startup command. Azure CLI turns empty quoted
# values into literal [""] arrays, and its --args parser rejects leading -ec.
bootstrap_job_json="$(az containerapp job show --name "$BOOTSTRAP_JOB" \
  --resource-group "$RESOURCE_GROUP" --output json 2>/dev/null || true)"
if [[ -z "$bootstrap_job_json" ]]; then
  az containerapp job create --name "$BOOTSTRAP_JOB" \
    --resource-group "$RESOURCE_GROUP" --environment "$ACA_ENVIRONMENT" \
    --trigger-type Manual --image "$BOOTSTRAP_IMAGE" \
    --command pnpm --args exec tsx scripts/bootstrap-azure-postgres-roles.ts \
    --mi-user-assigned "$BOOT_ID" "$PULL_ID" \
    --registry-server "$ACR_SERVER" --registry-identity "$PULL_ID" \
    --cpu 0.5 --memory 1.0Gi --replica-timeout 1200 --replica-retry-limit 0 \
    --parallelism 1 --replica-completion-count 1 \
    --env-vars "AZURE_CLIENT_ID=$BOOT_CLIENT_ID" \
    --tags "${TAGS[@]}" purpose=postgres-role-bootstrap \
    --only-show-errors --output none
else
  if ! jq --exit-status --arg env "$ENVIRONMENT_ID" '
    .properties.configuration.triggerType == "Manual"
    and (.properties.environmentId | ascii_downcase) == ($env | ascii_downcase)
    and (.properties.template.containers | length) == 1
    and ([.properties.configuration.secrets[]?] | length) == 0
    and ([.properties.template.containers[0].env[]? | select(.name != "AZURE_CLIENT_ID")] | length) == 0
  ' >/dev/null <<< "$bootstrap_job_json"; then
    die "Existing bootstrap Job '$BOOTSTRAP_JOB' has unexpected configuration."
  fi
  az containerapp job identity assign --name "$BOOTSTRAP_JOB" \
    --resource-group "$RESOURCE_GROUP" --user-assigned "$BOOT_ID" "$PULL_ID" \
    --only-show-errors --output none
  az containerapp job registry set --name "$BOOTSTRAP_JOB" \
    --resource-group "$RESOURCE_GROUP" --server "$ACR_SERVER" \
    --identity "$PULL_ID" --only-show-errors --output none
  az containerapp job update --name "$BOOTSTRAP_JOB" \
    --resource-group "$RESOURCE_GROUP" --image "$BOOTSTRAP_IMAGE" \
    --command pnpm --args exec tsx scripts/bootstrap-azure-postgres-roles.ts \
    --replica-timeout 1200 --replica-retry-limit 0 \
    --parallelism 1 --replica-completion-count 1 \
    --set-env-vars "AZURE_CLIENT_ID=$BOOT_CLIENT_ID" \
    --only-show-errors --output none
fi

start_json="$(az containerapp job start --name "$BOOTSTRAP_JOB" \
  --resource-group "$RESOURCE_GROUP" \
  --output json --only-show-errors)" \
  || die 'Could not start the private PostgreSQL role bootstrap Job.'
execution_name="$(jq -r '.name // empty' <<< "$start_json")"
[[ "$execution_name" =~ ^[a-z0-9][a-z0-9-]*$ ]] \
  || die 'The role bootstrap Job did not return an execution name.'
printf 'Started private PostgreSQL role bootstrap execution %s.\n' "$execution_name"

poll_interval="${ROLE_BOOTSTRAP_POLL_SECONDS:-10}"
# The default 25-minute poll window exceeds the 20-minute replica timeout.
max_polls="${ROLE_BOOTSTRAP_MAX_POLLS:-150}"
[[ "$poll_interval" =~ ^[0-9]+$ && "$max_polls" =~ ^[1-9][0-9]*$ ]] \
  || die 'Invalid role bootstrap polling settings.'
(( poll_interval <= 60 && max_polls <= 180 && poll_interval * max_polls <= 1800 )) \
  || die 'Role bootstrap polling settings exceed their safety limits.'
last_status=''
completed=false
for ((attempt = 1; attempt <= max_polls; attempt++)); do
  if execution_json="$(az containerapp job execution show --name "$BOOTSTRAP_JOB" \
      --resource-group "$RESOURCE_GROUP" --job-execution-name "$execution_name" \
      --output json --only-show-errors 2>/dev/null)"; then
    status="$(jq -r '.properties.status // empty' <<< "$execution_json")"
  else
    status='pending'
  fi
  if [[ "$status" != "$last_status" ]] || (( attempt % 6 == 0 )); then
    printf 'Role bootstrap execution %s: %s\n' "$execution_name" "$status"
    last_status="$status"
  fi
  case "$status" in
    Succeeded)
      if ! jq --exit-status --arg image "$BOOTSTRAP_IMAGE" \
        '[.properties.template.containers[]?.image] | index($image) != null' \
        >/dev/null <<< "$execution_json"; then
        die 'Role bootstrap execution used an unexpected image digest.'
      fi
      completed=true
      break ;;
    Failed|Stopped|Degraded|Canceled|Cancelled)
      die "Role bootstrap execution $execution_name ended in $status. Inspect the Job logs in Azure." ;;
  esac
  sleep "$poll_interval"
done
[[ "$completed" == true ]] || die 'Role bootstrap execution did not succeed within the wait window.'

# These are URI references only. No connection URL or password passes through
# command arguments, the process environment, GitHub, or an ACA template.
runtime_uri="https://${VAULT}.vault.azure.net/secrets/${RUNTIME_SECRET}"
migration_uri="https://${VAULT}.vault.azure.net/secrets/${MIGRATION_SECRET}"

ensure_role_assignment "$WEB_PRINCIPAL" "$VAULT_ID/secrets/$RUNTIME_SECRET" 'Key Vault Secrets User'
ensure_role_assignment "$WORKER_PRINCIPAL" "$VAULT_ID/secrets/$RUNTIME_SECRET" 'Key Vault Secrets User'
ensure_role_assignment "$MIG_PRINCIPAL" "$VAULT_ID/secrets/$MIGRATION_SECRET" 'Key Vault Secrets User'

check_existing_secret() {
  local json="$1" secret_name="$2" expected_uri="$3" identity_id="$4"
  jq --exit-status --arg name "$secret_name" --arg uri "$expected_uri" --arg id "$identity_id" '
    [.properties.configuration.secrets[]? | select(.name == $name)]
    | length == 0 or (length == 1 and .[0].keyVaultUrl == $uri
      and (.[0].identity | ascii_downcase) == ($id | ascii_downcase))
  ' >/dev/null <<< "$json"
}

wire_runtime() {
  local kind="$1" name="$2" identity_id="$3" current
  if [[ "$kind" == app ]]; then
    current="$(az containerapp show --name "$name" --resource-group "$RESOURCE_GROUP" --output json)"
  else
    current="$(az containerapp job show --name "$name" --resource-group "$RESOURCE_GROUP" --output json)"
  fi
  check_existing_secret "$current" "$RUNTIME_APP_SECRET" "$runtime_uri" "$identity_id" \
    || die "Workload '$name' has a conflicting '$RUNTIME_APP_SECRET' secret."
  if [[ "$kind" == app ]]; then
    az containerapp identity assign --name "$name" --resource-group "$RESOURCE_GROUP" \
      --user-assigned "$identity_id" --only-show-errors --output none
    az containerapp secret set --name "$name" --resource-group "$RESOURCE_GROUP" \
      --secrets "${RUNTIME_APP_SECRET}=keyvaultref:${runtime_uri},identityref:${identity_id}" \
      --only-show-errors --output none
    az containerapp update --name "$name" --resource-group "$RESOURCE_GROUP" \
      --set-env-vars "DATABASE_URL=secretref:${RUNTIME_APP_SECRET}" \
      --only-show-errors --output none
  else
    az containerapp job identity assign --name "$name" --resource-group "$RESOURCE_GROUP" \
      --user-assigned "$identity_id" --only-show-errors --output none
    az containerapp job secret set --name "$name" --resource-group "$RESOURCE_GROUP" \
      --secrets "${RUNTIME_APP_SECRET}=keyvaultref:${runtime_uri},identityref:${identity_id}" \
      --only-show-errors --output none
    az containerapp job update --name "$name" --resource-group "$RESOURCE_GROUP" \
      --set-env-vars "DATABASE_URL=secretref:${RUNTIME_APP_SECRET}" \
      --only-show-errors --output none
  fi
}

wire_runtime app "$WEB_APP" "$WEB_ID"
wire_runtime job "$GENERATION_JOB" "$WORKER_ID"
wire_runtime job "$RECOVERY_JOB" "$WORKER_ID"

migration_job_json="$(az containerapp job show --name "$MIGRATION_JOB" \
  --resource-group "$RESOURCE_GROUP" --output json 2>/dev/null || true)"
if [[ -z "$migration_job_json" ]]; then
  az containerapp job create --name "$MIGRATION_JOB" \
    --resource-group "$RESOURCE_GROUP" --environment "$ACA_ENVIRONMENT" \
    --trigger-type Manual --image "$MIGRATION_IMAGE" \
    --command pnpm --args run db:migrate:safe \
    --mi-user-assigned "$MIG_ID" "$PULL_ID" \
    --registry-server "$ACR_SERVER" --registry-identity "$PULL_ID" \
    --cpu 0.5 --memory 1.0Gi --replica-timeout 1800 --replica-retry-limit 0 \
    --parallelism 1 --replica-completion-count 1 \
    --secrets "${MIGRATION_APP_SECRET}=keyvaultref:${migration_uri},identityref:${MIG_ID}" \
    --env-vars "DATABASE_URL=secretref:${MIGRATION_APP_SECRET}" \
    --tags "${TAGS[@]}" purpose=postgres-migration \
    --only-show-errors --output none
else
  if ! jq --exit-status --arg env "$ENVIRONMENT_ID" --arg binding "$MIGRATION_APP_SECRET" '
    .properties.configuration.triggerType == "Manual"
    and (.properties.environmentId | ascii_downcase) == ($env | ascii_downcase)
    and (.properties.template.containers | length) == 1
    and ([.properties.template.containers[0].env[]? | select(.name == "DATABASE_URL")]
      | length == 0 or (length == 1 and .[0].secretRef == $binding))
  ' >/dev/null <<< "$migration_job_json"; then
    die "Existing migration Job '$MIGRATION_JOB' has unexpected configuration."
  fi
  check_existing_secret "$migration_job_json" "$MIGRATION_APP_SECRET" "$migration_uri" "$MIG_ID" \
    || die "Migration Job '$MIGRATION_JOB' has a conflicting database secret."
  az containerapp job identity assign --name "$MIGRATION_JOB" \
    --resource-group "$RESOURCE_GROUP" --user-assigned "$MIG_ID" "$PULL_ID" \
    --only-show-errors --output none
  az containerapp job registry set --name "$MIGRATION_JOB" \
    --resource-group "$RESOURCE_GROUP" --server "$ACR_SERVER" \
    --identity "$PULL_ID" --only-show-errors --output none
  az containerapp job secret set --name "$MIGRATION_JOB" \
    --resource-group "$RESOURCE_GROUP" \
    --secrets "${MIGRATION_APP_SECRET}=keyvaultref:${migration_uri},identityref:${MIG_ID}" \
    --only-show-errors --output none
  az containerapp job update --name "$MIGRATION_JOB" \
    --resource-group "$RESOURCE_GROUP" --image "$MIGRATION_IMAGE" \
    --command pnpm --args run db:migrate:safe \
    --replica-timeout 1800 --replica-retry-limit 0 \
    --parallelism 1 --replica-completion-count 1 \
    --set-env-vars "DATABASE_URL=secretref:${MIGRATION_APP_SECRET}" \
    --only-show-errors --output none
fi

printf 'PostgreSQL role URLs are in Key Vault and V2 workloads reference the least-privilege credentials. Bootstrap secret-read access is being revoked.\n'
