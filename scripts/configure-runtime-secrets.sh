#!/usr/bin/env bash
set -euo pipefail
set +x # Never trace paths to credential files or Azure secret operations.

# One-time, repeatable V2 runtime setup. Secret values move only through
# owner-only files and Key Vault data-plane calls. This script does not publish
# ingress, deploy images, enable channels, or change Twilio webhooks.

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "Install '$1' before running this script."; }

for command in az jq python3 node curl cmp; do require "$command"; done
: "${SUBSCRIPTION_ID:?Set SUBSCRIPTION_ID to the approved Azure subscription ID}"
EXPECTED_SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98'
[[ "$SUBSCRIPTION_ID" == "$EXPECTED_SUBSCRIPTION_ID" ]] \
  || die "This runtime setup targets subscription $EXPECTED_SUBSCRIPTION_ID."
[[ "${CONFIGURE_RUNTIME_CONFIRM:-}" == yes ]] \
  || die 'Set CONFIGURE_RUNTIME_CONFIRM=yes after reviewing the V2 runtime setup.'

RESOURCE_GROUP='rg-twilio-comics'
ACA_ENVIRONMENT='cae-twilio-comics-v2'
WEB_APP='twilio-comics-v2'
GENERATION_JOB='twilio-comics-generation-v2'
RECOVERY_JOB='twilio-comics-recovery-v2'
WEB_IDENTITY='id-twilio-comics-v2-web'
WORKER_IDENTITY='id-twilio-comics-v2-worker'
VAULT='kv-twilio-comics-1a1d98'
ACCOUNT_SID="${TWILIO_ACCOUNT_SID:-}"
[[ "$ACCOUNT_SID" =~ ^AC[[:xdigit:]]{32}$ ]] \
  || die 'Set TWILIO_ACCOUNT_SID to the approved account SID (AC followed by 32 hexadecimal characters).'
VERIFY_SERVICE_SID='VA9fae12b38cb0a91645f514842476e647'
PHONE_NUMBER='+18669012028'
REQUESTED_ADMIN_USERNAME="${ADMIN_USERNAME:-}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

active_subscription="$(az account show --query id --output tsv)" \
  || die 'Sign in to Azure before configuring V2 runtime secrets.'
[[ "$active_subscription" == "$SUBSCRIPTION_ID" ]] \
  || die "Active Azure subscription '$active_subscription' is not '$SUBSCRIPTION_ID'."

vault_json="$(az keyvault show --name "$VAULT" --resource-group "$RESOURCE_GROUP" --output json)" \
  || die "Key Vault '$VAULT' is missing. Provision the private platform first."
if ! jq --exit-status '
  .tags.managed_by == "twilio-comics-ci"
  and .properties.enableRbacAuthorization == true
  and .properties.enablePurgeProtection == true
  and .properties.networkAcls.defaultAction == "Deny"
  and .properties.publicNetworkAccess != "Disabled"
' >/dev/null <<< "$vault_json"; then
  die 'The expected Key Vault must be project-owned, RBAC-enabled, purge-protected, and deny by default with operator data-plane access.'
fi
VAULT_ID="$(jq -r '.id' <<< "$vault_json")"
[[ "$VAULT_ID" == "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.KeyVault/vaults/$VAULT" ]] \
  || die "Key Vault '$VAULT' has an unexpected resource ID."

# The private-platform provisioner allows one operator IP through the vault
# firewall. Keep that exact rule usable when the operator's IP changes.
if [[ -z "${OPERATOR_PUBLIC_IPV4:-}" ]]; then
  OPERATOR_PUBLIC_IPV4="$(curl -4fsS --max-time 10 https://api.ipify.org)" \
    || die 'Set OPERATOR_PUBLIC_IPV4 to the current public IPv4 address.'
fi
OPERATOR_PUBLIC_IPV4="$(python3 - "$OPERATOR_PUBLIC_IPV4" <<'PY'
import ipaddress
import sys

try:
    address = ipaddress.ip_address(sys.argv[1].strip())
    if address.version != 4 or not address.is_global:
        raise ValueError("expected a globally routable IPv4 address")
except ValueError as error:
    print(f"ERROR: Invalid OPERATOR_PUBLIC_IPV4: {error}", file=sys.stderr)
    sys.exit(1)
print(address)
PY
)" || die 'Correct OPERATOR_PUBLIC_IPV4 and retry.'
rules_json="$(az keyvault network-rule list --name "$VAULT" --resource-group "$RESOURCE_GROUP" --output json)" \
  || die 'Cannot inspect Key Vault firewall rules.'
