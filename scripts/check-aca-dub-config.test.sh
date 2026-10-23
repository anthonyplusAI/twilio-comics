#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
validator='scripts/check-aca-dub-config.sh'

base='{"properties":{"template":{"containers":[{"env":[{"name":"RESULT_MEDIA_PREVIEW_ENABLED","value":"false"}]}]},"configuration":{"secrets":[]}}}'
complete='{"properties":{"template":{"containers":[{"env":[{"name":"DUB_API_KEY","secretRef":"dub-api-key"},{"name":"DUB_DOMAIN","value":"twil.io"},{"name":"DUB_FOLDER_ID","value":"folder-test"}]}]},"configuration":{"secrets":[{"name":"dub-api-key"}]}}}'

assert_pass() {
  local output
  if ! output="$(bash "$validator" <<< "$1" 2>&1)"; then
    printf 'Expected valid Dub metadata, got: %s\n' "$output" >&2
    exit 1
  fi
}

assert_fail() {
  local output
  if output="$(bash "$validator" <<< "$1" 2>&1)"; then
    printf 'Expected invalid Dub metadata to fail: %s\n' "$output" >&2
    exit 1
  fi
  if [[ "$output" == *'do-not-log-this-api-key'* ]]; then
    echo 'Dub configuration check printed an API key value.' >&2
    exit 1
  fi
}

assert_pass "$base"
assert_pass "$complete"
assert_pass "$(jq '.properties.template.containers[0].env[0].value = ""' <<< "$complete")"
assert_pass "$(jq '.properties.template.containers[0].env += [{"name":"RESULT_MEDIA_PREVIEW_ENABLED","value":"true"}]' <<< "$complete")"

for name in DUB_API_KEY DUB_DOMAIN DUB_FOLDER_ID; do
  assert_fail "$(jq --arg name "$name" '.properties.template.containers[0].env |= map(select(.name != $name))' <<< "$complete")"
done
assert_fail "$(jq '.properties.template.containers[0].env[0] = {"name":"DUB_API_KEY","value":"do-not-log-this-api-key"}' <<< "$complete")"
assert_fail "$(jq '.properties.template.containers[0].env[0].value = "do-not-log-this-api-key"' <<< "$complete")"
assert_fail "$(jq '.properties.configuration.secrets = []' <<< "$complete")"
assert_fail "$(jq '.properties.template.containers[0].env[1].value = "   "' <<< "$complete")"
assert_fail "$(jq '.properties.template.containers[0].env[2].value = ""' <<< "$complete")"
assert_fail "$(jq '.properties.template.containers[0].env += [{"name":"DUB_DOMAIN","value":"another.example"}]' <<< "$complete")"
assert_fail "$(jq '.properties.template.containers = []' <<< "$base")"
assert_fail 'invalid JSON with do-not-log-this-api-key'

echo 'ACA Dub configuration preflight tests passed.'
