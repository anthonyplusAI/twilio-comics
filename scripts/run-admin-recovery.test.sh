#!/usr/bin/env bash
set -Eeuo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/twilio-comics-admin-recovery-test.XXXXXXXX")"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/tmp"

cat > "$fixture/bin/pbcopy" <<'MOCK_CLIPBOARD'
#!/usr/bin/env bash
set -euo pipefail
cat > "$MOCK_CLIPBOARD_FILE"
MOCK_CLIPBOARD
chmod 700 "$fixture/bin/pbcopy"

cat > "$fixture/bin/az" <<'MOCK_AZ'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_AZ_CALLS"

subscription='b001fc6f-ea19-456a-8401-63971a1a1d98'
group='rg-twilio-comics'
base="/subscriptions/$subscription/resourceGroups/$group"
job='twilio-comics-migrate-v2'
execution='twilio-comics-migrate-v2-test123'
environment='cae-twilio-comics-v2'
customer='2c790885-0df8-40a4-a36a-ef429f4c4411'
migration_identity="$base/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-twilio-comics-pg-migrate"
pull_identity="$base/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-twilio-comics-v2-acr-pull"
secret_uri='https://kv-twilio-comics-1a1d98.vault.azure.net/secrets/postgres-comics-migration-url'

case "${1:-} ${2:-} ${3:-}" in
  'account show --query')
    if [[ "$MOCK_MODE" == wrong-subscription ]]; then
      printf '%s\n' '00000000-0000-0000-0000-000000000000'
    else
      printf '%s\n' "$subscription"
    fi
    ;;
  'containerapp env show')
    jq -n --arg id "$base/providers/Microsoft.App/managedEnvironments/$environment" \
      --arg subnet "$base/providers/Microsoft.Network/virtualNetworks/vnet-twilio-comics-v2/subnets/aca-infrastructure" \
      --arg customer "$customer" \
      '{id:$id, properties:{vnetConfiguration:{infrastructureSubnetId:$subnet},appLogsConfiguration:{destination:"log-analytics",logAnalyticsConfiguration:{customerId:$customer}}}}' |
      if [[ "$MOCK_MODE" == wrong-subnet ]]; then
        jq '.properties.vnetConfiguration.infrastructureSubnetId = "/other/subnet"'
      else cat; fi
    ;;
  'monitor log-analytics workspace')
    jq -n --arg id "$base/providers/Microsoft.OperationalInsights/workspaces/law-twilio-comics" \
      --arg customer "$customer" \
      '{id:$id,customerId:$customer,tags:{managed_by:"twilio-comics-ci"}}'
    ;;
  'containerapp job show')
    jq -n --arg id "$base/providers/Microsoft.App/jobs/$job" \
      --arg env "$base/providers/Microsoft.App/managedEnvironments/$environment" \
      --arg migration "$migration_identity" --arg pull "$pull_identity" \
      --arg secret_uri "$secret_uri" '
      {
        id:$id,
        name:"twilio-comics-migrate-v2",
        tags:{managed_by:"twilio-comics-ci",purpose:"postgres-migration"},
        identity:{type:"UserAssigned",userAssignedIdentities:{($migration):{},($pull):{}}},
        properties:{
          environmentId:$env,
          configuration:{
            triggerType:"Manual",replicaRetryLimit:0,
            manualTriggerConfig:{parallelism:1,replicaCompletionCount:1},
            registries:[{server:"twiliocomicsacr1a1d98.azurecr.io",identity:$pull}],
            secrets:[{name:"migration-database-url",keyVaultUrl:$secret_uri,identity:$migration}]
          },
          template:{containers:[{
            name:"twilio-comics-migrate-v2",
            image:"twiliocomicsacr1a1d98.azurecr.io/twilio-comics-migrate@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            command:["pnpm"],args:["run","db:migrate:safe"],
            resources:{cpu:0.5,memory:"1Gi"},
            env:[{name:"DATABASE_URL",secretRef:"migration-database-url"}]
          }]}
        }
      }' |
      case "$MOCK_MODE" in
        wrong-job-id) jq '.id = "/subscriptions/other/resourceGroups/other/providers/Microsoft.App/jobs/twilio-comics-migrate-v2"' ;;
        wrong-secret) jq '.properties.configuration.secrets[0].keyVaultUrl = "https://other.vault.azure.net/secrets/other"' ;;
        wrong-database-env) jq '.properties.template.containers[0].env[0].value = "plaintext" | del(.properties.template.containers[0].env[0].secretRef)' ;;
        wrong-retry-limit) jq '.properties.configuration.replicaRetryLimit = 2' ;;
        *) cat ;;
      esac
    ;;
  'acr manifest show-metadata')
    if [[ "$MOCK_MODE" == wrong-acr-digest ]]; then
      printf 'sha256:%064d\n' 0 | tr 0 b
    else
      printf '%s\n' "${MIGRATION_IMAGE##*@}"
    fi
    ;;
  'containerapp job execution')
    case "${4:-}" in
      list)
        if [[ "$MOCK_MODE" == active-execution ]]; then
          printf '%s\n' '[{"properties":{"status":"Running"}}]'
        else
          printf '%s\n' '[]'
        fi
        ;;
      show)
        status=Succeeded
        [[ "$MOCK_MODE" == failed-execution ]] && status=Failed
        image="$MIGRATION_IMAGE"
        [[ "$MOCK_MODE" == wrong-execution-image ]] &&
          image='twiliocomicsacr1a1d98.azurecr.io/twilio-comics-migrate@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
        public_key="$(cat "$MOCK_DIR/public.base64")"
        jq -n --arg execution "$execution" --arg status "$status" \
          --arg image "$image" --arg public "$public_key" \
          --arg username "$MOCK_RECOVERY_USERNAME" '
          {
            name:$execution,
            properties:{
              status:$status,
              template:{containers:[{
                name:"twilio-comics-migrate-v2",image:$image,
                command:["pnpm"],args:["run","db:admin-recover"],
                resources:{cpu:0.5,memory:"1Gi"},
                env:[
                  {name:"DATABASE_URL",secretRef:"cappjob-twilio-comics-migrate-v2"},
                  {name:"ADMIN_RECOVERY_USERNAME",value:$username},
                  {name:"ADMIN_RECOVERY_PUBLIC_KEY_BASE64",value:$public},
                  {name:"ADMIN_RECOVERY_ACK",value:"REPLACE_ACTIVE_ADMIN_LOGIN"}
                ]
              }]}
            }
          }' |
          if [[ "$MOCK_MODE" == wrong-execution-env ]]; then
            jq '.properties.template.containers[0].env[0].secretRef = "runtime-database-url"'
          else cat; fi
        ;;
      *) printf 'Unexpected execution call: %s\n' "$*" >&2; exit 1 ;;
    esac
    ;;
  'containerapp job start')
    public_key=''
    username=''
    found_database=0
    found_image=0
    found_command=0
    for arg in "$@"; do
      case "$arg" in
        ADMIN_RECOVERY_PUBLIC_KEY_BASE64=*) public_key="${arg#*=}" ;;
        ADMIN_RECOVERY_USERNAME=*) username="${arg#*=}" ;;
        DATABASE_URL=secretref:migration-database-url) found_database=1 ;;
        "$MIGRATION_IMAGE") found_image=1 ;;
        db:admin-recover) found_command=1 ;;
      esac
    done
    [[ -n "$public_key" && "$username" == "$MOCK_RECOVERY_USERNAME" &&
       "$found_database" == 1 && "$found_image" == 1 && "$found_command" == 1 ]] ||
      { printf 'One-off override omitted a required input\n' >&2; exit 2; }
    printf '%s' "$public_key" > "$MOCK_DIR/public.base64"
    openssl base64 -A -d -in "$MOCK_DIR/public.base64" -out "$MOCK_DIR/public.der"
    openssl pkey -pubin -inform DER -in "$MOCK_DIR/public.der" \
      -out "$MOCK_DIR/public.pem" 2>/dev/null
    printf '%s' "$MOCK_PASSWORD" > "$MOCK_DIR/synthetic-password"
    openssl pkeyutl -encrypt -pubin -inkey "$MOCK_DIR/public.pem" \
      -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 \
      -pkeyopt rsa_mgf1_md:sha256 -in "$MOCK_DIR/synthetic-password" \
      -out "$MOCK_DIR/cipher.bin" 2>/dev/null
    ciphertext="$(openssl base64 -A -in "$MOCK_DIR/cipher.bin")"
    jq -n --arg username "$username" --arg ciphertext "$ciphertext" \
      '{version:1,username:$username,algorithm:"RSA-OAEP-SHA256",ciphertext:$ciphertext}' \
      > "$MOCK_DIR/envelope.json"
    printf '%s\n' "{\"name\":\"$execution\"}"
    ;;
  'rest --method post')
    body=''
    while (( $# )); do
      if [[ "$1" == --body ]]; then body="${2#@}"; break; fi
      shift
    done
    [[ -r "$body" ]] || { printf 'Missing query body\n' >&2; exit 3; }
    if jq -e '.query | contains("summarize count()")' >/dev/null < "$body"; then
      [[ "$MOCK_MODE" == no-log-access ]] && exit 4
      printf '%s\n' '{"tables":[{"columns":[{"name":"count_","type":"long"}],"rows":[[0]]}]}'
    else
      jq -e --arg execution "$execution" --arg job "$job" '
        .timespan == "P7D"
        and (.query | contains("ContainerGroupName_s startswith '\''" + $execution + "-'\''")
          and contains("ContainerJobName_s == '\''" + $job + "'\''")
          and contains("| distinct Log_s"))
      ' >/dev/null < "$body" || { printf 'Log query did not scope the execution\n' >&2; exit 5; }
      if [[ "$MOCK_MODE" == no-envelope ]]; then
        printf '%s\n' '{"tables":[{"columns":[{"name":"Log_s","type":"string"}],"rows":[]}]}'
      elif [[ "$MOCK_MODE" == duplicate-envelope ]]; then
        jq -n --rawfile envelope "$MOCK_DIR/envelope.json" \
          '{tables:[{columns:[{name:"Log_s",type:"string"}],rows:[[($envelope|rtrimstr("\n"))],[($envelope|rtrimstr("\n") + " ")]]}]}'
      else
        jq -n --rawfile envelope "$MOCK_DIR/envelope.json" \
          '{tables:[{columns:[{name:"Log_s",type:"string"}],rows:[[($envelope|rtrimstr("\n"))]]}]}'
      fi
    fi
    ;;
  *) printf 'Unexpected Azure command: %s\n' "$*" >&2; exit 99 ;;
esac
MOCK_AZ
chmod 700 "$fixture/bin/az"

image='twiliocomicsacr1a1d98.azurecr.io/twilio-comics-migrate@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
password='012345678901234567890123456789012345678901234567'

run_case() {
  local mode="$1"
  local resume_path="${2:-}" reset_mock="${3:-yes}"
  local username="${4:-comics-admin}"
  : > "$fixture/calls"
  rm -f "$fixture/clipboard"
  if [[ "$reset_mock" == yes ]]; then
    rm -rf "$fixture/mock"
    mkdir -p "$fixture/mock"
  fi
  env PATH="$fixture/bin:$PATH" TMPDIR="$fixture/tmp" \
    MOCK_AZ_CALLS="$fixture/calls" MOCK_MODE="$mode" MOCK_DIR="$fixture/mock" \
    MOCK_PASSWORD="$password" MOCK_RECOVERY_USERNAME="$username" \
    MOCK_CLIPBOARD_FILE="$fixture/clipboard" \
    SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98' \
    MIGRATION_IMAGE="$image" \
    ADMIN_RECOVERY_USERNAME="$username" \
    ADMIN_RECOVERY_RESUME_DIR="$resume_path" \
    ADMIN_RECOVERY_CONFIRM='REPLACE_ACTIVE_ADMIN_LOGIN' \
    ADMIN_RECOVERY_EXEC_POLL_SECONDS=0 ADMIN_RECOVERY_EXEC_POLLS=2 \
    ADMIN_RECOVERY_LOG_POLL_SECONDS=0 ADMIN_RECOVERY_LOG_POLLS=2 \
    bash "$project_root/scripts/run-admin-recovery.sh" > "$fixture/output" 2>&1
}

run_case valid
[[ "$(cat "$fixture/clipboard")" == "$password" ]]
grep -Fq 'New password copied to the macOS clipboard' "$fixture/output"
if grep -Fq "$password" "$fixture/output" ||
   grep -Fq "$password" "$fixture/calls"; then
  printf 'Recovery password appeared in output or Azure arguments\n' >&2
  exit 1
fi
grep -Fq 'containerapp job start' "$fixture/calls"
if grep -Eq 'containerapp job (update|exec)( |$)|keyvault secret' "$fixture/calls"; then
  printf 'Recovery used a persistent Job update, shell, or Key Vault secret read\n' >&2
  exit 1
fi
[[ -z "$(find "$fixture/tmp" -mindepth 1 -maxdepth 1 -print)" ]] ||
  { printf 'Recovery left a temporary private key behind\n' >&2; exit 1; }

run_case valid '' yes 'anthony.admin'
[[ "$(cat "$fixture/clipboard")" == "$password" ]]
grep -Fq 'Admin username: anthony.admin' "$fixture/output"
[[ -z "$(find "$fixture/tmp" -mindepth 1 -maxdepth 1 -print)" ]] ||
  { printf 'Custom-username recovery left a private key behind\n' >&2; exit 1; }

for mode in wrong-subscription wrong-subnet wrong-job-id wrong-secret \
  wrong-database-env wrong-retry-limit wrong-acr-digest active-execution \
  no-log-access; do
  if run_case "$mode"; then
    printf 'Expected %s to fail before recovery start\n' "$mode" >&2
    exit 1
  fi
  if grep -Fq 'containerapp job start' "$fixture/calls"; then
    printf '%s started a recovery Job despite failed preflight\n' "$mode" >&2
    exit 1
  fi
done

for mode in failed-execution wrong-execution-image wrong-execution-env \
  duplicate-envelope; do
  if run_case "$mode"; then
    printf 'Expected %s to fail without a clipboard password\n' "$mode" >&2
    exit 1
  fi
  [[ ! -e "$fixture/clipboard" ]] ||
    { printf '%s put a password on the clipboard\n' "$mode" >&2; exit 1; }
  pending_dir="$(find "$fixture/tmp" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  [[ -f "$pending_dir/private.pem" && -f "$pending_dir/state.json" ]] ||
    { printf '%s failed to retain its private key after a started Job\n' "$mode" >&2; exit 1; }
  rm -rf -- "$pending_dir"
done

# Log ingestion can lag after the database write. Retain the private key,
# reject a second reset, then retrieve the original envelope without starting
# another Job.
if run_case no-envelope; then
  printf 'Expected delayed logs to leave a resumable recovery\n' >&2
  exit 1
fi
pending_dir="$(find "$fixture/tmp" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[[ -f "$pending_dir/private.pem" && -f "$pending_dir/state.json" ]] ||
  { printf 'Delayed logs did not retain the recovery key\n' >&2; exit 1; }
if run_case valid '' no; then
  printf 'A fresh reset started while one was still pending\n' >&2
  exit 1
fi
if grep -Fq 'containerapp job start' "$fixture/calls"; then
  printf 'Fresh reset guard ran after Job start\n' >&2
  exit 1
fi
run_case valid "$pending_dir" no
[[ "$(cat "$fixture/clipboard")" == "$password" ]]
if grep -Fq 'containerapp job start' "$fixture/calls"; then
  printf 'Resume started a second Job\n' >&2
  exit 1
fi
[[ ! -e "$pending_dir" ]] ||
  { printf 'Successful resume retained the private key\n' >&2; exit 1; }

printf 'Admin recovery operator wrapper mock tests passed\n'
