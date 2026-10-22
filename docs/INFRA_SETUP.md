# Azure Infrastructure Setup

Twilio Comics uses Azure Container Apps for its public app and Jobs, Azure Storage for images and queue messages, and **Azure Database for PostgreSQL Flexible Server** for comics, conversations, and retained admin history. This guide covers the one-time resources and settings needed before the [production deployment](DEPLOYMENT.md). The [private PostgreSQL guide](AZURE_POSTGRES.md) covers networking, database roles, TLS, backups, and migrations in more detail.

## Current state and production target

The approved Azure subscription already has a foundation in `rg-twilio-comics`: ACR `twiliocomicsacr1a1d98`, Storage account `twiliocomicsst1a1d98`, Log Analytics, managed identities, GitHub OIDC, and a managed-network Container Apps environment. Its web app and Jobs are **sample-image placeholders**, not a Twilio Comics release. No Azure PostgreSQL server, production `DATABASE_URL`, or live migration is configured.

| Workload | Existing placeholder | Planned private-network production target |
|---|---|---|
| Container Apps environment | `cae-twilio-comics` | `cae-twilio-comics-v2` |
| Public web and Voice app | `twilio-comics` | `twilio-comics-v2` |
| Queue generation Job | `twilio-comics-generation` | `twilio-comics-generation-v2` |
| Scheduled recovery Job | `twilio-comics-recovery` | `twilio-comics-recovery-v2` |
| Manual migration Job | None | `twilio-comics-migrate-v2` |
| PostgreSQL | None | Flexible Server `twilio-comics-pg-1a1d98`, database `twilio_comics` |

The V2 names are a **plan**, not a claim that those resources exist. `scripts/provision-azure.sh` created the existing foundation with an Azure managed-network ACA environment. Run the private-platform provisioner **first** so the V2 environment exists with VNet integration. Only then rerun `provision-azure.sh` with V2 workload names; it reuses that environment and creates the V2 web app and two runtime Jobs. If the order is reversed, it can create a managed-network V2 environment that cannot reach the private database. Keep the existing placeholders until the V2 app and Jobs pass verification; move the public URL and Twilio webhooks in a deliberate cutover.

## Inspect or recreate the existing foundation

You need Azure permission to create resource groups, Container Apps, managed identities, an Entra application, and role assignments. You also need GitHub repository administrator access. Install Azure CLI, GitHub CLI, `git`, and `jq`, then authenticate:

```bash
az login
gh auth login
git remote get-url origin
```

The script checks that the `Microsoft.App`, `Microsoft.OperationalInsights`, `Microsoft.Storage`, `Microsoft.ContainerRegistry`, and `Microsoft.ManagedIdentity` resource providers are registered in the selected subscription before creating resources. On a fresh subscription, register any missing provider with `az provider register --namespace <provider> --wait` and rerun the script.

Confirm that `origin` names the intended GitHub repository. This script is useful on a fresh installation or to repair its own resources. For this installation, use its **existing** globally unique ACR and Storage account names:

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
| Public Container App | `twilio-comics` | ASP.NET sample image; port 8080 ingress |
| Event-driven ACA Job | `twilio-comics-generation` | Placeholder image and Azure Queue trigger |
| Scheduled ACA recovery Job | `twilio-comics-recovery` | Placeholder image and dormant annual cron |
| StorageV2 account | `STORAGE_ACCOUNT` | Private Blob container and generation queues |
| Blob container | `comics` | Generated images and references |
| Storage queues | `comic-generation`, `comic-generation-poison` | Pending and poison job messages |
| User-assigned identities | `id-twilio-comics-web`, `id-twilio-comics-worker`, `id-twilio-comics-acr-pull` | Storage access and ACR image pulls |
| Entra application | `twilio-comics-gha-deploy` | GitHub OIDC deployment principal |

Every newly created Azure Resource Manager resource receives `created_by=github-actions` and `managed_by=twilio-comics-ci` by default. The script creates or reuses a **tagged Log Analytics workspace before creating a new Container Apps environment**; this prevents ACA from generating an untagged workspace that a tenant policy may reject. Azure Blob containers and queues are data-plane objects and do not receive ARM resource tags. Existing resource tags are not rewritten.

