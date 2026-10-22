#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/twilio-comics-runtime-test.XXXXXXXX")"
trap 'rm -rf "$test_root"' EXIT
mkdir -p "$test_root/bin" "$test_root/state/secrets"

cat > "$test_root/bin/az" <<'AZ_MOCK'
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
printf '%s\n' "$*" >> "$AZ_MOCK_LOG"

case "${1:-} ${2:-} ${3:-}" in
  'account show --query') printf '%s\n' "${AZ_MOCK_ACCOUNT:-b001fc6f-ea19-456a-8401-63971a1a1d98}" ;;
  'keyvault show --name')
    cat <<'JSON'
{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.KeyVault/vaults/kv-twilio-comics-1a1d98","tags":{"managed_by":"twilio-comics-ci"},"properties":{"enableRbacAuthorization":true,"enablePurgeProtection":true,"publicNetworkAccess":"Enabled","networkAcls":{"defaultAction":"Deny"}}}
JSON
    ;;
  'keyvault network-rule list') printf '%s\n' '{"ipRules":[{"value":"8.8.8.8/32"}]}' ;;
  'keyvault secret list')
    if [[ "${AZ_MOCK_REQUIRE_TEMP_OFFICER:-}" == 1 ]] && \
        ! grep -Fq $'operator-principal\t/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.KeyVault/vaults/kv-twilio-comics-1a1d98\tKey Vault Secrets Officer\t' "$AZ_MOCK_STATE/roles.tsv"; then
      exit 96
    fi
    python3 - "$AZ_MOCK_STATE/secrets" <<'PY'
from pathlib import Path
import json
import sys
print(json.dumps([{"name": item.name, "attributes": {"enabled": True}} for item in Path(sys.argv[1]).iterdir() if item.is_file()]))
PY
    ;;
  'keyvault secret set')
    name="$(argument --name "$@")"
    expiration="$(argument --expires "$@")" || {
      printf 'Secret %s was created without an expiration\n' "$name" >&2
      exit 91
    }
    [[ "${AZ_MOCK_FAIL_HASH_SET:-}" != 1 || "$name" != admin-password-hash ]] || exit 88
    cp "$(argument --file "$@")" "$AZ_MOCK_STATE/secrets/$name"
    printf '%s\n' "$name" >> "$AZ_MOCK_STATE/secret-set.log"
    printf '%s\t%s\n' "$name" "$expiration" >> "$AZ_MOCK_STATE/secret-expiration.tsv"
    ;;
  'keyvault secret download')
    name="$(argument --name "$@")"
    cp "$AZ_MOCK_STATE/secrets/$name" "$(argument --file "$@")"
    ;;
  'ad signed-in-user show') printf '%s\n' 'operator-principal' ;;
  'role assignment list')
    principal="$(argument --assignee-object-id "$@")"
    scope="$(argument --scope "$@")"
    role="$(argument --role "$@")"
    python3 - "$AZ_MOCK_STATE/roles.tsv" "$principal" "$scope" "$role" <<'PY'
from pathlib import Path
import json
import sys
path, principal, scope, role = sys.argv[1:]
rows = [line.split("\t") for line in Path(path).read_text().splitlines()]
print(json.dumps([{"scope": scope, "id": row[3]} for row in rows if row[:3] == [principal, scope, role]]))
PY
    ;;
  'role assignment create')
    principal="$(argument --assignee-object-id "$@")"
    scope="$(argument --scope "$@")"
    role="$(argument --role "$@")"
    assignment="/role-assignments/$(wc -l < "$AZ_MOCK_STATE/roles.tsv" | tr -d ' ')"
    printf '%s\t%s\t%s\t%s\n' "$principal" "$scope" "$role" "$assignment" >> "$AZ_MOCK_STATE/roles.tsv"
    [[ "$*" != *'--query id'* ]] || printf '%s\n' "$assignment"
    ;;
  'role assignment delete')
    assignment="$(argument --ids "$@")"
    python3 - "$AZ_MOCK_STATE/roles.tsv" "$assignment" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text("".join(line for line in path.read_text().splitlines(keepends=True) if line.rstrip("\n").split("\t")[-1] != sys.argv[2]))
