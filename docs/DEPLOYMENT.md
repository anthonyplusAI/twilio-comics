# Deployment

The production deployment uses one image for three Azure Container Apps workloads:

- `twilio-comics`: public Next.js, Twilio HTTP webhooks, and ConversationRelay WebSocket server.
- `twilio-comics-generation`: private event-driven Queue Job for inbound text turns and comic generation using `pnpm start:worker`.
- `twilio-comics-recovery`: private scheduled Job using `RECOVERY_MODE=1 pnpm start:worker` to republish stale work every five minutes.

## Release Flow

Every push to `main` runs `.github/workflows/deploy.yml`:

1. Reuse `.github/workflows/ci.yml` and require `Validate` to pass.
2. Authenticate to Azure through GitHub OIDC.
3. Build the Docker image, push a full commit-SHA tag to ACR, and pin the pushed manifest by its immutable `sha256` digest.
4. Check PostgreSQL migration history and schema without changing the database.
5. Apply the reviewed, checked-in Drizzle migrations to PostgreSQL.
6. Update the generation Job, scheduled recovery Job, then the public Container App to that same image digest.
7. Poll `/api/healthz` until it reports the deployed commit SHA.

Deployments are serialized with `cancel-in-progress: false`; a production rollout is never cancelled midway.

## Database Migration Gate

The deploy workflow runs `scripts/check-migration-preflight.ts` before `pnpm db:migrate`. The check only reads PostgreSQL catalog tables, `drizzle.__drizzle_migrations`, duplicate `(story_id, page_number)` groups in `public.pages`, and a count of `conversations.active_story_id` values whose stories are missing. It requires a complete prefix of the checked-in migration journal with matching timestamps and SQL hashes, then compares the public tables, column types and nullability, and named constraints and indexes with the last applied migration. It blocks migration `0006` until duplicate page numbers and orphan story references are reviewed and corrected, because its unique index and foreign key would fail. It allows an empty database to receive the initial migration.

An existing database created with `drizzle-kit push` usually has app tables but no migration journal. The preflight blocks deployment in this state. Without that gate, Drizzle could try to replay `0000` against the existing `stories` table. A mismatch between the journal and the checked-in SQL, or an unexpected schema change, also blocks deployment before any workload is updated.

To establish a reviewed baseline for an existing Neon database:

1. Create a Neon branch or backup of the target database and use a maintenance window. Set `DATABASE_URL` to the exact target you intend to baseline.
2. Run `node --import tsx scripts/check-migration-preflight.ts`. It will fail safely on an unbaselined database and report an eligible migration tag if the live table, column, constraint-name, and index-name shape matches a checked-in migration at `0005` or later. Baseline SQL is unavailable for `0000`–`0004`, because later migrations need data review before they can safely run on a populated database. If it reports no eligible match, duplicate page numbers, or conversations referencing deleted stories, review the data and reconcile it manually before continuing.
3. Generate a **SQL file for review**, substituting the reported tag: `node --import tsx scripts/check-migration-preflight.ts --baseline-sql=<tag> > /tmp/twilio-comics-baseline.sql`. This command reads the database but does not execute the SQL. Inspect the full schema, index and constraint definitions, data, and the generated hashes and timestamps. The baseline records historical migrations as already applied; it does not create their app tables or columns.
4. After review, run the SQL in the Neon SQL editor or with `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /tmp/twilio-comics-baseline.sql`. The SQL runs in a transaction and refuses a nonempty journal. Then rerun the preflight and `pnpm db:migrate` on the branch or backup first. Repeat on the intended target only after the rehearsal succeeds.

The committed `0005_premium_speed` snapshot includes `feedback` and `stories.uses_own_api_key`, but its SQL does not add them. Either object may already exist from a prior `drizzle-kit push`, so the preflight recognizes all four historical 0005 combinations. Migration `0006_loose_midnight` adds either missing object with `IF NOT EXISTS` before the remaining changes. Do not edit the committed 0005 SQL or add only its last journal row as a shortcut; Drizzle expects the complete migration prefix.

If the preflight reports orphan `active_story_id` values, inspect the affected conversations with `SELECT c.id, c.active_story_id FROM public.conversations c LEFT JOIN public.stories s ON s.id = c.active_story_id WHERE c.active_story_id IS NOT NULL AND s.id IS NULL;`. Restore a missing story when the draft still needs it, or clear the obsolete reference after reviewing the draft. Rerun the preflight before migrating.

Keep production schema updates in checked-in migrations. If `drizzle-kit push` is used on a development database, baseline that database before switching it to the migration workflow.

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