The script checks for resources by their exact configured names before creating them. It reuses role assignments, identities, ACR pull configuration, and the OIDC credential. On an existing web app or Job, it fills in missing infrastructure environment variables; if a configured storage account or managed identity differs, it stops instead of redirecting a live workload. An adopted public app must already have external HTTP ingress targeting port 8080; the script stops with a corrective command if its ingress differs. Changing ingress on a live app may interrupt traffic, so align it when its image serves port 8080 or choose a new `ACA_NAME`. An existing Container Apps environment keeps its current Log Analytics destination. Rerunning the script after an interrupted setup is safe and does not delete any resource.

The public placeholder starts from Microsoft's ASP.NET sample image on port 8080 and does not serve `/api/healthz`. Its recovery Job has a dormant annual cron. The production release changes the **V2 workloads** to immutable image digests and enables the five-minute recovery sweep; the placeholder does not become production merely because it has an ACA URL.

After deployment, the V2 recovery Job runs `pnpm start:worker` with `RECOVERY_MODE=1` on `*/5 * * * *` (five-minute UTC). Give it the same worker managed identity, storage environment variables, runtime secrets, and ACR pull identity as the V2 queue Job. Its bounded sweep republishes pending inbound receipts and generation jobs after transient failures. The scheduled and queue Jobs remain separate so a recovery sweep never consumes a queue message.

## Build the private production environment

Follow [Azure PostgreSQL setup](AZURE_POSTGRES.md) before pointing the release workflow at V2. The planned `vnet-twilio-comics-v2` uses `10.74.0.0/20`, with a Container Apps infrastructure subnet (`aca-infrastructure`, `10.74.0.0/23`) and a **different** PostgreSQL delegated subnet (`postgresql`, `10.74.8.0/26`). Check existing VNet ranges for overlap before reserving them and register `Microsoft.Network`, `Microsoft.KeyVault`, and `Microsoft.DBforPostgreSQL` if needed. The provisioner generates a strong PostgreSQL administrator password, stores it as `postgres-bootstrap-password` in Key Vault `kv-twilio-comics-1a1d98`, and reuses it on later runs. It does not display the password or pass it in a command argument. Preview the Bicep resources without creating anything, then run the repeatable private-platform provisioner:

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

