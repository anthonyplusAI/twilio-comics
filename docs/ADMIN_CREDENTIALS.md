# Change the admin login

Sign in at [Twilio Comics Admin](https://twilio-comics-v2.kindriver-a0456aa8.eastus2.azurecontainerapps.io/admin/login), open **Settings**, and use **Change admin login**. Enter the current password, choose a new username, and enter the new password twice. Saving signs out the current session; sign in again with the new credentials.

The username must contain 3–64 letters, numbers, dots, underscores, or hyphens. The new password must be at least 16 characters and differ from the current one. Save the new login in a password manager. Never send a password through chat or put one in a Git commit. Routine changes require no Terminal command, Azure CLI login, or deployment.

The app checks the current password and limits failed attempts. It stores only a salted scrypt password hash in private Azure Database for PostgreSQL. The change invalidates existing admin sessions across app replicas and persists through deployments. If another admin changes the login at the same time, reload Settings and try again with the current credentials.

## Bootstrap and recovery

The initial login still comes from the Container App's `ADMIN_USERNAME` and Key Vault-backed `ADMIN_PASSWORD_HASH` until the first dashboard change. After that change, the PostgreSQL `admin_credentials` row is the login authority. The Key Vault `admin-initial-password` value is only a copy of the **initial** password and becomes stale. The old `scripts/rotate-admin-credentials.sh` changes the bootstrap values only; it cannot change an active database credential. Do not use it for routine rotation after this release.

If you lose the current password, a platform operator with authorized private PostgreSQL access must perform a controlled recovery by replacing the `admin_credentials` row with a new username and scrypt hash. Do not delete that row: deletion would reactivate the older bootstrap login. Revisions from before the database credential feature also ignore the override, so do not roll back to one after changing the login in Settings. Verify a recovered login in a private browser window.
