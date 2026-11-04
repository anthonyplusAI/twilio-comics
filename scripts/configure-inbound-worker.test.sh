#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin"
export INBOUND_TEST_LOG="$TEST_ROOT/azure-actions"
export INBOUND_TEST_ID='/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-twilio-comics-v2-worker'
export INBOUND_TEST_ENV='/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.App/managedEnvironments/cae-twilio-comics-v2'

cat > "$TEST_ROOT/bin/az" <<'AZ'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2 ${3:-}" in
  'account show --query') printf '%s\n' 'b001fc6f-ea19-456a-8401-63971a1a1d98' ;;
  'identity show --name') printf '%s\n' "$INBOUND_TEST_ID" ;;
  'storage queue exists') printf 'true\n' ;;
  'containerapp show --name')
    if [[ "${4:-}" == twilio-comics ]]; then
      jq -n --arg env "$INBOUND_TEST_ENV" \
        --arg channels "${INBOUND_TEST_WEB_CHANNELS:-sms,voice}" \
        --argjson missing "${INBOUND_TEST_WEB_MISSING_CHANNELS:-false}" '{
          properties: {
            environmentId: $env,
            template: {containers: [{env: (if $missing then [] else [
              {name: "TWILIO_ENABLED_CHANNELS", value: $channels}
            ] end)}]}
          }
        }'
      exit 0
    fi
    jq -n --arg env "$INBOUND_TEST_ENV" --arg id "$INBOUND_TEST_ID" \
      --argjson public "${INBOUND_TEST_PUBLIC:-false}" '{
        identity: {userAssignedIdentities: {($id): {}}},
        properties: {
          environmentId: $env,
          configuration: {ingress: (if $public then {external: true, targetPort: 8080} else null end)},
          template: {scale: {minReplicas: 0}, containers: [{
            image: "mcr.microsoft.com/dotnet/samples:aspnetapp",
            env: [
              {name: "WORKER_MODE", value: "inbound"},
              {name: "DB_POOL_MAX", value: "2"},
              {name: "INBOUND_WORKER_CONCURRENCY", value: "4"},
              {name: "AZURE_STORAGE_INBOUND_QUEUE_NAME", value: "comic-inbound"},
              {name: "AZURE_STORAGE_INBOUND_POISON_QUEUE_NAME", value: "comic-inbound-poison"}
            ]
          }]}
        }
      }' ;;
  'containerapp job show')
    jq -n --arg env "$INBOUND_TEST_ENV" --arg id "$INBOUND_TEST_ID" \
      --arg legacy "${INBOUND_TEST_GENERATION_QUEUE:-comic-generation}" \
      --arg vault 'https://kv-twilio-comics-1a1d98.vault.azure.net/secrets' \
      --argjson plaintext "${INBOUND_TEST_PLAINTEXT:-false}" '{
        properties: {
          environmentId: $env,
          configuration: {secrets: [
            {name:"runtime-database-url", keyVaultUrl: ($vault + "/postgres-comics-runtime-url"), identity:$id},
            {name:"media-signing-secret", keyVaultUrl: ($vault + "/media-signing-secret"), identity:$id},
            {name:"openai-api-key", keyVaultUrl: ($vault + "/openai-api-key"), identity:$id},
            (if $plaintext then {name:"twilio-auth-token", value:"unsafe"}
             else {name:"twilio-auth-token", keyVaultUrl: ($vault + "/twilio-auth-token"), identity:$id} end),
            {name:"dub-api-key", keyVaultUrl: ($vault + "/dub-api-key"), identity:$id}
          ]},
          template: {containers: [{env: [
            {name:"AZURE_CLIENT_ID", value:"worker-client"},
            {name:"AZURE_STORAGE_BLOB_ENDPOINT", value:"https://teststorage.blob.core.windows.net"},
            {name:"AZURE_STORAGE_QUEUE_ENDPOINT", value:"https://teststorage.queue.core.windows.net"},
            {name:"AZURE_STORAGE_CONTAINER_NAME", value:"comics"},
            {name:"AZURE_STORAGE_QUEUE_NAME", value:$legacy},
            {name:"AZURE_STORAGE_POISON_QUEUE_NAME", value:"comic-generation-poison"},
            {name:"DATABASE_URL", secretRef:"runtime-database-url"},
            {name:"MEDIA_SIGNING_SECRET", secretRef:"media-signing-secret"},
            {name:"OPENAI_API_KEY", secretRef:"openai-api-key"},
            {name:"TWILIO_AUTH_TOKEN", secretRef:"twilio-auth-token"},
            {name:"TWILIO_ACCOUNT_SID", value:"AC11111111111111111111111111111111"},
            {name:"TWILIO_PHONE_NUMBER", value:"+18669012028"},
            {name:"PUBLIC_BASE_URL", value:"https://comics.example.com"},
            {name:"DUB_API_KEY", secretRef:"dub-api-key"},
            {name:"DUB_DOMAIN", value:"go.example.com"},
            {name:"DUB_FOLDER_ID", value:"folder"}
          ]}]}
        }
      }' ;;
  'containerapp secret set'|'containerapp update --name') printf '%s\n' "$*" >> "$INBOUND_TEST_LOG" ;;
  *) printf 'Unexpected Azure call: %s\n' "$*" >&2; exit 90 ;;
