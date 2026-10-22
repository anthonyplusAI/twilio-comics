# Verified participant data deletion

Twilio Comics keeps SMS, Voice, comic, and usage history in PostgreSQL and images in Azure Blob Storage until an operator handles a verified deletion request. **`scripts/delete-subject-data.ts` is an inventory command only. It never deletes data.** This runbook covers one caller identified by an exact E.164 number, across SMS, Voice, and a possible future WhatsApp channel.

## Scope and prerequisites

The inventory counts channel identities, conversation drafts, inbound message receipts, calls, jobs, stories, pages, activity events, feedback, quotas, linked accounts and sessions, and matching verification tokens. It lists active Blob objects under this app's current owner paths: `uploads/<channel-user-id>/`, `references/twilio/<job-id>/`, `stories/<job-or-story-id>/`, and `<story-id>/`. It also preserves Twilio Message and Call SIDs for separate provider review. It does **not** inspect old or custom blob key layouts, Blob versions or soft-deleted objects, provider records, backups, logs, browser caches, or copies that a recipient saved.

1. Verify the requester's control of the **sender's** phone number or linked browser account through an approved support process. Record a private request ID and the verification method. Do not treat a number merely written in an email as proof of ownership. Phone numbers can change hands, so review whether the requester is entitled to the historical records before deleting every row tied to that number. If an identity is linked to another user or address, stop and review that relationship; the inventory flags it. This procedure does not cover deletion of a separate Google browser-studio account.
2. Schedule a maintenance window. Disable intake for SMS and Voice on the Twilio number, let active calls finish, pause the ACA queue and recovery Jobs, and confirm no execution is running. Keep them paused until the final checks finish. Twilio webhook retries and Azure Queue messages can otherwise race a deletion. Check the queue and poison queue for this subject's SIDs/job IDs; messages for deleted rows will no longer find those rows, but review any old payloads that contain personal data.
3. Confirm the exact Azure PostgreSQL database, Azure subscription, Storage account, and Blob container. Ensure the operator has PostgreSQL delete access and Azure Blob Data Contributor access. Take a restricted backup or recovery point according to your retention process, and record when that copy will expire or be purged. A backup holding the data prevents an immediate claim of complete erasure.

## 1. Make and review the read-only manifest

Run from the repository root with `DATABASE_URL`, `AZURE_STORAGE_BLOB_ENDPOINT`, and `AZURE_STORAGE_CONTAINER_NAME` set for the **same** environment. Locally, Azure's default credential can use an authorized Azure CLI login. A Storage connection string also works but should be handled as a secret.

```sh
umask 077
DELETION_SENDER='+15551234567' # replace with the verified caller's exact E.164 number
DELETION_MANIFEST="$(mktemp /private/tmp/twilio-comics-deletion.XXXXXX)"
node --import tsx scripts/delete-subject-data.ts --sender "$DELETION_SENDER" --json > "$DELETION_MANIFEST"
```

Exit code `0` means no active-work or ownership blocker was seen in this snapshot; it is **not** authorization to delete. Exit code `2` writes the manifest but reports blockers. Exit code `1` means the inventory itself failed, including a database or storage listing failure. Resolve every blocker and rerun after intake and workers are paused. Review the counts, exact Blob keys, `providerMessageSids`, `providerCallSids`, user ID, and story/job IDs. The manifest contains identifiers and belongs in restricted storage, never in Git or a shared ticket.

Search for legacy media URLs outside the listed prefixes in the subject's page, job, and draft records before proceeding. The current app writes media only to the owner paths above, but older deployments or manual uploads may have used other paths. If a matching Blob is outside them, add its **exact key** to the private deletion checklist after verifying ownership. Never delete a shared prefix or another user's Blob by pattern.

## 2. Confirm and remove active Blob objects

Have a second operator review the manifest when possible. Before any delete, type the exact confirmation phrase `DELETE <E.164 sender>` and compare it with the manifest's `sender`. Delete only the exact `blobKeys` from the reviewed manifest. The following shell example skips already absent keys so an interrupted run can resume. Set the account and container names to the reviewed environment, and do not run it until identity verification, maintenance, and manifest review are complete.

