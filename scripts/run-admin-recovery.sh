#!/usr/bin/env bash
set -euo pipefail
set +x # Never trace the encrypted response or local private key.
umask 077

# Controlled recovery when the active admin password is unknown. This runs
# one execution of the existing private migration Job; it does not update the
# Job template or expose a database URL to the operator's machine.

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "Install '$1' before recovery."; }
for command in az jq openssl python3 pbcopy; do require "$command"; done

expected_subscription='b001fc6f-ea19-456a-8401-63971a1a1d98'
resource_group='rg-twilio-comics'
job_name='twilio-comics-migrate-v2'
environment_name='cae-twilio-comics-v2'
workspace_name='law-twilio-comics'
acr_name='twiliocomicsacr1a1d98'
acr_server="$acr_name.azurecr.io"
database_binding='migration-database-url'
recovery_ack='REPLACE_ACTIVE_ADMIN_LOGIN'
base_id="/subscriptions/$expected_subscription/resourceGroups/$resource_group"
job_id="$base_id/providers/Microsoft.App/jobs/$job_name"
environment_id="$base_id/providers/Microsoft.App/managedEnvironments/$environment_name"
workspace_id="$base_id/providers/Microsoft.OperationalInsights/workspaces/$workspace_name"
subnet_id="$base_id/providers/Microsoft.Network/virtualNetworks/vnet-twilio-comics-v2/subnets/aca-infrastructure"
migration_identity="$base_id/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-twilio-comics-pg-migrate"
pull_identity="$base_id/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-twilio-comics-v2-acr-pull"
database_secret_uri='https://kv-twilio-comics-1a1d98.vault.azure.net/secrets/postgres-comics-migration-url'
admin_username="${ADMIN_RECOVERY_USERNAME:-comics-admin}"

[[ "${SUBSCRIPTION_ID:-}" == "$expected_subscription" ]] ||
  die "Set SUBSCRIPTION_ID=$expected_subscription for the approved production subscription."
[[ "${ADMIN_RECOVERY_CONFIRM:-}" == "$recovery_ack" ]] ||
  die "Set ADMIN_RECOVERY_CONFIRM=$recovery_ack only after the admin reset is approved."
[[ "${MIGRATION_IMAGE:-}" =~ ^twiliocomicsacr1a1d98\.azurecr\.io/twilio-comics-migrate@sha256:[a-f0-9]{64}$ ]] ||
  die 'MIGRATION_IMAGE must be the reviewed, digest-pinned migration image in the approved ACR.'
[[ "$admin_username" =~ ^[A-Za-z0-9._-]{3,64}$ ]] ||
  die 'ADMIN_RECOVERY_USERNAME must be 3–64 ASCII letters, digits, dots, underscores, or hyphens.'