PY
    ;;
  'containerapp env show')
    printf '%s\n' '{"id":"/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.App/managedEnvironments/cae-twilio-comics-v2"}'
    ;;
  'identity show --name')
    case "$(argument --name "$@")" in
      id-twilio-comics-v2-web) printf '%s\n' '{"id":"/identity/web","principalId":"principal-web"}' ;;
      id-twilio-comics-v2-worker) printf '%s\n' '{"id":"/identity/worker","principalId":"principal-worker"}' ;;
      *) exit 90 ;;
    esac
    ;;
  'containerapp show --name'|'containerapp job show')
    name="$(argument --name "$@")"
    cat "$AZ_MOCK_STATE/$name.json"
    ;;
  'containerapp secret set'|'containerapp job secret')
    name="$(argument --name "$@")"
    spec="$(argument --secrets "$@")"
    if [[ "$1 $2 $3" == 'containerapp secret set' && \
        "$name" == "${AZ_MOCK_TRANSPORT_ONCE_SECRET_APP:-}" && \
        "$spec" == auth-secret=* && \
        ! -e "$AZ_MOCK_STATE/secret-transport-once.done" ]]; then
      : > "$AZ_MOCK_STATE/secret-transport-once.done"
      printf '%s\n' 'HTTPSConnectionPool(host=management.azure.com): url: /operationStatuses/secret?sig=mock-signed-url (Caused by SSLEOFError(UNEXPECTED_EOF_WHILE_READING))' >&2
      exit 97
    fi
    python3 - "$AZ_MOCK_STATE/$name.json" "$spec" <<'PY'
from pathlib import Path
import json
import sys
path = Path(sys.argv[1])
name, rest = sys.argv[2].split("=keyvaultref:", 1)
uri, identity = rest.split(",identityref:", 1)
data = json.loads(path.read_text())
items = data["properties"]["configuration"]["secrets"]
items[:] = [item for item in items if item["name"] != name]
items.append({"name": name, "keyVaultUrl": uri, "identity": identity})
path.write_text(json.dumps(data))
PY
    ;;
  'containerapp update --name'|'containerapp job update')
    name="$(argument --name "$@")"
    if [[ "$1 $2 $3" == 'containerapp job update' && \
        "$name" == "${AZ_MOCK_TRANSPORT_ONCE_JOB:-}" && \
        ! -e "$AZ_MOCK_STATE/transport-once.done" ]]; then
      : > "$AZ_MOCK_STATE/transport-once.done"
      printf '%s\n' 'HTTPSConnectionPool(host=management.azure.com): url: /operationStatuses/test?sig=mock-signed-url (Caused by SSLEOFError(UNEXPECTED_EOF_WHILE_READING))' >&2
      exit 97
    fi
    if [[ "$1 $2 $3" == 'containerapp job update' && \
        "$name" == "${AZ_MOCK_DENIED_JOB:-}" ]]; then
      printf '%s\n' 'ERROR: (AuthorizationFailed) See https://management.azure.com/operationStatuses/test?sig=mock-signed-url' >&2
      exit 98
    fi
    env_args=()
    capture=false
    for item in "$@"; do
      if [[ "$item" == --set-env-vars ]]; then capture=true; continue; fi
      if [[ "$item" == --only-show-errors ]]; then capture=false; fi
      [[ "$capture" != true ]] || env_args+=("$item")
    done
    python3 - "$AZ_MOCK_STATE/$name.json" "${env_args[@]}" <<'PY'
from pathlib import Path
import json
import sys
path = Path(sys.argv[1])
data = json.loads(path.read_text())
items = data["properties"]["template"]["containers"][0]["env"]
for spec in sys.argv[2:]:
    name, value = spec.split("=", 1)
    items[:] = [item for item in items if item["name"] != name]
    items.append({"name": name, "secretRef": value[10:]} if value.startswith("secretref:") else {"name": name, "value": value})
