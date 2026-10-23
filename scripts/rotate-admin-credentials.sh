#!/usr/bin/env bash
set -euo pipefail
set +x # Never trace credential files or Key Vault operations.

# Legacy bootstrap credential update. After the first dashboard change, the
# active admin login lives in PostgreSQL, and changing these values has no
# effect on it. The password is entered through a terminal, never CLI args.

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "Install '$1' before running this script."; }
for command in az jq python3 node curl cmp; do require "$command"; done

EXPECTED_SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98'
RESOURCE_GROUP='rg-twilio-comics'
WEB_APP='twilio-comics-v2'
WEB_IDENTITY="/subscriptions/$EXPECTED_SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-twilio-comics-v2-web"
VAULT='kv-twilio-comics-1a1d98'
VAULT_ID="/subscriptions/$EXPECTED_SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.KeyVault/vaults/$VAULT"
HASH_URI="https://${VAULT}.vault.azure.net/secrets/admin-password-hash"
APP_ID="/subscriptions/$EXPECTED_SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/containerApps/$WEB_APP"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[[ "${SUBSCRIPTION_ID:-}" == "$EXPECTED_SUBSCRIPTION_ID" ]] \
  || die "Set SUBSCRIPTION_ID=$EXPECTED_SUBSCRIPTION_ID for this production rotation."
[[ "${ROTATE_ADMIN_BOOTSTRAP_ONLY:-}" == yes ]] \
  || die 'Change the active admin login at /admin/settings. This legacy script updates only bootstrap credentials; set ROTATE_ADMIN_BOOTSTRAP_ONLY=yes only for an authorized bootstrap maintenance task.'
[[ "${ROTATE_ADMIN_CONFIRM:-}" == yes ]] \
  || die 'Set ROTATE_ADMIN_CONFIRM=yes after reviewing docs/ADMIN_CREDENTIALS.md.'
[[ -t 0 && -t 1 ]] \
  || die 'Run this command in a local terminal with a TTY; credentials cannot be entered through chat or a pipe.'

active_subscription="$(az account show --query id --output tsv --only-show-errors 2>/dev/null)" \
  || die 'Sign in with az login before rotating the administrator credentials.'
[[ "$active_subscription" == "$EXPECTED_SUBSCRIPTION_ID" ]] \
  || die "Active Azure subscription '$active_subscription' is not the approved production subscription."

vault_json="$(az keyvault show --name "$VAULT" --resource-group "$RESOURCE_GROUP" \
  --subscription "$EXPECTED_SUBSCRIPTION_ID" --output json --only-show-errors)" \
  || die 'Cannot inspect the production Key Vault.'
jq -e --arg id "$VAULT_ID" '
  .id == $id and .tags.managed_by == "twilio-comics-ci"
  and .properties.enableRbacAuthorization == true
  and .properties.enablePurgeProtection == true
  and .properties.networkAcls.defaultAction == "Deny"
  and .properties.publicNetworkAccess != "Disabled"
' >/dev/null <<< "$vault_json" \
  || die 'The Key Vault identity or safety settings differ from this app. No credentials changed.'

validate_app() {
  local app_json="$1" expected_username="$2"
  jq -e --arg app_id "$APP_ID" --arg identity "$WEB_IDENTITY" \
    --arg hash_uri "$HASH_URI" --arg username "$expected_username" '
    .id == $app_id
    and (.identity.userAssignedIdentities | has($identity))
    and .properties.configuration.activeRevisionsMode == "Single"
    and ([.properties.configuration.secrets[]? | select(.name == "admin-password-hash")]
      | length == 1 and .[0].keyVaultUrl == $hash_uri
        and (.[0].identity | ascii_downcase) == ($identity | ascii_downcase))
    and ([.properties.template.containers[0].env[]? | select(.name == "ADMIN_USERNAME")]
      | length == 1 and .[0].value == $username)
    and ([.properties.template.containers[0].env[]? | select(.name == "ADMIN_PASSWORD_HASH")]
      | length == 1 and .[0].secretRef == "admin-password-hash")
  ' >/dev/null <<< "$app_json"
}

app_json="$(az containerapp show --name "$WEB_APP" --resource-group "$RESOURCE_GROUP" \
  --subscription "$EXPECTED_SUBSCRIPTION_ID" --output json --only-show-errors)" \
  || die 'Cannot inspect the production Container App.'
