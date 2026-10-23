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

# Reuse mocked foundation resources and stop at each Job's create call. This
# verifies the Azure CLI requests without touching Azure.
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
  local id="$1" identity="$2" client="$3"
  cat <<EOF
{"id":"$id","identity":{"userAssignedIdentities":{"$identity":{},"/identity/pull":{}}},"properties":{"configuration":{"ingress":{"external":${AZURE_TEST_INGRESS_EXTERNAL:-true},"targetPort":${AZURE_TEST_INGRESS_PORT:-8080},"transport":"auto"},"registries":[{"server":"testacr.azurecr.io","identity":"/identity/pull"}]},"template":{"containers":[{"image":"${AZURE_TEST_APP_IMAGE:-testacr.azurecr.io/twilio-comics@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}","env":[{"name":"AZURE_CLIENT_ID","value":"$client"},{"name":"AZURE_STORAGE_BLOB_ENDPOINT","value":"https://teststorage.blob.core.windows.net"},{"name":"AZURE_STORAGE_QUEUE_ENDPOINT","value":"https://teststorage.queue.core.windows.net"},{"name":"AZURE_STORAGE_CONTAINER_NAME","value":"comics"},{"name":"AZURE_STORAGE_QUEUE_NAME","value":"comic-generation"},{"name":"AZURE_STORAGE_POISON_QUEUE_NAME","value":"comic-generation-poison"}]}]}}}
EOF
}