path.write_text(json.dumps(data))
PY
    ;;
  *) printf 'Unexpected Azure call: %s\n' "$*" >&2; exit 90 ;;
esac
AZ_MOCK
chmod 700 "$test_root/bin/az"

python3 - "$test_root/state" <<'PY'
from pathlib import Path
import json
import sys

state = Path(sys.argv[1])
env_id = "/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.App/managedEnvironments/cae-twilio-comics-v2"
db_uri = "https://kv-twilio-comics-1a1d98.vault.azure.net/secrets/postgres-comics-runtime-url"
for name, identity in [("twilio-comics-v2", "/identity/web"), ("twilio-comics-generation-v2", "/identity/worker"), ("twilio-comics-recovery-v2", "/identity/worker")]:
    data = {
        "identity": {"userAssignedIdentities": {identity: {}}},
        "properties": {
            "environmentId": env_id,
            "configuration": {"ingress": {"external": False}, "secrets": [{"name": "runtime-database-url", "keyVaultUrl": db_uri, "identity": identity}]},
            "template": {"scale": {"minReplicas": 0}, "containers": [{"env": [{"name": "DATABASE_URL", "secretRef": "runtime-database-url"}]}]},
        },
    }
    if name == "twilio-comics-recovery-v2":
        data["properties"]["template"]["containers"][0]["env"].append({"name": "RECOVERY_MODE", "value": "1"})
    (state / f"{name}.json").write_text(json.dumps(data))
PY

export AZ_MOCK_STATE="$test_root/state"
export AZ_MOCK_LOG="$test_root/az.log"
export PATH="$test_root/bin:$PATH"
export SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98'
TWILIO_ACCOUNT_SID="AC$(printf '%032d' 1)"
export TWILIO_ACCOUNT_SID
export CONFIGURE_RUNTIME_CONFIRM=yes
export OPERATOR_PUBLIC_IPV4='8.8.8.8'
export RUNTIME_ROLE_POLL_SECONDS=0
export RUNTIME_ACA_RETRY_SECONDS=0
vault_id="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-twilio-comics/providers/Microsoft.KeyVault/vaults/kv-twilio-comics-1a1d98"
printf 'operator-principal\t%s\tKey Vault Secrets Officer\t/role-assignments/operator-officer\n' "$vault_id" > "$AZ_MOCK_STATE/roles.tsv"

: > "$AZ_MOCK_LOG"
if (unset TWILIO_ACCOUNT_SID; bash "$project_root/scripts/configure-runtime-secrets.sh" > "$test_root/missing-sid.out" 2>&1); then
  printf 'Runtime setup accepted a missing Twilio Account SID\n' >&2
  exit 1
fi
grep -Fq 'Set TWILIO_ACCOUNT_SID' "$test_root/missing-sid.out"
[[ ! -s "$AZ_MOCK_LOG" ]]

if TWILIO_ACCOUNT_SID='AC-invalid' \
    bash "$project_root/scripts/configure-runtime-secrets.sh" > "$test_root/invalid-sid.out" 2>&1; then
  printf 'Runtime setup accepted an invalid Twilio Account SID\n' >&2
  exit 1
fi
grep -Fq 'Set TWILIO_ACCOUNT_SID' "$test_root/invalid-sid.out"
[[ ! -s "$AZ_MOCK_LOG" ]]

AZ_MOCK_TRANSPORT_ONCE_SECRET_APP='twilio-comics-v2' \
AZ_MOCK_TRANSPORT_ONCE_JOB='twilio-comics-generation-v2' \
  bash "$project_root/scripts/configure-runtime-secrets.sh" > "$test_root/first.out" 2>&1
