#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/twilio-comics-admin-rotation-test.XXXXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin"
export AZ_TEST_ROOT="$TEST_ROOT"
export PATH="$TEST_ROOT/bin:$PATH"

cat > "$TEST_ROOT/bin/az" <<'AZ'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$AZ_TEST_ROOT/az-argv.log"

arg_after() {
  local previous='' item key="$1"
  shift
  for item in "$@"; do
    if [[ "$previous" == "$key" ]]; then printf '%s\n' "$item"; return; fi
    previous="$item"
  done
  return 1
}

case "$1 $2 ${3:-}" in
  'account show --query') printf '%s\n' 'b001fc6f-ea19-456a-8401-63971a1a1d98' ;;
  'keyvault show --name')
    printf '%s\n' '{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.KeyVault/vaults/kv-twilio-comics-1a1d98","tags":{"managed_by":"twilio-comics-ci"},"properties":{"enableRbacAuthorization":true,"enablePurgeProtection":true,"publicNetworkAccess":"Enabled","networkAcls":{"defaultAction":"Deny"}}}' ;;
  'keyvault network-rule list')
    if [[ -e "$AZ_TEST_ROOT/firewall-rule" ]]; then
      printf '%s\n' '{"ipRules":[{"value":"8.8.8.8/32"}]}'
    else
      printf '%s\n' '{"ipRules":[]}'
    fi ;;
  'keyvault network-rule add') touch "$AZ_TEST_ROOT/firewall-rule" "$AZ_TEST_ROOT/firewall-added" ;;
  'keyvault network-rule remove') rm -f -- "$AZ_TEST_ROOT/firewall-rule"; touch "$AZ_TEST_ROOT/firewall-removed" ;;
  'keyvault secret download')
    if [[ "${AZ_TEST_DENIED_CLIENT_IP:-0}" == 1 ]]; then
      printf 'ForbiddenByFirewall. Client address: 9.9.9.9\n' >&2
      exit 42
    fi
    name="$(arg_after --name "$@")"
    destination="$(arg_after --file "$@")"
    cp "$AZ_TEST_ROOT/$name" "$destination"
    chmod 600 "$destination" ;;
  'keyvault secret set')
    name="$(arg_after --name "$@")"
    source="$(arg_after --file "$@")"
    expiration="$(arg_after --expires "$@")"
    [[ "$expiration" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
    python3 - "$source" <<'PY'
import os, stat, sys
assert stat.S_IMODE(os.stat(sys.argv[1]).st_mode) == 0o600
PY
    if [[ "${AZ_TEST_FAIL_INITIAL_WRITE:-0}" == 1 && "$name" == admin-initial-password && ! -e "$AZ_TEST_ROOT/write-failed-once" ]]; then
      touch "$AZ_TEST_ROOT/write-failed-once"
      exit 33
    fi
    cp "$source" "$AZ_TEST_ROOT/$name" ;;
  'containerapp show --name')
    username="$(cat "$AZ_TEST_ROOT/admin-username")"
    jq -n --arg username "$username" '{
      id:"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.App/containerApps/twilio-comics-v2",
      identity:{userAssignedIdentities:{"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-twilio-comics-v2-web":{}}},
      properties:{
        configuration:{activeRevisionsMode:"Single",ingress:{fqdn:"twilio-comics-v2.kindriver-a0456aa8.eastus2.azurecontainerapps.io"},secrets:[{name:"admin-password-hash",keyVaultUrl:"https://kv-twilio-comics-1a1d98.vault.azure.net/secrets/admin-password-hash",identity:"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-twilio-comics-v2-web"}]},
        latestRevisionName:"twilio-comics-v2--test",
        template:{containers:[{env:[{name:"ADMIN_USERNAME",value:$username},{name:"ADMIN_PASSWORD_HASH",secretRef:"admin-password-hash"},{name:"OTHER_SETTING",value:"preserved"}]}]}
      }
    }' ;;
  'containerapp update --name')
    [[ "$*" == *'--set-env-vars ADMIN_USERNAME='* ]]
    new_username="$(arg_after --set-env-vars "$@")"
    printf '%s' "${new_username#ADMIN_USERNAME=}" > "$AZ_TEST_ROOT/admin-username" ;;
  'containerapp revision restart') touch "$AZ_TEST_ROOT/revision-restarted" ;;
  *) printf 'Unexpected Azure command: %s\n' "$*" >&2; exit 90 ;;