esac
AZ
chmod +x "$TEST_ROOT/bin/az"

: > "$INBOUND_TEST_LOG"
PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=b001fc6f-ea19-456a-8401-63971a1a1d98 \
  CONFIGURE_INBOUND_CONFIRM=yes bash "$PROJECT_ROOT/scripts/configure-inbound-worker.sh"
grep -Fq 'containerapp secret set --name twilio-comics-inbound-v2' "$INBOUND_TEST_LOG"
grep -Fq 'runtime-database-url=keyvaultref:https://kv-twilio-comics-1a1d98.vault.azure.net/secrets/postgres-comics-runtime-url' "$INBOUND_TEST_LOG"
grep -Fq 'containerapp update --name twilio-comics-inbound-v2' "$INBOUND_TEST_LOG"
grep -Fq 'DATABASE_URL=secretref:runtime-database-url' "$INBOUND_TEST_LOG"
grep -Fq 'WORKER_MODE=inbound' "$INBOUND_TEST_LOG"
grep -Fq 'INBOUND_WORKER_CONCURRENCY=4' "$INBOUND_TEST_LOG"
grep -Fq 'TWILIO_ENABLED_CHANNELS=sms,voice' "$INBOUND_TEST_LOG"
! grep -Fq 'AUTH_SECRET' "$INBOUND_TEST_LOG"
! grep -Fq 'dub-api-key' "$INBOUND_TEST_LOG"
! grep -Fq 'DUB_API_KEY' "$INBOUND_TEST_LOG"
! grep -Fq 'unsafe' "$INBOUND_TEST_LOG"

: > "$INBOUND_TEST_LOG"
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=b001fc6f-ea19-456a-8401-63971a1a1d98 \
  CONFIGURE_INBOUND_CONFIRM=yes INBOUND_TEST_PUBLIC=true \
  bash "$PROJECT_ROOT/scripts/configure-inbound-worker.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 1 && "$output" == *'no ingress'* && ! -s "$INBOUND_TEST_LOG" ]]

: > "$INBOUND_TEST_LOG"
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=b001fc6f-ea19-456a-8401-63971a1a1d98 \
  CONFIGURE_INBOUND_CONFIRM=yes INBOUND_TEST_PLAINTEXT=true \
  bash "$PROJECT_ROOT/scripts/configure-inbound-worker.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 1 && "$output" == *'Key Vault'* && ! -s "$INBOUND_TEST_LOG" ]]

: > "$INBOUND_TEST_LOG"
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=b001fc6f-ea19-456a-8401-63971a1a1d98 \
  CONFIGURE_INBOUND_CONFIRM=yes INBOUND_TEST_GENERATION_QUEUE=comic-inbound \
  bash "$PROJECT_ROOT/scripts/configure-inbound-worker.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 1 && "$output" == *'queue names must be distinct'* && ! -s "$INBOUND_TEST_LOG" ]]

: > "$INBOUND_TEST_LOG"
PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=b001fc6f-ea19-456a-8401-63971a1a1d98 \
  CONFIGURE_INBOUND_CONFIRM=yes INBOUND_TEST_WEB_MISSING_CHANNELS=true \
  bash "$PROJECT_ROOT/scripts/configure-inbound-worker.sh"
grep -Fq 'TWILIO_ENABLED_CHANNELS=' "$INBOUND_TEST_LOG"

: > "$INBOUND_TEST_LOG"
set +e
output="$(PATH="$TEST_ROOT/bin:$PATH" SUBSCRIPTION_ID=b001fc6f-ea19-456a-8401-63971a1a1d98 \
  CONFIGURE_INBOUND_CONFIRM=yes INBOUND_TEST_WEB_CHANNELS='sms;unexpected' \
  bash "$PROJECT_ROOT/scripts/configure-inbound-worker.sh" 2>&1)"
status=$?
set -e
[[ "$status" == 1 && "$output" == *'TWILIO_ENABLED_CHANNELS'* && ! -s "$INBOUND_TEST_LOG" ]]

printf 'Inbound worker Key Vault binding and private preflight mocks passed.\n'
