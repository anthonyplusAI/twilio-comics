#!/usr/bin/env bash
set -euo pipefail

# Exercise the OIDC preflight without allowing any Azure or GitHub mutation.
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/repo/scripts"
cp "$PROJECT_ROOT/scripts/provision-azure.sh" "$TEST_ROOT/repo/scripts/"
git -C "$TEST_ROOT/repo" init -q

cat > "$TEST_ROOT/bin/az" <<'AZ'
#!/usr/bin/env bash
case "$*" in
  'account show --output none'|'account set --subscription test-subscription') exit 0 ;;
  *) printf 'Unexpected Azure call: %s\n' "$*" >&2; exit 90 ;;
esac
AZ
cat > "$TEST_ROOT/bin/gh" <<'GH'
#!/usr/bin/env bash
case "$*" in
  'auth status'|api\ repos/*' --jq .full_name') exit 0 ;;
  *) printf 'Unexpected GitHub call: %s\n' "$*" >&2; exit 90 ;;
esac
GH
chmod +x "$TEST_ROOT/bin/az" "$TEST_ROOT/bin/gh"

assert_subject() {
  local remote="$1" expected="$2" output status
  git -C "$TEST_ROOT/repo" remote remove origin 2>/dev/null || true
  git -C "$TEST_ROOT/repo" remote add origin "$remote"
  set +e
  output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
    ACR_NAME=testacr STORAGE_ACCOUNT=teststorage \
    bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
  status=$?
  set -e
  [[ "$status" == 1 ]] || { printf '%s\n' "$output" >&2; exit 1; }
  [[ "$output" == *"OIDC subject: repo:${expected}:environment:production"* ]] \
    || { printf '%s\n' "$output" >&2; exit 1; }
  [[ "$output" == *'Set PROVISION_AZURE_CONFIRM=yes'* ]] \
    || { printf '%s\n' "$output" >&2; exit 1; }
}

assert_subject 'git@github.com:current-owner/twilio-comics.git' 'current-owner/twilio-comics'
assert_subject 'https://github.com/new-owner/twilio-comics.git' 'new-owner/twilio-comics'
assert_subject 'ssh://git@github.com/third-owner/twilio-comics.git' 'third-owner/twilio-comics'

# Reuse mocked existing foundation resources and stop at the scheduled Job's
# create call. This verifies the exact Azure CLI request without touching Azure.
cat > "$TEST_ROOT/bin/az" <<'AZ_RECOVERY'
#!/usr/bin/env bash
set -euo pipefail

after() {
  local key="$1" previous='' item
  shift
  for item in "$@"; do
    if [[ "$previous" == "$key" ]]; then printf '%s\n' "$item"; return; fi
    previous="$item"
  done
}
workload_json() {
  local identity="$1" client="$2"
  cat <<EOF
{"identity":{"userAssignedIdentities":{"$identity":{},"/identity/pull":{}}},"properties":{"configuration":{"ingress":{"external":${AZURE_TEST_INGRESS_EXTERNAL:-true},"targetPort":${AZURE_TEST_INGRESS_PORT:-8080},"transport":"auto"},"registries":[{"server":"testacr.azurecr.io","identity":"/identity/pull"}]},"template":{"containers":[{"env":[{"name":"AZURE_CLIENT_ID","value":"$client"},{"name":"AZURE_STORAGE_BLOB_ENDPOINT","value":"https://teststorage.blob.core.windows.net"},{"name":"AZURE_STORAGE_QUEUE_ENDPOINT","value":"https://teststorage.queue.core.windows.net"},{"name":"AZURE_STORAGE_CONTAINER_NAME","value":"comics"},{"name":"AZURE_STORAGE_QUEUE_NAME","value":"comic-generation"},{"name":"AZURE_STORAGE_POISON_QUEUE_NAME","value":"comic-generation-poison"}]}]}}}
EOF
}

case "$1 $2 ${3:-}" in
  'account show --output'|'account set --subscription'|'extension add --name') exit 0 ;;
  'provider show --namespace')
    if [[ "$(after --namespace "$@")" == "${AZURE_TEST_UNREGISTERED_PROVIDER:-}" ]]; then
      printf 'NotRegistered\n'
    else
      printf 'Registered\n'
    fi
    exit 0 ;;
  'containerapp job create')
    if [[ "${4:-}" == --help ]]; then printf '%s\n' '--scale-rule-identity'; exit 0; fi
    printf '%s\n' "$@" > "$AZURE_TEST_LOG"
    exit 77 ;;
  'containerapp create --name')
    printf '%s\n' "$@" > "$AZURE_TEST_LOG"
    exit 76 ;;
  'group show --name')
    [[ "${*}" == *'--query id'* ]] && printf '/resource-group\n'
    exit 0 ;;
  'acr show --name')
    case "$(after --query "$@")" in
      id) printf '/acr\n' ;;
      loginServer) printf 'testacr.azurecr.io\n' ;;
    esac
    exit 0 ;;
  'containerapp env show') exit 0 ;;
  'storage account show')
    [[ "${*}" == *'--query id'* ]] && printf '/storage\n'
    exit 0 ;;
  'storage container create'|'storage queue create') exit 0 ;;
  'identity show --name')
    name="$(after --name "$@")"
    case "$(after --query "$@")" in
      id)
        case "$name" in
          *-web) printf '/identity/web\n' ;;
          *-worker) printf '/identity/worker\n' ;;
          *-acr-pull) printf '/identity/pull\n' ;;
        esac ;;
      principalId) printf 'principal-%s\n' "$name" ;;
      clientId)
        case "$name" in
          *-web) printf 'web-client\n' ;;
          *-worker) printf 'worker-client\n' ;;
          *-acr-pull) printf 'pull-client\n' ;;
        esac ;;
    esac
    exit 0 ;;
  'role assignment list') printf '1\n'; exit 0 ;;
  'ad signed-in-user show') printf 'user-object\n'; exit 0 ;;
  'containerapp show --name')
    [[ "${AZURE_TEST_MISSING_APP:-}" == 1 ]] && exit 1
    [[ "${*}" == *'--output json'* ]] && workload_json '/identity/web' 'web-client'
    exit 0 ;;
  'containerapp job show')
    name="$(after --name "$@")"
    [[ "$name" == twilio-comics-recovery ]] && exit 1
    [[ "${*}" == *'--output json'* ]] && workload_json '/identity/worker' 'worker-client'
    exit 0 ;;
  *) printf 'Unexpected Azure call: %s\n' "$*" >&2; exit 90 ;;
esac
AZ_RECOVERY
chmod +x "$TEST_ROOT/bin/az"

AZURE_TEST_LOG="$TEST_ROOT/recovery-create-args"
export AZURE_TEST_LOG
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 77 ]] || { printf '%s\n' "$output" >&2; exit 1; }

arg_after() { awk -v key="$1" '$0 == key { getline; print; exit }' "$AZURE_TEST_LOG"; }
[[ "$(arg_after --name)" == twilio-comics-recovery ]]
[[ "$(arg_after --trigger-type)" == Schedule ]]
[[ "$(arg_after --cron-expression)" == '*/5 * * * *' ]]
[[ "$(arg_after --command)" == pnpm ]]
[[ "$(arg_after --args)" == start:worker ]]
[[ "$(arg_after --image)" == 'mcr.microsoft.com/dotnet/samples:aspnetapp' ]]
grep -Fxq 'RECOVERY_MODE=1' "$AZURE_TEST_LOG"
grep -Fxq 'AZURE_CLIENT_ID=worker-client' "$AZURE_TEST_LOG"
grep -Fxq '/identity/worker' "$AZURE_TEST_LOG"
grep -Fxq '/identity/pull' "$AZURE_TEST_LOG"
grep -Fxq 'created_by=github-actions' "$AZURE_TEST_LOG"
grep -Fxq 'managed_by=twilio-comics-ci' "$AZURE_TEST_LOG"