if ! jq --exit-status --arg ip "$OPERATOR_PUBLIC_IPV4" '
  any(.ipRules[]?; .value == $ip or .value == ($ip + "/32"))
' >/dev/null <<< "$rules_json"; then
  az keyvault network-rule add --name "$VAULT" --resource-group "$RESOURCE_GROUP" \
    --ip-address "$OPERATOR_PUBLIC_IPV4" --only-show-errors --output none \
    || die 'Could not allow the current operator IPv4 through the Key Vault firewall.'
fi

umask 077
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/twilio-comics-runtime.XXXXXXXX")"
TEMP_OFFICER_ASSIGNMENT_ID=''
cleanup() {
  local previous_status=$?
  trap - EXIT
  rm -rf -- "$TEMP_DIR"
  if [[ -n "$TEMP_OFFICER_ASSIGNMENT_ID" ]]; then
    if ! az role assignment delete --ids "$TEMP_OFFICER_ASSIGNMENT_ID" \
        --only-show-errors --output none; then
      printf 'ERROR: Revoke temporary Key Vault Secrets Officer assignment %s immediately.\n' \
        "$TEMP_OFFICER_ASSIGNMENT_ID" >&2
      previous_status=1
    fi
  fi
  exit "$previous_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -n "${PROVISIONER_OBJECT_ID:-}" ]]; then
  PROVISIONER_PRINCIPAL_TYPE="${PROVISIONER_PRINCIPAL_TYPE:-ServicePrincipal}"
else
  PROVISIONER_OBJECT_ID="$(az ad signed-in-user show --query id --output tsv 2>/dev/null)" \
    || die 'Set PROVISIONER_OBJECT_ID for a service-principal Azure login.'
  PROVISIONER_PRINCIPAL_TYPE=User
fi
[[ "$PROVISIONER_PRINCIPAL_TYPE" == User || "$PROVISIONER_PRINCIPAL_TYPE" == ServicePrincipal ]] \
  || die 'PROVISIONER_PRINCIPAL_TYPE must be User or ServicePrincipal.'

# The initial private-platform run normally grants the provisioner vault data
# access. If that grant is absent, create one temporarily and revoke on exit.
if ! az keyvault secret list --vault-name "$VAULT" --output json \
    > "$TEMP_DIR/secret-inventory.json" 2>/dev/null; then
  officer_json="$(az role assignment list --assignee-object-id "$PROVISIONER_OBJECT_ID" \
    --scope "$VAULT_ID" --role 'Key Vault Secrets Officer' --output json)" \
    || die 'Cannot inspect operator Key Vault RBAC.'
  if ! jq --exit-status --arg scope "$VAULT_ID" '
    any(.[]; (.scope | ascii_downcase) == ($scope | ascii_downcase))
  ' >/dev/null <<< "$officer_json"; then
    TEMP_OFFICER_ASSIGNMENT_ID="$(az role assignment create \
      --assignee-object-id "$PROVISIONER_OBJECT_ID" \
      --assignee-principal-type "$PROVISIONER_PRINCIPAL_TYPE" \
      --scope "$VAULT_ID" --role 'Key Vault Secrets Officer' \
      --query id --output tsv --only-show-errors)" \
      || die 'Cannot grant temporary Key Vault access to the provisioner.'
    [[ -n "$TEMP_OFFICER_ASSIGNMENT_ID" ]] \
      || die 'Temporary Key Vault role assignment ID was not returned.'
  fi
  access_ready=false
  for ((attempt = 1; attempt <= 30; attempt++)); do
    if az keyvault secret list --vault-name "$VAULT" --output json \
        > "$TEMP_DIR/secret-inventory.json" 2>/dev/null; then
      access_ready=true
      break
    fi
    if ((attempt < 30)); then sleep "${RUNTIME_ROLE_POLL_SECONDS:-5}"; fi
  done
  [[ "$access_ready" == true ]] \
    || die 'Key Vault data-plane access did not become ready for the operator.'
fi

secret_known() {
  jq --exit-status --arg name "$1" 'any(.[]; .name == $name)' \
    >/dev/null "$TEMP_DIR/secret-inventory.json"
}
for name in auth-secret media-signing-secret admin-initial-password \
    admin-password-hash openai-api-key twilio-auth-token; do
  if secret_known "$name"; then
    jq --exit-status --arg name "$name" '
      [.[] | select(.name == $name)] | length == 1 and .[0].attributes.enabled != false
    ' >/dev/null "$TEMP_DIR/secret-inventory.json" \
      || die "Existing Key Vault secret '$name' is disabled or ambiguous."
  fi
done

normalize_input_file() {
  local kind="$1" source="$2" destination="$3"
  python3 - "$kind" "$source" "$destination" <<'PY'
import os
from pathlib import Path
import re
import stat
import sys

kind, source_name, destination_name = sys.argv[1:]
source = Path(source_name)
try:
    details = source.lstat()
    if not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() or details.st_mode & 0o077:
        raise ValueError("credential file must be an owner-only regular file (mode 0600)")
    value = source.read_text(encoding="utf-8")
    if value.endswith("\r\n"):
        value = value[:-2]
    elif value.endswith("\n"):
        value = value[:-1]
    if any(ord(character) < 0x21 or ord(character) == 0x7f for character in value):
        raise ValueError("credential must be a single line without whitespace or controls")
    if kind == "twilio" and not re.fullmatch(r"[0-9a-fA-F]{32}", value):
        raise ValueError("Twilio Auth Token must be 32 hexadecimal characters")
    if kind == "openai" and not 20 <= len(value) <= 4096:
        raise ValueError("OpenAI API key length is outside the accepted range")
    Path(destination_name).write_text(value, encoding="utf-8")
except (OSError, UnicodeError, ValueError) as error:
    print(f"ERROR: Invalid {kind} credential file: {error}", file=sys.stderr)
    sys.exit(1)
PY
}

if [[ -n "${OPENAI_API_KEY_FILE:-}" ]]; then
  normalize_input_file openai "$OPENAI_API_KEY_FILE" "$TEMP_DIR/openai-input"
fi
if [[ -n "${TWILIO_AUTH_TOKEN_FILE:-}" ]]; then
  normalize_input_file twilio "$TWILIO_AUTH_TOKEN_FILE" "$TEMP_DIR/twilio-input"
fi

openai_configured=false
twilio_configured=false
if secret_known openai-api-key || [[ -n "${OPENAI_API_KEY_FILE:-}" ]]; then
  openai_configured=true
fi
if secret_known twilio-auth-token || [[ -n "${TWILIO_AUTH_TOKEN_FILE:-}" ]]; then
  twilio_configured=true
fi

environment_json="$(az containerapp env show --name "$ACA_ENVIRONMENT" \
  --resource-group "$RESOURCE_GROUP" --output json)" \
  || die 'The private V2 Container Apps environment is missing.'
ENVIRONMENT_ID="$(jq -r '.id' <<< "$environment_json")"
EXPECTED_ENVIRONMENT_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/managedEnvironments/$ACA_ENVIRONMENT"
[[ "$ENVIRONMENT_ID" == "$EXPECTED_ENVIRONMENT_ID" ]] \
  || die 'The V2 Container Apps environment has an unexpected resource ID.'

WEB_IDENTITY_JSON="$(az identity show --name "$WEB_IDENTITY" --resource-group "$RESOURCE_GROUP" --output json)" \
  || die "V2 web identity '$WEB_IDENTITY' is missing."
WORKER_IDENTITY_JSON="$(az identity show --name "$WORKER_IDENTITY" --resource-group "$RESOURCE_GROUP" --output json)" \
  || die "V2 worker identity '$WORKER_IDENTITY' is missing."
WEB_ID="$(jq -r '.id' <<< "$WEB_IDENTITY_JSON")"
WEB_PRINCIPAL="$(jq -r '.principalId' <<< "$WEB_IDENTITY_JSON")"
WORKER_ID="$(jq -r '.id' <<< "$WORKER_IDENTITY_JSON")"
WORKER_PRINCIPAL="$(jq -r '.principalId' <<< "$WORKER_IDENTITY_JSON")"

workload_json() {
  if [[ "$1" == app ]]; then
    az containerapp show --name "$2" --resource-group "$RESOURCE_GROUP" --output json
  else
    az containerapp job show --name "$2" --resource-group "$RESOURCE_GROUP" --output json
  fi
}

validate_workload() {
  local kind="$1" name="$2" identity_id="$3" current="$4"
  if ! jq --exit-status --arg env "$ENVIRONMENT_ID" --arg id "$identity_id" \
      --arg dburi "https://${VAULT}.vault.azure.net/secrets/postgres-comics-runtime-url" '
    (.properties.environmentId | ascii_downcase) == ($env | ascii_downcase)
    and ([.identity.userAssignedIdentities | keys[]? | ascii_downcase]
      | index($id | ascii_downcase) != null)
    and ([.properties.template.containers[0].env[]? | select(.name == "DATABASE_URL")]
      | length == 1 and .[0].secretRef == "runtime-database-url")
    and ([.properties.configuration.secrets[]? | select(.name == "runtime-database-url")]
      | length == 1 and .[0].keyVaultUrl == $dburi
        and (.[0].identity | ascii_downcase) == ($id | ascii_downcase))
  ' >/dev/null <<< "$current"; then
    die "Workload '$name' is missing the private V2 identity, environment, or runtime DATABASE_URL reference. Run provision-postgres-roles.sh first."
  fi
  if [[ "$kind" == app ]] && ! jq --exit-status '
    .properties.configuration.ingress.external == false
    and .properties.template.scale.minReplicas == 0
  ' >/dev/null <<< "$current"; then
    die "Web app '$name' must remain internal with zero minimum replicas during prelaunch setup."
  fi
}

check_binding() {
  local current="$1" secret_name="$2" env_name="$3" identity_id="$4"
  local uri="https://${VAULT}.vault.azure.net/secrets/${secret_name}"
  if ! jq --exit-status --arg secret "$secret_name" --arg env "$env_name" \
      --arg uri "$uri" --arg id "$identity_id" '
    ([.properties.configuration.secrets[]? | select(.name == $secret)]
      | length == 0 or (length == 1 and .[0].keyVaultUrl == $uri
        and (.[0].identity | ascii_downcase) == ($id | ascii_downcase)))
    and ([.properties.template.containers[0].env[]? | select(.name == $env)]
      | length == 0 or (length == 1 and .[0].secretRef == $secret))
  ' >/dev/null <<< "$current"; then
    die "Workload has a conflicting '$env_name' or '$secret_name' binding. Review it before rerunning."
  fi
}

require_binding() {
  local current="$1" secret_name="$2" env_name="$3" identity_id="$4"
  local uri="https://${VAULT}.vault.azure.net/secrets/${secret_name}"
  if ! jq --exit-status --arg secret "$secret_name" --arg env "$env_name" \
      --arg uri "$uri" --arg id "$identity_id" '
    ([.properties.configuration.secrets[]? | select(.name == $secret)]
      | length == 1 and .[0].keyVaultUrl == $uri
        and (.[0].identity | ascii_downcase) == ($id | ascii_downcase))
    and ([.properties.template.containers[0].env[]? | select(.name == $env)]
      | length == 1 and .[0].secretRef == $secret)
  ' >/dev/null <<< "$current"; then
    die "Workload is missing its verified '$env_name' Key Vault binding."
  fi
}

require_env_value() {
  local current="$1" env_name="$2" value="$3"
  if ! jq --exit-status --arg env "$env_name" --arg value "$value" '
    [.properties.template.containers[0].env[]? | select(.name == $env)]
      | length == 1 and .[0].value == $value
  ' >/dev/null <<< "$current"; then
    die "Workload is missing its expected '$env_name' setting."
  fi
}

check_optional_absent() {
  local current="$1" secret_name="$2" env_name="$3"
  if ! jq --exit-status --arg secret "$secret_name" --arg env "$env_name" '
    ([.properties.configuration.secrets[]? | select(.name == $secret)] | length) == 0
    and ([.properties.template.containers[0].env[]? | select(.name == $env)] | length) == 0
  ' >/dev/null <<< "$current"; then
    die "Workload references '$env_name' but Key Vault has no '$secret_name' secret."
  fi
}

check_existing_value() {
  local current="$1" env_name="$2" value="$3"
  if ! jq --exit-status --arg env "$env_name" --arg value "$value" '
    [.properties.template.containers[0].env[]? | select(.name == $env)]
      | length == 0 or (length == 1 and (.[0].value == "" or .[0].value == $value))
  ' >/dev/null <<< "$current"; then
    die "Workload has a different '$env_name' setting. Review it before rerunning runtime setup."
  fi
}

WEB_JSON="$(workload_json app "$WEB_APP")" || die "V2 web app '$WEB_APP' is missing."
GENERATION_JSON="$(workload_json job "$GENERATION_JOB")" || die "V2 generation Job '$GENERATION_JOB' is missing."
RECOVERY_JSON="$(workload_json job "$RECOVERY_JOB")" || die "V2 recovery Job '$RECOVERY_JOB' is missing."
validate_workload app "$WEB_APP" "$WEB_ID" "$WEB_JSON"
validate_workload job "$GENERATION_JOB" "$WORKER_ID" "$GENERATION_JSON"
validate_workload job "$RECOVERY_JOB" "$WORKER_ID" "$RECOVERY_JSON"

existing_admin_username="$(jq -r '
  [.properties.template.containers[0].env[]? | select(.name == "ADMIN_USERNAME")]
    | if length == 0 then "" elif length == 1 then (.[0].value // "__invalid__") else "__invalid__" end
' <<< "$WEB_JSON")"
[[ "$existing_admin_username" != __invalid__ ]] \
  || die 'Existing ADMIN_USERNAME binding is invalid.'
if [[ -n "$REQUESTED_ADMIN_USERNAME" && -n "$existing_admin_username" && \
    "$REQUESTED_ADMIN_USERNAME" != "$existing_admin_username" ]]; then
  die 'Existing ADMIN_USERNAME differs from the requested value; this setup does not change admin identity silently.'
fi
ADMIN_USERNAME="${REQUESTED_ADMIN_USERNAME:-${existing_admin_username:-comics-admin}}"
[[ "$ADMIN_USERNAME" =~ ^[A-Za-z0-9._-]{3,64}$ ]] \
  || die 'ADMIN_USERNAME must contain 3 to 64 letters, numbers, dots, underscores, or hyphens.'
check_existing_value "$WEB_JSON" ADMIN_USERNAME "$ADMIN_USERNAME"
check_existing_value "$WEB_JSON" TWILIO_VERIFY_SERVICE_SID "$VERIFY_SERVICE_SID"
check_existing_value "$WEB_JSON" APP_OPERATOR_NAME 'Anthony Dellavecchia'
check_existing_value "$WEB_JSON" APP_CONTACT_EMAIL 'adellavecchia@twilio.com'
for current in "$WEB_JSON" "$GENERATION_JSON" "$RECOVERY_JSON"; do
  check_existing_value "$current" TWILIO_ACCOUNT_SID "$ACCOUNT_SID"
  check_existing_value "$current" TWILIO_PHONE_NUMBER "$PHONE_NUMBER"
  check_existing_value "$current" DAILY_GENERATION_JOB_LIMIT 25
done

for kind in web generation recovery; do
  case "$kind" in
    web) current="$WEB_JSON"; identity_id="$WEB_ID" ;;
    *) current="$GENERATION_JSON"; identity_id="$WORKER_ID"
      [[ "$kind" != recovery ]] || current="$RECOVERY_JSON" ;;
  esac
  check_binding "$current" media-signing-secret MEDIA_SIGNING_SECRET "$identity_id"
  if [[ "$kind" == web ]]; then
    check_binding "$current" auth-secret AUTH_SECRET "$identity_id"
    check_binding "$current" admin-password-hash ADMIN_PASSWORD_HASH "$identity_id"
  fi
  if [[ "$openai_configured" == true ]]; then
    check_binding "$current" openai-api-key OPENAI_API_KEY "$identity_id"
  else
    check_optional_absent "$current" openai-api-key OPENAI_API_KEY
  fi
  if [[ "$twilio_configured" == true ]]; then
    check_binding "$current" twilio-auth-token TWILIO_AUTH_TOKEN "$identity_id"
  else
    check_optional_absent "$current" twilio-auth-token TWILIO_AUTH_TOKEN
  fi