grep -Fq 'Channels remain closed; web app remains internal' "$test_root/first.out"
grep -Fq 'transport error during secret binding for twilio-comics-v2/auth-secret; retrying (1/3)' "$test_root/first.out"
grep -Fq 'transport error during environment update for twilio-comics-generation-v2; retrying (1/3)' "$test_root/first.out"
[[ "$(grep -F 'containerapp secret set' "$AZ_MOCK_LOG" | grep -Fc 'auth-secret=keyvaultref')" == 2 ]]
[[ "$(grep -Fc 'containerapp job update --name twilio-comics-generation-v2' "$AZ_MOCK_LOG")" == 2 ]]
if grep -Fq 'mock-signed-url' "$test_root/first.out"; then
  printf 'A signed Azure operation URL leaked into runtime setup output\n' >&2
  exit 1
fi
[[ "$(wc -l < "$AZ_MOCK_STATE/secret-set.log" | tr -d ' ')" == 4 ]]
[[ "$(wc -l < "$AZ_MOCK_STATE/secret-expiration.tsv" | tr -d ' ')" == 4 ]]
jq --exit-status '
  .properties.configuration.ingress.external == false
  and .properties.template.scale.minReplicas == 0
  and ([.properties.template.containers[0].env[] | select(.name == "DATABASE_URL")][0].secretRef == "runtime-database-url")
  and ([.properties.template.containers[0].env[] | select(.name == "AUTH_SECRET")][0].secretRef == "auth-secret")
  and ([.properties.template.containers[0].env[] | select(.name == "ADMIN_PASSWORD_HASH")][0].secretRef == "admin-password-hash")
  and ([.properties.template.containers[0].env[] | select(.name == "TWILIO_ENABLED_CHANNELS")][0].value == "")
  and ([.properties.template.containers[0].env[] | select(.name == "TWILIO_VERIFY_SERVICE_SID")][0].value == "VA9fae12b38cb0a91645f514842476e647")
' "$AZ_MOCK_STATE/twilio-comics-v2.json" >/dev/null
for job in twilio-comics-generation-v2 twilio-comics-recovery-v2; do
  jq --exit-status '
    [.properties.template.containers[0].env[] | select(.name == "DATABASE_URL")][0].secretRef == "runtime-database-url"
    and [.properties.template.containers[0].env[] | select(.name == "MEDIA_SIGNING_SECRET")][0].secretRef == "media-signing-secret"
  ' "$AZ_MOCK_STATE/$job.json" >/dev/null
done
if grep -Eq 'principal-worker.*secrets/(auth-secret|admin-initial-password|admin-password-hash)' "$AZ_MOCK_STATE/roles.tsv"; then
  printf 'Worker received an admin or auth secret role\n' >&2
  exit 1
fi
if grep -Fq 'secrets/postgres-comics-runtime-url' "$AZ_MOCK_LOG" && \
    grep -Fq 'containerapp secret set' "$AZ_MOCK_LOG"; then
  # The database URI may appear in preflight data, but never in a secret-set call.
  if grep -E 'containerapp( job)? secret set' "$AZ_MOCK_LOG" | grep -Fq 'postgres-comics-runtime-url'; then
    printf 'Runtime script attempted to rewrite the database secret\n' >&2
    exit 1
  fi
fi
if grep -Fq "$(cat "$AZ_MOCK_STATE/secrets/admin-initial-password")" "$AZ_MOCK_LOG"; then
  printf 'Admin password leaked into Azure CLI arguments\n' >&2
  exit 1
fi

password_before="$(cat "$AZ_MOCK_STATE/secrets/admin-initial-password")"
hash_before="$(cat "$AZ_MOCK_STATE/secrets/admin-password-hash")"
mutation_count_before="$(grep -Ec '^containerapp (job )?(secret set|update)' "$AZ_MOCK_LOG")"
bash "$project_root/scripts/configure-runtime-secrets.sh" > "$test_root/repeat.out" 2>&1
mutation_count_after="$(grep -Ec '^containerapp (job )?(secret set|update)' "$AZ_MOCK_LOG")"
[[ "$mutation_count_after" == "$mutation_count_before" ]]
[[ "$(wc -l < "$AZ_MOCK_STATE/secret-set.log" | tr -d ' ')" == 4 ]]
[[ "$(wc -l < "$AZ_MOCK_STATE/secret-expiration.tsv" | tr -d ' ')" == 4 ]]
[[ "$(cat "$AZ_MOCK_STATE/secrets/admin-initial-password")" == "$password_before" ]]
[[ "$(cat "$AZ_MOCK_STATE/secrets/admin-password-hash")" == "$hash_before" ]]

