#!/usr/bin/env bash
set -euo pipefail

# Builds the reviewed bootstrap and Drizzle images from explicit, minimal
# contexts. Local .env files and unrelated workspace artifacts cannot enter
# the ACR Build upload or image layers.

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for command in az git tar; do
  command -v "$command" >/dev/null 2>&1 || die "Install '$command' before building images."
done
: "${SUBSCRIPTION_ID:?Set SUBSCRIPTION_ID to the approved Azure subscription ID}"
[[ "$SUBSCRIPTION_ID" == b001fc6f-ea19-456a-8401-63971a1a1d98 ]] \
  || die 'This image build targets the approved Twilio Comics subscription.'
active_subscription="$(az account show --query id --output tsv)" \
  || die 'Sign in to Azure first.'
[[ "$active_subscription" == "$SUBSCRIPTION_ID" ]] \
  || die 'Select the approved Azure subscription before building images.'

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

source_paths=(
  Dockerfile.bootstrap Dockerfile.migrate package.json pnpm-lock.yaml pnpm-workspace.yaml
  scripts/bootstrap-azure-postgres-roles.ts scripts/check-migration-preflight.ts
  drizzle.config.ts envConfig.ts tsconfig.json lib/db.ts lib/schema.ts drizzle
)
for path in "${source_paths[@]}"; do
  [[ -e "$path" ]] || die "Missing build input '$path'."
  git ls-files --error-unmatch "$path" >/dev/null 2>&1 \
    || die "Commit build input '$path' before creating a commit-tagged image."
done
[[ -z "$(git status --porcelain --untracked-files=all -- "${source_paths[@]}")" ]] \
  || die 'Commit all bootstrap and migration source changes before building commit-tagged images.'

release_sha="$(git rev-parse HEAD)"
[[ "$release_sha" =~ ^[a-f0-9]{40}$ ]] || die 'Cannot read the committed release SHA.'
acr_name='twiliocomicsacr1a1d98'
acr_server="${acr_name}.azurecr.io"

umask 077
build_root="$(mktemp -d "${TMPDIR:-/tmp}/twilio-comics-postgres-images.XXXXXXXX")"
trap 'rm -rf "$build_root"' EXIT
mkdir -p "$build_root/bootstrap/scripts" "$build_root/migration/scripts" "$build_root/migration/lib"

cp Dockerfile.bootstrap package.json pnpm-lock.yaml pnpm-workspace.yaml "$build_root/bootstrap/"
cp scripts/bootstrap-azure-postgres-roles.ts "$build_root/bootstrap/scripts/"

cp Dockerfile.migrate package.json pnpm-lock.yaml pnpm-workspace.yaml \
  drizzle.config.ts envConfig.ts tsconfig.json "$build_root/migration/"
cp scripts/check-migration-preflight.ts "$build_root/migration/scripts/"
cp lib/db.ts lib/schema.ts "$build_root/migration/lib/"
git archive HEAD drizzle | tar -x -C "$build_root/migration"

az acr build --registry "$acr_name" --image "twilio-comics-bootstrap:$release_sha" \
  --file Dockerfile.bootstrap "$build_root/bootstrap" --only-show-errors --output none
az acr build --registry "$acr_name" --image "twilio-comics-migrate:$release_sha" \
  --file Dockerfile.migrate "$build_root/migration" --only-show-errors --output none

bootstrap_digest="$(az acr manifest show-metadata --registry "$acr_name" \
  --name "twilio-comics-bootstrap:$release_sha" --query digest --output tsv --only-show-errors)" \
  || die 'Cannot read the bootstrap image digest from ACR.'
migration_digest="$(az acr manifest show-metadata --registry "$acr_name" \
  --name "twilio-comics-migrate:$release_sha" --query digest --output tsv --only-show-errors)" \
  || die 'Cannot read the migration image digest from ACR.'
[[ "$bootstrap_digest" =~ ^sha256:[a-f0-9]{64}$ ]] \
  || die 'Bootstrap image digest is missing or invalid.'
[[ "$migration_digest" =~ ^sha256:[a-f0-9]{64}$ ]] \
  || die 'Migration image digest is missing or invalid.'

printf 'export BOOTSTRAP_IMAGE=%s/twilio-comics-bootstrap@%s\n' "$acr_server" "$bootstrap_digest"
printf 'export MIGRATION_IMAGE=%s/twilio-comics-migrate@%s\n' "$acr_server" "$migration_digest"
