#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/twilio-comics-dub-config-test.XXXXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT
TEST_DUB_KEY="$(python3 -c 'print("x" * 40)')"
export TEST_DUB_KEY
mkdir -p "$test_root/bin" "$test_root/project/scripts" "$test_root/state"
cp "$project_root/scripts/configure-dub-runtime.sh" "$test_root/project/scripts/"
cp "$project_root/scripts/check-aca-dub-config.sh" "$test_root/project/scripts/"

cat > "$test_root/bin/az" <<'AZ'
#!/usr/bin/env bash
set -euo pipefail

argument() {
  local flag="$1" previous='' item
  shift
  for item in "$@"; do
    if [[ "$previous" == "$flag" ]]; then printf '%s\n' "$item"; return; fi
    previous="$item"
  done
  return 1
}
printf '%s\n' "$*" >> "$AZ_TEST_STATE/az-argv.log"

case "${1:-} ${2:-} ${3:-}" in
  'account show --query') printf '%s\n' "${AZ_TEST_SUBSCRIPTION:-b001fc6f-ea19-456a-8401-63971a1a1d98}" ;;
  'keyvault show --name')
    printf '%s\n' '{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.KeyVault/vaults/kv-twilio-comics-1a1d98","tags":{"managed_by":"twilio-comics-ci"},"properties":{"enableRbacAuthorization":true,"enablePurgeProtection":true,"publicNetworkAccess":"Enabled","networkAcls":{"defaultAction":"Deny"}}}' ;;
  'identity show --name')
    printf '%s\n' '{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-twilio-comics-v2-worker","principalId":"worker-principal"}' ;;
  'containerapp job show') cat "$AZ_TEST_STATE/job.json" ;;
  'keyvault network-rule list')
    if [[ -e "$AZ_TEST_STATE/ip-rule" ]]; then
      printf '%s\n' '{"ipRules":[{"value":"8.8.8.8/32"}]}'
    else
      printf '%s\n' '{"ipRules":[]}'
    fi ;;
  'keyvault network-rule add') touch "$AZ_TEST_STATE/ip-rule" "$AZ_TEST_STATE/ip-added" ;;
  'keyvault network-rule remove') rm -f -- "$AZ_TEST_STATE/ip-rule"; touch "$AZ_TEST_STATE/ip-removed" ;;
  'keyvault secret list')
    if [[ "${AZ_TEST_REQUIRE_OFFICER:-0}" == 1 ]] && \
        ! grep -Fq $'operator-principal\t/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.KeyVault/vaults/kv-twilio-comics-1a1d98\tKey Vault Secrets Officer\t' "$AZ_TEST_STATE/roles.tsv"; then
      exit 42
    fi
    if [[ -e "$AZ_TEST_STATE/dub-api-key" ]]; then
      jq -n --arg expires "$(cat "$AZ_TEST_STATE/expiry")" '[{name:"dub-api-key",attributes:{enabled:true,expires:$expires}}]'
    else
      printf '%s\n' '[]'
    fi ;;
  'keyvault secret set')
    [[ "$(argument --name "$@")" == dub-api-key ]]
    source="$(argument --file "$@")"
    expires="$(argument --expires "$@")"
    [[ "$expires" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
    python3 - "$source" <<'PY'
import os, stat, sys
assert stat.S_IMODE(os.stat(sys.argv[1]).st_mode) == 0o600
PY
    cp "$source" "$AZ_TEST_STATE/dub-api-key"
    printf '%s' "$expires" > "$AZ_TEST_STATE/expiry"
    touch "$AZ_TEST_STATE/secret-set" ;;
  'keyvault secret set-attributes')
    printf '%s' "$(argument --expires "$@")" > "$AZ_TEST_STATE/expiry" ;;
  'keyvault secret download')
    cp "$AZ_TEST_STATE/dub-api-key" "$(argument --file "$@")" ;;
  'ad signed-in-user show') printf '%s\n' 'operator-principal' ;;
  'role assignment list')
    principal="$(argument --assignee-object-id "$@")"
    scope="$(argument --scope "$@")"
    role="$(argument --role "$@")"
    python3 - "$AZ_TEST_STATE/roles.tsv" "$principal" "$scope" "$role" <<'PY'