done

download_secret() {
  az keyvault secret download --vault-name "$VAULT" --name "$1" \
    --file "$2" --overwrite --only-show-errors --output none \
    || die "Cannot read existing Key Vault secret '$1'."
}
# Azure policy requires a UTC expiry on new secrets. Reruns leave existing
# versions and expiry dates untouched; rotate credentials before they expire.
SECRET_EXPIRATION_UTC="$(python3 - <<'PY'
from datetime import datetime, timedelta, timezone

print((datetime.now(timezone.utc) + timedelta(days=365)).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
)"
set_secret() {
  az keyvault secret set --vault-name "$VAULT" --name "$1" --file "$2" \
    --encoding utf-8 --content-type "$3" --expires "$SECRET_EXPIRATION_UTC" \
    --only-show-errors --output none \
    || die "Cannot store Key Vault secret '$1'."
}
validate_stored_secret() {
  python3 - "$1" "$2" <<'PY'
from pathlib import Path
import re
import sys

kind, path = sys.argv[1:]
try:
    value = Path(path).read_text(encoding="utf-8")
    if any(ord(character) < 0x21 or ord(character) == 0x7f for character in value):
        raise ValueError("contains whitespace or controls")
    if kind in {"auth", "media"} and not 32 <= len(value) <= 4096:
        raise ValueError("must contain at least 32 characters")
    if kind == "admin" and not 16 <= len(value) <= 1024:
        raise ValueError("admin password must contain at least 16 characters")
    if kind == "openai" and not 20 <= len(value) <= 4096:
        raise ValueError("OpenAI API key length is outside the accepted range")
    if kind == "twilio" and not re.fullmatch(r"[0-9a-fA-F]{32}", value):
        raise ValueError("Twilio Auth Token must be 32 hexadecimal characters")
except (OSError, UnicodeError, ValueError) as error:
    print(f"ERROR: Existing {kind} Key Vault secret is invalid: {error}", file=sys.stderr)
    sys.exit(1)
PY
}