case "$1 $2 ${3:-}" in
  'account show --output'|'account set --subscription'|'extension add --name') exit 0 ;;
  'account show --query') printf 'tenant-test\n'; exit 0 ;;
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
  'containerapp job update')
    if [[ "${*}" == *'--polling-interval'* ]]; then
      printf '%s\n' "$*" >> "${AZURE_TEST_JOB_UPDATE_LOG:?}"
      if [[ -n "${AZURE_TEST_EVENT_POLLING_FILE:-}" ]]; then
        after --polling-interval "$@" > "$AZURE_TEST_EVENT_POLLING_FILE"
      fi
    fi
    exit 0 ;;
  'group show --name')
    [[ "${*}" == *'--query id'* ]] && printf '/resource-group\n'
    exit 0 ;;
  'acr show --name')
    case "$(after --query "$@")" in
      id) printf '/acr\n' ;;
      loginServer) printf 'testacr.azurecr.io\n' ;;
    esac
    exit 0 ;;
  'containerapp env show')
    if [[ "${*}" == *'--query properties.provisioningState'* ]]; then
      if [[ "${AZURE_TEST_ENV_READ_FAIL_ONCE:-}" == 1 && ! -e "${AZURE_TEST_ENV_READ_FILE:-/dev/null}" ]]; then
        : > "$AZURE_TEST_ENV_READ_FILE"
        printf 'Transient Azure transport error\n' >&2
        exit 55
      fi
      if [[ "${AZURE_TEST_ENV_WAIT_ONCE:-}" == 1 && ! -e "${AZURE_TEST_ENV_STATE_FILE:-/dev/null}" ]]; then
        : > "$AZURE_TEST_ENV_STATE_FILE"
        printf 'Waiting\n'
      else
        printf '%s\n' "${AZURE_TEST_ENV_STATE:-Succeeded}"
      fi
    fi
    exit 0 ;;
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
  'role assignment list')
    role="$(after --role "$@")"
    if [[ "${*}" == *'--output json'* ]]; then
      if [[ "$role" == Contributor && "${AZURE_TEST_LEGACY_ASSIGNMENT:-}" == 1 ]]; then
        printf '[{"id":"/roleAssignments/legacy-direct","scope":"/resource-group","roleDefinitionName":"Contributor"}]\n'
      else
        printf '[]\n'
      fi
    elif [[ "$role" == 'Container Apps Contributor' || "$role" == 'Container Apps Jobs Contributor' || "$role" == AcrPush ]]; then
      if [[ "$(after --scope "$@")" == *'/twilio-comics-migrate-v2' ]]; then
        printf '%s\n' "${AZURE_TEST_MIGRATION_ROLE_COUNT:-0}"
      else
        printf '%s\n' "${AZURE_TEST_DEPLOY_ROLE_COUNT:-0}"
      fi
    else
      printf '1\n'
    fi
    exit 0 ;;
  'role assignment create'|'role assignment delete')
    printf '%s\n' "$*" >> "$AZURE_TEST_ACTION_LOG"
    exit 0 ;;
  'ad signed-in-user show') printf 'user-object\n'; exit 0 ;;
  'ad app list') printf '[{"displayName":"twilio-comics-v2-gha-deploy","appId":"deploy-app"}]\n'; exit 0 ;;
  'ad sp show')
    [[ "${*}" == *'--query id'* ]] && printf 'principal-deploy\n'
    exit 0 ;;
  'ad app federated-credential')
    case "${4:-}" in
      list)
        if [[ "${AZURE_TEST_FEDERATED_EXISTS:-}" == 1 ]]; then
          jq -n --arg subject "${AZURE_TEST_FEDERATED_SUBJECT:-repo:third-owner/twilio-comics:environment:production}" \
            '[{"name":"gha-production","issuer":"https://token.actions.githubusercontent.com","subject":$subject,"audiences":["api://AzureADTokenExchange"]}]'
        else
          printf '[]\n'
        fi ;;
      create|update)
        printf '%s\n' "$*" >> "$AZURE_TEST_FEDERATED_LOG" ;;
      *) printf 'Unexpected federated-credential action: %s\n' "${4:-}" >&2; exit 90 ;;
    esac
    exit 0 ;;
  'containerapp show --name')
    [[ "${AZURE_TEST_MISSING_APP:-}" == 1 ]] && exit 1
    name="$(after --name "$@")"
    [[ "${*}" == *'--query id'* ]] && printf '/resource-group/providers/Microsoft.App/containerApps/%s\n' "$name"
    [[ "${*}" == *'--output json'* ]] && workload_json \
      "/resource-group/providers/Microsoft.App/containerApps/$name" '/identity/web' 'web-client'
    exit 0 ;;
  'containerapp job show')
    name="$(after --name "$@")"
    [[ "$name" == twilio-comics-generation && "${AZURE_TEST_MISSING_EVENT_JOB:-}" == 1 ]] && exit 1
    [[ "$name" == twilio-comics-recovery && "${AZURE_TEST_ALL_JOBS_EXIST:-}" != 1 ]] && exit 1
    [[ "$name" == twilio-comics-migrate-v2 && "${AZURE_TEST_MIGRATION_EXISTS:-}" != 1 ]] && exit 1
    [[ "${*}" == *'--query id'* ]] && printf '/resource-group/providers/Microsoft.App/jobs/%s\n' "$name"
    if [[ "${*}" == *'--output json'* ]]; then
      if [[ "$name" == twilio-comics-generation* ]]; then
        polling_interval="${AZURE_TEST_EVENT_POLLING_INTERVAL:-5}"
        if [[ -n "${AZURE_TEST_EVENT_POLLING_FILE:-}" && -e "$AZURE_TEST_EVENT_POLLING_FILE" ]]; then
          polling_interval="$(< "$AZURE_TEST_EVENT_POLLING_FILE")"
        fi
        workload_json \
          "/resource-group/providers/Microsoft.App/jobs/$name" '/identity/worker' 'worker-client' \
          | jq --arg trigger "${AZURE_TEST_GENERATION_TRIGGER_TYPE:-Event}" \
              --argjson polling "$polling_interval" \
              '.properties.configuration.triggerType = $trigger
                | .properties.configuration.eventTriggerConfig.scale.pollingInterval = $polling'
      else
        workload_json \
          "/resource-group/providers/Microsoft.App/jobs/$name" '/identity/worker' 'worker-client'
      fi
    fi
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
  AZURE_TEST_MISSING_EVENT_JOB=1 bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 77 ]] || { printf '%s\n' "$output" >&2; exit 1; }
arg_after() { awk -v key="$1" '$0 == key { getline; print; exit }' "$AZURE_TEST_LOG"; }
[[ "$(arg_after --name)" == twilio-comics-generation ]]
[[ "$(arg_after --trigger-type)" == Event ]]
[[ "$(arg_after --polling-interval)" == 5 ]]
[[ "$(arg_after --scale-rule-type)" == azure-queue ]]

set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 77 ]] || { printf '%s\n' "$output" >&2; exit 1; }

[[ "$(arg_after --name)" == twilio-comics-recovery ]]
[[ "$(arg_after --trigger-type)" == Schedule ]]
[[ "$(arg_after --cron-expression)" == '0 0 1 1 *' ]] || {
  printf 'Recovery placeholder must remain dormant until first deploy.\n' >&2
  exit 1
}
[[ "$(arg_after --command)" == pnpm ]]
[[ "$(arg_after --args)" == start:worker ]]
[[ "$(arg_after --image)" == 'mcr.microsoft.com/dotnet/samples:aspnetapp' ]]
grep -Fxq 'RECOVERY_MODE=1' "$AZURE_TEST_LOG"
grep -Fxq 'AZURE_CLIENT_ID=worker-client' "$AZURE_TEST_LOG"
grep -Fxq '/identity/worker' "$AZURE_TEST_LOG"
grep -Fxq '/identity/pull' "$AZURE_TEST_LOG"
grep -Fxq 'created_by=github-actions' "$AZURE_TEST_LOG"
grep -Fxq 'managed_by=twilio-comics-ci' "$AZURE_TEST_LOG"