from pathlib import Path
import json
import sys
rows = [line.split("\t") for line in Path(sys.argv[1]).read_text().splitlines()]
print(json.dumps([{"scope": row[1], "id": row[3]} for row in rows if row[:3] == sys.argv[2:5]]))
PY
    ;;
  'role assignment create')
    principal="$(argument --assignee-object-id "$@")"
    scope="$(argument --scope "$@")"
    role="$(argument --role "$@")"
    assignment="/role-assignments/$(wc -l < "$AZ_TEST_STATE/roles.tsv" | tr -d ' ')"
    printf '%s\t%s\t%s\t%s\n' "$principal" "$scope" "$role" "$assignment" >> "$AZ_TEST_STATE/roles.tsv"
    [[ "$*" != *'--query id'* ]] || printf '%s\n' "$assignment" ;;
  'role assignment delete')
    assignment="$(argument --ids "$@")"
    python3 - "$AZ_TEST_STATE/roles.tsv" "$assignment" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text("".join(line for line in path.read_text().splitlines(keepends=True) if line.rstrip("\n").split("\t")[-1] != sys.argv[2]))
PY
    ;;
  'containerapp job secret')
    spec="$(argument --secrets "$@")"
    python3 - "$AZ_TEST_STATE/job.json" "$spec" <<'PY'
from pathlib import Path
import json
import sys
path = Path(sys.argv[1])
name, rest = sys.argv[2].split("=keyvaultref:", 1)
uri, identity = rest.split(",identityref:", 1)
data = json.loads(path.read_text())
secrets = data["properties"]["configuration"]["secrets"]
secrets[:] = [item for item in secrets if item["name"] != name]
secrets.append({"name": name, "keyVaultUrl": uri, "identity": identity})
path.write_text(json.dumps(data))
PY
    ;;
  'containerapp job update')
    [[ "${AZ_TEST_FAIL_UPDATE:-0}" != 1 ]] || exit 93
    env_args=()
    capture=false
    for item in "$@"; do
      if [[ "$item" == --set-env-vars ]]; then capture=true; continue; fi
      if [[ "$item" == --subscription ]]; then capture=false; fi
      [[ "$capture" != true ]] || env_args+=("$item")
    done
    python3 - "$AZ_TEST_STATE/job.json" "${env_args[@]}" <<'PY'
from pathlib import Path
import json
import sys
path = Path(sys.argv[1])
data = json.loads(path.read_text())
env = data["properties"]["template"]["containers"][0]["env"]
for spec in sys.argv[2:]:
    name, value = spec.split("=", 1)
    env[:] = [item for item in env if item["name"] != name]
    env.append({"name": name, "secretRef": value.removeprefix("secretref:"), "value": ""} if value.startswith("secretref:") else {"name": name, "value": value})
path.write_text(json.dumps(data))
PY
    ;;
  *) printf 'Unexpected Azure command: %s\n' "$*" >&2; exit 90 ;;
esac
AZ

cat > "$test_root/bin/pnpm" <<'PNPM'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == '--silent dub:setup-folder' ]]
[[ "${DUB_API_KEY:-}" == "$TEST_DUB_KEY" ]]
printf '%s\n' 'DUB_FOLDER_ID=folder-test'
printf '%s\n' 'Set DUB_FOLDER_ID to this value in the app configuration.'
PNPM
chmod +x "$test_root/bin/az" "$test_root/bin/pnpm"

python3 - "$test_root/state/job.json" <<'PY'
from pathlib import Path
import json
import sys
sub = "b001fc6f-ea19-456a-8401-63971a1a1d98"
rg = "rg-twilio-comics"
vault = "kv-twilio-comics-1a1d98"
identity = f"/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-twilio-comics-v2-worker"
data = {
    "id": f"/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.App/jobs/twilio-comics-generation-v2",
    "identity": {"userAssignedIdentities": {identity: {}}},
    "properties": {
        "environmentId": f"/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.App/managedEnvironments/cae-twilio-comics-v2",
        "configuration": {"secrets": [{"name": "runtime-database-url", "keyVaultUrl": f"https://{vault}.vault.azure.net/secrets/postgres-comics-runtime-url", "identity": identity}]},
        "template": {"containers": [{"env": [{"name": "DATABASE_URL", "secretRef": "runtime-database-url"}]}]},
    },
}
Path(sys.argv[1]).write_text(json.dumps(data))
PY
printf 'DUB_API_KEY=%s' "$TEST_DUB_KEY" > "$test_root/project/.env.local"
chmod 600 "$test_root/project/.env.local"
: > "$test_root/state/roles.tsv"
export PATH="$test_root/bin:$PATH" AZ_TEST_STATE="$test_root/state"
export OPERATOR_PUBLIC_IPV4=8.8.8.8 AZ_TEST_REQUIRE_OFFICER=1 DUB_ROLE_POLL_SECONDS=0
script="$test_root/project/scripts/configure-dub-runtime.sh"