old_username="$(jq -r '
  [.properties.template.containers[0].env[]? | select(.name == "ADMIN_USERNAME")]
  | if length == 1 then (.[0].value // "") else "" end
' <<< "$app_json")"
[[ -n "$old_username" ]] || die 'The existing admin username is missing or ambiguous.'
validate_app "$app_json" "$old_username" \
  || die 'The Container App admin bindings differ from this rotation procedure. No credentials changed.'
old_non_admin_env="$(jq -cS '
  [.properties.template.containers[0].env[]? | select(.name != "ADMIN_USERNAME")]
    | sort_by(.name)
' <<< "$app_json")"
fqdn="$(jq -r '.properties.configuration.ingress.fqdn // ""' <<< "$app_json")"
[[ "$fqdn" == twilio-comics-v2.*.azurecontainerapps.io ]] \
  || die 'The Container App has an unexpected public hostname. No credentials changed.'

umask 077
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/twilio-comics-admin-rotation.XXXXXXXX")"
ip_rule_added=0
credentials_started=0
username_update_attempted=0
committed=0
new_username=''
expiration_utc="$(python3 - <<'PY'
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc) + timedelta(days=365)).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
)"

write_secret() {
  local name="$1" source="$2"
  az keyvault secret set --vault-name "$VAULT" --name "$name" \
    --file "$source" --encoding utf-8 --expires "$expiration_utc" \
    --subscription "$EXPECTED_SUBSCRIPTION_ID" --only-show-errors --output none \
    > "$TEMP_DIR/azure.stdout" 2> "$TEMP_DIR/azure.stderr"
}

rollback_credentials() {
  local rollback_failed=0
  printf 'Rotation stopped after a credential write. Restoring the previous administrator credentials.\n' >&2
  if [[ "$username_update_attempted" == 1 ]]; then
    az containerapp update --name "$WEB_APP" --resource-group "$RESOURCE_GROUP" \
      --subscription "$EXPECTED_SUBSCRIPTION_ID" \
      --set-env-vars "ADMIN_USERNAME=$old_username" \
      --only-show-errors --output none \
      > "$TEMP_DIR/azure.stdout" 2> "$TEMP_DIR/azure.stderr" \
      || rollback_failed=1
  fi
  write_secret admin-password-hash "$TEMP_DIR/old-hash" || rollback_failed=1
  write_secret admin-initial-password "$TEMP_DIR/old-password" || rollback_failed=1
  if [[ "$rollback_failed" == 1 ]]; then
    printf 'URGENT: Automatic rollback was incomplete. Keep the old and new passwords in your password manager and restore both Key Vault secrets and ADMIN_USERNAME manually using docs/ADMIN_CREDENTIALS.md.\n' >&2
  else
    printf 'Previous administrator credentials restored in Key Vault. Container Apps may take up to 30 minutes to refresh its versionless secret reference.\n' >&2
  fi
  return "$rollback_failed"
}

cleanup() {
  local result=$?
  trap - EXIT
  if [[ "$result" != 0 && "$credentials_started" == 1 && "$committed" == 0 ]]; then
    rollback_credentials || result=1
  fi
  if [[ "$ip_rule_added" == 1 ]]; then
    if ! az keyvault network-rule remove --name "$VAULT" \
      --resource-group "$RESOURCE_GROUP" --ip-address "$operator_ipv4" \
      --subscription "$EXPECTED_SUBSCRIPTION_ID" --only-show-errors --output none \
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

operator_ipv4="${OPERATOR_PUBLIC_IPV4:-}"
if [[ -z "$operator_ipv4" ]]; then
  operator_ipv4="$(curl -4fsS --max-time 10 https://api.ipify.org)" \
    || die 'Could not determine the operator public IPv4; set OPERATOR_PUBLIC_IPV4 explicitly.'
fi
operator_ipv4="$(python3 - "$operator_ipv4" <<'PY'
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
)" || die 'Correct OPERATOR_PUBLIC_IPV4 before retrying.'

rules_json="$(az keyvault network-rule list --name "$VAULT" \
  --resource-group "$RESOURCE_GROUP" --subscription "$EXPECTED_SUBSCRIPTION_ID" \
  --only-show-errors --output json)" \
  || die 'Cannot inspect Key Vault firewall rules.'
jq -e '.ipRules | type == "array"' >/dev/null <<< "$rules_json" \
  || die 'Key Vault firewall rule inventory is invalid.'
if ! jq -e --arg ip "$operator_ipv4" '
  any(.ipRules[]; .value == $ip or .value == ($ip + "/32"))
' >/dev/null <<< "$rules_json"; then
  az keyvault network-rule add --name "$VAULT" --resource-group "$RESOURCE_GROUP" \
    --ip-address "$operator_ipv4" --subscription "$EXPECTED_SUBSCRIPTION_ID" \
    --only-show-errors --output none \
    > "$TEMP_DIR/azure.stdout" 2> "$TEMP_DIR/azure.stderr" \
    || die 'Could not allow the operator IPv4 through the vault firewall. No credentials changed.'
  ip_rule_added=1
fi

