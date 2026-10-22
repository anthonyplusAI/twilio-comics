#!/usr/bin/env bash
set -Eeuo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/twilio-comics-images-test.XXXXXXXX")"
report_failure() {
  local status="$1" line="$2" command="$3" capture
  printf 'Image build mock test failed (exit %s) at line %s: %s\n' \
    "$status" "$line" "$command" >&2
  for capture in images.out untracked.out dirty.out; do
    if [[ -s "$test_root/$capture" ]]; then
      printf 'Captured %s:\n' "$capture" >&2
      sed -n '1,20p' "$test_root/$capture" >&2
    fi
  done
}
trap 'report_failure "$?" "$LINENO" "$BASH_COMMAND"' ERR
trap 'rm -rf "$test_root"' EXIT
fixture="$test_root/project"
mkdir -p "$fixture/scripts" "$fixture/lib" "$fixture/drizzle" "$test_root/bin"

cp "$project_root/scripts/build-azure-postgres-images.sh" "$fixture/scripts/"
for path in Dockerfile.bootstrap Dockerfile.migrate package.json pnpm-lock.yaml \
  pnpm-workspace.yaml drizzle.config.ts envConfig.ts tsconfig.json; do
  printf '%s\n' "$path" > "$fixture/$path"
done
for path in scripts/bootstrap-azure-postgres-roles.ts scripts/check-migration-preflight.ts \
  lib/db.ts lib/schema.ts drizzle/0000_test.sql; do
  printf '%s\n' "$path" > "$fixture/$path"
done
printf '%s\n' 'local-secret-must-not-be-uploaded' > "$fixture/.env"

git -C "$fixture" init -q
git -C "$fixture" config user.name 'Test'
git -C "$fixture" config user.email 'test@example.com'
git -C "$fixture" add .
git -C "$fixture" commit -qm 'Fixtures'

cat > "$test_root/bin/az" <<'AZ_MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$AZ_MOCK_LOG"
if [[ "${1:-} ${2:-}" == 'account show' ]]; then
  printf '%s\n' 'b001fc6f-ea19-456a-8401-63971a1a1d98'
elif [[ "${1:-} ${2:-}" == 'acr build' ]]; then
  context="${@: -1}"
  assert_context() {
    printf 'ACR build mock rejected context: %s\n' "$1" >&2
    exit 1
  }
  [[ -d "$context" ]] || assert_context 'the final argument must be a directory'
  [[ ! -e "$context/.env" ]] || assert_context '.env must not be uploaded'
  if [[ "$*" == *'twilio-comics-bootstrap:'* ]]; then
    [[ -f "$context/scripts/bootstrap-azure-postgres-roles.ts" ]] \
      || assert_context 'bootstrap input is missing'
    [[ ! -d "$context/drizzle" ]] \
      || assert_context 'bootstrap context includes migrations'
  else
    [[ -f "$context/scripts/check-migration-preflight.ts" ]] \
      || assert_context 'migration preflight input is missing'
    [[ -f "$context/drizzle/0000_test.sql" ]] \
      || assert_context 'committed migration is missing'
    [[ ! -e "$context/scripts/bootstrap-azure-postgres-roles.ts" ]] \
      || assert_context 'migration context includes bootstrap source'
  fi
elif [[ "${1:-} ${2:-} ${3:-}" == 'acr manifest show-metadata' ]]; then
  if [[ "$*" == *'twilio-comics-bootstrap:'* ]]; then
    printf 'sha256:%064d\n' 0 | tr '0' 'a'
  else
    printf 'sha256:%064d\n' 0 | tr '0' 'b'
  fi
fi
AZ_MOCK
chmod 700 "$test_root/bin/az"
export PATH="$test_root/bin:$PATH"
export AZ_MOCK_LOG="$test_root/az.log"
export SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98'

bash "$fixture/scripts/build-azure-postgres-images.sh" > "$test_root/images.out"
grep -Eq '^export BOOTSTRAP_IMAGE=twiliocomicsacr1a1d98\.azurecr\.io/twilio-comics-bootstrap@sha256:a{64}$' "$test_root/images.out"
grep -Eq '^export MIGRATION_IMAGE=twiliocomicsacr1a1d98\.azurecr\.io/twilio-comics-migrate@sha256:b{64}$' "$test_root/images.out"
[[ "$(grep -c '^acr build ' "$AZ_MOCK_LOG")" == 2 ]]

: > "$AZ_MOCK_LOG"
printf '%s\n' 'untracked migration must not be uploaded' > "$fixture/drizzle/evil.sql"
if bash "$fixture/scripts/build-azure-postgres-images.sh" > "$test_root/untracked.out" 2>&1; then
  printf 'Untracked migration input unexpectedly passed the committed-source check\n' >&2
  exit 1
fi
if grep -Fq 'acr build' "$AZ_MOCK_LOG"; then
  printf 'ACR build ran despite an untracked migration artifact\n' >&2
  exit 1
fi
rm "$fixture/drizzle/evil.sql"

: > "$AZ_MOCK_LOG"
printf '%s\n' '// uncommitted change' >> "$fixture/scripts/bootstrap-azure-postgres-roles.ts"
if bash "$fixture/scripts/build-azure-postgres-images.sh" > "$test_root/dirty.out" 2>&1; then
  printf 'Dirty bootstrap source unexpectedly passed the committed-source check\n' >&2
  exit 1
fi
if grep -Fq 'acr build' "$AZ_MOCK_LOG"; then
  printf 'ACR build ran despite an uncommitted bootstrap change\n' >&2
  exit 1
fi

printf 'Azure PostgreSQL image build mock tests passed\n'