cp "$AZ_MOCK_STATE/twilio-comics-recovery-v2.json" "$test_root/recovery-before-denied.json"
jq '.properties.template.containers[0].env |= map(select(.name != "MEDIA_SIGNING_SECRET"))' \
  "$test_root/recovery-before-denied.json" > "$AZ_MOCK_STATE/twilio-comics-recovery-v2.json"
denied_calls_before="$(grep -Fc 'containerapp job update --name twilio-comics-recovery-v2' "$AZ_MOCK_LOG")"
if AZ_MOCK_DENIED_JOB='twilio-comics-recovery-v2' \
    bash "$project_root/scripts/configure-runtime-secrets.sh" > "$test_root/denied.out" 2>&1; then
  printf 'Runtime setup ignored a non-retryable Azure permission failure\n' >&2
  exit 1
fi
denied_calls_after="$(grep -Fc 'containerapp job update --name twilio-comics-recovery-v2' "$AZ_MOCK_LOG")"
[[ $((denied_calls_after - denied_calls_before)) == 1 ]]
grep -Fq 'not a transient transport failure' "$test_root/denied.out"
if grep -Fq 'mock-signed-url' "$test_root/denied.out"; then
  printf 'A signed Azure operation URL leaked from a non-retryable failure\n' >&2
  exit 1
fi
cp "$test_root/recovery-before-denied.json" "$AZ_MOCK_STATE/twilio-comics-recovery-v2.json"

printf '%s\n' 'sk-proj-test-openai-key-with-sufficient-length' > "$test_root/openai.key"
printf '%s\n' '0123456789abcdef0123456789abcdef' > "$test_root/twilio.key"
chmod 600 "$test_root/openai.key" "$test_root/twilio.key"
OPENAI_API_KEY_FILE="$test_root/openai.key" TWILIO_AUTH_TOKEN_FILE="$test_root/twilio.key" \
  bash "$project_root/scripts/configure-runtime-secrets.sh" > "$test_root/optional.out" 2>&1
[[ "$(wc -l < "$AZ_MOCK_STATE/secret-set.log" | tr -d ' ')" == 6 ]]
python3 - "$AZ_MOCK_STATE/secret-expiration.tsv" <<'PY'
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

rows = [line.split("\t") for line in Path(sys.argv[1]).read_text().splitlines()]
expected_names = {
    "auth-secret", "media-signing-secret", "admin-initial-password",
    "admin-password-hash", "openai-api-key", "twilio-auth-token",
}
assert len(rows) == len(expected_names)
assert {name for name, _ in rows} == expected_names
now = datetime.now(timezone.utc)
for name, value in rows:
    expires = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    remaining = expires - now
    assert timedelta(days=364, hours=23) < remaining < timedelta(days=365, hours=1), name
PY
for workload in twilio-comics-v2 twilio-comics-generation-v2 twilio-comics-recovery-v2; do
  jq --exit-status '
    [.properties.template.containers[0].env[] | select(.name == "OPENAI_API_KEY")][0].secretRef == "openai-api-key"
    and [.properties.template.containers[0].env[] | select(.name == "TWILIO_AUTH_TOKEN")][0].secretRef == "twilio-auth-token"
  ' "$AZ_MOCK_STATE/$workload.json" >/dev/null
