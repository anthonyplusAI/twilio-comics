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

subscription='b001fc6f-ea19-456a-8401-63971a1a1d98'
resource_group='rg-twilio-comics'
base_id="/subscriptions/$subscription/resourceGroups/$resource_group"
job_id="$base_id/providers/Microsoft.App/jobs/twilio-comics-migrate-v2"
environment_id="$base_id/providers/Microsoft.App/managedEnvironments/cae-twilio-comics-v2"
identity_id="$base_id/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-twilio-comics-pg-migrate"
vault_uri='https://kv-twilio-comics-1a1d98.vault.azure.net/secrets/postgres-comics-migration-url'

case "$1 $2 $3" in
  'account show --query')
    if [[ "$MOCK_MODE" == 'wrong-subscription' ]]; then
      echo '00000000-0000-0000-0000-000000000000'
    else
      echo "$subscription"
    fi
    ;;
  'containerapp job show')
    job_json="$(jq --null-input \
      --arg job_id "$job_id" \
      --arg environment_id "$environment_id" \
      --arg identity_id "$identity_id" \
      --arg vault_uri "$vault_uri" '
      {
        id: $job_id,
        name: "twilio-comics-migrate-v2",
        identity: {
          type: "UserAssigned",
          userAssignedIdentities: {($identity_id): {}}
        },
        properties: {
          environmentId: $environment_id,
          configuration: {
            triggerType: "Manual",
            secrets: [{
              name: "migration-database-url",
              keyVaultUrl: $vault_uri,
              identity: $identity_id
            }]
          },
          template: {
            containers: [{
              name: "twilio-comics-migrate-v2",
              env: [{name: "DATABASE_URL", secretRef: "migration-database-url"}]
            }]
          }
        }
      }')"
    filter='.'
    case "$MOCK_MODE" in
      wrong-job-id) filter='.id = "/subscriptions/other/resourceGroups/other/providers/Microsoft.App/jobs/twilio-comics-migrate-v2"' ;;
      wrong-job-name) filter='.name = "another-job"' ;;
      wrong-environment) filter='.properties.environmentId = "/subscriptions/other/resourceGroups/other/providers/Microsoft.App/managedEnvironments/other"' ;;
      wrong-trigger) filter='.properties.configuration.triggerType = "Schedule"' ;;
      extra-container) filter='.properties.template.containers += [{name: "extra", env: []}]' ;;
      missing-assigned-identity) filter='.identity.userAssignedIdentities = {}' ;;
      missing-secret) filter='.properties.configuration.secrets = []' ;;
      duplicate-secret) filter='.properties.configuration.secrets += [.properties.configuration.secrets[0]]' ;;
      extra-secret) filter='.properties.configuration.secrets += [{name: "runtime-database-url", value: "unexpected-value"}]' ;;
      wrong-secret-uri) filter='.properties.configuration.secrets[0].keyVaultUrl = "https://other.vault.azure.net/secrets/postgres-comics-migration-url"' ;;
      versioned-secret-uri) filter='.properties.configuration.secrets[0].keyVaultUrl += "/secret-version"' ;;
      wrong-secret-identity) filter='.properties.configuration.secrets[0].identity = "other-identity"' ;;
      plaintext-secret) filter='.properties.configuration.secrets[0].value = "unexpected-value"' ;;
      missing-database-env) filter='.properties.template.containers[0].env = []' ;;
      duplicate-database-env) filter='.properties.template.containers[0].env += [{name: "DATABASE_URL", value: "unexpected-value"}]' ;;
      plaintext-database-env) filter='.properties.template.containers[0].env[0].value = "unexpected-value"' ;;
      wrong-database-ref) filter='.properties.template.containers[0].env[0].secretRef = "runtime-database-url"' ;;
    esac
    jq "$filter" <<< "$job_json"
    ;;
  'containerapp job update')
    if [[ "$*" != *'--command pnpm --args run db:migrate:safe'* ]]; then
      echo 'Migration Job update must store an executable startup command' >&2
      exit 98
    fi ;;
  'containerapp job start')
    # A start-time image override drops the stored DATABASE_URL secretref.
    if [[ " $* " == *' --image '* ]]; then
      echo 'Job start image override discarded DATABASE_URL' >&2
      exit 97
    fi
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

image='twiliocomicsacr1a1d98.azurecr.io/twilio-comics-migrate@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
sha='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

run_case() {
  local mode="$1" job="${2:-twilio-comics-migrate-v2}" group="${3:-rg-twilio-comics}" migration_image="${4:-$image}"
  : > "$fixture_dir/calls"
  echo 0 > "$fixture_dir/polls"
  env PATH="$fixture_dir:$PATH" \
    MOCK_MODE="$mode" \
    MOCK_AZ_CALLS="$fixture_dir/calls" \
    MOCK_POLL_COUNT="$fixture_dir/polls" \
    ACA_MIGRATION_JOB_NAME="$job" \
    ACA_RESOURCE_GROUP="$group" \
    MIGRATION_IMAGE="$migration_image" \
    GITHUB_SHA="$sha" \
    MIGRATION_POLL_INTERVAL_SECONDS=0 \
    MIGRATION_MAX_POLLS=3 \
    bash "$root_dir/scripts/run-azure-migration-job.sh" > "$fixture_dir/output" 2>&1
}

assert_preflight_rejects() {
  local mode="$1" job="${2:-twilio-comics-migrate-v2}" group="${3:-rg-twilio-comics}" migration_image="${4:-$image}"
  if run_case "$mode" "$job" "$group" "$migration_image"; then
    echo "Expected $mode to stop the release before updating the Job" >&2
    exit 1
  fi
  if grep -Eq '<containerapp><job><(update|start)>' "$fixture_dir/calls"; then
    echo "$mode changed or started a Job despite failing preflight" >&2
    exit 1
  fi
}

run_case processing
grep -q 'Migration preflight and Drizzle migration succeeded' "$fixture_dir/output"
[[ "$(cat "$fixture_dir/polls")" == '2' ]]
grep -q '<containerapp><job><update>' "$fixture_dir/calls"
grep -q '<containerapp><job><start>' "$fixture_dir/calls"
grep -Fq "<--image><$image>" "$fixture_dir/calls"
grep -Fq '<--command><pnpm><--args><run><db:migrate:safe>' "$fixture_dir/calls"

for mode in \
  wrong-subscription wrong-job-id wrong-job-name wrong-environment \
  wrong-trigger extra-container missing-assigned-identity missing-secret \
  duplicate-secret extra-secret wrong-secret-uri versioned-secret-uri wrong-secret-identity \
  plaintext-secret missing-database-env duplicate-database-env \
  plaintext-database-env wrong-database-ref; do
  assert_preflight_rejects "$mode"
done
assert_preflight_rejects valid another-job
assert_preflight_rejects valid twilio-comics-migrate-v2 another-resource-group
assert_preflight_rejects valid twilio-comics-migrate-v2 rg-twilio-comics \
  'other.azurecr.io/comics-migrate@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

for mode in failed wrong-image timeout; do
  if run_case "$mode"; then
    echo "Expected $mode to stop the release" >&2
    exit 1
  fi
done

echo 'Azure migration Job gate tests passed'