The script creates the private PostgreSQL DNS zone and VNet link, `cae-twilio-comics-v2` as a workload-profile environment, PostgreSQL Flexible Server with private access and public network access disabled, and the `twilio_comics` database. It does **not** create the V2 web app or Jobs, runtime/migration SQL roles or URLs, GitHub configuration, or Twilio webhooks. The existing managed-network ACA environment cannot provide the private database route.

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
PROVISION_AZURE_CONFIRM=yes \
bash scripts/provision-azure.sh
```

The V2 public app needs external HTTPS ingress on port 8080 for the website, Twilio webhooks, and ConversationRelay WebSocket; the two runtime Jobs need no public ingress. The PostgreSQL role provisioner creates the fourth workload as a **manual**, one-container migration Job using the reviewed `Dockerfile.migrate` image. Build and pin its image and the one-off role bootstrap image from committed source:

```bash
export SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98'
bash scripts/build-azure-postgres-images.sh
# Copy the two printed BOOTSTRAP_IMAGE and MIGRATION_IMAGE export lines here.
PROVISION_POSTGRES_ROLES_CONFIRM=yes bash scripts/provision-postgres-roles.sh
```

`scripts/provision-postgres-roles.sh` starts `twilio-comics-db-bootstrap-v2` inside the private V2 environment, creates separate `comics_runtime` and `comics_migrator` SQL logins, and stores their verify-full URLs in Key Vault as `postgres-comics-runtime-url` and `postgres-comics-migration-url`. It grants secret-scoped read access only to the V2 workload identities, binds the runtime URL as `runtime-database-url` on the web/generation/recovery workloads, and creates `twilio-comics-migrate-v2` with `migration-database-url`. Both are exposed to their containers as `DATABASE_URL=secretref:...`. During role provisioning, only the private Job retrieves the bootstrap administrator credential from Key Vault; its temporary Key Vault Secrets Officer assignment is revoked when the script exits. See the [role bootstrap steps](AZURE_POSTGRES.md#one-time-role-bootstrap-and-v2-workload-wiring) for exact behavior and recovery.

The platform template sets 14-day backups; review that retention and confirm point-in-time restore. Confirm private DNS resolution and port 5432 connectivity from a Job inside V2 before the first release.

The migration Job's image contains checked-in Drizzle migrations and the read-only preflight script. It runs preflight, then `pnpm db:migrate`, before a runtime image is rolled out. For an older populated database, follow the reviewed baseline or import procedure in [the private database guide](AZURE_POSTGRES.md#migration-execution-inside-the-vnet); do not replay initial migrations over its tables. `pnpm drizzle-kit push` is for a development database, not the production rollout.

## Access and GitHub OIDC

The script grants the following roles after creating or finding each identity:

| Principal | Scope | Role |
|---|---|---|
| Web managed identity | Storage account | Storage Blob Data Contributor; Storage Queue Data Message Sender |
| Worker managed identity | Storage account | Storage Blob Data Contributor; Storage Queue Data Contributor |
| ACR pull managed identity | Registry | AcrPull |
| Provisioning user | Storage account | Storage Blob Data Contributor; Storage Queue Data Contributor |
| GitHub deployment principal | Registry | AcrPush |
| GitHub deployment principal | Resource group | Contributor |

For a service-principal Azure login, set `PROVISIONER_OBJECT_ID` and `PROVISIONER_PRINCIPAL_TYPE=ServicePrincipal` so the script can grant data-plane rights needed to create the Blob container and queues. Role assignments can take time to propagate; the script waits and retries data-plane creation.

Both Azure-login jobs in `deploy.yml` use the GitHub `production` environment. The script parses the **actual `origin` Git remote** to derive the repository, then trusts the [environment-specific OIDC subject](https://docs.github.com/en/actions/reference/security/oidc):

```text
repo:<origin-owner>/<origin-repo>:environment:production
```

If GitHub reports an immutable or customized subject for this repository, set `GITHUB_OIDC_SUBJECT` to that exact claim before rerunning. The script updates the existing `gha-production` federated credential when the subject changes. It creates the GitHub `production` environment with a `main`-only deployment branch policy if absent. If the environment already exists, review its branch and reviewer rules in GitHub Settings; provisioning leaves them intact. Protect `main` with the `Validate` required check and set a production reviewer for routine releases.

The original foundation run points the repository's `ACA_*` variables at the **placeholders**. Its V2 rerun repoints the web and runtime Job variables. Verify them with `gh variable list`, repair any mismatch using the values below, and add the migration Job variable that the script does not set:

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

The PostgreSQL provisioner above owns all `DATABASE_URL` secrets and bindings. Add the **remaining** secrets through Azure Portal under **Container App or Container Apps Job → Settings → Secrets**, or through an approved secret-management process. Prefer Key Vault references with managed identities. Do not put secret values in shell history, a command log, Git, or an image. Set the same shared value wherever the table says it is needed:

| Azure secret | V2 web | Generation and recovery Jobs | Migration Job | Purpose |
|---|---|---|---|---|
| `auth-secret` | Yes |  |  | Auth.js/admin sessions and Voice authorization signing |
| `auth-google-id`, `auth-google-secret` | Optional |  |  | Browser testing studio OAuth |
| `media-signing-secret` | Yes | Yes |  | Private media link signing |
| `openai-api-key` | Yes | Yes |  | Comic and conversation models |
| `twilio-account-sid`, `twilio-auth-token` | Yes | Yes |  | Twilio API and inbound webhook validation |
| `admin-password-hash` | Yes |  |  | Scrypt hash for `/admin/login`, never a plaintext password |

Choose a private admin username and a unique password of at least 16 characters. Run `pnpm exec tsx scripts/hash-admin-password.ts`, enter the password at its hidden prompt, and store only the encoded hash as `admin-password-hash`. There are no default admin credentials. Google OAuth is optional for `/studio`; if enabled in production, set `STUDIO_TESTER_EMAILS` to a comma-separated allowlist of permitted Google email addresses. An empty list denies studio sign-in.

Reference the Azure secrets in each V2 workload. These commands update only the listed environment variables; they assume the secrets already exist on the corresponding workload:

```bash
az containerapp update --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars \
    'AUTH_SECRET=secretref:auth-secret' \
    'MEDIA_SIGNING_SECRET=secretref:media-signing-secret' \
    'OPENAI_API_KEY=secretref:openai-api-key' \
    'TWILIO_ACCOUNT_SID=secretref:twilio-account-sid' \
    'TWILIO_AUTH_TOKEN=secretref:twilio-auth-token' \
    'ADMIN_USERNAME=<your-admin-username>' \
    'ADMIN_PASSWORD_HASH=secretref:admin-password-hash'

