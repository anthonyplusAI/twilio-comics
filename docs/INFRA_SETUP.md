# Azure Infrastructure Setup

Twilio Comics uses Azure Container Apps for its public app and Jobs, Azure Storage for images and queue messages, and **Azure Database for PostgreSQL Flexible Server** for comics, conversations, and retained admin history. This guide covers the one-time resources and settings needed before the [production deployment](DEPLOYMENT.md). The [private PostgreSQL guide](AZURE_POSTGRES.md) covers networking, database roles, TLS, backups, and migrations in more detail.

## Current state and production target

The approved Azure subscription has a V1 foundation in `rg-twilio-comics`: ACR `twiliocomicsacr1a1d98`, Storage account `twiliocomicsst1a1d98`, Log Analytics, managed identities, GitHub OIDC, and a managed-network Container Apps environment. Its web app and Jobs are **sample-image placeholders**, not a Twilio Comics release. The private V2 platform is provisioned separately; inspect Azure for its current provisioning state. A server reaching `Running` does not establish runtime database URLs, roles, migrations, or a live application release.

| Workload | Existing placeholder | Planned private-network production target |
|---|---|---|
| Container Apps environment | `cae-twilio-comics` | `cae-twilio-comics-v2` |
| Public web and Voice app | `twilio-comics` | `twilio-comics-v2` |
| Queue generation Job | `twilio-comics-generation` | `twilio-comics-generation-v2` |
| Scheduled recovery Job | `twilio-comics-recovery` | `twilio-comics-recovery-v2` |
| Manual migration Job | None | `twilio-comics-migrate-v2` |
| PostgreSQL | Not part of V1 | Central US Flexible Server `twilio-comics-pg-1a1d98`, database `twilio_comics` |

The V2 names are the production **target**, not evidence that every V2 resource or application release is ready. `scripts/provision-azure.sh` created the existing foundation with an Azure managed-network ACA environment. Run the private-platform provisioner **first** so the V2 environment exists with VNet integration and a route to Central US PostgreSQL. Only then rerun `provision-azure.sh` with V2 workload names; it reuses that environment and creates the V2 web app and two runtime Jobs. If the order is reversed, it can create a managed-network V2 environment that cannot reach the private database. Keep the existing placeholders until the V2 app and Jobs pass verification; move the public URL and Twilio webhooks in a deliberate cutover.

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

