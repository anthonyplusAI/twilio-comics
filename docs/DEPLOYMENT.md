# Deployment

The production deployment uses a runtime image for three Azure Container Apps workloads and a separate migration image:

- `twilio-comics-v2`: Next.js, Twilio HTTP webhooks, and ConversationRelay WebSocket server; external HTTPS ingress opens after its first healthy release.
- `twilio-comics-generation-v2`: private event-driven Queue Job for inbound text turns and comic generation using `pnpm start:worker`.
- `twilio-comics-recovery-v2`: private scheduled Job using `RECOVERY_MODE=1 pnpm start:worker` to republish stale work every five minutes.
- `twilio-comics-migrate-v2`: private, manual ACA migration Job that runs read-only preflight and checked-in Drizzle migrations against Central US Azure PostgreSQL before the runtime image is rolled out.

The runtime workloads live in the East US 2 V2 Container Apps environment. The database lives in a Central US private VNet reached through bidirectional global VNet peering; its private DNS zone is linked to both networks. See [the network layout](AZURE_POSTGRES.md#current-state-and-required-network-change).

## Release Flow

Every push to `main` runs `.github/workflows/deploy.yml`. It releases only when `PRODUCTION_RELEASE_READY=true` is set as a GitHub repository variable:

1. Reuse `.github/workflows/ci.yml` and require `Validate` to pass.
2. Authenticate to Azure through GitHub OIDC.
3. Build runtime and migration images, push full commit-SHA tags to ACR, and pin each manifest by its immutable `sha256` digest.
4. Update and start the manual migration Job inside the private Container Apps network. Its command checks PostgreSQL migration history and schema read-only, then applies reviewed Drizzle migrations. Stop the release if this Job fails.
5. Update the generation Job, scheduled recovery Job, then the Container App to the runtime image digest. A new foundation app begins with internal ingress and zero minimum replicas.
6. Verify the digest-pinned app revision is healthy, then enable external ingress. Poll `/api/healthz` until it reports the deployed commit SHA, then require `/api/readyz` to return HTTP 200 against the migrated database.

Deployments are serialized with `cancel-in-progress: false`; a production rollout is never cancelled midway.
The provisioner initially leaves the recovery Job on a dormant annual placeholder cron; the first successful deployment switches it to its five-minute schedule with the real application image.

## Database Migration Gate

The private migration Job runs `scripts/check-migration-preflight.ts` before `pnpm db:migrate`. The GitHub-hosted runner triggers that Job through Azure management APIs and never connects directly to the private database. The check only reads PostgreSQL catalog tables, `drizzle.__drizzle_migrations`, duplicate `(story_id, page_number)` groups in `public.pages`, and a count of `conversations.active_story_id` values whose stories are missing. It requires a complete prefix of the checked-in migration journal with matching timestamps and SQL hashes, then compares the public tables, column types and nullability, and named constraints and indexes with the last applied migration. It blocks migration `0006` until duplicate page numbers and orphan story references are reviewed and corrected, because its unique index and foreign key would fail. It allows an empty database to receive the initial migration.

An existing database created with `drizzle-kit push` usually has app tables but no migration journal. The preflight blocks deployment in this state. Without that gate, Drizzle could try to replay `0000` against the existing `stories` table. A mismatch between the journal and the checked-in SQL, or an unexpected schema change, also blocks deployment before any workload is updated.

The new Azure PostgreSQL database starts empty and receives all migrations in order. If importing an older database, establish a reviewed baseline first:

1. Take a backup or branch of the source database and use a maintenance window. Run all database commands from a trusted host with a private route to the Central US PostgreSQL server, or from a one-off ACA Job in the peered East US 2 V2 environment. Set `DATABASE_URL` to the exact target you intend to baseline.
2. Run `node --import tsx scripts/check-migration-preflight.ts`. It will fail safely on an unbaselined database and report an eligible migration tag if the live table, column, constraint-name, and index-name shape matches a checked-in migration at `0005` or later. Baseline SQL is unavailable for `0000`–`0004`, because later migrations need data review before they can safely run on a populated database. If it reports no eligible match, duplicate page numbers, or conversations referencing deleted stories, review the data and reconcile it manually before continuing.
3. Generate a **SQL file for review**, substituting the reported tag: `node --import tsx scripts/check-migration-preflight.ts --baseline-sql=<tag> > /tmp/twilio-comics-baseline.sql`. This command reads the database but does not execute the SQL. Inspect the full schema, index and constraint definitions, data, and the generated hashes and timestamps. The baseline records historical migrations as already applied; it does not create their app tables or columns.
4. After review, run `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /tmp/twilio-comics-baseline.sql` from inside the trusted network. The SQL runs in a transaction and refuses a nonempty journal. Then rerun the preflight and `pnpm db:migrate` on the backup first. Repeat on the intended target only after the rehearsal succeeds.

The committed `0005_premium_speed` snapshot includes `feedback` and `stories.uses_own_api_key`, but its SQL does not add them. Either object may already exist from a prior `drizzle-kit push`, so the preflight recognizes all four historical 0005 combinations. Migration `0006_loose_midnight` adds either missing object with `IF NOT EXISTS` before the remaining changes. Do not edit the committed 0005 SQL or add only its last journal row as a shortcut; Drizzle expects the complete migration prefix.

If the preflight reports orphan `active_story_id` values, inspect the affected conversations with `SELECT c.id, c.active_story_id FROM public.conversations c LEFT JOIN public.stories s ON s.id = c.active_story_id WHERE c.active_story_id IS NOT NULL AND s.id IS NULL;`. Restore a missing story when the draft still needs it, or clear the obsolete reference after reviewing the draft. Rerun the preflight before migrating.

Keep production schema updates in checked-in migrations. If `drizzle-kit push` is used on a development database, baseline that database before switching it to the migration workflow. See the [private Azure PostgreSQL setup](AZURE_POSTGRES.md) for networking, database roles, TLS, and backups.

## Manual Deployment

After completing [`INFRA_SETUP.md`](INFRA_SETUP.md), trigger the workflow:

```bash
gh workflow run deploy.yml --ref main
gh run list --workflow deploy.yml --limit 1
```

Watch the selected run with `gh run watch <run-id> --exit-status`.

## Runtime Commands

The image defaults to:

```bash
pnpm start
```

The event-driven ACA Job overrides the command with:

```bash
pnpm start:worker
```

The queue item identifies either a saved inbound message or a generation job. The worker processes one item and exits. It removes the queue message only after successful handling; Azure Queue redelivers transient failures.

The recovery Job runs the same worker command with `RECOVERY_MODE=1`. Its five-minute sweep looks for inbound receipts and generation jobs that were saved in PostgreSQL but not durably published or completed. This Job does not consume a queue item.

## Runtime Configuration

Follow [Azure infrastructure setup](INFRA_SETUP.md#configure-v2-runtime-before-the-first-release) and [private PostgreSQL setup](AZURE_POSTGRES.md) to set Container Apps secrets and environment variables **before** the first release. The public app needs the database, Auth.js secret, admin credentials, OpenAI, Twilio, Blob/Queue, and public URL settings. Google OAuth credentials are optional unless the browser testing studio is used; production studio use also needs a `STUDIO_TESTER_EMAILS` allowlist. Set `TWILIO_VERIFY_SERVICE_SID` to an SMS Verify service and `CONVERSATION_RELAY_WS_URL` to the secure `wss://` `/relay` URL for the first-launch Voice channel. Both runtime Jobs need the database, OpenAI, Twilio, Blob/Queue, media signing key, and `PUBLIC_BASE_URL`. The migration Job needs a separate migration-role database URL. The runtime setup configures `TWILIO_PHONE_NUMBER=+18669012028` and initial `DAILY_GENERATION_JOB_LIMIT=25` on the public app and both Jobs, while leaving `TWILIO_ENABLED_CHANNELS` empty so the prelaunch page has no contact actions. After that script finishes, set the low-cost pilot values: `DAILY_GENERATION_JOB_LIMIT=5` on all three runtime workloads, `MESSAGE_AGENT_GLOBAL_DAILY_LIMIT=50` on the generation Job, and `VOICE_VERIFY_NUMBER_DAILY_LIMIT=4` on the web app. See [the exact commands and read-only verification](INFRA_SETUP.md#configure-v2-runtime-before-the-first-release). WhatsApp is outside the first launch; its later release needs an approved `TWILIO_WHATSAPP_NUMBER` on all three workloads. The recovery Job also needs `RECOVERY_MODE=1`.

`TWILIO_ENABLED_CHANNELS` belongs on the **public Container App**. Keep it empty or unset during prelaunch; after approval and setup, set it to `sms,voice`. A valid number alone does not open a channel. The public homepage links to `/start`, where available channels appear in that order with their own contact actions and desktop QR codes. Voice stays hidden until its Verify service, Relay URL, and signing configuration are present. An empty or unset selection turns off all public start actions and inbound channel acceptance. Changing this setting updates the public page and webhook behavior with the new ACA revision; it does not change the sender's actual Twilio capabilities, approval, or webhook settings in Twilio Console. The same number needs outbound SMS capability to deliver comic results to Voice callers.

Set `APP_OPERATOR_NAME=Anthony Dellavecchia` and `APP_CONTACT_EMAIL=adellavecchia@twilio.com` on the public app. These are also the code defaults for `/privacy` and `/terms`; the operator must review and approve their content before the URLs are used for toll-free verification. Twilio's [privacy notice](https://www.twilio.com/en-us/legal/privacy) and [terms](https://www.twilio.com/en-us/legal/tos) are linked as provider policies, not substitutes for the app's policies. Public SMS and Voice actions display the message purpose, frequency, rates, HELP/STOP, and Voice-to-SMS disclosures near the action. Configure `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` on the public app for `/admin/login`; store the hash as an ACA secret and never deploy a plaintext admin password.

Admin login throttling trusts only the rightmost client IP that [Azure Container Apps HTTP ingress appends to `X-Forwarded-For`](https://learn.microsoft.com/en-us/azure/container-apps/ingress?tabs=bash). The app fails admin password sign-in closed in production without ACA ingress metadata. Keep the app behind ACA HTTP ingress; if another proxy or hosting path is introduced, validate its client-address forwarding before enabling admin sign-in there.

Store runtime `DATABASE_URL`, migration-role `DATABASE_URL`, `AUTH_SECRET`, `ADMIN_PASSWORD_HASH`, `OPENAI_API_KEY`, `TWILIO_AUTH_TOKEN`, and `MEDIA_SIGNING_SECRET` as ACA secrets with environment-variable references on their respective workloads. Store `AUTH_GOOGLE_SECRET` there too if you enable Google OAuth for `/studio`. If you use `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET` for reference-photo downloads, configure them as a pair on the generation Job. `AZURE_CLIENT_ID` is the workload's managed identity client ID; do not use a Storage connection string in ACA. GitHub's `production` environment holds only Azure OIDC identifiers; it does not need a database URL.

### Channel generation admissions

`DAILY_GENERATION_JOB_LIMIT` limits new app-funded comic requests across all users per **UTC calendar day**, shared by SMS, WhatsApp, Voice, and browser studio requests using the app's OpenAI key. The code default is 25; the launch value is 5, and `0` pauses these requests. A channel rejection records `generation.rejected` with reason `daily_generation_capacity`, leaves the user's confirmed draft available, and does not consume their weekly generation slot. A failed channel job and its queue retries count once on the original admission day. An admitted job may make up to three image-generation attempts. Studio requests still use their per-user quota, and caller-owned API keys do not use app-funded capacity. A saved comic counts toward the weekly quota even if Twilio suppresses its delivery; an unsaved failed job releases that weekly slot. `MESSAGE_AGENT_GLOBAL_DAILY_LIMIT=50` limits new SMS/WhatsApp model turns across all phones per rolling 24 hours, and `VOICE_VERIFY_NUMBER_DAILY_LIMIT=4` limits Verify SMS starts across the number per rolling 24 hours. These are admission controls rather than strict provider bill caps: ConversationRelay minutes, inbound messages, delivery texts, and image retries can still incur charges. Review the [cost estimate](AZURE_COSTS.md) and provider usage during launch.

## Health And Rollback

`GET /api/healthz` is dependency-free. It verifies that the process and Next.js request handler are available without creating failures during a PostgreSQL, Twilio, OpenAI, or Storage outage. `GET /api/readyz` checks required runtime configuration and the migrated Azure PostgreSQL tables. The release configures an Azure Container Apps HTTP readiness probe at `/api/readyz` before updating the web image, waits for the revision to become healthy, and only then opens ingress. The public smoke test requires both endpoints to pass.

To roll back, choose the digest and matching commit SHA from a previously successful release. Update the generation Job first, then the recovery Job, then the public app:

```bash
IMAGE="<acr>.azurecr.io/twilio-comics@sha256:<digest>"
RELEASE_SHA="<commit-sha>"
az containerapp job update --name <generation-job> --resource-group <group> --image "$IMAGE" --set-env-vars "RELEASE_SHA=$RELEASE_SHA"
az containerapp job update --name <recovery-job> --resource-group <group> --image "$IMAGE" --command pnpm --args start:worker --cron-expression '*/5 * * * *' --set-env-vars "RELEASE_SHA=$RELEASE_SHA" 'RECOVERY_MODE=1'
az containerapp update --name <app> --resource-group <group> --image "$IMAGE" --set-env-vars "RELEASE_SHA=$RELEASE_SHA" --termination-grace-period 240 --min-replicas 1 --max-replicas 2
```

Check `/api/healthz` after rollback and confirm its `release` field equals `RELEASE_SHA`.

Database changes must remain backward-compatible during rollback. Do not delete old columns in the same release that stops writing them.

## Twilio Verification

After deployment, confirm the [pilot runtime values](INFRA_SETUP.md#configure-v2-runtime-before-the-first-release) are `5` on all three workloads, `50` on the generation Job, and `4` on the web app. Check the public homepage and `/start` at desktop and phone widths. The homepage should show the Twilio bug in the header and favicon, the “Twilio Comics” name, the red/white/blue palette, a link to `/start`, and the footer credit to [Make Comics](https://github.com/Nutlope/make-comics). The homepage is the public invitation; `/studio` remains a browser test tool. For the first launch, verify exactly two actions and QR destinations for **+1 866 901 2028**: `sms:+18669012028` and `tel:+18669012028`. Confirm the SMS program disclosure and `/privacy` and `/terms` links sit beside the actions; confirm the provider Twilio policies are separately labeled in the footer. At desktop width, scan each QR code with a phone. In prelaunch, an empty channel selection or missing valid sender must show “opening soon” with no live contact action or QR code. The authenticated Twilio CLI reported toll-free status `TWILIO_APPROVED` on October 21, 2026; recheck it and complete the tests below before announcing live actions.

Then test each enabled channel:

1. When SMS is enabled, send an idea. Answer or revise the agent's follow-up, then send `CREATE`. Confirm the result has a story link and an image preview when available.
2. Call the number from an SMS-capable phone. Confirm Twilio Verify sends a six-digit text, enter it on the call keypad, then discuss an idea with ConversationRelay and say “create it.” Confirm the code is absent from the stored transcript and the result arrives by SMS/MMS at the caller number. Try an incorrect code and confirm Relay never starts. A verified number has a six-call rolling 24-hour limit.
3. Send `STATUS` while generation is pending. After delivery, send `CONTINUE`, describe the next page, and approve it. Confirm the result's 14-day conversation-resume wording. An inactive SMS, WhatsApp, or Voice draft resets after 14 days, once an active job completes, while prior messages and finished comics remain in admin history. Also verify `NEW` and `DISCARD` on an unsubmitted text draft; on a call, say “cancel” to discard it.
4. Confirm each approval queues one generation job and duplicate webhook delivery with the same `MessageSid` does not create another. Check that `/api/twilio/status` records the outbound `delivered`, `failed`, or `undelivered` result, and attempts a link-only fallback for a failed delivery. If preview creation fails before sending, the worker should still send a story link. A job more than 24 hours old must suppress its result/failure text while preserving its records; Twilio's per-message queue validity bounds an SMS waiting in Twilio's queue.
5. Confirm STOP and HELP behavior on the number in Twilio Console and with a test handset. Verify the support destination and all live disclosure and policy URLs. Add a WhatsApp end-to-end test only when that channel is approved and enabled later.
6. In a prelaunch test deployment, temporarily set `DAILY_GENERATION_JOB_LIMIT=0` on the V2 runtime workloads and confirm a new channel request receives the capacity response without queueing a job or using a weekly slot. Restore `5` on all three workloads afterward. Confirm an opted-out recipient's Twilio `21610` response suppresses further outbound replies while preserving the job and history; a later opted-in inbound message can proceed.

After those calls and messages, sign in at `/admin/login` with the configured username/password. Verify `/admin` shows SMS, answered and rate-limited Voice calls, comic, and delivery counters and daily trend, then search for the test phone in `/admin/users` and inspect the cursor-paginated timeline. Check that the timeline contains only finalized voice transcript text, not raw call audio. Deploy a later revision and confirm earlier records remain. The dashboard reads durable Azure PostgreSQL tables (`activity_events`, `voice_calls`, inbound messages, jobs, identities, and stories); an ACA image update does not reset them. There is no automatic expiry or delete-on-deploy step. Rehearse the [verified data deletion runbook](DATA_DELETION.md) for retained database records and Blob images; deleting only the user row does not remove all retained addresses or content.

Configure inbound SMS and Voice webhooks as HTTP POST URLs for the first launch; add WhatsApp's separate webhook only when that channel is enabled later. The optional Twilio retry fragment `#rc=3&rp=5xx,ct,rt` belongs on those **HTTP** URLs; it is omitted when validating signatures. The `/relay` URL must be `wss://` and have no retry fragment. `CONVERSATION_RELAY_WS_URL` must exactly match the URL embedded in TwiML and validated during the WebSocket upgrade. The app generates the signed Voice keypad check, action, and outbound delivery-status callback URLs; they are not separate phone-number webhooks.