az containerapp job update --name "$ACA_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars \
    'MEDIA_SIGNING_SECRET=secretref:media-signing-secret' \
    'OPENAI_API_KEY=secretref:openai-api-key' \
    'TWILIO_ACCOUNT_SID=secretref:twilio-account-sid' \
    'TWILIO_AUTH_TOKEN=secretref:twilio-auth-token'

az containerapp job update --name "$ACA_RECOVERY_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars \
    'MEDIA_SIGNING_SECRET=secretref:media-signing-secret' \
    'OPENAI_API_KEY=secretref:openai-api-key' \
    'TWILIO_ACCOUNT_SID=secretref:twilio-account-sid' \
    'TWILIO_AUTH_TOKEN=secretref:twilio-auth-token' \
    'RECOVERY_MODE=1'
```

The V2 rerun of `provision-azure.sh` sets the Storage endpoints, container/queue names, workload-specific `AZURE_CLIENT_ID`, web/worker identities, and ACR pull identity on the web app and both runtime Jobs. Verify those settings before release; they are independent of the old placeholders. The PostgreSQL role provisioner creates and configures the manual migration Job, including its dedicated Key Vault identity and ACR pull access. Production Storage access uses managed identity, not `AZURE_STORAGE_CONNECTION_STRING`. The image listens on `PORT=8080` and `HOSTNAME=0.0.0.0`; the worker creates a unique `WORKER_ID` when needed.

Set the final public origin on the V2 app and runtime Jobs. The worker uses it to build story links. The V2 ACA domain can be used for a prelaunch smoke test; use the chosen final HTTPS domain before configuring Twilio webhooks. During prelaunch, leave `TWILIO_ENABLED_CHANNELS` empty **or unset**. Either state shows no SMS/call/WhatsApp action or QR code and rejects inbound channel conversations; a configured number alone never enables a channel.

```bash
export PUBLIC_BASE_URL='https://<your-final-domain>'

az containerapp update --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "PUBLIC_BASE_URL=$PUBLIC_BASE_URL" "AUTH_URL=$PUBLIC_BASE_URL" \
    'TWILIO_ENABLED_CHANNELS=' \
    'APP_OPERATOR_NAME=Anthony Dellavecchia' \
    'APP_CONTACT_EMAIL=adellavecchia@twilio.com'

az containerapp job update --name "$ACA_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "PUBLIC_BASE_URL=$PUBLIC_BASE_URL"

az containerapp job update --name "$ACA_RECOVERY_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "PUBLIC_BASE_URL=$PUBLIC_BASE_URL"
```

If the browser testing studio is used, reference `AUTH_GOOGLE_ID=secretref:auth-google-id` and `AUTH_GOOGLE_SECRET=secretref:auth-google-secret` on the V2 web app, set `STUDIO_TESTER_EMAILS` there, and add `https://<your-final-domain>/api/auth/callback/google` as a Google OAuth callback. See [authentication](../README.md#authentication). SMS, Voice, and the admin dashboard do not require Google OAuth.

For Voice, create a Twilio Verify service that sends six-digit **SMS** codes and set its `VA...` Service SID on the V2 web app. The caller receives a text and enters the code on the phone keypad before ConversationRelay can use saved conversation data. Also set the secure relay URL. Voice stays unavailable on `/start` until its Verify service, relay URL, Twilio credentials, and signing secret are configured:

```bash
az containerapp update --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars \
    'TWILIO_VERIFY_SERVICE_SID=<your-Verify-Service-SID>' \
    "CONVERSATION_RELAY_WS_URL=wss://${PUBLIC_BASE_URL#https://}/relay"
```

The app-specific `/privacy` and `/terms` pages name **Anthony Dellavecchia** and **adellavecchia@twilio.com** for support and deletion requests. Review their content before toll-free verification or launch. The linked [Twilio privacy notice](https://www.twilio.com/en-us/legal/privacy) and [Twilio terms](https://www.twilio.com/en-us/legal/tos) describe the provider and do not replace the app's own pages.

WhatsApp is outside the initial launch. To add it later, configure an approved `whatsapp:` sender on the V2 app and both runtime Jobs, its webhook, and add `whatsapp` to the explicit channel list. The [README](../README.md#twilio-setup) lists the channel-specific requirements.

## Configure Twilio and release

Confirm **+1 866 901 2028** is owned by the intended Twilio account and has SMS and Voice capabilities. The Account SID and toll-free SMS approval have not been verified in this workspace. Twilio [requires toll-free verification for SMS to the United States and Canada](https://www.twilio.com/docs/messaging/compliance/toll-free/console-onboarding), including the comic result sent after a Voice call. Confirm Verify's SMS sender and Voice code delivery, review the SMS/Voice disclosures and app policies, and accept the [ConversationRelay AI/ML Features Addendum](https://www.twilio.com/docs/voice/conversationrelay/onboarding).

Configure the number's HTTP webhooks with the **exact** origin in `PUBLIC_BASE_URL`; Twilio signatures depend on the URL. ConversationRelay uses the `wss://` URL in the Voice TwiML. The app's channel selection does not change the number's settings in Twilio Console:

```text
SMS/MMS: POST https://<your-final-domain>/api/twilio/sms
Voice:   POST https://<your-final-domain>/api/twilio/voice
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

After toll-free approval and configuration of Twilio webhooks, Verify, and ConversationRelay, set the phone number on the V2 app and both runtime Jobs, then enable only SMS and Voice on the V2 web app for controlled production tests:

```bash
export TWILIO_PHONE_NUMBER='+18669012028'
az containerapp update --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "TWILIO_PHONE_NUMBER=$TWILIO_PHONE_NUMBER"
az containerapp job update --name "$ACA_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "TWILIO_PHONE_NUMBER=$TWILIO_PHONE_NUMBER"
az containerapp job update --name "$ACA_RECOVERY_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "TWILIO_PHONE_NUMBER=$TWILIO_PHONE_NUMBER"
az containerapp update --name "$ACA_NAME" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars 'TWILIO_ENABLED_CHANNELS=sms,voice'
```

At phone and desktop widths, verify the two `/start` actions and QR codes lead to `sms:+18669012028` and `tel:+18669012028`, with their disclosures and policy links nearby. Send a real SMS comic, then make a real call: receive the Verify text, enter its code on the keypad, create a comic through ConversationRelay, and receive the result by SMS. Confirm the queue Job and recovery Job execute, `/admin/login` shows the activity and timeline, and the records remain after a new revision. Those records live in PostgreSQL and Azure Blob Storage, outside the container image. [Deployment verification](DEPLOYMENT.md#twilio-verification) has the detailed checks and [rollback](DEPLOYMENT.md#health-and-rollback) covers image recovery.

To close entry without clearing the sender number, set `TWILIO_ENABLED_CHANNELS=` on the V2 web app. Unset is also closed. This changes the public actions and inbound channel acceptance, not the sender's Twilio capabilities or webhook settings. Keep the database and backup policy active so admin history survives deploys; use the [deletion procedure](DATA_DELETION.md) for explicit user requests.

Keep initial capacity modest: web `0.5` CPU and `1Gi`, each runtime Job `1` CPU and `2Gi`, generation `minExecutions: 0` and `maxExecutions: 1`, recovery every five minutes with one replica. Create an Azure budget and lifecycle policy for abandoned Blob uploads after observing actual usage. No ACR admin password or Azure service-principal secret is stored in GitHub.