# A new placeholder has no public ingress and no always-on replica.
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  AZURE_TEST_MISSING_APP=1 bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 76 ]] || { printf '%s\n' "$output" >&2; exit 1; }
[[ "$(arg_after --name)" == twilio-comics ]]
[[ "$(arg_after --image)" == 'mcr.microsoft.com/dotnet/samples:aspnetapp' ]]
[[ "$(arg_after --ingress)" == internal ]]
[[ "$(arg_after --target-port)" == 8080 ]]
[[ "$(arg_after --min-replicas)" == 0 ]]
[[ "$(arg_after --termination-grace-period)" == 240 ]]

# A resumed run waits for an existing ACA environment to finish provisioning
# before it attempts to create a Container App inside that environment.
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  AZURE_TEST_MISSING_APP=1 AZURE_TEST_ENV_WAIT_ONCE=1 \
  AZURE_TEST_ENV_STATE_FILE="$TEST_ROOT/env-wait-seen" AZURE_ENV_POLL_SECONDS=0 \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 76 && -e "$TEST_ROOT/env-wait-seen" ]] || {
  printf '%s\n' "$output" >&2
  exit 1
}

# A single failed ARM read during environment provisioning should be retried.
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  AZURE_TEST_MISSING_APP=1 AZURE_TEST_ENV_READ_FAIL_ONCE=1 \
  AZURE_TEST_ENV_READ_FILE="$TEST_ROOT/env-read-failed" AZURE_ENV_POLL_SECONDS=0 \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 76 && -e "$TEST_ROOT/env-read-failed" ]] || {
  printf '%s\n' "$output" >&2
  exit 1
}

# A reused app on the wrong port must fail before identity/env/registry
# modifications, so the operator can switch its live ingress deliberately.
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  AZURE_TEST_INGRESS_PORT=80 bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 1 ]] || { printf '%s\n' "$output" >&2; exit 1; }
[[ "$output" == *"must have HTTP ingress on port 8080"* ]] \
  || { printf '%s\n' "$output" >&2; exit 1; }

# Internal ingress is valid for an existing app and remains private on rerun.
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  AZURE_TEST_INGRESS_EXTERNAL=false bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 77 ]] || { printf '%s\n' "$output" >&2; exit 1; }

# An old public sample must be fixed before provisioning continues.
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  AZURE_TEST_APP_IMAGE='mcr.microsoft.com/dotnet/samples:aspnetapp' \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 1 ]] || { printf '%s\n' "$output" >&2; exit 1; }
[[ "$output" == *"exposes the sample placeholder"* ]] \
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

# Complete a V2 foundation run with scoped deployment grants. The migration
# Job does not exist yet, so it receives no assignment on this run.
cat > "$TEST_ROOT/bin/gh" <<'GH_FULL'
#!/usr/bin/env bash
set -euo pipefail
repo_api='repos/third-owner/twilio-comics'
environment_api="${repo_api}/environments/production"
state_dir="$AZURE_TEST_GH_STATE_DIR"
mkdir -p "$state_dir"

case "$1" in
  auth) [[ "${2:-}" == status ]] && exit 0 ;;
  variable|secret)
    [[ "${2:-}" == set ]] || exit 90
    printf '%s\n' "$*" >> "$AZURE_TEST_GH_LOG"
    exit 0 ;;
  api) shift ;;
  *) printf 'Unexpected GitHub call: %s\n' "$*" >&2; exit 90 ;;
esac

