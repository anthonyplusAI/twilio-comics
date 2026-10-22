#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin"

cat > "$TEST_ROOT/app.json" <<'JSON'
{
  "id": "/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.App/containerApps/twilio-comics-v2",
  "name": "twilio-comics-v2",
  "type": "Microsoft.App/containerApps",
  "location": "eastus2",
  "properties": {
    "provisioningState": "Succeeded",
    "configuration": {
      "activeRevisionsMode": "Single",
      "ingress": {"external": false, "targetPort": 8080}
    },
    "template": {
      "scale": {"minReplicas": 0, "maxReplicas": 2},
      "containers": [{
        "name": "twilio-comics-v2",
        "image": "mcr.microsoft.com/dotnet/samples:aspnetapp",
        "resources": {"cpu": 0.5, "memory": "1Gi"},
        "env": [{"name": "DATABASE_URL", "secretRef": "runtime-database-url"}],
        "command": ["pnpm"],
        "args": ["start"],
        "probes": [
          {"type": "Startup", "tcpSocket": {"port": 8080}, "failureThreshold": 240},
          {"type": "Liveness", "tcpSocket": {"port": 8080}},
          {"type": "Readiness", "tcpSocket": {"port": 8080}}
        ]
      }]
    }
  }
}
JSON
cp "$TEST_ROOT/app.json" "$TEST_ROOT/original.json"

cat > "$TEST_ROOT/bin/az" <<'AZ'
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
    [[ "$url" == 'https://management.azure.com/subscriptions/b001fc6f-ea19-456a-8401-63971a1a1d98/resourceGroups/rg-twilio-comics/providers/Microsoft.App/containerApps/twilio-comics-v2?api-version=2025-07-01' ]]
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
            .location = $patch[0].location
            | .properties.template.containers = $patch[0].properties.template.containers
          ' "$AZ_TEST_STATE" > "$AZ_TEST_STATE.next"
          mv "$AZ_TEST_STATE.next" "$AZ_TEST_STATE"
        fi ;;
      *) printf 'Unexpected REST method: %s\n' "$method" >&2; exit 90 ;;
    esac ;;
  *) printf 'Unexpected Azure command: %s\n' "$*" >&2; exit 91 ;;
esac
AZ
chmod +x "$TEST_ROOT/bin/az"

export AZ_TEST_STATE="$TEST_ROOT/app.json"
export AZ_TEST_PATCH="$TEST_ROOT/patch.json"
export AZ_TEST_PATCH_COUNT="$TEST_ROOT/patch-count"

run_ensure() {
  PATH="$TEST_ROOT/bin:$PATH" \
  ACA_NAME=twilio-comics-v2 \
  ACA_RESOURCE_GROUP=rg-twilio-comics \
  READY_PROBE_MAX_POLLS=2 \
  READY_PROBE_POLL_SECONDS=0 \
    bash "$PROJECT_ROOT/scripts/ensure-azure-readiness-probe.sh"
}

# A private, scaled-to-zero placeholder receives the HTTP readiness probe. The
# merge-patch body must carry every existing container field and no unrelated
# versioned template field, so the array replacement cannot erase env/resources.
run_ensure
[[ "$(wc -l < "$AZ_TEST_PATCH_COUNT" | tr -d ' ')" == 1 ]]
jq --exit-status '
  (keys == ["location", "properties"])
  and (.properties | keys == ["template"])
  and (.properties.template | keys == ["containers"])
  and .location == "eastus2"
  and .properties.template.containers[0].resources == {"cpu":0.5,"memory":"1Gi"}
  and .properties.template.containers[0].env == [{"name":"DATABASE_URL","secretRef":"runtime-database-url"}]
  and .properties.template.containers[0].command == ["pnpm"]
  and .properties.template.containers[0].args == ["start"]
  and ([.properties.template.containers[0].probes[] | select(.type == "Readiness")] | length == 1)
  and ([.properties.template.containers[0].probes[] | select(.type == "Readiness")][0].httpGet == {"path":"/api/readyz","port":8080})
  and ([.properties.template.containers[0].probes[] | select(.type == "Startup" or .type == "Liveness")] | length == 2)
' "$AZ_TEST_PATCH" >/dev/null
run_ensure
[[ "$(wc -l < "$AZ_TEST_PATCH_COUNT" | tr -d ' ')" == 1 ]]

# Later public releases may have a sidecar. The complete container array must
# survive the JSON Merge Patch; only the first container's readiness probe moves.
jq '.properties.configuration.ingress.external = true
  | .properties.template.scale.minReplicas = 1
  | .properties.template.containers[0].image = "testacr.azurecr.io/twilio-comics@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  | .properties.template.containers[0].probes = [{"type":"Readiness","tcpSocket":{"port":8080}}]
  | .properties.template.containers += [{"name":"metrics","image":"metrics:v1","env":[{"name":"MODE","value":"safe"}],"resources":{"cpu":0.25,"memory":"0.5Gi"}}]
' "$TEST_ROOT/original.json" > "$AZ_TEST_STATE"
cp "$AZ_TEST_STATE" "$TEST_ROOT/public-before.json"
run_ensure
[[ "$(wc -l < "$AZ_TEST_PATCH_COUNT" | tr -d ' ')" == 2 ]]
jq --slurpfile before "$TEST_ROOT/public-before.json" '
  .properties.template.containers[1] == $before[0].properties.template.containers[1]
  and (.properties.template.containers[0] | del(.probes)) == ($before[0].properties.template.containers[0] | del(.probes))
' "$AZ_TEST_PATCH" >/dev/null

# Bad target state must stop before a PATCH. A public sample placeholder is
# especially dangerous because it would expose an unrelated app on cutover.
jq '.properties.configuration.ingress.external = true' "$TEST_ROOT/original.json" > "$AZ_TEST_STATE"
if run_ensure >"$TEST_ROOT/error.txt" 2>&1; then
  echo 'Public placeholder unexpectedly accepted' >&2
  exit 1
fi
[[ "$(wc -l < "$AZ_TEST_PATCH_COUNT" | tr -d ' ')" == 2 ]]

# An accepted PATCH that never appears in ARM reads is not deployment success.
cp "$TEST_ROOT/original.json" "$AZ_TEST_STATE"
if AZ_TEST_SKIP_APPLY=1 run_ensure >"$TEST_ROOT/error.txt" 2>&1; then
  echo 'Unverified readiness patch unexpectedly accepted' >&2
  exit 1
fi
[[ "$(wc -l < "$AZ_TEST_PATCH_COUNT" | tr -d ' ')" == 3 ]]

grep -q 'Ensure web readiness probe' "$PROJECT_ROOT/.github/workflows/deploy.yml"
python3 - "$PROJECT_ROOT/.github/workflows/deploy.yml" <<'PY'
from pathlib import Path
import sys

workflow = Path(sys.argv[1]).read_text()
assert workflow.index('name: Ensure web readiness probe') < workflow.index('name: Deploy web and voice app')
assert 'bash scripts/ensure-azure-readiness-probe.sh' in workflow
PY

echo 'Azure readiness probe patch tests passed'
