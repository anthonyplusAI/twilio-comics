# Azure Infrastructure Setup

This is the one-time foundation for the [deployment workflow](../.github/workflows/deploy.yml). The workflow builds and releases the application; provisioning creates the Azure and GitHub resources it needs. The application runs on Azure Container Apps, stores images and jobs in Azure Storage, and continues to use the configured PostgreSQL database.

## Run the provisioning script

You need Azure permission to create resource groups, Container Apps, managed identities, an Entra application, and role assignments. You also need GitHub repository administrator access. Install Azure CLI, GitHub CLI, `git`, and `jq`, then authenticate:

```bash
az login
gh auth login
git remote get-url origin
```

The script checks that the `Microsoft.App`, `Microsoft.OperationalInsights`, `Microsoft.Storage`, `Microsoft.ContainerRegistry`, and `Microsoft.ManagedIdentity` resource providers are registered in the selected subscription before creating resources. On a fresh subscription, register any missing provider with `az provider register --namespace <provider> --wait` and rerun the script.

Confirm that `origin` names the GitHub repository whose `main` branch will deploy. Export the target subscription and two globally unique resource names. For an existing installation, use its **existing** ACR and Storage account names:

```bash
export SUBSCRIPTION_ID="<subscription-id>"
export ACR_NAME="<existing-or-new-registry-name>"
export STORAGE_ACCOUNT="<existing-or-new-storage-account-name>"
bash scripts/provision-azure.sh
```

The script prints the subscription, resource group, repository, and OIDC subject before its confirmation prompt. It does **not** build an image, deploy a revision, run a database migration, configure Twilio, or set application credentials. For an unattended run, set `PROVISION_AZURE_CONFIRM=yes` after reviewing those values.

Optional name overrides are `RESOURCE_GROUP`, `LOCATION`, `LOG_ANALYTICS_WORKSPACE`, `ACA_ENVIRONMENT`, `ACA_NAME`, `ACA_JOB_NAME`, `ACA_RECOVERY_JOB_NAME`, `BLOB_CONTAINER`, `QUEUE_NAME`, `POISON_QUEUE_NAME`, the three `*_IDENTITY_NAME` variables, and `DEPLOY_APP_NAME`. Defaults are shown below. `CREATED_BY` and `MANAGED_BY` override the tenant tag values if your policy requires different values.

## Resources created or reused

| Resource | Default name | Purpose |
|---|---|---|
| Resource group | `rg-twilio-comics` | Contains the Azure resources |
| Container Registry | `ACR_NAME` | Private image repository, admin account disabled on new registries |
| Log Analytics workspace | `law-twilio-comics` | Explicit log destination for a new ACA environment |
| Container Apps environment | `cae-twilio-comics` | Hosts all three workloads |
| Public Container App | `twilio-comics` | Next.js, Twilio HTTP webhooks, and ConversationRelay WebSocket on port 8080 |
| Event-driven ACA Job | `twilio-comics-generation` | One-shot comic generation from Azure Queue |
| Scheduled ACA recovery Job | `twilio-comics-recovery` | Recovery sweep every five minutes, UTC |
| StorageV2 account | `STORAGE_ACCOUNT` | Private Blob container and generation queues |
| Blob container | `comics` | Generated images and references |
| Storage queues | `comic-generation`, `comic-generation-poison` | Pending and poison job messages |
| User-assigned identities | `id-twilio-comics-web`, `id-twilio-comics-worker`, `id-twilio-comics-acr-pull` | Storage access and ACR image pulls |
| Entra application | `twilio-comics-gha-deploy` | GitHub OIDC deployment principal |

Every newly created Azure Resource Manager resource receives `created_by=github-actions` and `managed_by=twilio-comics-ci` by default. The script creates or reuses a **tagged Log Analytics workspace before creating a new Container Apps environment**; this prevents ACA from generating an untagged workspace that a tenant policy may reject. Azure Blob containers and queues are data-plane objects and do not receive ARM resource tags. Existing resource tags are not rewritten.

The script checks for resources by their exact configured names before creating them. It reuses role assignments, identities, ACR pull configuration, and the OIDC credential. On an existing web app or Job, it fills in missing infrastructure environment variables; if a configured storage account or managed identity differs, it stops instead of redirecting a live workload. An adopted public app must already have external HTTP ingress targeting port 8080; the script stops with a corrective command if its ingress differs. Changing ingress on a live app may interrupt traffic, so align it when its image serves port 8080 or choose a new `ACA_NAME`. An existing Container Apps environment keeps its current Log Analytics destination. Rerunning the script after an interrupted setup is safe and does not delete any resource.