```bash
set -euo pipefail
DELETION_STORAGE_ACCOUNT='<reviewed-storage-account>'
DELETION_CONTAINER='<reviewed-container>'
DELETION_KEYS="$(mktemp /private/tmp/twilio-comics-blob-keys.XXXXXX)"
jq -e --arg sender "$DELETION_SENDER" \
  '.sender == $sender and .readOnly == true and .readyForManualDeletion == true and (.blockers | length) == 0' \
  "$DELETION_MANIFEST" >/dev/null
printf 'Type DELETE %s to continue: ' "$DELETION_SENDER"
IFS= read -r DELETION_CONFIRMATION
test "$DELETION_CONFIRMATION" = "DELETE $DELETION_SENDER" || exit 1
jq -r '.blobKeys[]' "$DELETION_MANIFEST" > "$DELETION_KEYS"
while IFS= read -r blobKey; do
  present="$(az storage blob exists --account-name "$DELETION_STORAGE_ACCOUNT" \
    --container-name "$DELETION_CONTAINER" --name "$blobKey" \
    --auth-mode login --query exists --output tsv)"
  if [ "$present" = 'true' ]; then
    az storage blob delete --account-name "$DELETION_STORAGE_ACCOUNT" \
      --container-name "$DELETION_CONTAINER" --name "$blobKey" \
      --delete-snapshots include --auth-mode login --output none
  fi
done < "$DELETION_KEYS"
```

Stop on any Azure error. Keep the original manifest and retry only its remaining keys after resolving the error. Deleting Blobs first leaves the database rows available to retry the inventory and PostgreSQL deletion; the affected comic links can be broken during this maintenance window. If Blob soft delete or versioning is enabled, deleting active objects can leave recoverable copies for the configured period. Review the account's [soft delete and version behavior](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview) and any backups separately before describing the data as fully erased.

## 3. Delete the app's PostgreSQL rows in one reviewed transaction

Save the SQL below as a **local, restricted file outside this repository**, review it against the deployed schema, then run it with `psql` using the sender, `userId`, and exact confirmation from the same manifest. The transaction locks the affected tables, checks ownership and active work again, deletes linked rows in dependency order, and rolls back on error. Keep the Twilio intake and ACA Jobs paused. If a lock times out, do not force it; find the active writer and restart the process from a new manifest.

```sh
DELETION_USER_ID='<userId copied exactly from the reviewed manifest>'
psql "$DATABASE_URL" \
  -v sender="$DELETION_SENDER" \
  -v user_id="$DELETION_USER_ID" \
  -v confirmation="$DELETION_CONFIRMATION" \
  -f '/private/tmp/twilio-comics-delete-subject.sql'
```