ensure_generated_secret() {
  local name="$1" kind="$2" file="$TEMP_DIR/$1"
  if secret_known "$name"; then
    download_secret "$name" "$file"
  else
    python3 - "$file" <<'PY'
from pathlib import Path
import secrets
import sys

Path(sys.argv[1]).write_text(secrets.token_hex(48), encoding="utf-8")
PY
    set_secret "$name" "$file" "Twilio Comics $kind secret"
  fi
  validate_stored_secret "$kind" "$file"
}

ensure_generated_secret auth-secret auth
ensure_generated_secret media-signing-secret media

admin_password_file="$TEMP_DIR/admin-initial-password"
admin_hash_file="$TEMP_DIR/admin-password-hash"
if secret_known admin-password-hash && ! secret_known admin-initial-password; then
  die 'Admin password hash exists without its initial password. Review credentials before rerunning; this script will not rotate them.'
fi
if secret_known admin-initial-password; then
  download_secret admin-initial-password "$admin_password_file"
else
  python3 - "$admin_password_file" <<'PY'
from pathlib import Path
import secrets
import string
import sys

alphabet = string.ascii_letters + string.digits
while True:
    password = "".join(secrets.choice(alphabet) for _ in range(48))
    if any(c.islower() for c in password) and any(c.isupper() for c in password) and any(c.isdigit() for c in password):
        break