method=GET
endpoint=''
input=''
fields=()
while (($#)); do
  case "$1" in
    --method) method="$2"; shift 2 ;;
    --input) input="$2"; shift 2 ;;
    --field) fields+=("$2"); shift 2 ;;
    --paginate|--slurp) shift ;;
    --jq) shift 2 ;;
    repos/*) endpoint="$1"; shift ;;
    *) printf 'Unexpected GitHub API argument: %s\n' "$1" >&2; exit 90 ;;
  esac
done

case "$method:$endpoint" in
  "GET:$repo_api") printf '%s\n' 'third-owner/twilio-comics'; exit 0 ;;
  "GET:${repo_api}/environments?per_page=100")
    [[ "${AZURE_TEST_GH_FAIL_LIST:-}" == 1 ]] && exit 91
    if [[ "${AZURE_TEST_GH_SCENARIO:-new}" == new && ! -e "$state_dir/environment-created" ]]; then
      printf '[{"environments":[]}]\n'
    else
      printf '[{"environments":[{"name":"production"}]}]\n'
    fi
    exit 0 ;;
  "GET:$environment_api")
    if [[ "${AZURE_TEST_GH_SCENARIO:-new}" == new && ! -e "$state_dir/environment-created" ]]; then
      exit 92
    fi
    if [[ "${AZURE_TEST_GH_SCENARIO:-new}" == unrestricted && ! -e "$state_dir/mode-custom" ]]; then
      cat <<'JSON'
{"name":"production","protection_rules":[{"type":"wait_timer","wait_timer":7},{"type":"required_reviewers","prevent_self_review":true,"reviewers":[{"type":"User","reviewer":{"id":42}}]}],"deployment_branch_policy":null}
JSON
    else
      printf '{"name":"production","protection_rules":[],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}\n'
    fi
    exit 0 ;;
  "PUT:$environment_api")
    [[ "$input" == - ]] || exit 93
    cat > "$state_dir/environment-put.json"
    jq -e '.deployment_branch_policy == {"protected_branches":false,"custom_branch_policies":true}' \
      "$state_dir/environment-put.json" >/dev/null || exit 94
    printf 'api PUT %s\n' "$endpoint" >> "$AZURE_TEST_GH_LOG"
    : > "$state_dir/environment-created"
    : > "$state_dir/mode-custom"
    exit 0 ;;
  "GET:${environment_api}/deployment-branch-policies?per_page=100")
    case "${AZURE_TEST_GH_SCENARIO:-new}" in
      custom_main) policies='[{"id":1,"name":"main"}]' ;;
      custom_extra)
        if [[ -e "$state_dir/extra-deleted" ]]; then
          policies='[{"id":1,"name":"main"}]'
        else
          policies='[{"id":1,"name":"main"},{"id":2,"name":"release/*"}]'
        fi ;;
      custom_tag)
        if [[ -e "$state_dir/extra-deleted" ]]; then
          policies='[{"id":3,"name":"main","type":"branch"}]'
        elif [[ -e "$state_dir/main-created" ]]; then
          policies='[{"id":2,"name":"main","type":"tag"},{"id":3,"name":"main","type":"branch"}]'
        else
          policies='[{"id":2,"name":"main","type":"tag"}]'
        fi ;;
      *)
        if [[ -e "$state_dir/main-created" ]]; then
          policies='[{"id":1,"name":"main"}]'
        else
          policies='[]'
        fi ;;
    esac
    printf '[{"branch_policies":%s}]\n' "$policies"
    exit 0 ;;
  "POST:${environment_api}/deployment-branch-policies")
    [[ " ${fields[*]} " == *' name=main '* && " ${fields[*]} " == *' type=branch '* ]] || exit 95
    printf 'api POST %s\n' "$endpoint" >> "$AZURE_TEST_GH_LOG"
    : > "$state_dir/main-created"
    exit 0 ;;
  "DELETE:${environment_api}/deployment-branch-policies/2")
    printf 'api DELETE %s\n' "$endpoint" >> "$AZURE_TEST_GH_LOG"
    : > "$state_dir/extra-deleted"
    exit 0 ;;
  *) printf 'Unexpected GitHub API call: %s %s\n' "$method" "$endpoint" >&2; exit 90 ;;
esac
GH_FULL
chmod +x "$TEST_ROOT/bin/gh"
AZURE_TEST_ACTION_LOG="$TEST_ROOT/role-actions"
AZURE_TEST_FEDERATED_LOG="$TEST_ROOT/federated-actions"
AZURE_TEST_GH_LOG="$TEST_ROOT/gh-actions"
AZURE_TEST_GH_STATE_DIR="$TEST_ROOT/gh-state"
export AZURE_TEST_ACTION_LOG AZURE_TEST_FEDERATED_LOG AZURE_TEST_GH_LOG AZURE_TEST_GH_STATE_DIR
: > "$AZURE_TEST_ACTION_LOG"
: > "$AZURE_TEST_FEDERATED_LOG"
: > "$AZURE_TEST_GH_LOG"

# A broad, direct legacy assignment requires a separate operator review. The
# foundation script must not remove it or claim narrow access while it exists.
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  ACA_ENVIRONMENT=cae-twilio-comics-v2 ACA_NAME=twilio-comics-v2 \
  ACA_JOB_NAME=twilio-comics-generation-v2 \
  ACA_RECOVERY_JOB_NAME=twilio-comics-recovery-v2 \
  AZURE_TEST_LEGACY_ASSIGNMENT=1 AZURE_DEPLOY_RBAC_POLL_SECONDS=0 \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 1 ]] || { printf '%s\n' "$output" >&2; exit 1; }
[[ "$output" == *'Review and revoke that assignment manually'* ]] \
  || { printf '%s\n' "$output" >&2; exit 1; }
[[ ! -s "$AZURE_TEST_ACTION_LOG" ]]

set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  ACA_ENVIRONMENT=cae-twilio-comics-v2 ACA_NAME=twilio-comics-v2 \
  ACA_JOB_NAME=twilio-comics-generation-v2 \
  ACA_RECOVERY_JOB_NAME=twilio-comics-recovery-v2 \
  AZURE_DEPLOY_RBAC_POLL_SECONDS=0 \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 0 ]] || { printf '%s\n' "$output" >&2; exit 1; }
grep -Fq 'role assignment create --assignee-object-id principal-deploy --assignee-principal-type ServicePrincipal --scope /acr --role AcrPush' "$AZURE_TEST_ACTION_LOG"
grep -Fq 'role assignment create --assignee-object-id principal-deploy --assignee-principal-type ServicePrincipal --scope /resource-group/providers/Microsoft.App/containerApps/twilio-comics-v2 --role Container Apps Contributor' "$AZURE_TEST_ACTION_LOG"
grep -Fq 'role assignment create --assignee-object-id principal-deploy --assignee-principal-type ServicePrincipal --scope /resource-group/providers/Microsoft.App/jobs/twilio-comics-generation-v2 --role Container Apps Jobs Contributor' "$AZURE_TEST_ACTION_LOG"
grep -Fq 'role assignment create --assignee-object-id principal-deploy --assignee-principal-type ServicePrincipal --scope /resource-group/providers/Microsoft.App/jobs/twilio-comics-recovery-v2 --role Container Apps Jobs Contributor' "$AZURE_TEST_ACTION_LOG"
for forbidden in 'role assignment delete' ' --scope /resource-group --role Contributor' 'twilio-comics-migrate-v2 --role'; do
  if grep -Fq "$forbidden" "$AZURE_TEST_ACTION_LOG"; then
    printf 'Unexpected role mutation: %s\n' "$forbidden" >&2
    exit 1
  fi
done
grep -Fq 'variable set ACA_MIGRATION_JOB_NAME --repo third-owner/twilio-comics --body twilio-comics-migrate-v2' "$AZURE_TEST_GH_LOG"
grep -Fq 'api PUT repos/third-owner/twilio-comics/environments/production' "$AZURE_TEST_GH_LOG"
grep -Fq 'api POST repos/third-owner/twilio-comics/environments/production/deployment-branch-policies' "$AZURE_TEST_GH_LOG"
[[ "$output" == *'does not exist yet; rerun this script after role bootstrap'* ]]

# Once role bootstrap creates the migration Job, rerunning adds only its
# scoped grant and leaves all existing grants untouched.
: > "$AZURE_TEST_ACTION_LOG"
: > "$AZURE_TEST_GH_LOG"
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  ACA_ENVIRONMENT=cae-twilio-comics-v2 ACA_NAME=twilio-comics-v2 \
  ACA_JOB_NAME=twilio-comics-generation-v2 \
  ACA_RECOVERY_JOB_NAME=twilio-comics-recovery-v2 \
  AZURE_TEST_MIGRATION_EXISTS=1 AZURE_TEST_DEPLOY_ROLE_COUNT=1 \
  AZURE_TEST_FEDERATED_EXISTS=1 AZURE_DEPLOY_RBAC_POLL_SECONDS=0 \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 0 ]] || { printf '%s\n' "$output" >&2; exit 1; }
[[ "$(wc -l < "$AZURE_TEST_ACTION_LOG" | tr -d ' ')" == 1 ]]
grep -Fq 'role assignment create --assignee-object-id principal-deploy --assignee-principal-type ServicePrincipal --scope /resource-group/providers/Microsoft.App/jobs/twilio-comics-migrate-v2 --role Container Apps Jobs Contributor' "$AZURE_TEST_ACTION_LOG"
if grep -Eq 'api (PUT|POST|DELETE) repos/.*/environments/production' "$AZURE_TEST_GH_LOG"; then
  printf 'Rerun unexpectedly changed GitHub environment policy.\n' >&2
  exit 1