bash "$script" > "$test_root/success.out" 2>&1
[[ -e "$test_root/state/secret-set" ]]
[[ -e "$test_root/state/ip-added" && -e "$test_root/state/ip-removed" && ! -e "$test_root/state/ip-rule" ]]
grep -Fq 'role assignment create --assignee-object-id worker-principal' "$test_root/state/az-argv.log"
grep -Fq '/secrets/dub-api-key --role Key Vault Secrets User' "$test_root/state/az-argv.log"
grep -Fq 'role assignment delete --ids /role-assignments/0' "$test_root/state/az-argv.log"
if grep -Fq "$TEST_DUB_KEY" "$test_root/success.out" \
  || grep -Fq "$TEST_DUB_KEY" "$test_root/state/az-argv.log"; then
  printf 'Dub key leaked in command output or Azure arguments.\n' >&2
  exit 1
fi
jq -e '
  ([.properties.configuration.secrets[] | select(.name == "dub-api-key")]
    | length == 1 and .[0].keyVaultUrl == "https://kv-twilio-comics-1a1d98.vault.azure.net/secrets/dub-api-key")
  and ([.properties.template.containers[0].env[] | select(.name == "DUB_API_KEY")]
    | length == 1 and .[0].secretRef == "dub-api-key")
  and ([.properties.template.containers[0].env[] | select(.name == "RESULT_MEDIA_PREVIEW_ENABLED")]
    | length == 1 and .[0].value == "false")
' >/dev/null "$test_root/state/job.json"

# A repeat run reuses the same Key Vault version and worker role. A firewall
# rule that existed beforehand is never removed by this script.
touch "$test_root/state/ip-rule"
rm -f -- "$test_root/state/ip-added" "$test_root/state/ip-removed" "$test_root/state/secret-set"
: > "$test_root/state/az-argv.log"
AZ_TEST_REQUIRE_OFFICER=0 bash "$script" > "$test_root/repeat.out" 2>&1
[[ -e "$test_root/state/ip-rule" && ! -e "$test_root/state/ip-added" && ! -e "$test_root/state/ip-removed" ]]
[[ ! -e "$test_root/state/secret-set" ]]
if grep -Eq 'keyvault secret set --|role assignment create' "$test_root/state/az-argv.log"; then
  printf 'Repeat setup needlessly changed Key Vault or RBAC.\n' >&2
  exit 1
fi

# Reject a wrong subscription, an inline key, and a key file with loose
# permissions before any Key Vault secret or Job mutation.
if AZ_TEST_SUBSCRIPTION=another-subscription bash "$script" > "$test_root/wrong.out" 2>&1; then
  printf 'Wrong subscription was accepted.\n' >&2
  exit 1
fi
python3 - "$test_root/state/job.json" <<'PY'
from pathlib import Path
import json
import sys
path = Path(sys.argv[1])
data = json.loads(path.read_text())
env = data["properties"]["template"]["containers"][0]["env"]
env[:] = [item for item in env if item["name"] != "DUB_API_KEY"]
env.append({"name": "DUB_API_KEY", "value": "unsafe-inline-key"})
path.write_text(json.dumps(data))
PY
: > "$test_root/state/az-argv.log"
if bash "$script" > "$test_root/inline.out" 2>&1; then
  printf 'Inline Dub key was accepted.\n' >&2
  exit 1
fi
if grep -Eq 'keyvault secret set|containerapp job secret|containerapp job update' "$test_root/state/az-argv.log"; then
  printf 'Setup mutated Azure after detecting an inline key.\n' >&2
  exit 1
fi

# A late ACA failure must still revoke the temporary firewall rule. The saved
# Key Vault secret is retained so a rerun can finish the idempotent binding.
python3 - "$test_root/state/job.json" <<'PY'
from pathlib import Path
import json
import sys
path = Path(sys.argv[1])
data = json.loads(path.read_text())
env = data["properties"]["template"]["containers"][0]["env"]
env[:] = [item for item in env if item["name"] != "DUB_API_KEY"]
path.write_text(json.dumps(data))
PY
rm -f -- "$test_root/state/ip-rule" "$test_root/state/ip-added" "$test_root/state/ip-removed"
if AZ_TEST_REQUIRE_OFFICER=0 AZ_TEST_FAIL_UPDATE=1 bash "$script" \
  > "$test_root/update-failed.out" 2>&1; then
  printf 'The simulated Container Apps update failure was accepted.\n' >&2
  exit 1
fi
[[ -e "$test_root/state/ip-added" && -e "$test_root/state/ip-removed" && ! -e "$test_root/state/ip-rule" ]]
if grep -Fq "$TEST_DUB_KEY" "$test_root/update-failed.out"; then
  printf 'Dub key leaked in failure output.\n' >&2
  exit 1
fi

printf '%s' "$TEST_DUB_KEY" > "$test_root/loose-key"
chmod 644 "$test_root/loose-key"
if DUB_API_KEY_FILE="$test_root/loose-key" bash "$script" > "$test_root/loose.out" 2>&1; then
  printf 'Loose key file was accepted.\n' >&2
  exit 1
fi

printf 'Dub runtime configuration tests passed.\n'