The active `az` subscription must match `SUBSCRIPTION_ID`. The preview covers the Bicep resources; the Key Vault is created only by the actual provisioning run. Tenant policy requires Key Vault purge protection and a deny by default firewall. The script detects the operator's public IPv4 address and allows that single address for Azure CLI secret operations; set `OPERATOR_PUBLIC_IPV4` explicitly if automatic detection sees a different egress address. It enables the `Microsoft.KeyVault` service endpoint on the V2 Container Apps subnet, then adds that subnet to the vault firewall for managed-identity Jobs. The vault also needs a Key Vault Secrets User role assignment for each Job identity that reads it. A protected, single-line `POSTGRES_ADMIN_PASSWORD_FILE` with mode `0600` is an optional first-run override; omit it for secure generation and storage in Key Vault.

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
PROVISION_AZURE_CONFIRM=yes \
bash scripts/provision-azure.sh
```

The new V2 web placeholder remains internal and scaled to zero. The release workflow requires single revision mode and makes it externally reachable only after the private migration Job succeeds and a digest-pinned Twilio Comics web revision is healthy. Production needs external HTTPS ingress on port 8080 for the website, Twilio webhooks, and ConversationRelay WebSocket. The two runtime Jobs need no public ingress. The PostgreSQL role provisioner creates the fourth workload as a **manual**, one-container migration Job using the reviewed `Dockerfile.migrate` image. Build and pin its image and the one-off role bootstrap image from committed source:

```bash
export SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98'
bash scripts/build-azure-postgres-images.sh
# Copy the two printed BOOTSTRAP_IMAGE and MIGRATION_IMAGE export lines here.
PROVISION_POSTGRES_ROLES_CONFIRM=yes bash scripts/provision-postgres-roles.sh
```

`scripts/provision-postgres-roles.sh` first seeds `postgres-comics-runtime-url` and `postgres-comics-migration-url` in Key Vault through owner-only temporary files and the host Azure CLI, preserving valid existing URLs on reruns. It then starts `twilio-comics-db-bootstrap-v2` inside the private V2 environment to create and verify separate `comics_runtime` and `comics_migrator` SQL logins. The Job retrieves the administrator password and the two URL secrets through temporary, secret-scoped Key Vault Secrets User grants that the host script revokes on exit. Only after SQL verification succeeds does the script grant the V2 workload identities their own secret-scoped reads, bind the runtime URL as `runtime-database-url` on the web/generation/recovery workloads, and create `twilio-comics-migrate-v2` with `migration-database-url`. Both are exposed to their containers as `DATABASE_URL=secretref:...`. See the [role bootstrap steps](AZURE_POSTGRES.md#one-time-role-bootstrap-and-v2-workload-wiring) for exact behavior and recovery.

Rerun `scripts/provision-azure.sh` with the same V2 name overrides after the migration Job exists. Its first run cannot grant a role on a Job that has not been created. The second run assigns the GitHub deployment principal `Container Apps Jobs Contributor` on that exact migration Job, which includes permission to start it. Keep the production release gate closed until this grant is present.

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

Both Azure-login jobs in `deploy.yml` use the GitHub `production` environment. The script parses the **actual `origin` Git remote** to derive the repository, then trusts the [environment-specific OIDC subject](https://docs.github.com/en/actions/reference/security/oidc):

```text
repo:<origin-owner>/<origin-repo>:environment:production
```

If GitHub reports an immutable or customized subject for this repository, set `GITHUB_OIDC_SUBJECT` to that exact claim before rerunning. The script updates the existing `gha-production` federated credential when the subject changes. On every run it enforces a custom `main`-only deployment branch policy on the GitHub `production` environment, including one created earlier without restrictions; it preserves existing required reviewers and wait timers when switching policy modes. It removes other deployment branch patterns and verifies the final rule. **Before opening the release gate**, protect `main` with the `Validate` required check and require a production environment reviewer in GitHub Settings. Verify the reviewer rule after provisioning.

The original foundation run points the repository's `ACA_*` variables at the **placeholders**. Its V2 rerun repoints the web, runtime Job, and migration Job variables. Verify them with `gh variable list` and repair any mismatch using the values below:

```bash
gh variable set ACA_NAME --body 'twilio-comics-v2'
gh variable set ACA_JOB_NAME --body 'twilio-comics-generation-v2'
gh variable set ACA_RECOVERY_JOB_NAME --body 'twilio-comics-recovery-v2'
gh variable set ACA_MIGRATION_JOB_NAME --body 'twilio-comics-migrate-v2'
gh variable set ACA_RESOURCE_GROUP --body 'rg-twilio-comics'
gh variable set ACR_NAME --body 'twiliocomicsacr1a1d98'
```

The script sets these **production environment secrets**: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`. They are OIDC identifiers, not a reusable Azure password. The GitHub-hosted runner starts the private migration Job through Azure's management API and never connects to PostgreSQL. **Do not add `DATABASE_URL` to GitHub secrets or variables.** Keep `PRODUCTION_RELEASE_READY` unset or false while the V2 network, database, roles, runtime secrets, and migration Job are incomplete. A closed prelaunch site can be released with `TWILIO_ENABLED_CHANNELS` empty while sender approval is pending; production startup still requires Twilio account credentials. The [release workflow](DEPLOYMENT.md#release-flow) requires `PRODUCTION_RELEASE_READY=true` before it builds or deploys.

## Configure V2 runtime before the first release

The sample workloads do not carry the credentials or database settings needed by the real app. Configure the **V2** app and Jobs before setting the release gate. The values below use the planned target names; replace them if the actual resources differ:

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