fi

# A third run with every grant present does not create or delete a role.
: > "$AZURE_TEST_ACTION_LOG"
: > "$AZURE_TEST_GH_LOG"
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  ACA_ENVIRONMENT=cae-twilio-comics-v2 ACA_NAME=twilio-comics-v2 \
  ACA_JOB_NAME=twilio-comics-generation-v2 \
  ACA_RECOVERY_JOB_NAME=twilio-comics-recovery-v2 \
  AZURE_TEST_MIGRATION_EXISTS=1 AZURE_TEST_DEPLOY_ROLE_COUNT=1 \
  AZURE_TEST_MIGRATION_ROLE_COUNT=1 AZURE_TEST_FEDERATED_EXISTS=1 \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 0 && ! -s "$AZURE_TEST_ACTION_LOG" ]] \
  || { printf '%s\n' "$output" >&2; exit 1; }
if grep -Eq 'api (PUT|POST|DELETE) repos/.*/environments/production' "$AZURE_TEST_GH_LOG"; then
  printf 'Idempotent rerun unexpectedly changed GitHub environment policy.\n' >&2
  exit 1
fi

# An existing generation Job is reconciled with one narrowly scoped update.
# Its next provisioning run should see the persisted value and skip the update.
AZURE_TEST_JOB_UPDATE_LOG="$TEST_ROOT/job-updates"
AZURE_TEST_EVENT_POLLING_FILE="$TEST_ROOT/event-polling"
export AZURE_TEST_JOB_UPDATE_LOG
printf '15\n' > "$AZURE_TEST_EVENT_POLLING_FILE"
: > "$AZURE_TEST_JOB_UPDATE_LOG"
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  ACA_ENVIRONMENT=cae-twilio-comics-v2 ACA_NAME=twilio-comics-v2 \
  ACA_JOB_NAME=twilio-comics-generation-v2 \
  ACA_RECOVERY_JOB_NAME=twilio-comics-recovery-v2 \
  AZURE_TEST_EVENT_POLLING_FILE="$AZURE_TEST_EVENT_POLLING_FILE" \
  AZURE_TEST_MIGRATION_EXISTS=1 AZURE_TEST_DEPLOY_ROLE_COUNT=1 \
  AZURE_TEST_MIGRATION_ROLE_COUNT=1 AZURE_TEST_FEDERATED_EXISTS=1 \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 0 && "$(< "$AZURE_TEST_EVENT_POLLING_FILE")" == 5 ]] \
  || { printf '%s\n' "$output" >&2; exit 1; }
