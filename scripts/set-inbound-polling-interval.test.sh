#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root/bin"

release_sha='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
app_image='twiliocomicsacr1a1d98.azurecr.io/twilio-comics@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
cat > "$test_root/original.json" <<JSON
{
  "id": "/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.App/containerApps/twilio-comics-inbound-v2",
  "name": "twilio-comics-inbound-v2",
  "type": "Microsoft.App/containerApps",
  "location": "eastus2",
  "properties": {
    "provisioningState": "Succeeded",
    "configuration": {"activeRevisionsMode": "Single", "ingress": null},
    "template": {
      "scale": {
        "minReplicas": 1,
        "maxReplicas": 8,
        "pollingInterval": 30,
        "cooldownPeriod": 300,
        "rules": [{
          "name": "inbound-queue",
          "custom": {
            "type": "azure-queue",
            "identity": "/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-twilio-comics-v2-worker",
            "auth": [],
            "metadata": {
              "accountName": "twiliocomicsst1a1d98",
              "cloud": "AzurePublicCloud",
              "queueLength": "4",
              "queueName": "comic-inbound"
            }
          }
        }]
      },
      "containers": [{
        "name": "twilio-comics-inbound-v2",
        "image": "$app_image",
        "resources": {"cpu": 0.25, "memory": "0.5Gi"},
        "env": [
          {"name": "RELEASE_SHA", "value": "$release_sha"},
          {"name": "DATABASE_URL", "secretRef": "runtime-database-url"}
        ]
      }]
    }
  }
}
JSON
cp "$test_root/original.json" "$test_root/state.json"

cat > "$test_root/bin/az" <<'AZ'
#!/usr/bin/env bash
set -euo pipefail
after() {
  local key="$1" previous='' item
  shift
  for item in "$@"; do
    if [[ "$previous" == "$key" ]]; then printf '%s\n' "$item"; return; fi
    previous="$item"
  done
  return 1
}
case "$1 $2" in
  'account show')
    [[ "$*" == *'--query id'* ]]
    printf '%s\n' 'b001fc6f-ea19-456a-8401-63971a1a1d98' ;;
  'rest --method')
    method="$(after --method "$@")"
    url="$(after --url "$@")"
    [[ "$url" == 'https://management.azure.com/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.App/containerApps/twilio-comics-inbound-v2?api-version=2026-01-01' ]]
    case "$method" in
      get) cat "$AZ_TEST_STATE" ;;
      patch)
        [[ "$(after --headers "$@")" == 'Content-Type=application/json' ]]
        body="$(after --body "$@")"
        [[ "$body" == @* && -f "${body#@}" ]]
        cp "${body#@}" "$AZ_TEST_PATCH"
        printf 'patch\n' >> "$AZ_TEST_PATCH_COUNT"
        if [[ "${AZ_TEST_SKIP_APPLY:-}" != 1 ]]; then
          jq --slurpfile patch "$AZ_TEST_PATCH" '
            .properties.template.scale.pollingInterval =
              $patch[0].properties.template.scale.pollingInterval
          ' "$AZ_TEST_STATE" > "$AZ_TEST_STATE.next"
          mv "$AZ_TEST_STATE.next" "$AZ_TEST_STATE"
        fi
        if [[ "${AZ_TEST_DRIFT:-}" == 1 ]]; then
          jq '.properties.template.scale.rules[0].custom.metadata.queueName = "wrong-queue"' \
            "$AZ_TEST_STATE" > "$AZ_TEST_STATE.next"
          mv "$AZ_TEST_STATE.next" "$AZ_TEST_STATE"
        fi ;;
      *) exit 90 ;;
    esac ;;
  *) printf 'Unexpected Azure command: %s\n' "$*" >&2; exit 91 ;;
esac
AZ
chmod +x "$test_root/bin/az"

export AZ_TEST_STATE="$test_root/state.json"
export AZ_TEST_PATCH="$test_root/patch.json"
export AZ_TEST_PATCH_COUNT="$test_root/patch-count.txt"

run_set_polling() {
  PATH="$test_root/bin:$PATH" \
  ACA_INBOUND_APP_NAME=twilio-comics-inbound-v2 \
  ACA_RESOURCE_GROUP=rg-twilio-comics \
  ACA_INBOUND_MAX_REPLICAS=8 \
  AZURE_STORAGE_INBOUND_QUEUE_NAME=comic-inbound \
  APP_IMAGE="$app_image" \
  GITHUB_SHA="$release_sha" \
  INBOUND_POLLING_MAX_POLLS=2 \
  INBOUND_POLLING_POLL_SECONDS=0 \
    bash "$project_root/scripts/set-inbound-polling-interval.sh"
}

# Apply only the scalar interval; every other scale field and identity survives.
run_set_polling
[[ "$(wc -l < "$AZ_TEST_PATCH_COUNT" | tr -d ' ')" == 1 ]]
jq --exit-status '
  (keys == ["location", "properties"])
  and (.properties | keys == ["template"])
  and (.properties.template | keys == ["scale"])
  and (.properties.template.scale | keys == ["pollingInterval"])
  and .properties.template.scale.pollingInterval == 10
  and .location == "eastus2"
' "$AZ_TEST_PATCH" >/dev/null
jq --exit-status --slurpfile before "$test_root/original.json" '
  .properties.template.scale.pollingInterval == 10
  and ((.properties.template.scale | del(.pollingInterval))
    == ($before[0].properties.template.scale | del(.pollingInterval)))
  and .properties.template.containers == $before[0].properties.template.containers
' "$AZ_TEST_STATE" >/dev/null

# Reruns are idempotent; an unexpected queue or failed ARM confirmation fails.
run_set_polling
[[ "$(wc -l < "$AZ_TEST_PATCH_COUNT" | tr -d ' ')" == 1 ]]
jq '.properties.template.scale.rules[0].custom.metadata.queueName = "other"' \
  "$test_root/original.json" > "$AZ_TEST_STATE"
if run_set_polling > "$test_root/error.txt" 2>&1; then
  echo 'Wrong queue unexpectedly accepted' >&2
  exit 1
fi
[[ "$(wc -l < "$AZ_TEST_PATCH_COUNT" | tr -d ' ')" == 1 ]]

jq '.properties.template.scale.rules[0].custom.identity = ""' \
  "$test_root/original.json" > "$AZ_TEST_STATE"
if run_set_polling > "$test_root/error.txt" 2>&1; then
  echo 'Missing queue managed identity unexpectedly accepted' >&2
  exit 1
fi
[[ "$(wc -l < "$AZ_TEST_PATCH_COUNT" | tr -d ' ')" == 1 ]]

cp "$test_root/original.json" "$AZ_TEST_STATE"
if AZ_TEST_SKIP_APPLY=1 run_set_polling > "$test_root/error.txt" 2>&1; then
  echo 'Unconfirmed polling interval unexpectedly accepted' >&2
  exit 1
fi
[[ "$(wc -l < "$AZ_TEST_PATCH_COUNT" | tr -d ' ')" == 2 ]]

cp "$test_root/original.json" "$AZ_TEST_STATE"
if AZ_TEST_DRIFT=1 run_set_polling > "$test_root/error.txt" 2>&1; then
  echo 'Scale rule drift unexpectedly accepted' >&2
  exit 1
fi
[[ "$(wc -l < "$AZ_TEST_PATCH_COUNT" | tr -d ' ')" == 3 ]]

grep -Fq 'run: bash scripts/set-inbound-polling-interval.sh' \
  "$project_root/.github/workflows/deploy.yml"
printf 'Inbound queue polling change, idempotence, and safety mocks passed.\n'