Path(sys.argv[1]).write_text(password, encoding="utf-8")
PY
  set_secret admin-initial-password "$admin_password_file" \
    'Twilio Comics initial admin password (operator retrieval only)'
fi
validate_stored_secret admin "$admin_password_file"
if secret_known admin-password-hash; then
  download_secret admin-password-hash "$admin_hash_file"
else
  (cd "$PROJECT_ROOT" && node --import tsx scripts/hash-admin-password.ts \
    < "$admin_password_file" > "$admin_hash_file") \
    || die 'Could not derive the admin scrypt hash.'
  python3 - "$admin_hash_file" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
path.write_text(path.read_text(encoding="utf-8").rstrip("\r\n"), encoding="utf-8")
PY
  set_secret admin-password-hash "$admin_hash_file" \
    'Twilio Comics admin scrypt hash (runtime reference)'
fi
python3 - "$admin_password_file" "$admin_hash_file" <<'PY'
from pathlib import Path
import base64
import hashlib
import hmac
import sys

try:
    password = Path(sys.argv[1]).read_text(encoding="utf-8")
    parts = Path(sys.argv[2]).read_text(encoding="utf-8").split("$")
    if len(parts) != 6 or parts[:4] != ["scrypt", "32768", "8", "1"]:
        raise ValueError("scrypt parameters do not match the app")
    salt = base64.urlsafe_b64decode(parts[4] + "==")
    expected = base64.urlsafe_b64decode(parts[5] + "==")
    if len(salt) != 32 or len(expected) != 64:
        raise ValueError("scrypt hash has invalid length")
    actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=32768, r=8, p=1,
                            maxmem=64 * 1024 * 1024, dklen=64)
    if not hmac.compare_digest(actual, expected):
        raise ValueError("admin password and hash do not match")