[[ "$(< "$AZURE_TEST_JOB_UPDATE_LOG")" == \
  'containerapp job update --name twilio-comics-generation-v2 --resource-group rg-twilio-comics --polling-interval 5 --output none' ]] \
  || { printf 'Existing Job update changed more than its polling interval.\n' >&2; exit 1; }

: > "$AZURE_TEST_JOB_UPDATE_LOG"
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  ACA_ENVIRONMENT=cae-twilio-comics-v2 ACA_NAME=twilio-comics-v2 \
  ACA_JOB_NAME=twilio-comics-generation-v2 \
  ACA_RECOVERY_JOB_NAME=twilio-comics-recovery-v2 \
  AZURE_TEST_EVENT_POLLING_FILE="$AZURE_TEST_EVENT_POLLING_FILE" \
  AZURE_TEST_MIGRATION_EXISTS=1 AZURE_TEST_DEPLOY_ROLE_COUNT=1 \
  AZURE_TEST_MIGRATION_ROLE_COUNT=1 AZURE_TEST_FEDERATED_EXISTS=1 \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 0 && ! -s "$AZURE_TEST_JOB_UPDATE_LOG" ]] \
  || { printf '%s\n' "$output" >&2; exit 1; }

# A different trigger type is not a generation queue Job and must not be
# silently rewritten just because it has the configured name.
printf '15\n' > "$AZURE_TEST_EVENT_POLLING_FILE"
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  ACA_ENVIRONMENT=cae-twilio-comics-v2 ACA_NAME=twilio-comics-v2 \
  ACA_JOB_NAME=twilio-comics-generation-v2 \
  ACA_RECOVERY_JOB_NAME=twilio-comics-recovery-v2 \
  AZURE_TEST_EVENT_POLLING_FILE="$AZURE_TEST_EVENT_POLLING_FILE" \
  AZURE_TEST_GENERATION_TRIGGER_TYPE=Schedule \
  AZURE_TEST_MIGRATION_EXISTS=1 AZURE_TEST_DEPLOY_ROLE_COUNT=1 \
  AZURE_TEST_MIGRATION_ROLE_COUNT=1 AZURE_TEST_FEDERATED_EXISTS=1 \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 1 && "$output" == *'is not event-triggered'* \
  && ! -s "$AZURE_TEST_JOB_UPDATE_LOG" ]] \
  || { printf '%s\n' "$output" >&2; exit 1; }