# A new app's public placeholder must listen on the same port as ingress and
# ACA's default TCP probes, or its first revision cannot become healthy.
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  AZURE_TEST_MISSING_APP=1 bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 76 ]] || { printf '%s\n' "$output" >&2; exit 1; }
[[ "$(arg_after --name)" == twilio-comics ]]
[[ "$(arg_after --image)" == 'mcr.microsoft.com/dotnet/samples:aspnetapp' ]]
[[ "$(arg_after --target-port)" == 8080 ]]
[[ "$(arg_after --termination-grace-period)" == 240 ]]

# A reused app on the wrong port must fail before identity/env/registry
# modifications, so the operator can switch its live ingress deliberately.
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  AZURE_TEST_INGRESS_PORT=80 bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 1 ]] || { printf '%s\n' "$output" >&2; exit 1; }
[[ "$output" == *"must have external HTTP ingress on port 8080"* ]] \
  || { printf '%s\n' "$output" >&2; exit 1; }
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  AZURE_TEST_INGRESS_EXTERNAL=false bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 1 ]] || { printf '%s\n' "$output" >&2; exit 1; }
[[ "$output" == *"must have external HTTP ingress on port 8080"* ]] \
  || { printf '%s\n' "$output" >&2; exit 1; }

# Provider registration is checked before any ARM resource creation.
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  AZURE_TEST_UNREGISTERED_PROVIDER=Microsoft.App \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 1 ]] || { printf '%s\n' "$output" >&2; exit 1; }
[[ "$output" == *"az provider register --namespace Microsoft.App --wait"* ]] \
  || { printf '%s\n' "$output" >&2; exit 1; }
printf 'Azure provisioning OIDC, provider, app ingress, and recovery Job mocks passed.\n'