The script generates strong `AUTH_SECRET`, `MEDIA_SIGNING_SECRET`, and a 48-character admin password. It stores the initial password in Key Vault as `admin-initial-password`, stores only its scrypt hash as `admin-password-hash` for the web app, and defaults the admin username to `comics-admin`. Set `ADMIN_USERNAME` before the first run if a different username is desired. No password is printed or passed to Azure CLI as an argument. The script reuses existing secrets, checks that the admin password matches its hash, and refuses to rotate existing credentials or the username silently. It also grants the current operator read access only to the initial admin password secret. Retrieve it into an owner-only local file, move it to a password manager, and delete the file; keep it out of Git and chat:

```bash
umask 077
admin_password_file="$(mktemp "${TMPDIR:-/tmp}/twilio-comics-admin.XXXXXXXX")"
az keyvault secret download --vault-name kv-twilio-comics-1a1d98 \
  --name admin-initial-password --file "$admin_password_file" --overwrite \
  --only-show-errors --output none
```

| Key Vault secret | V2 web | Generation and recovery Jobs | Purpose |
|---|---|---|---|
| `auth-secret` | Yes |  | Auth.js/admin sessions and Voice authorization signing |
| `media-signing-secret` | Yes | Yes | Private media link signing |
| `admin-password-hash` | Yes |  | `/admin/login` password check; plaintext is never bound to a workload |
| `openai-api-key` | When supplied | When supplied | Comic and conversation models |
| `twilio-auth-token` | When supplied | When supplied | Twilio API and signed webhook validation |

The approved Twilio Account SID supplied through `TWILIO_ACCOUNT_SID`, `+18669012028` number, Voice Verify Service SID, operator name/contact, and shared 25-per-day generation limit are configured as ordinary environment settings. `TWILIO_ENABLED_CHANNELS` is explicitly empty, so the number does not appear as an available action yet. The script leaves the migration Job and `DATABASE_URL` bindings alone. It uses the existing Key Vault operator access or a temporary Secrets Officer grant that it revokes on exit; it allows only the current operator IPv4 through the vault firewall when needed.

The OpenAI API key and Twilio Auth Token are not in this repository. When available, put each value in its own owner-only (`0600`), single-line local file and rerun with file **paths**, not credential values, in the command. Either file can be supplied independently. The script copies the value through a short-lived owner-only file into Key Vault, then wires only the workloads that need it. If a Key Vault secret already exists, a supplied file must match it exactly; a different value is rejected without rotation. Without these two credentials, `/api/readyz` remains closed and the release gate must stay unset.

```bash
SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98' \
TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
OPENAI_API_KEY_FILE='/secure/path/openai.key' \
TWILIO_AUTH_TOKEN_FILE='/secure/path/twilio-auth-token' \
CONFIGURE_RUNTIME_CONFIRM=yes \
bash scripts/configure-runtime-secrets.sh
```

Google OAuth is optional for `/studio`; if enabled in production, store its client ID and secret as V2 web app secrets, set `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` secret references, and set `STUDIO_TESTER_EMAILS` to a comma-separated email allowlist. An empty allowlist denies studio sign-in. SMS, Voice, and the admin dashboard do not require Google OAuth.

The V2 rerun of `provision-azure.sh` sets the Storage endpoints, container/queue names, workload-specific `AZURE_CLIENT_ID`, web/worker identities, and ACR pull identity on the web app and both runtime Jobs. Verify those settings before release; they are independent of the old placeholders. The PostgreSQL role provisioner creates and configures the manual migration Job, including its dedicated Key Vault identity and ACR pull access. Production Storage access uses managed identity, not `AZURE_STORAGE_CONNECTION_STRING`. The image listens on `PORT=8080` and `HOSTNAME=0.0.0.0`; the worker creates a unique `WORKER_ID` when needed.

Keep `DAILY_GENERATION_JOB_LIMIT` the same on all three runtime workloads. The default is 25 new app-funded comic admissions per UTC day across users, Twilio channel jobs, and browser studio requests using the app's OpenAI key; `0` pauses these requests. PostgreSQL serializes admissions so retries and duplicate queue deliveries do not consume another slot. Studio requests also retain their per-user quota, while requests using a caller-owned API key do not use the app-funded pool. This limit does not impose a strict OpenAI or Twilio billing ceiling. See [cost controls](AZURE_COSTS.md#cost-controls-for-launch).