```sql
\set ON_ERROR_STOP on
SELECT set_config('twilio_comics.delete_sender', :'sender', false);
SELECT set_config('twilio_comics.delete_user_id', :'user_id', false);
SELECT set_config('twilio_comics.delete_confirmation', :'confirmation', false);
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
LOCK TABLE users, accounts, sessions, verification_tokens, channel_identities,
  conversations, twilio_inbound_messages, voice_calls, generation_jobs,
  stories, pages, activity_events, feedback, free_tier_quotas,
  free_tier_quota_claims IN ACCESS EXCLUSIVE MODE;

DO $guard$
DECLARE
  sender text := current_setting('twilio_comics.delete_sender');
  subject_id text := current_setting('twilio_comics.delete_user_id');
  whatsapp_address text := 'whatsapp:' || current_setting('twilio_comics.delete_sender');
BEGIN
  IF sender !~ '^\+[1-9][0-9]{6,14}$'
     OR subject_id !~ '^twilio_[0-9a-f]{32}$'
     OR current_setting('twilio_comics.delete_confirmation') <> 'DELETE ' || sender THEN
    RAISE EXCEPTION 'Exact sender, channel user ID, or confirmation is invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE id = subject_id
             AND (kind <> 'channel' OR email IS NOT NULL))
     OR EXISTS (SELECT 1 FROM accounts WHERE user_id = subject_id)
     OR EXISTS (SELECT 1 FROM sessions WHERE user_id = subject_id) THEN
    RAISE EXCEPTION 'Channel user has a linked account or session';
  END IF;
  IF EXISTS (SELECT 1 FROM channel_identities
             WHERE (normalized_address = sender OR user_id = subject_id)
               AND (user_id <> subject_id OR normalized_address <> sender
                 OR provider <> 'twilio'))
     OR EXISTS (SELECT 1 FROM users WHERE id = subject_id
                  AND NOT EXISTS (SELECT 1 FROM channel_identities
                    WHERE user_id = subject_id AND normalized_address = sender
                      AND provider = 'twilio')) THEN
    RAISE EXCEPTION 'Channel identity has mixed ownership';
  END IF;
  IF EXISTS (SELECT 1 FROM generation_jobs
             WHERE (user_id = subject_id OR recipient_address IN (sender, whatsapp_address))
               AND (user_id <> subject_id
                 OR recipient_address NOT IN (sender, whatsapp_address)
                 OR status NOT IN ('succeeded', 'failed', 'quota_rejected')
                 OR delivery_fallback_status IN ('sending', 'retry_pending'))) THEN
    RAISE EXCEPTION 'Generation job has mixed ownership or active work';
  END IF;
  IF EXISTS (SELECT 1 FROM generation_jobs AS job
             JOIN stories AS story ON story.id IN (job.story_id, job.target_story_id)
             WHERE (job.user_id = subject_id OR job.recipient_address IN (sender, whatsapp_address))
               AND story.user_id <> subject_id) THEN
    RAISE EXCEPTION 'Generation job references another user story';
  END IF;
  IF EXISTS (SELECT 1 FROM activity_events
             WHERE address IN (sender, whatsapp_address)
               AND user_id IS NOT NULL AND user_id <> subject_id)
     OR EXISTS (SELECT 1 FROM voice_calls
                  WHERE from_address = sender
                    AND user_id IS NOT NULL AND user_id <> subject_id) THEN
    RAISE EXCEPTION 'Address history is attributed to another user';
  END IF;
  IF EXISTS (SELECT 1 FROM twilio_inbound_messages
             WHERE from_address IN (sender, whatsapp_address) AND status <> 'completed')
     OR EXISTS (SELECT 1 FROM voice_calls
                WHERE (from_address = sender OR user_id = subject_id) AND ended_at IS NULL)
     OR EXISTS (SELECT 1 FROM conversations
                WHERE phone_number IN (sender, whatsapp_address)
                  AND (state = 'generating' OR lease_expires_at > NOW())) THEN
    RAISE EXCEPTION 'A message, call, or conversation is still active';
  END IF;
END
$guard$;

CREATE TEMP TABLE tc_delete_jobs ON COMMIT DROP AS
  SELECT id, quota_claim_key, delivery_sid, delivery_fallback_sid
  FROM generation_jobs
  WHERE user_id = current_setting('twilio_comics.delete_user_id')
     OR recipient_address IN (current_setting('twilio_comics.delete_sender'),
       'whatsapp:' || current_setting('twilio_comics.delete_sender'));
CREATE TEMP TABLE tc_delete_stories ON COMMIT DROP AS
  SELECT id FROM stories WHERE user_id = current_setting('twilio_comics.delete_user_id');
CREATE TEMP TABLE tc_delete_messages ON COMMIT DROP AS
  SELECT message_sid, outbound_sid FROM twilio_inbound_messages
  WHERE from_address IN (current_setting('twilio_comics.delete_sender'),
    'whatsapp:' || current_setting('twilio_comics.delete_sender'));
CREATE TEMP TABLE tc_delete_calls ON COMMIT DROP AS
  SELECT call_sid FROM voice_calls
  WHERE user_id = current_setting('twilio_comics.delete_user_id')
     OR from_address = current_setting('twilio_comics.delete_sender');

DELETE FROM activity_events AS event
WHERE event.user_id = current_setting('twilio_comics.delete_user_id')
   OR event.address IN (current_setting('twilio_comics.delete_sender'),
     'whatsapp:' || current_setting('twilio_comics.delete_sender'))
   OR event.job_id IN (SELECT id FROM tc_delete_jobs)
   OR event.story_id IN (SELECT id FROM tc_delete_stories)
   OR event.call_sid IN (SELECT call_sid FROM tc_delete_calls)
   OR event.message_sid IN (
     SELECT message_sid FROM tc_delete_messages
     UNION SELECT outbound_sid FROM tc_delete_messages WHERE outbound_sid IS NOT NULL
     UNION SELECT delivery_sid FROM tc_delete_jobs WHERE delivery_sid IS NOT NULL
     UNION SELECT delivery_fallback_sid FROM tc_delete_jobs WHERE delivery_fallback_sid IS NOT NULL
   );
DELETE FROM feedback WHERE user_id = current_setting('twilio_comics.delete_user_id');
DELETE FROM conversations WHERE phone_number IN (
  current_setting('twilio_comics.delete_sender'),
  'whatsapp:' || current_setting('twilio_comics.delete_sender'));
DELETE FROM twilio_inbound_messages WHERE message_sid IN (
  SELECT message_sid FROM tc_delete_messages);
DELETE FROM voice_calls WHERE call_sid IN (SELECT call_sid FROM tc_delete_calls);
DELETE FROM free_tier_quota_claims
WHERE subject IN (current_setting('twilio_comics.delete_user_id'),
    current_setting('twilio_comics.delete_sender'),
    'whatsapp:' || current_setting('twilio_comics.delete_sender'))
   OR claim_key IN (SELECT quota_claim_key FROM tc_delete_jobs);
DELETE FROM free_tier_quotas
WHERE subject IN (current_setting('twilio_comics.delete_user_id'),
  current_setting('twilio_comics.delete_sender'),
  'whatsapp:' || current_setting('twilio_comics.delete_sender'));
DELETE FROM generation_jobs WHERE id IN (SELECT id FROM tc_delete_jobs);
DELETE FROM pages WHERE story_id IN (SELECT id FROM tc_delete_stories);
DELETE FROM stories WHERE id IN (SELECT id FROM tc_delete_stories);
DELETE FROM verification_tokens WHERE identifier IN (
  current_setting('twilio_comics.delete_sender'),
  'whatsapp:' || current_setting('twilio_comics.delete_sender'));
DELETE FROM channel_identities
WHERE normalized_address = current_setting('twilio_comics.delete_sender')
   OR user_id = current_setting('twilio_comics.delete_user_id');
DELETE FROM users
WHERE id = current_setting('twilio_comics.delete_user_id') AND kind = 'channel';
COMMIT;
```