download_secret() {
  local name="$1" destination="$2" attempt
  for attempt in 1 2 3 4 5 6; do
    if az keyvault secret download --vault-name "$VAULT" --name "$name" \
      --file "$destination" --overwrite --subscription "$EXPECTED_SUBSCRIPTION_ID" \
      --only-show-errors --output none \
      > "$TEMP_DIR/azure.stdout" 2> "$TEMP_DIR/azure.stderr"; then
      chmod 600 "$destination"
      return 0
    fi
    if [[ "$attempt" != 6 ]]; then sleep "${ADMIN_ROTATION_ACCESS_RETRY_SECONDS:-5}"; fi
  done
  return 1
}

denied_client_ipv4() {
  python3 - "$TEMP_DIR/azure.stderr" <<'PY'
from pathlib import Path
import ipaddress
import re
import sys

try:
    error = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
except OSError:
    sys.exit(0)
if "ForbiddenByFirewall" not in error:
    sys.exit(0)
match = re.search(r"client address\s*:\s*((?:\d{1,3}\.){3}\d{1,3})", error, re.I)
if match:
    try:
        address = ipaddress.IPv4Address(match.group(1))
        if address.is_global:
            print(address)
    except ValueError:
        pass
PY
}

if ! download_secret admin-initial-password "$TEMP_DIR/old-password"; then
  denied_ipv4="$(denied_client_ipv4)"
  if [[ -n "$denied_ipv4" ]]; then
    printf 'Key Vault denied client IPv4 %s. This can differ from the IP reported by your VPN or proxy.\n' \
      "$denied_ipv4" >&2
    printf 'Retry from a trusted terminal with OPERATOR_PUBLIC_IPV4=%s; the temporary firewall rule is removed on exit.\n' \
      "$denied_ipv4" >&2
  fi
  die 'Cannot read the existing admin password from Key Vault. Check RBAC and the vault firewall. No credentials changed.'
fi
download_secret admin-password-hash "$TEMP_DIR/old-hash" \
  || die 'Cannot read the existing admin hash from Key Vault. Check RBAC and the vault firewall. No credentials changed.'

# Ensure the operator-only password copy still matches the runtime hash before
# writing a new pair. An earlier partial rotation must be repaired first.
python3 - "$TEMP_DIR/old-password" "$TEMP_DIR/old-hash" <<'PY' \
  || die 'The existing Key Vault admin password and hash do not match. Repair them before rotating.'
from pathlib import Path
import base64
import hashlib
import hmac
import sys

try:
    password = Path(sys.argv[1]).read_text(encoding="utf-8")
    parts = Path(sys.argv[2]).read_text(encoding="utf-8").strip().split("$")
    if len(parts) != 6 or parts[:4] != ["scrypt", "32768", "8", "1"]:
        raise ValueError("invalid hash format")
    salt = base64.urlsafe_b64decode(parts[4] + "==")
    expected = base64.urlsafe_b64decode(parts[5] + "==")
    if len(salt) != 32 or len(expected) != 64:
        raise ValueError("invalid hash length")
    actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=32768, r=8, p=1,
                            maxmem=64 * 1024 * 1024, dklen=64)
    if not hmac.compare_digest(actual, expected):
        raise ValueError("password and hash differ")
except (OSError, UnicodeError, ValueError) as error:
    print(f"ERROR: Existing admin credential pair is invalid: {error}", file=sys.stderr)
    sys.exit(1)
PY

cat > "$TEMP_DIR/prompt.py" <<'PY'
from pathlib import Path
import os
import re
import sys
import termios

def read_hidden(label: str) -> str:
    input_fd = sys.stdin.fileno()
    settings = termios.tcgetattr(input_fd)
    hidden = settings.copy()
    hidden[3] &= ~termios.ECHO
    try:
        termios.tcsetattr(input_fd, termios.TCSANOW, hidden)
        sys.stderr.write(label)
        sys.stderr.flush()
        return sys.stdin.readline().rstrip("\r\n")
    finally:
        termios.tcsetattr(input_fd, termios.TCSANOW, settings)
        sys.stderr.write("\n")
        sys.stderr.flush()

try:
    sys.stderr.write("New admin username: ")
    sys.stderr.flush()
    username = sys.stdin.readline().rstrip("\r\n")
    if not re.fullmatch(r"[A-Za-z0-9._-]{3,64}", username):
        raise ValueError("username must be 3–64 letters, numbers, dots, underscores, or hyphens")
    password = read_hidden("New admin password (hidden): ")
    confirmation = read_hidden("Confirm new admin password (hidden): ")
    if password != confirmation:
        raise ValueError("passwords did not match")
    if not 16 <= len(password) <= 1024 or any(ord(c) < 0x20 or ord(c) == 0x7f for c in password):
        raise ValueError("password must be 16–1024 printable characters")
    Path(sys.argv[1]).write_text(username, encoding="utf-8")
    descriptor = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as file:
        file.write(password)
