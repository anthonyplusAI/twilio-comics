# Change the admin login

Sign in at [Twilio Comics Admin](https://twilio-comics-v2.kindriver-a0456aa8.eastus2.azurecontainerapps.io/admin/login), open **Settings**, and use **Change admin login**. Enter the current password, choose a new username, and enter the new password twice. Saving signs out the current session; sign in again with the new credentials.

The username must contain 3–64 letters, numbers, dots, underscores, or hyphens. The new password must be at least 16 characters and differ from the current one. Save the new login in a password manager. Never send a password through chat or put one in a Git commit. Routine changes require no Terminal command, Azure CLI login, or deployment.

The app checks the current password and limits failed attempts. It stores only a salted scrypt password hash in private Azure Database for PostgreSQL. The change invalidates existing admin sessions across app replicas and persists through deployments. If another admin changes the login at the same time, reload Settings and try again with the current credentials.

## Bootstrap and recovery

The initial login still comes from the Container App's `ADMIN_USERNAME` and Key Vault-backed `ADMIN_PASSWORD_HASH` until the first dashboard change. After that change, the PostgreSQL `admin_credentials` row is the login authority. The Key Vault `admin-initial-password` value is only a copy of the **initial** password and becomes stale. The old `scripts/rotate-admin-credentials.sh` changes the bootstrap values only; it cannot change an active database credential. Do not use it for routine rotation after this release.

## Lost username or password

An authorized Azure operator can reset both without knowing the old login. Use the checked-in recovery wrapper from a trusted macOS machine with the Azure CLI signed into the approved subscription. The `MIGRATION_IMAGE` must be the reviewed, digest-pinned **migration image that includes** `pnpm run db:admin-recover`:

```bash
SUBSCRIPTION_ID=b001fc6f-ea19-456a-8401-63971a1a1d98 \
MIGRATION_IMAGE='twiliocomicsacr1a1d98.azurecr.io/twilio-comics-migrate@sha256:<64-hex-digest>' \
ADMIN_RECOVERY_CONFIRM=REPLACE_ACTIVE_ADMIN_LOGIN \
bash scripts/run-admin-recovery.sh
```

The recovered username defaults to `comics-admin`. Set `ADMIN_RECOVERY_USERNAME` in that command to choose another username (3–64 ASCII letters, numbers, dots, underscores, or hyphens). The wrapper confirms the exact Azure subscription and private migration Job, starts a one-off execution, and copies the new password to the macOS clipboard. Paste it directly into a password manager, then sign in at `/admin/login` in a private browser window. The password is not printed in the terminal or sent through chat. Clear the clipboard after saving it. Once signed in, **Settings → Change admin login** can rotate to another username and password normally.

The wrapper generates an RSA key pair locally and passes only the public key to the private Job. The Job creates a random 48-character password, hashes it with the app's salted scrypt scheme, and atomically inserts or updates **only** `admin_credentials.id = 1`. The recovery program emits one JSON result line with the username, `RSA-OAEP-SHA256` algorithm, and base64 ciphertext; it never logs the plaintext password or hash. The private key stays on the operator machine; the wrapper decrypts the envelope there and removes its temporary files after the password reaches the clipboard. `DATABASE_URL` remains the migration Job's Key Vault-backed secret reference. The one-off execution does not change the Job's saved migration command or environment.

If Azure starts the Job but its encrypted result is delayed or cannot be read, the wrapper retains the owner-only key directory and prints its path. **Do not start another reset.** Rerun the same command with `ADMIN_RECOVERY_RESUME_DIR` set to that path; the wrapper checks the original execution and retries retrieval without starting another Job. If Azure did not return an execution name, first inspect that Job's execution history and set `ADMIN_RECOVERY_EXECUTION_NAME` to the matching name. Keep the retained directory private until retrieval succeeds. The wrapper removes it after copying the password.

**Never delete `admin_credentials.id = 1`:** deletion would reactivate the older bootstrap login. The Key Vault `admin-initial-password` may be stale and is not a recovery password after a dashboard change. The recovery replaces the active login in PostgreSQL, invalidates existing admin sessions, and persists across deployments. Revisions from before the database credential feature ignore the override, so do not roll back to one after changing or recovering the login.