The public Container App starts from Microsoft's ASP.NET sample image, which listens on port 8080 and matches the app's ingress and ACA's default TCP probes. The placeholder does not serve `/api/healthz`; the release workflow checks `GET /api/healthz` after the real application image is deployed. The workflow tags the image with the commit SHA and deploys its registry digest to the app and both Jobs, so later changes to a tag cannot change their pinned image. The scheduled Job may show unsuccessful placeholder executions before the first release; configure its secrets and deploy the real image promptly.

The recovery Job runs `pnpm start:worker` with `RECOVERY_MODE=1` on `*/5 * * * *` (five-minute UTC) and uses the same worker managed identity, storage environment variables, runtime secrets, and ACR pull identity as the queue Job. Its bounded sweep republishes pending inbound receipts and generation jobs after transient failures. The scheduled and queue Jobs remain separate so a recovery sweep never consumes a queue message.

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

If GitHub reports an immutable or customized subject for this repository, set `GITHUB_OIDC_SUBJECT` to that exact claim before rerunning. The script updates the existing `gha-production` federated credential when the subject changes. It creates the GitHub `production` environment with a `main`-only deployment branch policy if absent. If the environment already exists, review its branch and reviewer rules in GitHub Settings; provisioning leaves them intact.

The script sets these GitHub **repository variables**: `ACR_NAME`, `ACA_NAME`, `ACA_JOB_NAME`, `ACA_RECOVERY_JOB_NAME`, `ACA_RESOURCE_GROUP`. `ACA_RECOVERY_JOB_NAME` defaults to exactly `twilio-comics-recovery` and the workflow uses it when deploying the recovery image. The script sets these **production environment secrets**: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`. These three values are identifiers, not a reusable Azure password. Add the database migration connection string to that same environment separately:

```bash
gh secret set DATABASE_URL --env production
```

Run that command inside this repository and paste the PostgreSQL URL at the prompt. GitHub uses it only for `pnpm db:migrate` in the deployment workflow. Protect `main` with the `Validate` required check and set a reviewer for the `production` environment before allowing routine releases.

## Configure ACA runtime before the first release

The application image exits at startup when required runtime variables are absent. Provisioning sets the Azure Storage endpoints, container and queue names, and each workload's `AZURE_CLIENT_ID`; it also sets `RECOVERY_MODE=1` only on the recovery Job. Set the remaining values on the Azure workloads **before** triggering the first deployment.

1. Choose the final HTTPS origin. The generated ACA domain works for initial testing; a custom domain can replace it. Resolve the initial domain with:

   ```bash
   az containerapp show --name twilio-comics --resource-group rg-twilio-comics \
     --query properties.configuration.ingress.fqdn --output tsv
   ```

2. In the Azure Portal, add these secrets under **Container App → Settings → Secrets**. Add the worker subset to **both** the generation and recovery Jobs under **Container Apps Job → Settings → Secrets**. Use the same values for shared secrets.

   | Secret name in ACA | Public app | Both Jobs | Value |
   |---|---|---|---|
   | `database-url` | Yes | Yes | PostgreSQL connection string |
   | `auth-secret` | Yes |  | Random Auth.js signing secret |
   | `auth-google-id` | Yes |  | Google OAuth client ID |
   | `auth-google-secret` | Yes |  | Google OAuth client secret |
   | `media-signing-secret` | Yes | Yes | Random media URL signing key |
   | `openai-api-key` | Yes | Yes | OpenAI API key |
   | `twilio-account-sid` | Yes | Yes | Twilio Account SID |
   | `twilio-auth-token` | Yes | Yes | Twilio Auth Token |

3. Reference those secrets as environment variables. These commands add or update only the listed variables and preserve the storage variables from provisioning:

   ```bash
   az containerapp update --name twilio-comics --resource-group rg-twilio-comics \
     --set-env-vars \
       'DATABASE_URL=secretref:database-url' \
       'AUTH_SECRET=secretref:auth-secret' \
       'AUTH_GOOGLE_ID=secretref:auth-google-id' \
       'AUTH_GOOGLE_SECRET=secretref:auth-google-secret' \
       'MEDIA_SIGNING_SECRET=secretref:media-signing-secret' \
       'OPENAI_API_KEY=secretref:openai-api-key' \
       'TWILIO_ACCOUNT_SID=secretref:twilio-account-sid' \
       'TWILIO_AUTH_TOKEN=secretref:twilio-auth-token'

   az containerapp job update --name twilio-comics-generation --resource-group rg-twilio-comics \
     --set-env-vars \
       'DATABASE_URL=secretref:database-url' \
       'MEDIA_SIGNING_SECRET=secretref:media-signing-secret' \
       'OPENAI_API_KEY=secretref:openai-api-key' \
       'TWILIO_ACCOUNT_SID=secretref:twilio-account-sid' \
       'TWILIO_AUTH_TOKEN=secretref:twilio-auth-token'

   az containerapp job update --name twilio-comics-recovery --resource-group rg-twilio-comics \
     --set-env-vars \
       'DATABASE_URL=secretref:database-url' \
       'MEDIA_SIGNING_SECRET=secretref:media-signing-secret' \
       'OPENAI_API_KEY=secretref:openai-api-key' \
       'TWILIO_ACCOUNT_SID=secretref:twilio-account-sid' \
       'TWILIO_AUTH_TOKEN=secretref:twilio-auth-token' \
       'RECOVERY_MODE=1'
   ```

4. Set the final public URL on **all three** workloads. The generation worker uses it to build story links. You can release the public invitation before either sender is ready; it shows no text, call, WhatsApp, or QR action until a valid sender is configured. Messaging and Voice webhooks reject traffic for any unconfigured or disabled channel.

   ```bash
   export PUBLIC_BASE_URL='https://<your-domain>'

   az containerapp update --name twilio-comics --resource-group rg-twilio-comics \
     --set-env-vars \
       "PUBLIC_BASE_URL=$PUBLIC_BASE_URL" \
       "AUTH_URL=$PUBLIC_BASE_URL"

   az containerapp job update --name twilio-comics-generation --resource-group rg-twilio-comics \
     --set-env-vars "PUBLIC_BASE_URL=$PUBLIC_BASE_URL"

   az containerapp job update --name twilio-comics-recovery --resource-group rg-twilio-comics \
     --set-env-vars "PUBLIC_BASE_URL=$PUBLIC_BASE_URL"
   ```

   If Voice is selected, set the secure relay URL on the public app. The server requires this setting for Voice; SMS-only and WhatsApp-only deployments do not need it.

   ```bash
   az containerapp update --name twilio-comics --resource-group rg-twilio-comics \
     --set-env-vars "CONVERSATION_RELAY_WS_URL=wss://${PUBLIC_BASE_URL#https://}/relay"
   ```

   Choose the public start channels in display order **before setting a phone number**. This example makes WhatsApp the primary action and QR code once its sender is configured, with SMS as another option. Set this variable on the public app only; the Jobs use the destination variables below to deliver results. A channel without a valid configured destination is omitted. If `TWILIO_ENABLED_CHANNELS` is unset, a valid phone number enables both SMS and Voice and an approved WhatsApp sender enables WhatsApp. For an SMS-only launch, set `TWILIO_ENABLED_CHANNELS=sms` before setting `TWILIO_PHONE_NUMBER`; otherwise the server infers Voice and requires `CONVERSATION_RELAY_WS_URL`. An explicitly empty value disables every public start channel and its inbound webhook. The setting does not query Twilio Console or change number capabilities, sender approvals, or webhook configuration.

   ```bash
   az containerapp update --name twilio-comics --resource-group rg-twilio-comics \
     --set-env-vars 'TWILIO_ENABLED_CHANNELS=whatsapp,sms'
   ```

   To change the advertised flow later, update this value and check the new homepage revision. To return to destination-based inference, remove the variable from the public app with `az containerapp update --name twilio-comics --resource-group rg-twilio-comics --remove-env-vars TWILIO_ENABLED_CHANNELS`. To temporarily close every start channel, set the variable to an empty value with `az containerapp update --name twilio-comics --resource-group rg-twilio-comics --set-env-vars 'TWILIO_ENABLED_CHANNELS='`, then verify the page says “opening soon” and the Twilio webhooks no longer accept new conversations. Do not clear a sender value on the Jobs merely to hide its public action.

   When you enable SMS/MMS or ConversationRelay, set a real E.164 number with the capabilities you need on the public app and both Jobs. The worker replies from the number that received the original message; the phone number also sends links to Voice callers by SMS. A Voice-only public entry therefore still needs outbound SMS capability.

   ```bash
   export TWILIO_PHONE_NUMBER='<your-real-E.164-number>'
   az containerapp update --name twilio-comics --resource-group rg-twilio-comics \
     --set-env-vars "TWILIO_PHONE_NUMBER=$TWILIO_PHONE_NUMBER"
   az containerapp job update --name twilio-comics-generation --resource-group rg-twilio-comics \
     --set-env-vars "TWILIO_PHONE_NUMBER=$TWILIO_PHONE_NUMBER"
   az containerapp job update --name twilio-comics-recovery --resource-group rg-twilio-comics \
     --set-env-vars "TWILIO_PHONE_NUMBER=$TWILIO_PHONE_NUMBER"
   ```

   If you enable WhatsApp, set an approved sender with the `whatsapp:` prefix on the public app and both Jobs. WhatsApp works independently of the SMS and Voice number:

   ```bash
   export TWILIO_WHATSAPP_NUMBER='whatsapp:<your-approved-E.164-number>'
   az containerapp update --name twilio-comics --resource-group rg-twilio-comics \
     --set-env-vars "TWILIO_WHATSAPP_NUMBER=$TWILIO_WHATSAPP_NUMBER"
   az containerapp job update --name twilio-comics-generation --resource-group rg-twilio-comics \
     --set-env-vars "TWILIO_WHATSAPP_NUMBER=$TWILIO_WHATSAPP_NUMBER"
   az containerapp job update --name twilio-comics-recovery --resource-group rg-twilio-comics \
     --set-env-vars "TWILIO_WHATSAPP_NUMBER=$TWILIO_WHATSAPP_NUMBER"
   ```

   The image already sets `PORT=8080` and `HOSTNAME=0.0.0.0`. The worker generates a unique `WORKER_ID` if none is supplied.

5. Add the Google OAuth callback `https://<your-domain>/api/auth/callback/google`. Configure webhooks in Twilio Console for **each selected and available** channel with the **exact** origin used in `PUBLIC_BASE_URL`, since signature validation uses that URL. An ACA channel selection does not configure these Twilio resources for you:

   ```text
   SMS/MMS:  POST https://<your-domain>/api/twilio/sms
   WhatsApp: POST https://<your-domain>/api/twilio/whatsapp
   Voice:    POST https://<your-domain>/api/twilio/voice
   Relay:    wss://<your-domain>/relay
   ```

   Attach the SMS webhook to the SMS-capable number (or its Messaging Service), the WhatsApp webhook to the approved sender, and the Voice webhook to the callable number. ConversationRelay must be available for Voice, and the shared number must be able to send the SMS result even when Voice is the only public start action. US outbound SMS may also require A2P 10DLC or toll-free verification. Consult the [Twilio setup in the README](../README.md#twilio-setup) for the current channel details.

## Verify and release

Before the first deployment, confirm resource names and the GitHub variables/secrets, then trigger the workflow:

```bash
gh variable list
gh secret list --env production
gh workflow run deploy.yml --ref main
gh run list --workflow deploy.yml --limit 1
```

Watch the run with `gh run watch <run-id> --exit-status`. The deployment checks the new image's SHA via `/api/healthz`. Check the public page on desktop and mobile: the Twilio Comics branding and Make Comics fork credit should render, the first available channel should own the primary action and QR code, and unavailable channels should have no action. For each enabled channel, send a test message or place a test call, then confirm the generation Job consumes the queue message and sends a story link. Check that the scheduled recovery Job completes a sweep within five minutes. See [deployment verification](DEPLOYMENT.md#twilio-verification) for the full website and channel checks and [rollback](DEPLOYMENT.md#health-and-rollback) for recovery.

Keep initial capacity modest: web `0.5` CPU and `1Gi`, each Job `1` CPU and `2Gi`, generation `minExecutions: 0` and `maxExecutions: 1`, recovery every five minutes with one replica. Create an Azure budget and lifecycle policy for abandoned Blob uploads after observing actual usage. No ACR admin password or Azure service-principal secret is stored in GitHub.