execution_polls="${ADMIN_RECOVERY_EXEC_POLLS:-90}"
execution_interval="${ADMIN_RECOVERY_EXEC_POLL_SECONDS:-10}"
log_polls="${ADMIN_RECOVERY_LOG_POLLS:-60}"
log_interval="${ADMIN_RECOVERY_LOG_POLL_SECONDS:-10}"
for limit in "$execution_polls" "$log_polls"; do
  if [[ ! "$limit" =~ ^[1-9][0-9]*$ || ${#limit} -gt 3 ]] ||
     (( 10#$limit > 180 )); then
    die 'Recovery polling limits must be between 1 and 180.'
  fi
done
for interval in "$execution_interval" "$log_interval"; do
  if [[ ! "$interval" =~ ^[0-9]+$ || ${#interval} -gt 2 ]] ||
     (( 10#$interval > 60 )); then
    die 'Recovery polling intervals must be between 0 and 60 seconds.'
  fi
done

active_subscription="$(az account show --query id --output tsv --only-show-errors)" ||
  die 'Sign in to the approved Azure subscription first.'
[[ "$active_subscription" == "$expected_subscription" ]] ||
  die 'The active Azure subscription is not the approved Twilio Comics production subscription.'

environment_json="$(az containerapp env show --name "$environment_name" \
  --resource-group "$resource_group" --subscription "$expected_subscription" \
  --output json --only-show-errors)" ||
  die 'Cannot inspect the private V2 Container Apps environment.'
if ! jq -e --arg id "$environment_id" --arg subnet "$subnet_id" '
  ((.id // "" | ascii_downcase) == ($id | ascii_downcase))
  and ((.properties.vnetConfiguration.infrastructureSubnetId // "" | ascii_downcase) == ($subnet | ascii_downcase))
  and .properties.appLogsConfiguration.destination == "log-analytics"
  and (.properties.appLogsConfiguration.logAnalyticsConfiguration.customerId | type == "string")
' >/dev/null <<< "$environment_json"; then
  die 'The V2 environment is not the expected private, Log Analytics-backed environment.'
fi
customer_id="$(jq -r '.properties.appLogsConfiguration.logAnalyticsConfiguration.customerId' <<< "$environment_json")"
[[ "$customer_id" =~ ^[a-fA-F0-9-]{36}$ ]] ||
  die 'The V2 environment has no valid Log Analytics workspace ID.'

workspace_json="$(az monitor log-analytics workspace show --name "$workspace_name" \
  --resource-group "$resource_group" --subscription "$expected_subscription" \
  --output json --only-show-errors)" ||
  die 'Cannot inspect the approved Log Analytics workspace.'
if ! jq -e --arg id "$workspace_id" --arg customer "$customer_id" '
  ((.id // "" | ascii_downcase) == ($id | ascii_downcase))
  and ((.customerId // "" | ascii_downcase) == ($customer | ascii_downcase))
  and .tags.managed_by == "twilio-comics-ci"
' >/dev/null <<< "$workspace_json"; then
  die 'The Log Analytics workspace does not match the V2 environment.'
fi

job_json="$(az containerapp job show --name "$job_name" \
  --resource-group "$resource_group" --subscription "$expected_subscription" \
  --output json --only-show-errors)" ||
  die 'Cannot inspect the manual migration Job.'
if ! jq -e --arg id "$job_id" --arg job "$job_name" \
  --arg env "$environment_id" --arg migration_identity "$migration_identity" \
  --arg pull_identity "$pull_identity" --arg acr "$acr_server" \
  --arg binding "$database_binding" --arg secret_uri "$database_secret_uri" '
  (.properties.template.containers[0].env // []) as $container_env
  | .name == $job
  and ((.id // "" | ascii_downcase) == ($id | ascii_downcase))
  and ((.properties.environmentId // "" | ascii_downcase) == ($env | ascii_downcase))
  and .properties.configuration.triggerType == "Manual"
  and .properties.configuration.replicaRetryLimit == 0
  and .properties.configuration.manualTriggerConfig.parallelism == 1
  and .properties.configuration.manualTriggerConfig.replicaCompletionCount == 1
  and .tags.managed_by == "twilio-comics-ci"
  and .tags.purpose == "postgres-migration"
  and (.properties.template.containers | length) == 1
  and .properties.template.containers[0].name == $job
  and .properties.template.containers[0].command == ["pnpm"]
  and .properties.template.containers[0].args == ["run", "db:migrate:safe"]
  and .properties.template.containers[0].resources.cpu == 0.5
  and .properties.template.containers[0].resources.memory == "1Gi"
  and ([.identity.userAssignedIdentities // {} | keys[]
        | select(ascii_downcase == ($migration_identity | ascii_downcase))] | length) == 1
  and ([.identity.userAssignedIdentities // {} | keys[]
        | select(ascii_downcase == ($pull_identity | ascii_downcase))] | length) == 1
  and ([.properties.configuration.registries[]?
        | select(.server == $acr and ((.identity // "" | ascii_downcase) == ($pull_identity | ascii_downcase)))]
       | length) == 1
  and (.properties.configuration.secrets | length) == 1
  and .properties.configuration.secrets[0].name == $binding
  and .properties.configuration.secrets[0].keyVaultUrl == $secret_uri
  and ((.properties.configuration.secrets[0].identity // "" | ascii_downcase) == ($migration_identity | ascii_downcase))
  and ((.properties.configuration.secrets[0].value // "") == "")
  and ([$container_env[] | select(.name == "DATABASE_URL")] | length) == 1
  and ([$container_env[] | select(.name == "DATABASE_URL")][0].secretRef == $binding)
  and ([$container_env[] | select(.name == "DATABASE_URL")][0].value // "") == ""
  and ([$container_env[] | select(.name | startswith("ADMIN_RECOVERY_"))] | length) == 0
' >/dev/null <<< "$job_json"; then
  die 'The Job differs from the reviewed private migration Job. Nothing was started.'
fi

image_digest="${MIGRATION_IMAGE##*@}"
acr_digest="$(az acr manifest show-metadata --registry "$acr_name" \
  --name "twilio-comics-migrate@$image_digest" \
  --subscription "$expected_subscription" --query digest --output tsv \
  --only-show-errors)" ||
  die 'Cannot inspect the reviewed migration image in ACR.'
[[ "$acr_digest" == "$image_digest" ]] ||
  die 'The reviewed migration image digest is not available in the approved ACR.'

executions_json="$(az containerapp job execution list --name "$job_name" \
  --resource-group "$resource_group" --subscription "$expected_subscription" \
  --output json --only-show-errors)" ||
  die 'Cannot inspect current migration Job executions.'
if [[ -z "${ADMIN_RECOVERY_RESUME_DIR:-}" ]] && ! jq -e '
  type == "array"
  and ([.[] | select(
    .properties.status != "Succeeded"
    and .properties.status != "Failed"
    and .properties.status != "Stopped"
    and .properties.status != "Degraded"
    and .properties.status != "Canceled"
    and .properties.status != "Cancelled"
  )] | length) == 0
' >/dev/null <<< "$executions_json"; then
  die 'Another migration Job execution is active or its status is unknown.'
fi

temporary_dir=''
preserve_private_key=0
recovery_copied=0
cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n "$temporary_dir" ]]; then
    if [[ "$preserve_private_key" == 1 && "$recovery_copied" != 1 ]]; then
      printf 'Recovery key retained in %s (owner-only). Do not start a second reset.\n' "$temporary_dir" >&2
      printf 'To retry result retrieval, rerun this command with ADMIN_RECOVERY_RESUME_DIR set to that path.\n' >&2
      printf 'If the Job start returned no execution name, also set ADMIN_RECOVERY_EXECUTION_NAME after checking Azure Job history.\n' >&2
    else
      rm -rf -- "$temporary_dir"
    fi
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
temporary_base="${TMPDIR:-/tmp}"
resume_dir="${ADMIN_RECOVERY_RESUME_DIR:-}"
if [[ -n "$resume_dir" ]]; then
  python3 - "$resume_dir" "$temporary_base" <<'PY' ||
    die 'ADMIN_RECOVERY_RESUME_DIR is not an owner-only recovery directory containing a private key and state.'
import os
from pathlib import Path
import stat
import sys

candidate = Path(sys.argv[1])
base = Path(sys.argv[2]).resolve()
if (not candidate.is_absolute() or candidate.is_symlink()
        or candidate.parent.resolve() != base
        or not candidate.name.startswith("twilio-comics-admin-recovery.")):
    sys.exit(1)
folder = os.lstat(candidate)
if (not stat.S_ISDIR(folder.st_mode) or folder.st_uid != os.getuid()
        or stat.S_IMODE(folder.st_mode) != 0o700):
    sys.exit(1)
for name in ("private.pem", "state.json"):
    item = os.lstat(candidate / name)
    if (not stat.S_ISREG(item.st_mode) or item.st_uid != os.getuid()
            or stat.S_IMODE(item.st_mode) != 0o600):
        sys.exit(1)
PY
  temporary_dir="$resume_dir"
  preserve_private_key=1
else
  for pending_dir in "$temporary_base"/twilio-comics-admin-recovery.*; do
    if [[ -f "$pending_dir/state.json" ]]; then
      die "A recovery is pending in $pending_dir. Resume it before starting another reset."
    fi
  done
  temporary_dir="$(mktemp -d "$temporary_base/twilio-comics-admin-recovery.XXXXXXXX")"
  [[ -d "$temporary_dir" ]] || die 'Could not create an owner-only recovery directory.'
  chmod 700 "$temporary_dir"
fi

logs_api='https://api.loganalytics.io'
logs_resource='https://api.loganalytics.io'
logs_url="$logs_api/v1/workspaces/$customer_id/query"
query_logs() {
  az rest --method post --uri "$logs_url" --resource "$logs_resource" \
    --headers Content-Type=application/json --body "@$temporary_dir/query.json" \
    --subscription "$expected_subscription" --output json --only-show-errors \
    > "$temporary_dir/response.json" 2> "$temporary_dir/azure.err"
}

# Check read access before changing the login. A successful database write
# without access to the encrypted result would leave no usable password.
jq -n '{query:"ContainerAppConsoleLogs_CL | where TimeGenerated > ago(1h) | summarize count()", timespan:"PT1H"}' \
  > "$temporary_dir/query.json"
query_logs || die 'Cannot query Log Analytics before recovery. Nothing was started.'
jq -e '.tables[0].rows[0][0] | type == "number"' \
  >/dev/null < "$temporary_dir/response.json" ||
  die 'Log Analytics returned an unexpected result. Nothing was started.'

if [[ -n "$resume_dir" ]]; then
  if ! jq -e --arg image "$MIGRATION_IMAGE" --arg username "$admin_username" \
    --arg customer "$customer_id" --arg job "$job_name" '
    type == "object"
    and (keys == ["customerId", "executionName", "image", "jobName", "publicKeyBase64", "username"])
    and .image == $image
    and .username == $username
    and .customerId == $customer
    and .jobName == $job
    and (.publicKeyBase64 | type == "string" and length > 500 and length < 1000)
    and (.executionName | type == "string")
  ' >/dev/null < "$temporary_dir/state.json"; then
    die 'The saved recovery state does not match the approved image, username, workspace, or Job.'
  fi
  execution_name="$(jq -r '.executionName' "$temporary_dir/state.json")"
  if [[ -z "$execution_name" ]]; then
    execution_name="${ADMIN_RECOVERY_EXECUTION_NAME:-}"
    [[ -n "$execution_name" ]] ||
      die 'The original Job start did not return an execution name. Inspect Azure Job history and set ADMIN_RECOVERY_EXECUTION_NAME.'
  fi
  public_key_base64="$(jq -r '.publicKeyBase64' "$temporary_dir/state.json")"
  openssl pkey -in "$temporary_dir/private.pem" -pubout -outform DER \
    -out "$temporary_dir/resumed-public.der" 2> "$temporary_dir/openssl.err" ||
    die 'Could not validate the retained private recovery key.'
  actual_public_key="$(openssl base64 -A -in "$temporary_dir/resumed-public.der")" ||
    die 'Could not validate the retained public recovery key.'
  [[ "$actual_public_key" == "$public_key_base64" ]] ||
    die 'The retained private key does not match the one used for recovery.'
  printf 'Resuming encrypted result retrieval for %s.\n' "$execution_name"
else
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
    -out "$temporary_dir/private.pem" > /dev/null 2> "$temporary_dir/openssl.err" ||
    die 'Could not generate the local recovery key.'
  chmod 600 "$temporary_dir/private.pem"
  openssl pkey -in "$temporary_dir/private.pem" -pubout -outform DER \
    -out "$temporary_dir/public.der" 2> "$temporary_dir/openssl.err" ||
    die 'Could not derive the public recovery key.'
  public_key_base64="$(openssl base64 -A -in "$temporary_dir/public.der")" ||
    die 'Could not encode the public recovery key.'
  jq -n --arg image "$MIGRATION_IMAGE" --arg username "$admin_username" \
    --arg customer "$customer_id" --arg job "$job_name" \
    --arg public_key "$public_key_base64" \
    '{image:$image,username:$username,customerId:$customer,jobName:$job,publicKeyBase64:$public_key,executionName:""}' \
    > "$temporary_dir/state.json"
  chmod 600 "$temporary_dir/state.json"

  printf 'Starting a one-time admin recovery execution for %s.\n' "$admin_username"
  preserve_private_key=1
  start_json="$(az containerapp job start --name "$job_name" \
    --resource-group "$resource_group" --subscription "$expected_subscription" \
    --image "$MIGRATION_IMAGE" --container-name "$job_name" \
    --cpu 0.5 --memory 1Gi \
    --command pnpm --args run db:admin-recover \
    --env-vars "DATABASE_URL=secretref:$database_binding" \
      "ADMIN_RECOVERY_USERNAME=$admin_username" \
      "ADMIN_RECOVERY_PUBLIC_KEY_BASE64=$public_key_base64" \
      "ADMIN_RECOVERY_ACK=$recovery_ack" \
    --output json --only-show-errors)" ||
    die 'Azure did not return a recovery execution. Check Job history before retrying.'
  execution_name="$(jq -r '.name // empty' <<< "$start_json")"
  [[ "$execution_name" =~ ^[a-z0-9][a-z0-9-]{1,90}$ ]] ||
    die 'Azure returned an invalid recovery execution name. Check Job history before retrying.'
  jq --arg execution "$execution_name" '.executionName = $execution' \
    "$temporary_dir/state.json" > "$temporary_dir/state.next"
  mv "$temporary_dir/state.next" "$temporary_dir/state.json"
  chmod 600 "$temporary_dir/state.json"
  printf 'Recovery execution %s started.\n' "$execution_name"
fi
[[ "$execution_name" =~ ^[a-z0-9][a-z0-9-]{1,90}$ ]] ||
  die 'The recovery execution name is invalid.'

verified_execution=0
for (( attempt = 1; attempt <= execution_polls; attempt++ )); do
  if ! execution_json="$(az containerapp job execution show --name "$job_name" \
    --resource-group "$resource_group" --job-execution-name "$execution_name" \
    --subscription "$expected_subscription" --output json --only-show-errors \
    2> "$temporary_dir/azure.err")"; then
    sleep "$execution_interval"
    continue
  fi
  status="$(jq -r '.properties.status // empty' <<< "$execution_json")"
  case "$status" in
    Succeeded)
      if ! jq -e --arg execution "$execution_name" --arg image "$MIGRATION_IMAGE" \
        --arg job "$job_name" --arg binding "$database_binding" \
        --arg username "$admin_username" --arg public_key "$public_key_base64" \
        --arg ack "$recovery_ack" '
        (.properties.template.containers[0].env // []) as $vars
        | .name == $execution
        and (.properties.template.containers | length) == 1
        and .properties.template.containers[0].name == $job
        and .properties.template.containers[0].image == $image
        and .properties.template.containers[0].command == ["pnpm"]
        and .properties.template.containers[0].args == ["run", "db:admin-recover"]
        and .properties.template.containers[0].resources.cpu == 0.5
        and .properties.template.containers[0].resources.memory == "1Gi"
        and ($vars | length) == 4
        and ([$vars[] | select(.name == "DATABASE_URL"
          and (.secretRef == $binding or .secretRef == ("cappjob-" + $job))
          and ((.value // "") == ""))] | length) == 1
        and ([$vars[] | select(.name == "ADMIN_RECOVERY_USERNAME" and .value == $username and ((.secretRef // "") == ""))] | length) == 1
        and ([$vars[] | select(.name == "ADMIN_RECOVERY_PUBLIC_KEY_BASE64" and .value == $public_key and ((.secretRef // "") == ""))] | length) == 1
        and ([$vars[] | select(.name == "ADMIN_RECOVERY_ACK" and .value == $ack and ((.secretRef // "") == ""))] | length) == 1
      ' >/dev/null <<< "$execution_json"; then
        die 'Recovery execution succeeded with an unexpected image, command, or environment. Encrypted output was not used.'
      fi
      verified_execution=1
      break
      ;;
    Failed|Stopped|Degraded|Canceled|Cancelled)
      die "Recovery execution ended in $status. No new password is available."
      ;;
  esac
  if (( attempt % 6 == 0 )); then
    printf 'Recovery execution is %s.\n' "${status:-pending}"
  fi
  sleep "$execution_interval"
done
[[ "$verified_execution" == 1 ]] ||
  die 'Recovery execution did not finish within the wait window. Inspect its status before retrying.'

# The override must leave the ordinary migration template alone. Do not
# discard a usable encrypted password if an unrelated template update occurs.
if job_after="$(az containerapp job show --name "$job_name" \
  --resource-group "$resource_group" --subscription "$expected_subscription" \
  --output json --only-show-errors 2> "$temporary_dir/azure.err")"; then
  before_template="$(jq -cS '{identity, configuration: .properties.configuration, template: .properties.template}' <<< "$job_json")"
  after_template="$(jq -cS '{identity, configuration: .properties.configuration, template: .properties.template}' <<< "$job_after")"
  if [[ "$before_template" != "$after_template" ]]; then
    printf 'WARNING: The stored migration Job configuration changed. Review it after signing in.\n' >&2
  fi
else
  printf 'WARNING: Could not verify the stored migration Job after recovery.\n' >&2
fi

query="ContainerAppConsoleLogs_CL
| where ContainerJobName_s == '$job_name'
| where ContainerGroupName_s startswith '$execution_name-'
| where Log_s contains '\"algorithm\":\"RSA-OAEP-SHA256\"'
| project Log_s
| distinct Log_s
| take 2"
jq -n --arg query "$query" '{query:$query, timespan:"P7D"}' \
  > "$temporary_dir/query.json"
found_envelope=0
for (( attempt = 1; attempt <= log_polls; attempt++ )); do
  if ! query_logs; then
    sleep "$log_interval"
    continue
  fi
  rows="$(jq -r '.tables[0].rows | if type == "array" then length else -1 end' \
    "$temporary_dir/response.json" 2>/dev/null)" || rows=-1
  case "$rows" in
    0|-1) ;;
    1)
      jq -er '.tables[0].rows[0][0] | select(type == "string")' \
        "$temporary_dir/response.json" > "$temporary_dir/envelope.json" ||
        die 'The encrypted recovery result had an invalid Log Analytics shape.'
      found_envelope=1
      break
      ;;
    *) die 'Multiple encrypted recovery results were found for one execution. No password was copied.' ;;
  esac
  if (( attempt % 6 == 0 )); then
    printf 'Waiting for encrypted recovery output in Log Analytics.\n'
  fi
  sleep "$log_interval"
done
[[ "$found_envelope" == 1 ]] ||
  die 'Recovery ran, but its encrypted output has not appeared in Log Analytics. No password was copied; retry only after checking this execution.'

if ! jq -e --arg username "$admin_username" '
  type == "object"
  and (keys == ["algorithm", "ciphertext", "username", "version"])
  and .version == 1
  and .username == $username
  and .algorithm == "RSA-OAEP-SHA256"
  and (.ciphertext | type == "string" and test("^[A-Za-z0-9+/]{512}$"))
' >/dev/null < "$temporary_dir/envelope.json"; then
  die 'The encrypted recovery envelope is invalid. No password was copied.'
fi
jq -j '.ciphertext' "$temporary_dir/envelope.json" |
  openssl base64 -A -d > "$temporary_dir/cipher.bin" ||
  die 'Could not decode the encrypted recovery password.'
[[ "$(wc -c < "$temporary_dir/cipher.bin" | tr -d '[:space:]')" == 384 ]] ||
  die 'The encrypted recovery password has the wrong length.'

# Password bytes go from OpenSSL through a validator directly to the macOS
# clipboard. No shell variable, file, Azure argument, or log gets plaintext.
openssl pkeyutl -decrypt -inkey "$temporary_dir/private.pem" \
  -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 \
  -pkeyopt rsa_mgf1_md:sha256 -in "$temporary_dir/cipher.bin" \
  2> "$temporary_dir/openssl.err" |
  python3 -c '
import re
import subprocess
import sys

password = sys.stdin.buffer.read(128)
if not re.fullmatch(rb"[A-Za-z0-9_-]{48}", password):
    sys.exit(2)
try:
    subprocess.run(["pbcopy"], input=password, check=True)
except (OSError, subprocess.CalledProcessError):
    sys.exit(3)
' || die 'Could not decrypt and copy the password to the macOS clipboard.'

recovery_copied=1
printf 'Admin username: %s\n' "$admin_username"
printf 'New password copied to the macOS clipboard. Paste it at /admin/login and save it in a password manager.\n'