except (OSError, UnicodeError, ValueError) as error:
    print(f"ERROR: Invalid stored admin credential pair: {error}", file=sys.stderr)
    sys.exit(1)
PY

ensure_optional_secret() {
  local name="$1" kind="$2" input_file="$3" stored_file="$TEMP_DIR/$1"
  if secret_known "$name"; then
    download_secret "$name" "$stored_file"
    validate_stored_secret "$kind" "$stored_file"
    if [[ -n "$input_file" ]] && ! cmp --silent "$input_file" "$stored_file"; then
      die "Provided $kind credential differs from existing Key Vault secret '$name'; no value was rotated."
    fi
  elif [[ -n "$input_file" ]]; then
    set_secret "$name" "$input_file" "Twilio Comics $kind credential"
  fi
}
ensure_optional_secret openai-api-key openai "${OPENAI_API_KEY_FILE:+$TEMP_DIR/openai-input}"
ensure_optional_secret twilio-auth-token twilio "${TWILIO_AUTH_TOKEN_FILE:+$TEMP_DIR/twilio-input}"

ensure_role_assignment() {
  local principal="$1" principal_type="$2" scope="$3" role="$4" current
  current="$(az role assignment list --assignee-object-id "$principal" \
    --scope "$scope" --role "$role" --output json)" \
    || die "Cannot inspect $role at $scope."
  if ! jq --exit-status --arg scope "$scope" '
    any(.[]; (.scope | ascii_downcase) == ($scope | ascii_downcase))
  ' >/dev/null <<< "$current"; then
    az role assignment create --assignee-object-id "$principal" \
      --assignee-principal-type "$principal_type" --scope "$scope" \
      --role "$role" --only-show-errors --output none \
      || die "Cannot grant $role at $scope."
  fi
}