esac
AZ
chmod +x "$TEST_ROOT/bin/az"

cat > "$TEST_ROOT/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *'https://twilio-comics-v2.kindriver-a0456aa8.eastus2.azurecontainerapps.io/api/readyz'* ]]; then
  touch "$AZ_TEST_ROOT/readiness-checked"
  printf '200'
else
  printf 'Unexpected curl: %s\n' "$*" >&2
  exit 90
fi
CURL
chmod +x "$TEST_ROOT/bin/curl"

cat > "$TEST_ROOT/run-with-tty.py" <<'PY'
import os
import pty
import select
import sys
import time

script, output_file = sys.argv[1:]
prompts = [
    (b"New admin username: ", b"new-admin\n"),
    (b"New admin password (hidden): ", b"NewTestAdminPassword-2026!\n"),
    (b"Confirm new admin password (hidden): ", b"NewTestAdminPassword-2026!\n"),
]
if os.environ.get("AZ_TEST_EXPECT_NO_PROMPT") == "1":
    prompts = []
pid, master = pty.fork()
if pid == 0:
    os.execv("/bin/bash", ["bash", script])

received = b""
sent = 0
deadline = time.monotonic() + 60
while time.monotonic() < deadline:
    readable, _, _ = select.select([master], [], [], 0.2)
    if readable:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        received += chunk
    if sent < len(prompts) and prompts[sent][0] in received:
        os.write(master, prompts[sent][1])
        sent += 1
    finished, status = os.waitpid(pid, os.WNOHANG)
    if finished:
        break
else:
    os.kill(pid, 9)
    raise SystemExit("rotation script timed out")

if not finished:
    _, status = os.waitpid(pid, 0)
with open(output_file, "wb") as file:
    file.write(received)
assert b"NewTestAdminPassword-2026!" not in received
assert sent == len(prompts), received.decode(errors="replace")
raise SystemExit(os.waitstatus_to_exitcode(status))
PY

printf '%s' 'OldTestAdminPassword-2026!' > "$TEST_ROOT/admin-initial-password"
(cd "$PROJECT_ROOT" && node --import tsx scripts/hash-admin-password.ts \
  < "$TEST_ROOT/admin-initial-password" > "$TEST_ROOT/admin-password-hash")
python3 - "$TEST_ROOT/admin-password-hash" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text(path.read_text().strip())
PY
printf '%s' 'old-admin' > "$TEST_ROOT/admin-username"
cp "$TEST_ROOT/admin-initial-password" "$TEST_ROOT/original-password"
cp "$TEST_ROOT/admin-password-hash" "$TEST_ROOT/original-hash"

export SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98'
export ROTATE_ADMIN_BOOTSTRAP_ONLY=yes
export ROTATE_ADMIN_CONFIRM=yes
export OPERATOR_PUBLIC_IPV4=8.8.8.8
export ADMIN_ROTATION_ACCESS_RETRY_SECONDS=0
export ADMIN_ROTATION_READINESS_RETRY_SECONDS=0