Set the final public origin on the V2 app and runtime Jobs. The worker uses it to build story links. The V2 ACA domain can be used for a prelaunch smoke test; use the chosen final HTTPS domain before configuring Twilio webhooks. During prelaunch, leave `TWILIO_ENABLED_CHANNELS` empty **or unset**. Either state shows no SMS/call/WhatsApp action or QR code and rejects inbound channel conversations; a configured number alone never enables a channel.

```bash
export PUBLIC_BASE_URL='https://<your-final-domain>'

az containerapp update --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "PUBLIC_BASE_URL=$PUBLIC_BASE_URL" "AUTH_URL=$PUBLIC_BASE_URL" \
    'TWILIO_ENABLED_CHANNELS='

az containerapp job update --name "$ACA_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "PUBLIC_BASE_URL=$PUBLIC_BASE_URL"

az containerapp job update --name "$ACA_RECOVERY_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "PUBLIC_BASE_URL=$PUBLIC_BASE_URL"
```

If the browser testing studio is used, reference `AUTH_GOOGLE_ID=secretref:auth-google-id` and `AUTH_GOOGLE_SECRET=secretref:auth-google-secret` on the V2 web app, set `STUDIO_TESTER_EMAILS` there, and add `https://<your-final-domain>/api/auth/callback/google` as a Google OAuth callback. See [authentication](../README.md#authentication). SMS, Voice, and the admin dashboard do not require Google OAuth.

For Voice, the dedicated six-digit SMS Verify service `Comics Voice` (`VA9fae12b38cb0a91645f514842476e647`) was created in the launch account. The runtime setup sets its Service SID on the V2 web app. The caller receives a text and enters the code on the phone keypad before ConversationRelay can use saved conversation data. Set the secure relay URL after choosing the final public origin. Voice stays unavailable on `/start` until its Verify service, relay URL, Twilio credentials, and signing secret are configured:

```bash
az containerapp update --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "CONVERSATION_RELAY_WS_URL=wss://${PUBLIC_BASE_URL#https://}/relay"
```

The initial Voice Verify budget allows 4 starts per caller per hour and 10 per day, plus 12 starts per app number per hour and 40 per day. PostgreSQL locks make these rolling limits apply across replicas; denied starts are recorded in admin history. The number limit contains costs if caller IDs rotate, but may also turn away legitimate callers at higher traffic. Review actual demand and denied events before raising it. Enable [Verify SMS Fraud Guard](https://www.twilio.com/docs/verify/preventing-toll-fraud/sms-fraud-guard) and restrict [Verify Geo Permissions](https://www.twilio.com/docs/verify/preventing-toll-fraud/verify-geo-permissions) to launch countries.

The app-specific `/privacy` and `/terms` pages name **Anthony Dellavecchia** and **adellavecchia@twilio.com** for support and deletion requests. Review their content before launch. The linked [Twilio privacy notice](https://www.twilio.com/en-us/legal/privacy) and [Twilio terms](https://www.twilio.com/en-us/legal/tos) describe the provider and do not replace the app's own pages.

WhatsApp is outside the initial launch. To add it later, configure an approved `whatsapp:` sender on the V2 app and both runtime Jobs, its webhook, and add `whatsapp` to the explicit channel list. The [README](../README.md#twilio-setup) lists the channel-specific requirements.

## Configure Twilio and release

On October 21, 2026, the authenticated Twilio CLI confirmed that **+1 866 901 2028** belongs to the provided account, supports SMS, MMS, and Voice, and has toll-free verification status `TWILIO_APPROVED`. Both inbound webhook URLs were blank at that check. Twilio [requires toll-free verification for SMS to the United States and Canada](https://www.twilio.com/docs/messaging/compliance/toll-free/console-onboarding), including the comic result sent after a Voice call. Confirm the new Verify service can deliver SMS codes, review the SMS/Voice disclosures and app policies, and accept the [ConversationRelay AI/ML Features Addendum](https://www.twilio.com/docs/voice/conversationrelay/onboarding) before enabling Voice.

After a healthy V2 revision is publicly reachable, configure the number's HTTP webhooks with the **exact** origin in `PUBLIC_BASE_URL`; Twilio signatures depend on the URL. The retry fragment is a [Twilio connection override](https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides), excluded from signature validation. ConversationRelay uses the `wss://` URL in the Voice TwiML, without that fragment. The app's channel selection does not change the number's settings in Twilio:

```text
SMS/MMS: POST https://<your-final-domain>/api/twilio/sms#rc=3&rp=5xx,ct,rt
Voice:   POST https://<your-final-domain>/api/twilio/voice#rc=3&rp=5xx,ct,rt
Relay:   wss://<your-final-domain>/relay
```

Before releasing a closed prelaunch site, verify the V2 resource names, Azure secrets, private migration Job, PostgreSQL backup/restore, OIDC access, Twilio account credentials, and main branch protections. Keep `TWILIO_ENABLED_CHANNELS` empty. Set the release variable only when these prerequisites are complete, then trigger a deployment from `main`:

```bash
gh variable list
gh secret list --env production
gh variable set PRODUCTION_RELEASE_READY --body 'true'
gh workflow run deploy.yml --ref main
gh run list --workflow deploy.yml --limit 1
```

Watch the selected run with `gh run watch <run-id> --exit-status`. The workflow must finish the private migration Job before rolling out the runtime workloads, then check the commit SHA at `/api/healthz`. Confirm the prelaunch homepage and `/start` show “opening soon” with no contact action. The current managed-network placeholder's health page is not evidence of a V2 release.

Once `PUBLIC_BASE_URL` is the final HTTPS origin and its `/api/readyz` reports `ready: true`, cut over the approved number through the authenticated Twilio CLI profile:

```bash
curl --fail --silent --show-error "$PUBLIC_BASE_URL/api/readyz"
TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
CONFIGURE_TWILIO_WEBHOOKS_CONFIRM=yes TWILIO_PROFILE=Demo \
  bash scripts/configure-twilio-webhooks.sh
```

Use the same approved `TWILIO_ACCOUNT_SID` entered for runtime setup; enter it locally again if this is a new shell. The script fetches the number in that account, checks its SMS and Voice capabilities, and refuses an existing unrelated webhook, fallback URL, TwiML app, or SIP trunk. It sets both URLs and their POST methods in one CLI update, then fetches the number again to verify the result. A repeat run with matching settings makes no update. Review any reported conflict before changing the existing number setup. If the number belongs to a [Messaging Service](https://www.twilio.com/docs/messaging/services), verify that service uses “Defer to sender's webhook,” so its SMS handling follows the number's URL. The script does not read the Auth Token or enable public channels.

After the configured number, Twilio webhooks, Verify, and ConversationRelay pass readiness checks, enable only SMS and Voice on the V2 web app for controlled production tests:

```bash
az containerapp update --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars 'TWILIO_ENABLED_CHANNELS=sms,voice'
```

At phone and desktop widths, verify the two `/start` actions and QR codes lead to `sms:+18669012028` and `tel:+18669012028`, with their disclosures and policy links nearby. Send a real SMS comic, then make a real call: receive the Verify text, enter its code on the keypad, create a comic through ConversationRelay, and receive the result by SMS. Confirm the queue Job and recovery Job execute, `/admin/login` shows the activity and timeline, and the records remain after a new revision. Those records live in PostgreSQL and Azure Blob Storage, outside the container image. [Deployment verification](DEPLOYMENT.md#twilio-verification) has the detailed checks and [rollback](DEPLOYMENT.md#health-and-rollback) covers image recovery.

To close entry without clearing the sender number, set `TWILIO_ENABLED_CHANNELS=` on the V2 web app. Unset is also closed. This changes the public actions and inbound channel acceptance, not the sender's Twilio capabilities or webhook settings. Keep the database and backup policy active so admin history survives deploys; use the [deletion procedure](DATA_DELETION.md) for explicit user requests.

Keep initial capacity modest: web `0.5` CPU and `1Gi`, each runtime Job `1` CPU and `2Gi`, generation `minExecutions: 0` and `maxExecutions: 1`, recovery every five minutes with one replica. Create an Azure budget and lifecycle policy for abandoned Blob uploads after observing actual usage. No ACR admin password or Azure service-principal secret is stored in GitHub.