done
if grep -Fq '0123456789abcdef0123456789abcdef' "$AZ_MOCK_LOG" || \
    grep -Fq 'sk-proj-test-openai-key-with-sufficient-length' "$AZ_MOCK_LOG"; then
  printf 'API credential leaked into Azure CLI arguments\n' >&2
  exit 1
fi

printf '%s\n' 'fedcba9876543210fedcba9876543210' > "$test_root/twilio.key"
if OPENAI_API_KEY_FILE="$test_root/openai.key" TWILIO_AUTH_TOKEN_FILE="$test_root/twilio.key" \
    bash "$project_root/scripts/configure-runtime-secrets.sh" > "$test_root/mismatch.out" 2>&1; then
  printf 'A changed Twilio Auth Token silently rotated the stored secret\n' >&2
  exit 1
fi
grep -Fq 'no value was rotated' "$test_root/mismatch.out"
[[ "$(wc -l < "$AZ_MOCK_STATE/secret-set.log" | tr -d ' ')" == 6 ]]

jq '.properties.configuration.ingress.external = true' \
  "$AZ_MOCK_STATE/twilio-comics-v2.json" > "$test_root/external.json"
cp "$AZ_MOCK_STATE/twilio-comics-v2.json" "$test_root/internal.json"
cp "$test_root/external.json" "$AZ_MOCK_STATE/twilio-comics-v2.json"
if bash "$project_root/scripts/configure-runtime-secrets.sh" > "$test_root/external.out" 2>&1; then
  printf 'Prelaunch setup accepted an external web app\n' >&2
  exit 1
fi
grep -Fq 'must remain internal' "$test_root/external.out"
[[ "$(wc -l < "$AZ_MOCK_STATE/secret-set.log" | tr -d ' ')" == 6 ]]
cp "$test_root/internal.json" "$AZ_MOCK_STATE/twilio-comics-v2.json"

cp "$AZ_MOCK_STATE/twilio-comics-generation-v2.json" "$test_root/generation-good.json"
jq '(.properties.template.containers[0].env[] | select(.name == "DATABASE_URL")).secretRef = "wrong-secret"' \
  "$test_root/generation-good.json" > "$AZ_MOCK_STATE/twilio-comics-generation-v2.json"
if bash "$project_root/scripts/configure-runtime-secrets.sh" > "$test_root/database-conflict.out" 2>&1; then
  printf 'Runtime setup accepted a changed DATABASE_URL binding\n' >&2
  exit 1
fi
grep -Fq 'runtime DATABASE_URL reference' "$test_root/database-conflict.out"
[[ "$(wc -l < "$AZ_MOCK_STATE/secret-set.log" | tr -d ' ')" == 6 ]]
cp "$test_root/generation-good.json" "$AZ_MOCK_STATE/twilio-comics-generation-v2.json"

chmod 644 "$test_root/openai.key"
if OPENAI_API_KEY_FILE="$test_root/openai.key" \
    bash "$project_root/scripts/configure-runtime-secrets.sh" > "$test_root/file-mode.out" 2>&1; then
  printf 'Runtime setup accepted a group-readable credential file\n' >&2
  exit 1
fi
grep -Fq 'owner-only regular file' "$test_root/file-mode.out"
chmod 600 "$test_root/openai.key"

python3 - "$AZ_MOCK_STATE/roles.tsv" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
path.write_text("".join(line for line in path.read_text().splitlines(keepends=True) if "/role-assignments/operator-officer" not in line))
PY
AZ_MOCK_REQUIRE_TEMP_OFFICER=1 \
  bash "$project_root/scripts/configure-runtime-secrets.sh" > "$test_root/temporary-role.out" 2>&1
if grep -Fq $'operator-principal\t'"$vault_id"$'\tKey Vault Secrets Officer\t' "$AZ_MOCK_STATE/roles.tsv"; then
  printf 'Temporary operator Secrets Officer grant was not revoked\n' >&2
  exit 1
fi
grep -Fq 'role assignment delete --ids /role-assignments/' "$AZ_MOCK_LOG"

printf 'Runtime secret setup mock tests passed.\n'