# Existing GitHub subjects may include immutable owner and repository IDs.
# A path-only default must not overwrite an ID-based credential silently.
id_subject='repo:third-owner@26190505/twilio-comics@1286817910:environment:production'
: > "$AZURE_TEST_FEDERATED_LOG"
: > "$AZURE_TEST_GH_LOG"
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  ACA_ENVIRONMENT=cae-twilio-comics-v2 ACA_NAME=twilio-comics-v2 \
  ACA_JOB_NAME=twilio-comics-generation-v2 \
  ACA_RECOVERY_JOB_NAME=twilio-comics-recovery-v2 \
  AZURE_TEST_MIGRATION_EXISTS=1 AZURE_TEST_DEPLOY_ROLE_COUNT=1 \
  AZURE_TEST_MIGRATION_ROLE_COUNT=1 AZURE_TEST_FEDERATED_EXISTS=1 \
  AZURE_TEST_FEDERATED_SUBJECT="$id_subject" \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 1 && "$output" == *'GITHUB_OIDC_SUBJECT'* \
  && "$output" == *"$id_subject"* ]] \
  || { printf '%s\n' "$output" >&2; exit 1; }
[[ ! -s "$AZURE_TEST_FEDERATED_LOG" && ! -s "$AZURE_TEST_GH_LOG" ]] || {
  printf 'Subject drift unexpectedly mutated Azure OIDC or GitHub configuration.\n' >&2
  exit 1
}

# An exact explicit claim should be accepted and leave the credential alone.
: > "$AZURE_TEST_FEDERATED_LOG"
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  ACA_ENVIRONMENT=cae-twilio-comics-v2 ACA_NAME=twilio-comics-v2 \
  ACA_JOB_NAME=twilio-comics-generation-v2 \
  ACA_RECOVERY_JOB_NAME=twilio-comics-recovery-v2 \
  AZURE_TEST_MIGRATION_EXISTS=1 AZURE_TEST_DEPLOY_ROLE_COUNT=1 \
  AZURE_TEST_MIGRATION_ROLE_COUNT=1 AZURE_TEST_FEDERATED_EXISTS=1 \
  AZURE_TEST_FEDERATED_SUBJECT="$id_subject" GITHUB_OIDC_SUBJECT="$id_subject" \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 0 && ! -s "$AZURE_TEST_FEDERATED_LOG" ]] \
  || { printf '%s\n' "$output" >&2; exit 1; }

# A deliberate explicit replacement claim still updates the Azure credential.
replacement_subject='repo:third-owner@99999999/twilio-comics@88888888:environment:production'
: > "$AZURE_TEST_FEDERATED_LOG"
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  ACA_ENVIRONMENT=cae-twilio-comics-v2 ACA_NAME=twilio-comics-v2 \
  ACA_JOB_NAME=twilio-comics-generation-v2 \
  ACA_RECOVERY_JOB_NAME=twilio-comics-recovery-v2 \
  AZURE_TEST_MIGRATION_EXISTS=1 AZURE_TEST_DEPLOY_ROLE_COUNT=1 \
  AZURE_TEST_MIGRATION_ROLE_COUNT=1 AZURE_TEST_FEDERATED_EXISTS=1 \
  AZURE_TEST_FEDERATED_SUBJECT="$id_subject" \
  GITHUB_OIDC_SUBJECT="$replacement_subject" \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 0 ]] || { printf '%s\n' "$output" >&2; exit 1; }
grep -Fq 'ad app federated-credential update' "$AZURE_TEST_FEDERATED_LOG"
grep -Fq "$replacement_subject" "$AZURE_TEST_FEDERATED_LOG"

# A preexisting unrestricted environment is repaired without dropping its
# reviewer or wait timer from the PUT payload.
rm -rf "$AZURE_TEST_GH_STATE_DIR"
: > "$AZURE_TEST_GH_LOG"
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  ACA_ENVIRONMENT=cae-twilio-comics-v2 ACA_NAME=twilio-comics-v2 \
  ACA_JOB_NAME=twilio-comics-generation-v2 \
  ACA_RECOVERY_JOB_NAME=twilio-comics-recovery-v2 \
  AZURE_TEST_MIGRATION_EXISTS=1 AZURE_TEST_DEPLOY_ROLE_COUNT=1 \
  AZURE_TEST_MIGRATION_ROLE_COUNT=1 AZURE_TEST_FEDERATED_EXISTS=1 \
  AZURE_TEST_GH_SCENARIO=unrestricted \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 0 ]] || { printf '%s\n' "$output" >&2; exit 1; }