grant_secret_reader() {
  ensure_role_assignment "$1" ServicePrincipal "$VAULT_ID/secrets/$2" 'Key Vault Secrets User'
}
grant_secret_reader "$WEB_PRINCIPAL" auth-secret
grant_secret_reader "$WEB_PRINCIPAL" media-signing-secret
grant_secret_reader "$WORKER_PRINCIPAL" media-signing-secret
grant_secret_reader "$WEB_PRINCIPAL" admin-password-hash
ensure_role_assignment "$PROVISIONER_OBJECT_ID" "$PROVISIONER_PRINCIPAL_TYPE" \
  "$VAULT_ID/secrets/admin-initial-password" 'Key Vault Secrets User'
if [[ "$openai_configured" == true ]]; then
  grant_secret_reader "$WEB_PRINCIPAL" openai-api-key
  grant_secret_reader "$WORKER_PRINCIPAL" openai-api-key
fi
if [[ "$twilio_configured" == true ]]; then
  grant_secret_reader "$WEB_PRINCIPAL" twilio-auth-token
  grant_secret_reader "$WORKER_PRINCIPAL" twilio-auth-token
fi

wire_secret() {
  local kind="$1" name="$2" secret_name="$3" identity_id="$4"
  local uri="https://${VAULT}.vault.azure.net/secrets/${secret_name}"
  if [[ "$kind" == app ]]; then
    az containerapp secret set --name "$name" --resource-group "$RESOURCE_GROUP" \
      --secrets "${secret_name}=keyvaultref:${uri},identityref:${identity_id}" \
      --only-show-errors --output none
  else
    az containerapp job secret set --name "$name" --resource-group "$RESOURCE_GROUP" \
      --secrets "${secret_name}=keyvaultref:${uri},identityref:${identity_id}" \
      --only-show-errors --output none
  fi
}

wire_secret app "$WEB_APP" auth-secret "$WEB_ID"
wire_secret app "$WEB_APP" media-signing-secret "$WEB_ID"
wire_secret app "$WEB_APP" admin-password-hash "$WEB_ID"
for job in "$GENERATION_JOB" "$RECOVERY_JOB"; do
  wire_secret job "$job" media-signing-secret "$WORKER_ID"
done
if [[ "$openai_configured" == true ]]; then
  wire_secret app "$WEB_APP" openai-api-key "$WEB_ID"
  for job in "$GENERATION_JOB" "$RECOVERY_JOB"; do
    wire_secret job "$job" openai-api-key "$WORKER_ID"
  done
fi
if [[ "$twilio_configured" == true ]]; then
  wire_secret app "$WEB_APP" twilio-auth-token "$WEB_ID"
  for job in "$GENERATION_JOB" "$RECOVERY_JOB"; do
    wire_secret job "$job" twilio-auth-token "$WORKER_ID"
  done
fi