except (EOFError, KeyboardInterrupt, OSError, ValueError) as error:
    print(f"ERROR: {error}", file=sys.stderr)
    sys.exit(1)
PY
python3 "$TEMP_DIR/prompt.py" "$TEMP_DIR/new-username" "$TEMP_DIR/new-password" \
  || die 'Administrator credential entry was cancelled; no credentials changed.'
new_username="$(< "$TEMP_DIR/new-username")"
if cmp -s "$TEMP_DIR/new-password" "$TEMP_DIR/old-password"; then
  die 'Choose a password that differs from the current administrator password. No credentials changed.'
fi

(cd "$PROJECT_ROOT" && node --import tsx scripts/hash-admin-password.ts \
  < "$TEMP_DIR/new-password" > "$TEMP_DIR/new-hash") \
  || die 'Could not derive the new administrator scrypt hash. No credentials changed.'
python3 - "$TEMP_DIR/new-hash" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text(path.read_text(encoding="utf-8").rstrip("\r\n"), encoding="utf-8")
PY
chmod 600 "$TEMP_DIR/new-hash"

# Key Vault writes create new versions. Mark rotation active before the first
# write because Azure may accept a write even when its client loses a response.
credentials_started=1
write_secret admin-password-hash "$TEMP_DIR/new-hash" \
  || die 'Could not store the new admin hash in Key Vault.'
write_secret admin-initial-password "$TEMP_DIR/new-password" \
  || die 'Could not store the new admin password in Key Vault.'
download_secret admin-password-hash "$TEMP_DIR/verified-hash" \
  || die 'Could not verify the new admin hash in Key Vault.'
download_secret admin-initial-password "$TEMP_DIR/verified-password" \
  || die 'Could not verify the new admin password in Key Vault.'
cmp -s "$TEMP_DIR/new-hash" "$TEMP_DIR/verified-hash" \
  || die 'Key Vault did not return the new admin hash.'
cmp -s "$TEMP_DIR/new-password" "$TEMP_DIR/verified-password" \
  || die 'Key Vault did not return the new admin password.'

if [[ "$new_username" != "$old_username" ]]; then
  username_update_attempted=1
  az containerapp update --name "$WEB_APP" --resource-group "$RESOURCE_GROUP" \
    --subscription "$EXPECTED_SUBSCRIPTION_ID" \
    --set-env-vars "ADMIN_USERNAME=$new_username" \
    --only-show-errors --output none \
    > "$TEMP_DIR/azure.stdout" 2> "$TEMP_DIR/azure.stderr" \
    || die 'Could not update the Container App admin username.'
fi

updated_app_json="$(az containerapp show --name "$WEB_APP" --resource-group "$RESOURCE_GROUP" \
  --subscription "$EXPECTED_SUBSCRIPTION_ID" --output json --only-show-errors)" \
  || die 'Could not verify the updated Container App.'
validate_app "$updated_app_json" "$new_username" \
  || die 'The updated Container App admin binding is invalid.'
updated_non_admin_env="$(jq -cS '
  [.properties.template.containers[0].env[]? | select(.name != "ADMIN_USERNAME")]
    | sort_by(.name)
' <<< "$updated_app_json")"
[[ "$updated_non_admin_env" == "$old_non_admin_env" ]] \
  || die 'The Container App update changed another environment variable.'
committed=1

revision="$(jq -r '.properties.latestRevisionName // ""' <<< "$updated_app_json")"
if [[ -z "$revision" ]] || ! az containerapp revision restart --name "$WEB_APP" \
    --resource-group "$RESOURCE_GROUP" --revision "$revision" \
    --subscription "$EXPECTED_SUBSCRIPTION_ID" --only-show-errors --output none \
    > "$TEMP_DIR/azure.stdout" 2> "$TEMP_DIR/azure.stderr"; then
  die 'The new credentials are stored, but the active revision could not be restarted. Restart it manually; the versionless Key Vault reference should refresh within 30 minutes.'
fi

ready=0
for attempt in 1 2 3; do
  status="$(curl --silent --show-error --proto '=https' --tlsv1.2 \
    --max-time 15 --output /dev/null --write-out '%{http_code}' \
    "https://${fqdn}/api/readyz" 2> "$TEMP_DIR/azure.stderr")" || status=''
  if [[ "$status" == 200 ]]; then ready=1; break; fi
  if [[ "$attempt" != 3 ]]; then sleep "${ADMIN_ROTATION_READINESS_RETRY_SECONDS:-5}"; fi
done
[[ "$ready" == 1 ]] \
  || die 'The new credentials are stored, but /api/readyz did not return 200. Check the app health and complete the private login check in docs/ADMIN_CREDENTIALS.md.'

printf 'Admin username and password rotated. Container App binding and /api/readyz verified.\n'
printf 'Use the new credentials in a private browser window. A versionless Key Vault update may take up to 30 minutes to reach every active replica.\n'