## 4. Verify and resume

With intake still paused, rerun the inventory and expect zero database counts and zero active Blobs. Also check **every exact Blob key and prefix in the original manifest**: after deleting jobs and stories, a fresh inventory cannot reconstruct those old IDs or discover a leftover orphan image. This command lists any remaining active objects under the original prefixes; an empty output is expected:

```sh
jq -r '.blobPrefixes[]' "$DELETION_MANIFEST" | while IFS= read -r prefix; do
  az storage blob list --account-name "$DELETION_STORAGE_ACCOUNT" \
    --container-name "$DELETION_CONTAINER" --prefix "$prefix" \
    --auth-mode login --query '[].name' --output tsv
done
```

Check the provider SIDs in the original manifest before discarding it. Record only the request ID, verification method, aggregate deleted counts, completion time, and outstanding provider or backup actions in the private support record. Restrict and eventually remove the local manifest, key list, and SQL file.

Twilio account records are a separate operation. The [Twilio Message resource](https://www.twilio.com/docs/messaging/api/message-resource) supports deleting Message records and associated media; the [Twilio Call resource](https://www.twilio.com/docs/voice/api/call-resource) supports deleting Call records but explicitly does not delete associated recordings or transcription records. Review those resources and any account retention policy using the saved SIDs. Likewise, provider backups and copies held by OpenAI or Azure need their own retention or deletion handling. The app now sends private, no-store headers for media; copies fetched under older deployments' one-year public cache header or saved by a recipient may still remain outside the app.

After confirming the database, active Blob keys, provider actions, and backup plan, restore the app's normal Twilio intake and ACA Jobs. If any step fails, keep intake paused and retry from the saved manifest or take a new read-only inventory. Do not claim completion while a blocker or unknown media location remains.
