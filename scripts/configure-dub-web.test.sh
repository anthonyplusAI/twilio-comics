#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/twilio-comics-dub-web-test.XXXXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root/bin"

cat > "$test_root/bin/az" <<'AZ'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$AZ_TEST_ROOT/argv.log"
case "$1 $2" in
  'account show')
    printf '%s\n' "${AZ_TEST_SUBSCRIPTION:-b001fc6f-ea19-456a-8401-63971a1a1d98}"
    ;;
  'keyvault show')
    cat "$AZ_TEST_ROOT/vault.json"
    ;;
  'identity show')
    if [[ " $* " == *' id-twilio-comics-v2-web '* ]]; then
      cat "$AZ_TEST_ROOT/web-identity.json"
    elif [[ " $* " == *' id-twilio-comics-v2-worker '* ]]; then
      cat "$AZ_TEST_ROOT/worker-identity.json"
    else
      exit 91
    fi
    ;;
  'containerapp job')
    [[ "$3" == show ]]
    cat "$AZ_TEST_ROOT/job.json"
    ;;
  'containerapp show')
    cat "$AZ_TEST_ROOT/web.json"
    ;;
  'role assignment')
    case "$3" in
      list) cat "$AZ_TEST_ROOT/roles.json" ;;
      create)
        [[ " $* " == *' --scope /subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.KeyVault/vaults/kv-twilio-comics-1a1d98/secrets/dub-api-key '* ]]
        [[ " $* " == *' --assignee-object-id web-principal '* ]]
        [[ " $* " == *' --role Key Vault Secrets User '* ]]
        [[ "${AZ_TEST_FAIL_ROLE:-0}" != 1 ]] || exit 92
        printf '%s\n' '[{"scope":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.KeyVault/vaults/kv-twilio-comics-1a1d98/secrets/dub-api-key"}]' > "$AZ_TEST_ROOT/roles.json"
        ;;
      *) exit 93 ;;
    esac
    ;;
  'containerapp secret')
    [[ "$3" == set ]]
    [[ "${AZ_TEST_FAIL_SECRET:-0}" != 1 ]] || exit 94
    spec=''
    while (($#)); do
      if [[ "$1" == --secrets ]]; then spec="$2"; break; fi
      shift
    done
    python3 - "$AZ_TEST_ROOT/web.json" "$spec" <<'PY'
from pathlib import Path
import json
import sys
path = Path(sys.argv[1])
name, binding = sys.argv[2].split("=", 1)
uri, identity = binding.removeprefix("keyvaultref:").split(",identityref:", 1)
data = json.loads(path.read_text())
secrets = data["properties"]["configuration"]["secrets"]
secrets[:] = [item for item in secrets if item["name"] != name]
secrets.append({"name": name, "keyVaultUrl": uri, "identity": identity})
path.write_text(json.dumps(data))
PY
    ;;
  'containerapp update')
    [[ "${AZ_TEST_FAIL_UPDATE:-0}" != 1 ]] || exit 95
    env_args=()
    capture=false
    for item in "$@"; do
      if [[ "$item" == --set-env-vars ]]; then capture=true; continue; fi
      if [[ "$item" == --subscription ]]; then capture=false; fi
      [[ "$capture" != true ]] || env_args+=("$item")
    done
    python3 - "$AZ_TEST_ROOT/web.json" "${env_args[@]}" <<'PY'
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
chmod +x "$test_root/bin/az"

python3 - "$test_root" <<'PY'
from pathlib import Path
import json
import sys
root = Path(sys.argv[1])
sub = "b001fc6f-ea19-456a-8401-63971a1a1d98"
rg = "rg-twilio-comics"
vault = "kv-twilio-comics-1a1d98"
base = f"/subscriptions/{sub}/resourceGroups/{rg}"
environment = f"{base}/providers/Microsoft.App/managedEnvironments/cae-twilio-comics-v2"
web_id = f"{base}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-twilio-comics-v2-web"
worker_id = f"{base}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-twilio-comics-v2-worker"
uri = f"https://{vault}.vault.azure.net/secrets/dub-api-key"
for name, identity, principal in (("web", web_id, "web-principal"), ("worker", worker_id, "worker-principal")):
    (root / f"{name}-identity.json").write_text(json.dumps({"id": identity, "principalId": principal}))
(root / "vault.json").write_text(json.dumps({
    "id": f"{base}/providers/Microsoft.KeyVault/vaults/{vault}",
    "tags": {"managed_by": "twilio-comics-ci"},
    "properties": {"enableRbacAuthorization": True, "enablePurgeProtection": True,
                   "networkAcls": {"defaultAction": "Deny"}},
}))
(root / "job.json").write_text(json.dumps({
    "id": f"{base}/providers/Microsoft.App/jobs/twilio-comics-generation-v2",
    "identity": {"userAssignedIdentities": {worker_id: {}}},
    "properties": {"environmentId": environment,
        "configuration": {"secrets": [{"name": "dub-api-key", "keyVaultUrl": uri, "identity": worker_id}]},
        "template": {"containers": [{"env": [
            {"name": "DUB_API_KEY", "secretRef": "dub-api-key", "value": ""},
            {"name": "DUB_DOMAIN", "value": "twil.io"},
            {"name": "DUB_FOLDER_ID", "value": "folder-test"},
        ]}]},
    },
}))
(root / "web.json").write_text(json.dumps({
    "id": f"{base}/providers/Microsoft.App/containerApps/twilio-comics",
    "identity": {"userAssignedIdentities": {web_id: {}}},
    "properties": {"environmentId": environment,
        "configuration": {"secrets": [{"name": "runtime-database-url",
            "keyVaultUrl": f"https://{vault}.vault.azure.net/secrets/postgres-comics-runtime-url",
            "identity": web_id}]},
        "template": {"containers": [{"env": [{"name": "DATABASE_URL", "secretRef": "runtime-database-url"}]}]},
    },
}))
(root / "roles.json").write_text("[]")
PY

export PATH="$test_root/bin:$PATH" AZ_TEST_ROOT="$test_root"
cp "$test_root/web.json" "$test_root/web-initial.json"
script="$repo_root/scripts/configure-dub-web.sh"
run_script() {
  SUBSCRIPTION_ID=b001fc6f-ea19-456a-8401-63971a1a1d98 \
    CONFIGURE_DUB_WEB_CONFIRM=yes bash "$script" > "$test_root/output.log" 2>&1
}
assert_no_mutation() {
  if grep -Eq 'role assignment create|containerapp secret set|containerapp update' "$test_root/argv.log"; then
    printf 'A rejected configuration mutated Azure.\n' >&2
    exit 1
  fi
}

run_script
grep -Fq '/secrets/dub-api-key --role Key Vault Secrets User' "$test_root/argv.log"
grep -Fq 'containerapp secret set --name twilio-comics' "$test_root/argv.log"
grep -Fq 'dub-api-key=keyvaultref:https://kv-twilio-comics-1a1d98.vault.azure.net/secrets/dub-api-key,identityref:' "$test_root/argv.log"
grep -Fq 'DUB_API_KEY=secretref:dub-api-key DUB_DOMAIN=twil.io DUB_FOLDER_ID=folder-test' "$test_root/argv.log"
jq -e '
  ([.properties.configuration.secrets[] | select(.name == "dub-api-key")]
    | length == 1 and .[0].keyVaultUrl == "https://kv-twilio-comics-1a1d98.vault.azure.net/secrets/dub-api-key")
  and ([.properties.template.containers[0].env[] | select(.name == "DUB_API_KEY")]
    | length == 1 and .[0].secretRef == "dub-api-key" and .[0].value == "")
  and ([.properties.template.containers[0].env[] | select(.name == "DUB_DOMAIN")]
    | length == 1 and .[0].value == "twil.io")
  and ([.properties.template.containers[0].env[] | select(.name == "DUB_FOLDER_ID")]
    | length == 1 and .[0].value == "folder-test")
' >/dev/null "$test_root/web.json"

# Repeat runs must not create a new role, secret binding, or revision.
: > "$test_root/argv.log"
run_script
assert_no_mutation

# Reject wrong subscription, source inline key, source versioned URI, target
# inline key, and target conflicting domain before any mutation.
if AZ_TEST_SUBSCRIPTION=another-subscription run_script; then
  echo 'Wrong subscription was accepted.' >&2
  exit 1
fi
assert_no_mutation
: > "$test_root/argv.log"
jq '.properties.template.containers[0].env[0] = {"name":"DUB_API_KEY","value":"do-not-log-this-api-key"}' \
  "$test_root/job.json" > "$test_root/job-new.json"
mv "$test_root/job-new.json" "$test_root/job.json"
if run_script; then echo 'Inline source key was accepted.' >&2; exit 1; fi
assert_no_mutation
if grep -Fq 'do-not-log-this-api-key' "$test_root/output.log"; then
  echo 'A rejected source key was printed.' >&2
  exit 1
fi
jq '.properties.template.containers[0].env[0] = {"name":"DUB_API_KEY","secretRef":"dub-api-key"}
  | .properties.configuration.secrets[0].keyVaultUrl += "/version123"' \
  "$test_root/job.json" > "$test_root/job-new.json"
mv "$test_root/job-new.json" "$test_root/job.json"
: > "$test_root/argv.log"
if run_script; then echo 'Versioned source secret was accepted.' >&2; exit 1; fi
assert_no_mutation
jq '.properties.configuration.secrets[0].keyVaultUrl |= sub("/version123$"; "")' \
  "$test_root/job.json" > "$test_root/job-new.json"
mv "$test_root/job-new.json" "$test_root/job.json"
jq '.properties.template.containers[0].env |= map(if .name == "DUB_API_KEY" then {"name":"DUB_API_KEY","value":"do-not-log-this-api-key"} else . end)' \
  "$test_root/web.json" > "$test_root/web-new.json"
mv "$test_root/web-new.json" "$test_root/web.json"
: > "$test_root/argv.log"
if run_script; then echo 'Inline target key was accepted.' >&2; exit 1; fi
assert_no_mutation
if grep -Fq 'do-not-log-this-api-key' "$test_root/output.log"; then
  echo 'A rejected target key was printed.' >&2
  exit 1
fi
jq '.properties.template.containers[0].env |= map(if .name == "DUB_API_KEY" then {"name":"DUB_API_KEY","secretRef":"dub-api-key"} else . end)
  | .properties.template.containers[0].env += [{"name":"DUB_DOMAIN","value":"other.example"}]' \
  "$test_root/web.json" > "$test_root/web-new.json"
mv "$test_root/web-new.json" "$test_root/web.json"
: > "$test_root/argv.log"
if run_script; then echo 'Conflicting target domain was accepted.' >&2; exit 1; fi
assert_no_mutation

# A role failure cannot proceed to the Container App. A later secret or
# revision failure can be recovered by rerunning without changing the role.
cp "$test_root/web-initial.json" "$test_root/web.json"
printf '[]' > "$test_root/roles.json"
: > "$test_root/argv.log"
if AZ_TEST_FAIL_ROLE=1 run_script; then echo 'Failed role grant was accepted.' >&2; exit 1; fi
if grep -Eq 'containerapp secret set|containerapp update' "$test_root/argv.log"; then
  echo 'Container App changed after a failed role grant.' >&2
  exit 1
fi
: > "$test_root/argv.log"
if AZ_TEST_FAIL_SECRET=1 run_script; then echo 'Failed secret binding was accepted.' >&2; exit 1; fi
if grep -q 'containerapp update' "$test_root/argv.log"; then
  echo 'Container App env changed after a failed secret binding.' >&2
  exit 1
fi
: > "$test_root/argv.log"
if AZ_TEST_FAIL_UPDATE=1 run_script; then echo 'Failed env update was accepted.' >&2; exit 1; fi
: > "$test_root/argv.log"
run_script
if grep -Eq 'role assignment create|containerapp secret set' "$test_root/argv.log"; then
  echo 'Recovery run repeated a completed role or secret binding.' >&2
  exit 1
fi

printf 'Dub web binding tests passed.\n'
