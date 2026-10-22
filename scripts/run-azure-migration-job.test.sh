#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT

cat > "$fixture_dir/az" <<'MOCK_AZ'
#!/usr/bin/env bash
set -euo pipefail
printf '<%s>' "$@" >> "$MOCK_AZ_CALLS"
printf '\n' >> "$MOCK_AZ_CALLS"

case "$1 $2 $3" in
  'containerapp job show')
    if [[ "$MOCK_MODE" == 'missing-secret' ]]; then
      echo '{"properties":{"configuration":{"triggerType":"Manual"},"template":{"containers":[{"env":[]}]}}}'
    else
      echo '{"properties":{"configuration":{"triggerType":"Manual"},"template":{"containers":[{"env":[{"name":"DATABASE_URL","secretRef":"migration-database-url"}]}]}}}'
    fi
    ;;
  'containerapp job update')
    ;;
  'containerapp job start')
    echo '{"name":"comics-migrate-abc123"}'
    ;;
  'containerapp job execution')
    poll_count="$(cat "$MOCK_POLL_COUNT")"
    poll_count=$((poll_count + 1))
    echo "$poll_count" > "$MOCK_POLL_COUNT"
    status='Succeeded'
    case "$MOCK_MODE" in
      failed) status='Failed' ;;
      processing) if (( poll_count == 1 )); then status='Processing'; fi ;;
      timeout) status='Running' ;;
    esac
    image="$MIGRATION_IMAGE"
    if [[ "$MOCK_MODE" == 'wrong-image' ]]; then
      image='other.azurecr.io/comics-migrate@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    fi
    jq --null-input --arg status "$status" --arg image "$image" \
      '{properties:{status:$status,template:{containers:[{image:$image}]}}}'
    ;;
  *) echo "Unexpected az call: $*" >&2; exit 1 ;;
esac
MOCK_AZ
chmod +x "$fixture_dir/az"

image='comics.azurecr.io/twilio-comics-migrate@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
sha='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

run_case() {
  local mode="$1"
  : > "$fixture_dir/calls"
  echo 0 > "$fixture_dir/polls"
  env PATH="$fixture_dir:$PATH" \
    MOCK_MODE="$mode" \
    MOCK_AZ_CALLS="$fixture_dir/calls" \
    MOCK_POLL_COUNT="$fixture_dir/polls" \
    ACA_MIGRATION_JOB_NAME='comics-migrate' \
    ACA_RESOURCE_GROUP='comics-rg' \
    MIGRATION_IMAGE="$image" \
    GITHUB_SHA="$sha" \
    MIGRATION_POLL_INTERVAL_SECONDS=0 \
    MIGRATION_MAX_POLLS=3 \
    bash "$root_dir/scripts/run-azure-migration-job.sh" > "$fixture_dir/output" 2>&1
}

run_case processing
grep -q 'Migration preflight and Drizzle migration succeeded' "$fixture_dir/output"
[[ "$(cat "$fixture_dir/polls")" == '2' ]]
grep -q '<containerapp><job><update>' "$fixture_dir/calls"
grep -q '<containerapp><job><start>' "$fixture_dir/calls"
grep -q "<--image><$image>" "$fixture_dir/calls"
grep -q '<--command><><--args><>' "$fixture_dir/calls"

if run_case missing-secret; then
  echo 'Expected missing secret to stop the release' >&2
  exit 1
fi
if grep -q '<containerapp><job><update>' "$fixture_dir/calls"; then
  echo 'Missing secret must block before the job update' >&2
  exit 1
fi

for mode in failed wrong-image timeout; do
  if run_case "$mode"; then
    echo "Expected $mode to stop the release" >&2
    exit 1
  fi
done

echo 'Azure migration Job gate tests passed'