python3 "$TEST_ROOT/run-with-tty.py" "$PROJECT_ROOT/scripts/rotate-admin-credentials.sh" "$TEST_ROOT/success-output"
[[ "$(cat "$TEST_ROOT/admin-username")" == new-admin ]]
[[ "$(cat "$TEST_ROOT/admin-initial-password")" == 'NewTestAdminPassword-2026!' ]]
[[ "$(cat "$TEST_ROOT/admin-password-hash")" != "$(cat "$TEST_ROOT/original-hash")" ]]
[[ ! -e "$TEST_ROOT/firewall-rule" && -e "$TEST_ROOT/firewall-added" && -e "$TEST_ROOT/firewall-removed" ]]
[[ -e "$TEST_ROOT/revision-restarted" && -e "$TEST_ROOT/readiness-checked" ]]
if grep -Fq 'NewTestAdminPassword-2026!' "$TEST_ROOT/az-argv.log" \
    || grep -Fq 'OldTestAdminPassword-2026!' "$TEST_ROOT/az-argv.log"; then
  printf 'A credential appeared in Azure CLI arguments.\n' >&2
  exit 1
fi

cp "$TEST_ROOT/original-password" "$TEST_ROOT/admin-initial-password"
cp "$TEST_ROOT/original-hash" "$TEST_ROOT/admin-password-hash"
printf '%s' 'old-admin' > "$TEST_ROOT/admin-username"
touch "$TEST_ROOT/firewall-rule"
rm -f -- "$TEST_ROOT/firewall-added" "$TEST_ROOT/firewall-removed" "$TEST_ROOT/write-failed-once"
if AZ_TEST_FAIL_INITIAL_WRITE=1 python3 "$TEST_ROOT/run-with-tty.py" \
    "$PROJECT_ROOT/scripts/rotate-admin-credentials.sh" "$TEST_ROOT/failure-output"; then
  printf 'Expected the simulated Key Vault write failure to stop rotation.\n' >&2
  exit 1
fi
[[ -e "$TEST_ROOT/write-failed-once" ]]
grep -Fq 'Could not store the new admin password in Key Vault' "$TEST_ROOT/failure-output"
cmp "$TEST_ROOT/admin-initial-password" "$TEST_ROOT/original-password"
cmp "$TEST_ROOT/admin-password-hash" "$TEST_ROOT/original-hash"
[[ "$(cat "$TEST_ROOT/admin-username")" == old-admin ]]
[[ -e "$TEST_ROOT/firewall-rule" && ! -e "$TEST_ROOT/firewall-added" && ! -e "$TEST_ROOT/firewall-removed" ]]
if grep -Fq 'NewTestAdminPassword-2026!' "$TEST_ROOT/failure-output"; then
  printf 'A credential appeared in terminal output.\n' >&2
  exit 1
fi

if AZ_TEST_DENIED_CLIENT_IP=1 AZ_TEST_EXPECT_NO_PROMPT=1 \
    python3 "$TEST_ROOT/run-with-tty.py" \
    "$PROJECT_ROOT/scripts/rotate-admin-credentials.sh" "$TEST_ROOT/denied-output"; then
  printf 'Expected the proxy IPv4 denial to stop rotation before prompting.\n' >&2
  exit 1
fi
grep -Fq 'Key Vault denied client IPv4 9.9.9.9' "$TEST_ROOT/denied-output"
cmp "$TEST_ROOT/admin-initial-password" "$TEST_ROOT/original-password"
cmp "$TEST_ROOT/admin-password-hash" "$TEST_ROOT/original-hash"
[[ "$(cat "$TEST_ROOT/admin-username")" == old-admin ]]

if SUBSCRIPTION_ID=wrong bash "$PROJECT_ROOT/scripts/rotate-admin-credentials.sh" \
    > "$TEST_ROOT/wrong-subscription-output" 2>&1; then
  printf 'Expected a wrong subscription to fail before prompting.\n' >&2
  exit 1
fi

if ROTATE_ADMIN_BOOTSTRAP_ONLY=no bash "$PROJECT_ROOT/scripts/rotate-admin-credentials.sh" \
    > "$TEST_ROOT/dashboard-rotation-output" 2>&1; then
  printf 'Expected routine rotation to redirect to the dashboard.\n' >&2
  exit 1
fi
grep -Fq 'Change the active admin login at /admin/settings' "$TEST_ROOT/dashboard-rotation-output"

printf 'Admin credential rotation tests passed.\n'