jq -e '.wait_timer == 7 and .prevent_self_review == true
  and .reviewers == [{"type":"User","id":42}]
  and .deployment_branch_policy == {"protected_branches":false,"custom_branch_policies":true}' \
  "$AZURE_TEST_GH_STATE_DIR/environment-put.json" >/dev/null
grep -Fq 'api PUT repos/third-owner/twilio-comics/environments/production' "$AZURE_TEST_GH_LOG"
grep -Fq 'api POST repos/third-owner/twilio-comics/environments/production/deployment-branch-policies' "$AZURE_TEST_GH_LOG"

# An already-custom environment keeps main, removes a broader release rule,
# and does not rewrite its unrelated protection settings.
rm -rf "$AZURE_TEST_GH_STATE_DIR"
: > "$AZURE_TEST_GH_LOG"
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  ACA_ENVIRONMENT=cae-twilio-comics-v2 ACA_NAME=twilio-comics-v2 \
  ACA_JOB_NAME=twilio-comics-generation-v2 \
  ACA_RECOVERY_JOB_NAME=twilio-comics-recovery-v2 \
  AZURE_TEST_MIGRATION_EXISTS=1 AZURE_TEST_DEPLOY_ROLE_COUNT=1 \
  AZURE_TEST_MIGRATION_ROLE_COUNT=1 AZURE_TEST_FEDERATED_EXISTS=1 \
  AZURE_TEST_GH_SCENARIO=custom_extra \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 0 ]] || { printf '%s\n' "$output" >&2; exit 1; }
grep -Fq 'api DELETE repos/third-owner/twilio-comics/environments/production/deployment-branch-policies/2' "$AZURE_TEST_GH_LOG"
if grep -Eq 'api (PUT|POST) repos/.*/environments/production' "$AZURE_TEST_GH_LOG"; then
  printf 'Existing custom policy unexpectedly rewrote the GitHub environment.\n' >&2
  exit 1
fi

# A tag called main does not satisfy the branch rule for the deploy workflow.
rm -rf "$AZURE_TEST_GH_STATE_DIR"
: > "$AZURE_TEST_GH_LOG"
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  ACA_ENVIRONMENT=cae-twilio-comics-v2 ACA_NAME=twilio-comics-v2 \
  ACA_JOB_NAME=twilio-comics-generation-v2 \
  ACA_RECOVERY_JOB_NAME=twilio-comics-recovery-v2 \
  AZURE_TEST_MIGRATION_EXISTS=1 AZURE_TEST_DEPLOY_ROLE_COUNT=1 \
  AZURE_TEST_MIGRATION_ROLE_COUNT=1 AZURE_TEST_FEDERATED_EXISTS=1 \
  AZURE_TEST_GH_SCENARIO=custom_tag \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 0 ]] || { printf '%s\n' "$output" >&2; exit 1; }
grep -Fq 'api POST repos/third-owner/twilio-comics/environments/production/deployment-branch-policies' "$AZURE_TEST_GH_LOG"
grep -Fq 'api DELETE repos/third-owner/twilio-comics/environments/production/deployment-branch-policies/2' "$AZURE_TEST_GH_LOG"

# A failed environment list cannot be mistaken for an absent environment.
rm -rf "$AZURE_TEST_GH_STATE_DIR"
: > "$AZURE_TEST_GH_LOG"
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=test-subscription \
  ACR_NAME=testacr STORAGE_ACCOUNT=teststorage PROVISION_AZURE_CONFIRM=yes \
  ACA_ENVIRONMENT=cae-twilio-comics-v2 ACA_NAME=twilio-comics-v2 \
  ACA_JOB_NAME=twilio-comics-generation-v2 \
  ACA_RECOVERY_JOB_NAME=twilio-comics-recovery-v2 \
  AZURE_TEST_MIGRATION_EXISTS=1 AZURE_TEST_DEPLOY_ROLE_COUNT=1 \
  AZURE_TEST_MIGRATION_ROLE_COUNT=1 AZURE_TEST_FEDERATED_EXISTS=1 \
  AZURE_TEST_GH_FAIL_LIST=1 \
  bash "$TEST_ROOT/repo/scripts/provision-azure.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 1 && "$output" == *'Cannot list GitHub environments'* ]] \
  || { printf '%s\n' "$output" >&2; exit 1; }
if grep -Eq 'api (PUT|POST|DELETE) repos/.*/environments/production' "$AZURE_TEST_GH_LOG"; then
  printf 'Failed environment read unexpectedly changed GitHub policy.\n' >&2
  exit 1
fi

printf 'Azure provisioning OIDC, private placeholder, scoped RBAC, and GitHub environment policy mocks passed.\n'