Follow [Azure infrastructure setup](INFRA_SETUP.md#configure-aca-runtime-before-the-first-release) to set Container Apps secrets and environment variables **before** the first release. The public app needs the database, Google/Auth.js, OpenAI, Twilio, Blob/Queue, and public URL settings. Set `CONVERSATION_RELAY_WS_URL` to the secure `wss://` `/relay` URL **only when Voice is enabled**; the public server requires it for that channel. Both Jobs need the database, OpenAI, Twilio, Blob/Queue, media signing key, and `PUBLIC_BASE_URL`. A prelaunch release can leave both sender numbers unset; the public page then shows no contact actions. Set `TWILIO_PHONE_NUMBER` on the public app and both Jobs for selected SMS or Voice use. Set the approved `TWILIO_WHATSAPP_NUMBER` on all three workloads for WhatsApp; it can be the only enabled start channel. The recovery Job also needs `RECOVERY_MODE=1`.

`TWILIO_ENABLED_CHANNELS` belongs on the **public Container App**. Leave it unset to infer SMS and Voice from a valid `TWILIO_PHONE_NUMBER` and WhatsApp from a valid `TWILIO_WHATSAPP_NUMBER`. Set it to an ordered comma-separated subset of `sms,whatsapp,voice` to advertise and accept only those channels when their destinations are valid. The first available listed channel supplies the primary homepage action and QR code. An explicitly empty value turns off all public start actions and inbound channel acceptance. Changing this setting updates the public page and webhook behavior with the new ACA revision; it does not change the sender's actual Twilio capabilities or webhook settings in Twilio Console. Even if `voice` is the only advertised channel, `TWILIO_PHONE_NUMBER` needs outbound SMS capability to deliver comic results.

For an SMS-only launch, set `TWILIO_ENABLED_CHANNELS=sms` **before** adding `TWILIO_PHONE_NUMBER`. An unset channel list infers Voice from that number too, so the production server would require `CONVERSATION_RELAY_WS_URL`.

Store `DATABASE_URL`, `AUTH_SECRET`, `AUTH_GOOGLE_SECRET`, `OPENAI_API_KEY`, `TWILIO_AUTH_TOKEN`, and `MEDIA_SIGNING_SECRET` as ACA secrets with environment-variable references. If you use `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET` for reference-photo downloads, configure them as a pair on the generation Job. `AZURE_CLIENT_ID` is the workload's managed identity client ID; do not use a Storage connection string in ACA. GitHub's separate `production` environment holds the Azure OIDC identifiers and the database migration URL.

## Health And Rollback

`GET /api/healthz` is dependency-free. It verifies that the process and Next.js request handler are available without creating failures during a Neon, Twilio, OpenAI, or Storage outage.

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

After deployment, check the public homepage at desktop and phone widths. It should show the Twilio bug in the header and favicon, the “Twilio Comics” name, the red/white/blue palette, and the footer credit to [Make Comics](https://github.com/Nutlope/make-comics). The page is the public invitation; `/studio` remains a browser test tool. Verify that only configured, enabled channels appear and each has the right instructions. The first available channel in the selected or inferred order should supply the primary action and QR target: `sms:` for SMS, `https://wa.me/` for WhatsApp, or `tel:` for Voice. Scan the QR code with a phone to check its destination. In staging, also check that an empty channel selection or missing valid sender shows “opening soon” with no live action or QR code.

Then test each enabled channel:

1. When SMS is enabled, send an idea. Answer or revise the agent's follow-up, then send `CREATE`. Confirm the result has a story link and an image preview when available.
2. When WhatsApp is enabled, repeat through the approved sender, including a photo-only message if reference images are enabled.
3. When Voice is enabled, call the number, discuss an idea with ConversationRelay, and say “create it.” Confirm the result arrives by SMS/MMS after the call.
4. Send `STATUS` while generation is pending. After delivery, send `CONTINUE`, describe the next page, and approve it. Also verify `NEW` and `DISCARD` on an unsubmitted text draft; on a call, say “cancel” to discard it.
5. Confirm each approval queues one generation job and duplicate webhook delivery with the same `MessageSid` does not create another. Check that `/api/twilio/status` records the outbound `delivered`, `failed`, or `undelivered` result, and attempts a link-only fallback for a failed delivery. If preview creation fails before sending, the worker should still send a story link.

Configure inbound SMS, WhatsApp, and Voice webhooks as HTTP POST URLs. The optional Twilio retry fragment `#rc=3&rp=5xx,ct,rt` belongs on those **HTTP** URLs; it is omitted when validating signatures. The `/relay` URL must be `wss://` and have no retry fragment. `CONVERSATION_RELAY_WS_URL` must exactly match the URL embedded in TwiML and validated during the WebSocket upgrade. The app generates the signed Voice action and outbound delivery-status callback URLs; they are not separate phone-number webhooks.