WEB_ENV=(
  "AUTH_SECRET=secretref:auth-secret"
  "MEDIA_SIGNING_SECRET=secretref:media-signing-secret"
  "ADMIN_PASSWORD_HASH=secretref:admin-password-hash"
  "ADMIN_USERNAME=$ADMIN_USERNAME"
  "TWILIO_ACCOUNT_SID=$ACCOUNT_SID"
  "TWILIO_PHONE_NUMBER=$PHONE_NUMBER"
  "TWILIO_VERIFY_SERVICE_SID=$VERIFY_SERVICE_SID"
  'TWILIO_ENABLED_CHANNELS='
  'DAILY_GENERATION_JOB_LIMIT=25'
  'APP_OPERATOR_NAME=Anthony Dellavecchia'
  'APP_CONTACT_EMAIL=adellavecchia@twilio.com'
)
JOB_ENV=(
  'MEDIA_SIGNING_SECRET=secretref:media-signing-secret'
  "TWILIO_ACCOUNT_SID=$ACCOUNT_SID"
  "TWILIO_PHONE_NUMBER=$PHONE_NUMBER"
  'DAILY_GENERATION_JOB_LIMIT=25'
)
if [[ "$openai_configured" == true ]]; then
  WEB_ENV+=('OPENAI_API_KEY=secretref:openai-api-key')
  JOB_ENV+=('OPENAI_API_KEY=secretref:openai-api-key')
fi
if [[ "$twilio_configured" == true ]]; then
  WEB_ENV+=('TWILIO_AUTH_TOKEN=secretref:twilio-auth-token')
  JOB_ENV+=('TWILIO_AUTH_TOKEN=secretref:twilio-auth-token')
fi

az containerapp update --name "$WEB_APP" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "${WEB_ENV[@]}" --only-show-errors --output none
for job in "$GENERATION_JOB" "$RECOVERY_JOB"; do
  az containerapp job update --name "$job" --resource-group "$RESOURCE_GROUP" \
    --set-env-vars "${JOB_ENV[@]}" --only-show-errors --output none
done

# Re-read every workload to catch an incomplete CLI update. In particular,
# the SQL role provisioner's DATABASE_URL reference must still be intact.
WEB_JSON="$(workload_json app "$WEB_APP")"
GENERATION_JSON="$(workload_json job "$GENERATION_JOB")"
RECOVERY_JSON="$(workload_json job "$RECOVERY_JOB")"
validate_workload app "$WEB_APP" "$WEB_ID" "$WEB_JSON"
validate_workload job "$GENERATION_JOB" "$WORKER_ID" "$GENERATION_JSON"
validate_workload job "$RECOVERY_JOB" "$WORKER_ID" "$RECOVERY_JSON"
for kind in web generation recovery; do
  case "$kind" in
    web) current="$WEB_JSON"; identity_id="$WEB_ID" ;;
    *) current="$GENERATION_JSON"; identity_id="$WORKER_ID"
      [[ "$kind" != recovery ]] || current="$RECOVERY_JSON" ;;
  esac
  require_binding "$current" media-signing-secret MEDIA_SIGNING_SECRET "$identity_id"
  [[ "$kind" != web ]] || {
    require_binding "$current" auth-secret AUTH_SECRET "$identity_id"
    require_binding "$current" admin-password-hash ADMIN_PASSWORD_HASH "$identity_id"
    require_env_value "$current" ADMIN_USERNAME "$ADMIN_USERNAME"
    require_env_value "$current" TWILIO_VERIFY_SERVICE_SID "$VERIFY_SERVICE_SID"
    require_env_value "$current" TWILIO_ENABLED_CHANNELS ''
    require_env_value "$current" APP_OPERATOR_NAME 'Anthony Dellavecchia'
    require_env_value "$current" APP_CONTACT_EMAIL 'adellavecchia@twilio.com'
  }
  if [[ "$openai_configured" == true ]]; then
    require_binding "$current" openai-api-key OPENAI_API_KEY "$identity_id"
  fi
  if [[ "$twilio_configured" == true ]]; then
    require_binding "$current" twilio-auth-token TWILIO_AUTH_TOKEN "$identity_id"
  fi
  require_env_value "$current" TWILIO_ACCOUNT_SID "$ACCOUNT_SID"
  require_env_value "$current" TWILIO_PHONE_NUMBER "$PHONE_NUMBER"
  require_env_value "$current" DAILY_GENERATION_JOB_LIMIT 25
done

printf 'V2 runtime secrets and settings are configured. Admin username: %s. OpenAI key: %s. Twilio Auth Token: %s. Channels remain closed; web app remains internal.\n' \
  "$ADMIN_USERNAME" "$openai_configured" "$twilio_configured"
printf 'The generated admin password is stored only in Key Vault secret admin-initial-password. Retrieve it through an owner-only file when the operator is ready to sign in.\n'
