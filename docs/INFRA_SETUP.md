# Azure Infrastructure Setup

Twilio Comics uses Azure Container Apps for its public app and Jobs, Azure Storage for images and queue messages, and **Azure Database for PostgreSQL Flexible Server** for comics, conversations, and retained admin history. This guide records the running V2 pilot and the steps to recreate or change its infrastructure. The [private PostgreSQL guide](AZURE_POSTGRES.md) covers networking, database roles, TLS, backups, and migrations in more detail.

## Current state and production target

The approved Azure subscription has a V1 foundation in `rg-twilio-comics`: ACR `twiliocomicsacr1a1d98`, Storage account `twiliocomicsst1a1d98`, Log Analytics, managed identities, GitHub OIDC, and a managed-network Container Apps environment. Its web app and Jobs are **sample-image placeholders**. The private V2 platform is provisioned and its app is public at [the V2 origin](https://twilio-comics-v2.kindriver-a0456aa8.eastus2.azurecontainerapps.io). Check `/api/healthz` for the currently deployed release and `/api/readyz` for database readiness; a previously observed readiness check returned HTTP 200 against the migrated private database. The production release gate is `PRODUCTION_RELEASE_READY=true`.

The Twilio number **+1 866 901 2028** is toll-free approved and has verified SMS and Voice POST webhooks. The V2 web app has `TWILIO_ENABLED_CHANNELS=sms,voice`; WhatsApp remains disabled. The operator confirmed admin password sign-in, and a live inbound SMS received a delivered agent reply after the October 22 worker repair. This is a controlled pilot: end-to-end handset SMS and Voice comics and their result deliveries still need confirmation. The one-time provisioning commands below describe how this environment was built; do not rerun bootstrap scripts against the active pilot without reviewing their preconditions and current settings.

| Workload | V1 placeholder | Current private-network pilot |
|---|---|---|
| Container Apps environment | `cae-twilio-comics` | `cae-twilio-comics-v2` |
| Public web and Voice app | `twilio-comics` | `twilio-comics-v2` |
| Queue generation Job | `twilio-comics-generation` | `twilio-comics-generation-v2` |
| Scheduled recovery Job | `twilio-comics-recovery` | `twilio-comics-recovery-v2` |
| Manual migration Job | None | `twilio-comics-migrate-v2` |
| PostgreSQL | Not part of V1 | Central US Flexible Server `twilio-comics-pg-1a1d98`, database `twilio_comics` |

`scripts/provision-azure.sh` created the V1 foundation with an Azure managed-network ACA environment. To reproduce the V2 platform, run the private-platform provisioner **first** so the V2 environment exists with VNet integration and a route to Central US PostgreSQL. Only then rerun `provision-azure.sh` with V2 workload names; it reuses that environment and creates the V2 web app and two runtime Jobs. If the order is reversed, it can create a managed-network V2 environment that cannot reach the private database. The V2 app and Jobs now run the pilot image; the V1 placeholders remain outside the public Twilio route and can be retired after live handset and admin checks.

## Inspect or recreate the existing foundation

You need Azure permission to create resource groups, Container Apps, managed identities, an Entra application, and role assignments. You also need GitHub repository administrator access. Install Azure CLI, GitHub CLI, `git`, and `jq`, then authenticate:

```bash
az login
gh auth login
git remote get-url origin
```

The script checks that the `Microsoft.App`, `Microsoft.OperationalInsights`, `Microsoft.Storage`, `Microsoft.ContainerRegistry`, and `Microsoft.ManagedIdentity` resource providers are registered in the selected subscription before creating resources. On a fresh subscription, register any missing provider with `az provider register --namespace <provider> --wait` and rerun the script.

Confirm that `origin` names the intended GitHub repository. The script can create a fresh private placeholder or repair matching resources. The existing V1 web placeholder has external ingress, so a default-name rerun stops until that sample is made internal; scale it to zero to avoid idle compute charges. For this installation, follow the V2 command below after its private Container Apps environment exists. A fresh installation can use its own globally unique ACR and Storage account names:

```bash
export SUBSCRIPTION_ID="<subscription-id>"
export ACR_NAME='twiliocomicsacr1a1d98'
export STORAGE_ACCOUNT='twiliocomicsst1a1d98'
bash scripts/provision-azure.sh
```

The script prints the subscription, resource group, repository, and OIDC subject before its confirmation prompt. It creates or reuses the foundation; it does **not** deploy this application, create the private VNet or PostgreSQL server, run migrations, configure Twilio, or set runtime credentials. For an unattended rerun, set `PROVISION_AZURE_CONFIRM=yes` only after reviewing those values.

Optional name overrides are `RESOURCE_GROUP`, `LOCATION`, `LOG_ANALYTICS_WORKSPACE`, `ACA_ENVIRONMENT`, `ACA_NAME`, `ACA_JOB_NAME`, `ACA_RECOVERY_JOB_NAME`, `BLOB_CONTAINER`, `QUEUE_NAME`, `POISON_QUEUE_NAME`, the three `*_IDENTITY_NAME` variables, and `DEPLOY_APP_NAME`. Defaults are shown below. `CREATED_BY` and `MANAGED_BY` override the tenant tag values if your policy requires different values.

## Placeholder resources created or reused

| Resource | Default name | Purpose |
|---|---|---|
| Resource group | `rg-twilio-comics` | Contains the Azure resources |
| Container Registry | `ACR_NAME` | Private image repository, admin account disabled on new registries |
| Log Analytics workspace | `law-twilio-comics` | Explicit log destination for a new ACA environment |
| Container Apps environment | `cae-twilio-comics` | Managed-network placeholder environment |
| Web Container App | `twilio-comics` | ASP.NET sample image; new placeholders use internal port 8080 ingress and zero minimum replicas |
| Event-driven ACA Job | `twilio-comics-generation` | Placeholder image and Azure Queue trigger |
| Scheduled ACA recovery Job | `twilio-comics-recovery` | Placeholder image and dormant annual cron |
| StorageV2 account | `STORAGE_ACCOUNT` | Private Blob container and generation queues |
| Blob container | `comics` | Generated images and references |
| Storage queues | `comic-generation`, `comic-generation-poison` | Pending and poison job messages |
| User-assigned identities | `id-twilio-comics-web`, `id-twilio-comics-worker`, `id-twilio-comics-acr-pull` | Storage access and ACR image pulls |
| Entra application | `twilio-comics-gha-deploy` | GitHub OIDC deployment principal |

Every newly created Azure Resource Manager resource receives `created_by=github-actions` and `managed_by=twilio-comics-ci` by default. The script creates or reuses a **tagged Log Analytics workspace before creating a new Container Apps environment**; this prevents ACA from generating an untagged workspace that a tenant policy may reject. Azure Blob containers and queues are data-plane objects and do not receive ARM resource tags. Existing resource tags are not rewritten.

The script checks for resources by their exact configured names before creating them. It reuses role assignments, identities, ACR pull configuration, and the OIDC credential. On an existing web app or Job, it fills in missing infrastructure environment variables; if a configured storage account or managed identity differs, it stops instead of redirecting a live workload. An adopted app must have HTTP ingress targeting port 8080; the script accepts internal or external ingress without changing it. It refuses to proceed if the ASP.NET sample is externally reachable. Changing ingress on a live app may interrupt traffic, so make that change deliberately or choose a new `ACA_NAME`. An existing Container Apps environment keeps its current Log Analytics destination. Rerunning after an interrupted setup does not delete resources.

New web placeholders start from Microsoft's ASP.NET sample image on internal port 8080 with `minReplicas=0`, and do not serve `/api/healthz`. The existing V1 sample predates that setting and needs a separate ingress review. The recovery Job has a dormant annual cron. The production release changes the **V2 workloads** to immutable image digests, enables the five-minute recovery sweep, waits for the web revision to become healthy, and then switches its ingress to external HTTPS.

After deployment, the V2 recovery Job runs `pnpm start:worker` with `RECOVERY_MODE=1` on `*/5 * * * *` (five-minute UTC). Give it the same worker managed identity, storage environment variables, runtime secrets, and ACR pull identity as the V2 queue Job. Its bounded sweep republishes pending inbound receipts and generation jobs after transient failures. The scheduled and queue Jobs remain separate so a recovery sweep never consumes a queue message.

## Build the private production environment

Follow [Azure PostgreSQL setup](AZURE_POSTGRES.md) before pointing the release workflow at V2, and review the [early launch Azure cost estimate](AZURE_COSTS.md). The V2 Container Apps VNet `vnet-twilio-comics-v2` is in **East US 2**, uses `10.74.0.0/20`, and has an `aca-infrastructure` subnet at `10.74.0.0/23`. The database VNet `vnet-twilio-comics-pg-cus` is in **Central US**, uses `10.75.0.0/20`, and has a PostgreSQL delegated subnet at `10.75.0.0/26`. The template creates bidirectional global peering and links the PostgreSQL private DNS zone to both VNets. An unused PostgreSQL subnet at `10.74.8.0/26` remains in the East US 2 VNet so incremental updates preserve that existing resource. Check all address ranges for overlap and register `Microsoft.Network`, `Microsoft.KeyVault`, and `Microsoft.DBforPostgreSQL` if needed. The provisioner generates a strong PostgreSQL administrator password, stores it as `postgres-bootstrap-password` in Key Vault `kv-twilio-comics-1a1d98`, and reuses it on later runs. It does not display the password or pass it in a command argument. Preview the Bicep resources without creating anything, then run the repeatable private-platform provisioner:

```bash
az account set --subscription 'b001fc6f-ea19-456a-8401-63971a1a1d98'

SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98' \
PRIVATE_PLATFORM_MODE=what-if \
bash scripts/provision-private-platform.sh

SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98' \
PROVISION_PRIVATE_PLATFORM_CONFIRM=yes \
bash scripts/provision-private-platform.sh
```

The active `az` subscription must match `SUBSCRIPTION_ID`. The preview covers the Bicep resources; the Key Vault is created only by the actual provisioning run. Tenant policy requires Key Vault purge protection, a deny by default firewall, and an expiry on **every new secret version**. New secrets created by these scripts expire 365 days after creation; reruns keep existing values and expiry dates. The script detects the operator's public IPv4 address and allows that single address for Azure CLI secret operations; set `OPERATOR_PUBLIC_IPV4` explicitly if automatic detection sees a different egress address. It enables the `Microsoft.KeyVault` service endpoint on the V2 Container Apps subnet, then adds that subnet to the vault firewall for managed-identity Jobs. The vault also needs a Key Vault Secrets User role assignment for each Job identity that reads it. A protected, single-line `POSTGRES_ADMIN_PASSWORD_FILE` with mode `0600` is an optional first-run override; omit it for secure generation and storage in Key Vault.

The existing `postgres-bootstrap-password` version has `expires: null`; provisioning will reuse it and will **not** repair that metadata. After ensuring the operator can reach the vault and has permission to set secret attributes, assign the current version a UTC expiry. This updates metadata without fetching or changing the password:

```bash
bootstrap_expires_utc="$(python3 - <<'PY'
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc) + timedelta(days=365)).strftime('%Y-%m-%dT%H:%M:%SZ'))
PY
)"
az keyvault secret set-attributes --vault-name kv-twilio-comics-1a1d98 \
  --name postgres-bootstrap-password --expires "$bootstrap_expires_utc" \
  --only-show-errors --output none
az keyvault secret show --vault-name kv-twilio-comics-1a1d98 \
  --name postgres-bootstrap-password \
  --query '{name:name,expires:attributes.expires}' --output json
```

The expiry is a deadline for a planned password rotation, not an automatic refresh. Set a Key Vault near-expiry alert and follow the [database credential rotation procedure](AZURE_POSTGRES.md#key-vault-expiry-and-database-credential-rotation) before that date.

The script creates the private PostgreSQL DNS zone with links to both VNets, global peerings in both directions, `cae-twilio-comics-v2` as a workload-profile environment in East US 2, a `Standard_B1ms` PostgreSQL Flexible Server in Central US with private access and public network access disabled, and the `twilio_comics` database. It does **not** create the V2 web app or Jobs, runtime/migration SQL roles or URLs, GitHub configuration, or Twilio webhooks. The existing managed-network ACA environment cannot provide the private database route.

Confirm the V2 environment exists and its infrastructure subnet ID is the new VNet's ACA subnet. **Only after that**, invoke the existing foundation script with V2 workload names and the original ACR and Storage account. It reuses the V2 environment, creates the web app plus event and recovery Jobs with sample images, attaches their managed identities, and repoints the GitHub workload variables to V2:

```bash
az containerapp env show --name cae-twilio-comics-v2 --resource-group rg-twilio-comics \
  --query properties.vnetConfiguration.infrastructureSubnetId --output tsv

SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98' \
ACR_NAME='twiliocomicsacr1a1d98' \
STORAGE_ACCOUNT='twiliocomicsst1a1d98' \
ACA_ENVIRONMENT='cae-twilio-comics-v2' \
ACA_NAME='twilio-comics-v2' \
ACA_JOB_NAME='twilio-comics-generation-v2' \
ACA_RECOVERY_JOB_NAME='twilio-comics-recovery-v2' \
ACA_MIGRATION_JOB_NAME='twilio-comics-migrate-v2' \
GITHUB_OIDC_SUBJECT='repo:anthonyplusAI@26190505/twilio-comics@1286817910:environment:production' \
PROVISION_AZURE_CONFIRM=yes \
bash scripts/provision-azure.sh
```

At bootstrap, the V2 web placeholder is internal and scaled to zero. The release workflow requires single revision mode and makes it externally reachable only after the private migration Job succeeds and a digest-pinned Twilio Comics web revision is healthy. The current V2 web app now has external HTTPS ingress on port 8080 for the website, Twilio webhooks, and ConversationRelay WebSocket. The two runtime Jobs need no public ingress. The PostgreSQL role provisioner creates the fourth workload as a **manual**, one-container migration Job using the reviewed `Dockerfile.migrate` image. Build and pin its image and the one-off role bootstrap image from committed source:

```bash
export SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98'
bash scripts/build-azure-postgres-images.sh
# Copy the two printed BOOTSTRAP_IMAGE and MIGRATION_IMAGE export lines here.
PROVISION_POSTGRES_ROLES_CONFIRM=yes bash scripts/provision-postgres-roles.sh
```

`scripts/provision-postgres-roles.sh` first seeds `postgres-comics-runtime-url` and `postgres-comics-migration-url` in Key Vault through owner-only temporary files and the host Azure CLI, preserving valid existing URLs on reruns. It then starts `twilio-comics-db-bootstrap-v2` inside the private V2 environment to create and verify separate `comics_runtime` and `comics_migrator` SQL logins. The Job retrieves the administrator password and the two URL secrets through temporary, secret-scoped Key Vault Secrets User grants that the host script revokes on exit. Only after SQL verification succeeds does the script grant the V2 workload identities their own secret-scoped reads, bind the runtime URL as `runtime-database-url` on the web/generation/recovery workloads, and create `twilio-comics-migrate-v2` with `migration-database-url`. Both are exposed to their containers as `DATABASE_URL=secretref:...`. See the [role bootstrap steps](AZURE_POSTGRES.md#one-time-role-bootstrap-and-v2-workload-wiring) for exact behavior and recovery.

For a fresh installation, rerun `scripts/provision-azure.sh` with the same V2 name overrides after the migration Job exists. Its first run cannot grant a role on a Job that has not been created. The second run assigns the GitHub deployment principal `Container Apps Jobs Contributor` on that exact migration Job, which includes permission to start it. Keep the production release gate closed until this grant is present; the current pilot has completed this step.

The platform template sets 14-day backups; review that retention and confirm point-in-time restore. Confirm the database is `Ready`, both peerings are `Connected`, both private DNS links are complete, and port 5432 works from a Job inside the East US 2 V2 environment before the first release.

The migration Job's image contains checked-in Drizzle migrations and the read-only preflight script. It runs preflight, then `pnpm db:migrate`, before a runtime image is rolled out. For an older populated database, follow the reviewed baseline or import procedure in [the private database guide](AZURE_POSTGRES.md#migration-execution-inside-the-vnet); do not replay initial migrations over its tables. `pnpm drizzle-kit push` is for a development database, not the production rollout.

## Access and GitHub OIDC

The script grants the following roles after creating or finding each identity:

| Principal | Scope | Role |
|---|---|---|
| Web managed identity | Storage account | Storage Blob Data Contributor; Storage Queue Data Message Sender |
| Worker managed identity | Storage account | Storage Blob Data Contributor; Storage Queue Data Contributor |
| ACR pull managed identity | Registry | AcrPull |
| Provisioning user | Storage account | Storage Blob Data Contributor; Storage Queue Data Contributor |
| GitHub V2 deployment principal | Existing registry | AcrPush |
| GitHub V2 deployment principal | Exact V2 web app | Container Apps Contributor |
| GitHub V2 deployment principal | Exact V2 generation and recovery Jobs | Container Apps Jobs Contributor on each Job |
| GitHub V2 deployment principal | Exact V2 migration Job, after it exists | Container Apps Jobs Contributor |

For a service-principal Azure login, set `PROVISIONER_OBJECT_ID` and `PROVISIONER_PRINCIPAL_TYPE=ServicePrincipal` so the script can grant data-plane rights needed to create the Blob container and queues. Role assignments can take time to propagate; the script waits and retries data-plane creation.

The V2 script does not grant Resource Group Contributor to GitHub. If the **same** deployment principal still has a direct Resource Group Contributor assignment from an older run, it stops and asks for a manual review and revocation; it does not delete an assignment automatically. The older V1 OIDC principal may have its own Resource Group Contributor grant. Audit that principal after V2 cutover and revoke its grant when V1 deployments are no longer needed. [Microsoft's built-in Container Apps roles](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers) include the app update and Job update/start operations used by this workflow. [Their wildcard actions can also read secrets](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets#permissions-for-managing-secrets) on the scoped app or Job, so restrict GitHub environment access to trusted release operators.

Both Azure-login jobs in `deploy.yml` use the GitHub `production` environment. The script parses the **actual `origin` Git remote** to derive the repository. Without an override, it computes the usual [environment-specific OIDC subject](https://docs.github.com/en/actions/reference/security/oidc):

```text
repo:<origin-owner>/<origin-repo>:environment:production
```

This repository's production workflow emitted an ID-based `sub` claim, so its current override is:

```bash
GITHUB_OIDC_SUBJECT='repo:anthonyplusAI@26190505/twilio-comics@1286817910:environment:production'
```

Use that value with the V2 provisioning command above and on later reruns. The claim can change if the repository is transferred or replaced; verify the actual `sub` claim from a trusted production workflow before changing the override. If the existing `gha-production` credential subject differs from the computed default and `GITHUB_OIDC_SUBJECT` is absent, the script stops without updating the credential. An explicit override authorizes the script to update that credential when needed. On every completed run it enforces a custom `main`-only deployment branch policy on the GitHub `production` environment, including one created earlier without restrictions; it preserves existing required reviewers and wait timers when switching policy modes. It removes other deployment branch patterns and verifies the final rule. The current protected `main` branch requires `Validate`, and the GitHub `production` environment requires a reviewer. Preserve those protections on later runs.

The original foundation run points the repository's `ACA_*` variables at the **placeholders**. Its V2 rerun repoints the web, runtime Job, and migration Job variables. Verify them with `gh variable list` and repair any mismatch using the values below:

```bash
gh variable set ACA_NAME --body 'twilio-comics-v2'
gh variable set ACA_JOB_NAME --body 'twilio-comics-generation-v2'
gh variable set ACA_RECOVERY_JOB_NAME --body 'twilio-comics-recovery-v2'
gh variable set ACA_MIGRATION_JOB_NAME --body 'twilio-comics-migrate-v2'
gh variable set ACA_RESOURCE_GROUP --body 'rg-twilio-comics'
gh variable set ACR_NAME --body 'twiliocomicsacr1a1d98'
```

The script sets these **production environment secrets**: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`. They are OIDC identifiers, not a reusable Azure password. The GitHub-hosted runner starts the private migration Job through Azure's management API and never connects to PostgreSQL. **Do not add `DATABASE_URL` to GitHub secrets or variables.** The current `PRODUCTION_RELEASE_READY` repository variable is `true`, allowing the [release workflow](DEPLOYMENT.md#release-flow) to build and deploy after its approval gate. For a new installation, keep this variable unset or false until the V2 network, database, roles, runtime secrets, and migration Job are ready. A closed initial release can use an empty `TWILIO_ENABLED_CHANNELS` while its sender is being prepared; the current pilot uses `sms,voice`.

## Configure V2 runtime before the first release

The original sample workloads did not carry the credentials or database settings needed by the real app. The **V2** app and Jobs are configured and released. The steps below are the bootstrap procedure for a fresh V2 environment; the script requires an internal, zero-replica placeholder and should not be rerun against the public pilot. Replace these resource names for a different installation:

```bash
export RESOURCE_GROUP='rg-twilio-comics'
export ACA_NAME='twilio-comics-v2'
export ACA_JOB_NAME='twilio-comics-generation-v2'
export ACA_RECOVERY_JOB_NAME='twilio-comics-recovery-v2'
export ACA_MIGRATION_JOB_NAME='twilio-comics-migrate-v2'
```

The PostgreSQL provisioner owns the `DATABASE_URL` secret references. Once it finishes, run the runtime setup from an Azure CLI login in the approved subscription. Enter the approved Twilio Account SID in the local terminal and pass it as `TWILIO_ACCOUNT_SID`; the script requires `AC` followed by 32 hexadecimal characters. Keep the SID out of committed scripts and docs. The SID identifies the account; the Auth Token is a separate credential handled through an owner-only file below. The setup checks that the V2 web app is internal and scaled to zero, verifies all three V2 workloads still use the private database URL, generates the app and admin credentials, and configures Key Vault references and exact secret-scoped reader roles. It does not run migrations, publish ingress, open the GitHub release gate, or change Twilio webhooks.

```bash
read -r -p 'Approved Twilio Account SID: ' TWILIO_ACCOUNT_SID
SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98' \
TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
CONFIGURE_RUNTIME_CONFIRM=yes \
bash scripts/configure-runtime-secrets.sh
```

The script generated strong `AUTH_SECRET`, `MEDIA_SIGNING_SECRET`, and a 48-character admin password. It stored the initial password in Key Vault as `admin-initial-password` and only its scrypt hash as `admin-password-hash` for the web app. The initial admin username is `comics-admin`; the operator has confirmed password sign-in from Chrome. No password is printed or passed to Azure CLI as an argument. For a fresh installation, set `ADMIN_USERNAME` before the first run if a different username is desired. The script reuses existing secrets, checks that the initial admin password matches its hash, and refuses to rotate bootstrap credentials or the username silently. It grants the current operator read access only to the initial admin password secret. Retrieve it into an owner-only local file on a trusted operator machine, move it to a password manager, and delete the file; keep it out of Git and chat. After the first change in `/admin/settings`, the database login takes precedence and this Key Vault copy no longer signs in:

```bash
umask 077
admin_password_file="$(mktemp "${TMPDIR:-/tmp}/twilio-comics-admin.XXXXXXXX")"
az keyvault secret download --vault-name kv-twilio-comics-1a1d98 \
  --name admin-initial-password --file "$admin_password_file" --overwrite \
  --only-show-errors --output none
```

If the Key Vault firewall denies the operator's current network, temporarily allow that trusted machine's public IPv4 address, then remove **only a rule added for this retrieval** afterward. The earlier pilot testing exception has been removed, so do not assume a local host still has access. Behind a proxy or VPN, the client IP in Azure's `ForbiddenByFirewall` error may differ from `api.ipify.org`; set `OPERATOR_PUBLIC_IPV4` to the IPv4 named in that error if needed. The operator still needs permission to read `admin-initial-password`. Use an approved private network path instead when available. This subshell checks existing rules, retries briefly for rule propagation, and removes only an exact IP rule that it added, even if the download fails. Never print the password to a terminal, put it in a shell argument, or send it in chat:

```bash
(
  set -e
  operator_ipv4="${OPERATOR_PUBLIC_IPV4:-$(curl -4fsS https://api.ipify.org)}"
  rules_json="$(az keyvault network-rule list --name kv-twilio-comics-1a1d98 \
    --resource-group rg-twilio-comics --only-show-errors --output json)"
  jq -e '.ipRules | type == "array"' <<<"$rules_json" >/dev/null
  rule_added=0
  cleanup_rule() {
    if [[ "$rule_added" == 1 ]]; then
      az keyvault network-rule remove --name kv-twilio-comics-1a1d98 \
        --resource-group rg-twilio-comics --ip-address "$operator_ipv4" \
        --only-show-errors --output none
    fi
  }
  trap cleanup_rule EXIT
  if ! jq -e --arg ip "$operator_ipv4" \
    '(.ipRules // []) | any(.value == $ip or .value == ($ip + "/32"))' \
    <<<"$rules_json" >/dev/null; then
    az keyvault network-rule add --name kv-twilio-comics-1a1d98 \
      --resource-group rg-twilio-comics --ip-address "$operator_ipv4" \
      --only-show-errors --output none
    rule_added=1
  fi
  download_ok=0
  for attempt in 1 2 3; do
    if az keyvault secret download --vault-name kv-twilio-comics-1a1d98 \
      --name admin-initial-password --file "$admin_password_file" --overwrite \
      --only-show-errors --output none; then
      download_ok=1
      break
    fi
    if [[ "$attempt" -lt 3 ]]; then sleep 5; fi
  done
  if [[ "$download_ok" != 1 ]]; then
    rm -f -- "$admin_password_file"
    exit 1
  fi
)
```

Import the owner-only file into a password manager, then run `rm -- "$admin_password_file"`. Do not keep a local copy. The firewall rule cleanup runs before the subshell returns. If cleanup reports an error, remove the temporary rule manually before proceeding.

| Key Vault secret | V2 web | Generation and recovery Jobs | Purpose |
|---|---|---|---|
| `auth-secret` | Yes |  | Auth.js/admin sessions and Voice authorization signing |
| `media-signing-secret` | Yes | Yes | Private media link signing |
| `admin-password-hash` | Yes |  | `/admin/login` password check; plaintext is never bound to a workload |
| `openai-api-key` | Yes | Yes | Comic and conversation models |
| `twilio-auth-token` | Yes | Yes | Twilio API and signed webhook validation |

The approved Twilio Account SID supplied through `TWILIO_ACCOUNT_SID`, `+18669012028` number, Voice Verify Service SID, operator name/contact, and initial shared 25-per-day generation limit are configured as ordinary environment settings. The bootstrap script initially leaves `TWILIO_ENABLED_CHANNELS` empty. The current public pilot overrides it with `sms,voice` and the daily generation limit with `5`. The script leaves the migration Job and `DATABASE_URL` bindings alone. It uses existing Key Vault operator access or a temporary Secrets Officer grant that it revokes on exit; it allows only the current operator IPv4 through the vault firewall when needed.

The production OpenAI API key and Twilio Auth Token are in Key Vault and bound to the V2 workloads; they are not in this repository. For a fresh installation, put each value in its own owner-only (`0600`), single-line local file and run the script with file **paths**, not credential values, in the command. Either file can be supplied independently. The script copies the value through a short-lived owner-only file into Key Vault, then wires only the workloads that need it. If a Key Vault secret already exists, a supplied file must match it exactly; a different value is rejected without rotation. Existing `auth-secret`, `media-signing-secret`, admin credentials, and their expiry dates are also reused. Without the OpenAI and Twilio credentials, `/api/readyz` remains closed and the release gate must stay unset.

```bash
SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98' \
TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
OPENAI_API_KEY_FILE='/secure/path/openai.key' \
TWILIO_AUTH_TOKEN_FILE='/secure/path/twilio-auth-token' \
CONFIGURE_RUNTIME_CONFIRM=yes \
bash scripts/configure-runtime-secrets.sh
```

### Runtime secret expiry and rotation

Inventory the latest Key Vault expiry dates for `auth-secret`, `media-signing-secret`, `admin-initial-password`, `admin-password-hash`, `openai-api-key`, and `twilio-auth-token` with the metadata-only command in the [database guide](AZURE_POSTGRES.md#key-vault-expiry-and-database-credential-rotation). Set an owned alert for `Microsoft.KeyVault.SecretNearExpiry` (30 days before expiry), review expiries at least monthly, and plan changes 60 days before expiry. The setup script creates new versions with a 365-day UTC expiry but intentionally **does not rotate or extend existing versions**. Rerunning it, including with a new OpenAI key or Twilio token file, cannot renew an existing secret.

For each planned provider-secret rotation, obtain or generate the replacement through its issuing system, stage it in an owner-only local file, and write a new Key Vault version using `az keyvault secret set --file ... --expires <UTC timestamp>`. Coordinate the provider cutover for OpenAI and Twilio with the matching vault version; a new Twilio Auth Token must still validate signed SMS and Voice webhooks. For the **admin username and password**, sign in and use **Change admin login** in `/admin/settings`; the [short guide](ADMIN_CREDENTIALS.md) explains the steps. The active login changes in PostgreSQL immediately, with no Key Vault command or app restart. The initial Key Vault password and hash remain bootstrap values; keep their bindings healthy while they are still referenced by the Container App, but do not mistake them for the current login after a dashboard change. Rotating `auth-secret` ends current sessions, and rotating `media-signing-secret` invalidates outstanding signed media links, so schedule both when users can be informed. For Key Vault secret changes, roll or restart the V2 web app and affected Jobs to load the new versions, test `/api/readyz`, one admin login, and both SMS and Voice flows, and confirm the new expiry metadata before retiring the old provider credentials. Keep channels closed if any required secret or credential is expired or out of sync. Expiry metadata can be changed with `az keyvault secret set-attributes --expires` without changing a value, but that action does **not** rotate the credential.

Google OAuth is optional for `/studio`; if enabled in production, store its client ID and secret as V2 web app secrets, set `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` secret references, and set `STUDIO_TESTER_EMAILS` to a comma-separated email allowlist. An empty allowlist denies studio sign-in. SMS, Voice, and the admin dashboard do not require Google OAuth.

The V2 rerun of `provision-azure.sh` sets the Storage endpoints, container/queue names, workload-specific `AZURE_CLIENT_ID`, web/worker identities, and ACR pull identity on the web app and both runtime Jobs. Verify those settings before release; they are independent of the old placeholders. The PostgreSQL role provisioner creates and configures the manual migration Job, including its dedicated Key Vault identity and ACR pull access. Production Storage access uses managed identity, not `AZURE_STORAGE_CONNECTION_STRING`. The image listens on `PORT=8080` and `HOSTNAME=0.0.0.0`; the worker creates a unique `WORKER_ID` when needed.

Keep `DAILY_GENERATION_JOB_LIMIT` the same on all three runtime workloads. The code and runtime-setup default is 25 new app-funded comic admissions per UTC day across users, Twilio channel jobs, and browser studio requests using the app's OpenAI key; `0` pauses these requests. PostgreSQL serializes admissions so retries and duplicate queue deliveries do not consume another slot. Studio requests also retain their per-user quota, while requests using a caller-owned API key do not use the app-funded pool. The current pilot uses the low-cost values below, applied **after** `configure-runtime-secrets.sh` finished:

```bash
az containerapp update --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars 'DAILY_GENERATION_JOB_LIMIT=5' 'VOICE_VERIFY_NUMBER_DAILY_LIMIT=4'

az containerapp job update --name "$ACA_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars 'DAILY_GENERATION_JOB_LIMIT=5' 'MESSAGE_AGENT_GLOBAL_DAILY_LIMIT=50'

az containerapp job update --name "$ACA_RECOVERY_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars 'DAILY_GENERATION_JOB_LIMIT=5'
```

The web app handles Voice Verify starts; the generation Job handles SMS and WhatsApp agent turns. The recovery Job needs only the shared generation limit. The new limits default to 40 Verify starts per number and 200 message-agent turns globally per rolling 24 hours when unset. `0` pauses new starts or turns. The runtime setup script currently requires `DAILY_GENERATION_JOB_LIMIT=25` on every workload, so do not rerun it against the pilot values; follow the [rotation procedure](#runtime-secret-expiry-and-rotation) for later credentials. These limits reduce usage but do not cap OpenAI or Twilio billing. See [cost controls](AZURE_COSTS.md#cost-controls-for-launch).

Verify the three non-secret settings before release and after each runtime update:

```bash
az containerapp show --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" --output json \
  | jq -r '.properties.template.containers[].env[]? | select(.name == "DAILY_GENERATION_JOB_LIMIT" or .name == "VOICE_VERIFY_NUMBER_DAILY_LIMIT") | "\(.name)=\(.value)"'
az containerapp job show --name "$ACA_JOB_NAME" --resource-group "$RESOURCE_GROUP" --output json \
  | jq -r '.properties.template.containers[].env[]? | select(.name == "DAILY_GENERATION_JOB_LIMIT" or .name == "MESSAGE_AGENT_GLOBAL_DAILY_LIMIT") | "\(.name)=\(.value)"'
az containerapp job show --name "$ACA_RECOVERY_JOB_NAME" --resource-group "$RESOURCE_GROUP" --output json \
  | jq -r '.properties.template.containers[].env[]? | select(.name == "DAILY_GENERATION_JOB_LIMIT") | "\(.name)=\(.value)"'
```

The public origin is the V2 ACA HTTPS domain on the web app and runtime Jobs; the worker uses it to build story links. Use the exact origin before configuring Twilio webhooks because signed webhook URLs are origin-sensitive. The bootstrap step below left `TWILIO_ENABLED_CHANNELS` empty for the closed release. The current pilot has `sms,voice`, which shows only the text and call actions. Setting the list empty or unsetting it again closes the actions and rejects inbound channel conversations.

```bash
export PUBLIC_BASE_URL='https://twilio-comics-v2.kindriver-a0456aa8.eastus2.azurecontainerapps.io'

az containerapp update --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "PUBLIC_BASE_URL=$PUBLIC_BASE_URL" "AUTH_URL=$PUBLIC_BASE_URL" \
    'TWILIO_ENABLED_CHANNELS='

az containerapp job update --name "$ACA_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "PUBLIC_BASE_URL=$PUBLIC_BASE_URL"

az containerapp job update --name "$ACA_RECOVERY_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "PUBLIC_BASE_URL=$PUBLIC_BASE_URL"
```

If the browser testing studio is used, reference `AUTH_GOOGLE_ID=secretref:auth-google-id` and `AUTH_GOOGLE_SECRET=secretref:auth-google-secret` on the V2 web app, set `STUDIO_TESTER_EMAILS` there, and add `https://<your-final-domain>/api/auth/callback/google` as a Google OAuth callback. See [authentication](../README.md#authentication). SMS, Voice, and the admin dashboard do not require Google OAuth.

For Voice, the dedicated six-digit SMS Verify service `Comics Voice` (`VA9fae12b38cb0a91645f514842476e647`) was created in the launch account. The runtime setup set its Service SID on the V2 web app. The caller should receive a text and enter the code on the phone keypad before ConversationRelay can use saved conversation data; this handset path is still awaiting confirmation. The V2 web app has the secure relay URL below. Voice is shown on `/start` because its Verify service, relay URL, Twilio credentials, and signing secret are configured:

```bash
az containerapp update --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "CONVERSATION_RELAY_WS_URL=wss://${PUBLIC_BASE_URL#https://}/relay"
```

The Voice Verify budget allows 4 starts per caller per hour and 10 per rolling 24 hours, plus 12 starts per app number per hour. `VOICE_VERIFY_NUMBER_DAILY_LIMIT` defaults to 40 starts per number per rolling 24 hours; the pilot sets 4 on the web app. PostgreSQL locks make these rolling limits apply across replicas; denied starts are recorded in admin history. The number limit contains costs if caller IDs rotate, but may also turn away legitimate callers at higher traffic. Review actual demand and denied events before raising it. Enable [Verify SMS Fraud Guard](https://www.twilio.com/docs/verify/preventing-toll-fraud/sms-fraud-guard) and restrict [Verify Geo Permissions](https://www.twilio.com/docs/verify/preventing-toll-fraud/verify-geo-permissions) to launch countries.

The app-specific `/privacy` and `/terms` pages name **Anthony Dellavecchia** and **adellavecchia@twilio.com** for support and deletion requests. Review their content before launch. The linked [Twilio privacy notice](https://www.twilio.com/en-us/legal/privacy) and [Twilio terms](https://www.twilio.com/en-us/legal/tos) describe the provider and do not replace the app's own pages.

WhatsApp is outside the initial launch. To add it later, configure an approved `whatsapp:` sender on the V2 app and both runtime Jobs, its webhook, and add `whatsapp` to the explicit channel list. The [README](../README.md#twilio-setup) lists the channel-specific requirements.

## Configure Twilio and release

On October 22, 2026, the authenticated Twilio CLI confirmed that **+1 866 901 2028** belongs to the provided account, supports SMS, MMS, and Voice, has toll-free verification status `TWILIO_APPROVED`, and has the exact SMS and Voice POST webhook URLs below. Twilio [requires toll-free verification for SMS to the United States and Canada](https://www.twilio.com/docs/messaging/compliance/toll-free/console-onboarding), including the comic result sent after a Voice call. Confirm actual Verify SMS delivery, review the SMS/Voice disclosures and app policies, and confirm the [ConversationRelay AI/ML Features Addendum](https://www.twilio.com/docs/voice/conversationrelay/onboarding) before a broad announcement.

The number's HTTP webhooks use the **exact** origin in `PUBLIC_BASE_URL`; Twilio signatures depend on the URL. The retry fragment is a [Twilio connection override](https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides), excluded from signature validation. ConversationRelay uses the `wss://` URL in the Voice TwiML, without that fragment. The app's channel selection does not change the number's settings in Twilio:

```text
SMS/MMS: POST https://twilio-comics-v2.kindriver-a0456aa8.eastus2.azurecontainerapps.io/api/twilio/sms#rc=3&rp=5xx,ct,rt
Voice:   POST https://twilio-comics-v2.kindriver-a0456aa8.eastus2.azurecontainerapps.io/api/twilio/voice#rc=3&rp=5xx,ct,rt
Relay:   wss://twilio-comics-v2.kindriver-a0456aa8.eastus2.azurecontainerapps.io/relay
```

The first closed V2 release completed these infrastructure checks before the Twilio cutover. For a new installation, verify the V2 resource names, Azure secrets, private migration Job, PostgreSQL backup/restore, OIDC access, Twilio account credentials, and main branch protections. Keep `TWILIO_ENABLED_CHANNELS` empty until its number and webhooks are configured. Then set the release variable and trigger a deployment from `main`:

```bash
gh variable list
gh secret list --env production
gh variable set PRODUCTION_RELEASE_READY --body 'true'
gh workflow run deploy.yml --ref main
gh run list --workflow deploy.yml --limit 1
```

Watch the selected run with `gh run watch <run-id> --exit-status`. The workflow must finish the private migration Job before rolling out the runtime workloads, then check the commit SHA at `/api/healthz`. An initial closed release shows “opening soon” on `/start`; the homepage still points there with its single start link and QR code. Check `/api/readyz` for HTTP 200 before directing visitors to the current release. The old managed-network placeholder is not the public app.

After `PUBLIC_BASE_URL` is the final HTTPS origin and `/api/readyz` reports `ready: true`, use the authenticated Twilio CLI profile to configure or reverify the approved number. This cutover has completed for the current pilot:

```bash
curl --fail --silent --show-error "$PUBLIC_BASE_URL/api/readyz"
TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
CONFIGURE_TWILIO_WEBHOOKS_CONFIRM=yes TWILIO_PROFILE=Demo \
  bash scripts/configure-twilio-webhooks.sh
```

Use the same approved `TWILIO_ACCOUNT_SID` entered for runtime setup; enter it locally again if this is a new shell. The script fetches the number in that account, checks its SMS and Voice capabilities, and refuses an existing unrelated webhook, fallback URL, TwiML app, or SIP trunk. It sets both URLs and their POST methods in one CLI update, then fetches the number again to verify the result. A repeat run with matching settings makes no update. Review any reported conflict before changing the existing number setup. If the number belongs to a [Messaging Service](https://www.twilio.com/docs/messaging/services), verify that service uses “Defer to sender's webhook,” so its SMS handling follows the number's URL. The script does not read the Auth Token or enable public channels. The current number's two POST URLs were verified after cutover.

Only SMS and Voice are enabled on the V2 web app for controlled production tests. The current setting is:

```bash
az containerapp update --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars 'TWILIO_ENABLED_CHANNELS=sms,voice'
```

At phone and desktop widths, verify the two `/start` actions and QR codes lead to `sms:+18669012028?body=Turn%20me%20into%20a%20comic!` and `tel:+18669012028`, with the shared disclosure and policy links nearby. Scanning the SMS code opens a draft with the suggested “Turn me into a comic!” opener; the user must tap Send, replace it with an idea, or send one or two photos. Any first idea or photo-only MMS starts a comic without `NEW`. A live inbound SMS and delivered agent reply have confirmed the queued reply path after release `1e94459`; see the [incident record](DEPLOYMENT.md#if-a-text-gets-no-reply). **Pending real-device checks:** complete the agent's SMS approval step and receive a generated comic result; then make a call, receive the Verify text, enter its code on the keypad, create a comic through ConversationRelay, and receive the result by SMS. Confirm the generation Job completes comic work and the recovery Job runs as scheduled, then verify the test activity and timeline at `/admin/login`. Operator sign-in has succeeded, but live test records still need review. Finally, verify records remain after a new revision; they live in PostgreSQL and Azure Blob Storage, outside the container image. [Deployment verification](DEPLOYMENT.md#twilio-verification) has the detailed checks and [rollback](DEPLOYMENT.md#health-and-rollback) covers image recovery.

The checked-in experience-settings migration adds a durable admin choice for Voice photo priority and an independent browser photo booth toggle, default off. Apply it through the normal private migration Job before rolling out runtime code; it requires no new Azure resource. At `/admin/settings`, **Use saved photos (text first)** makes a verified call prefer recent same-number MMS photos, with browser photos as a fallback when the booth is enabled. **Use saved photos (camera first)** reverses that priority. **Calls without photos** suppresses Voice references, while SMS can still use browser photos. A person must send each MMS photo within 24 hours of calling; a browser camera set is usable for 24 hours after its latest upload or replacement. Photos from another phone are not eligible. Calls without photos still work. The camera booth also requires a ready SMS or photo-enabled Voice channel, valid `PUBLIC_BASE_URL`, `TWILIO_VERIFY_SERVICE_SID`, Account SID, Auth Token, and `AUTH_SECRET`; its bounded Verify and upload events live in PostgreSQL, and photos live in private Blob Storage under the channel user prefix. `CAMERA_VERIFY_GLOBAL_HOURLY_LIMIT` defaults to 30 and accepts 1–100; `CAMERA_VERIFY_GLOBAL_DAILY_LIMIT` defaults to 50 and accepts 1–500. Both are rolling limits for browser Verify starts, with values above each maximum clamped and invalid values falling back to the default; per-phone limits stay in force. The signed camera session lasts 15 minutes and the shared booth resets after five minutes idle or a new page visit. In shared-booth use, **Finish photo setup** must successfully clear the browser session and preview before any SMS/call QR code or tap link appears; it also works with no photos. A failed clear keeps those actions hidden without deleting staged photos. Test the finish-step QR codes and tap links, SMS, MMS, camera, and Voice handsets, then restore the desired admin settings before announcing the feature. The Twilio CLI's SMS/MMS/Voice capability report confirms configuration, not successful handset photo processing or comic generation.

To close entry without clearing the sender number, set `TWILIO_ENABLED_CHANNELS=` on the V2 web app. Unset is also closed. This changes the public actions and inbound channel acceptance, not the sender's Twilio capabilities or webhook settings. Keep the database and backup policy active so admin history survives deploys; use the [deletion procedure](DATA_DELETION.md) for explicit user requests.

Keep initial capacity modest: web `0.5` CPU and `1Gi`, each runtime Job `1` CPU and `2Gi`, generation `minExecutions: 0` and `maxExecutions: 1`, recovery every five minutes with one replica. The `twilio-comics-launch` $150 monthly budget is already configured for `rg-twilio-comics`, with actual alerts at 50%, 80%, and 100% and a forecast alert at 100% emailed to `adellavecchia@twilio.com`; it does not stop spending or cover Twilio and OpenAI. Add a lifecycle policy for abandoned Blob uploads after observing actual usage. No ACR admin password or Azure service-principal secret is stored in GitHub.
