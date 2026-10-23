# Production administrator credentials

The [admin login](https://twilio-comics-v2.kindriver-a0456aa8.eastus2.azurecontainerapps.io/admin/login) uses a username in the V2 Azure Container App and a scrypt password hash from Key Vault. It cannot be changed inside the dashboard. The app reads only `admin-password-hash`; `admin-initial-password` is a recoverable plaintext copy for the operator and is never bound to the app.

## Rotate the username and password

Use a trusted local terminal with Azure CLI, `jq`, Python 3, and Node.js installed. Sign in to the approved Azure subscription and verify it:

```bash
az login
az account set --subscription 'b001fc6f-ea19-456a-8401-63971a1a1d98'
az account show --query id --output tsv
```

Create a password-manager entry for the new login first. The username may contain 3–64 letters, numbers, dots, underscores, or hyphens. Choose a **new** password of 16–1024 printable characters and store it in the password manager. From the repository root, run:

```bash
SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98' \
ROTATE_ADMIN_CONFIRM=yes \
bash scripts/rotate-admin-credentials.sh
```

Enter the new username when prompted and paste the new password twice at the hidden prompts. Do not put a password in a shell command, environment variable, chat, ticket, or Git commit. The script does not print it. It checks the production subscription and expected V2 bindings, verifies the current password/hash pair, creates owner-only temporary files, writes both new Key Vault versions with a 365-day expiry, changes only `ADMIN_USERNAME` in the Container App, restarts the latest revision, and checks `/api/readyz`. It removes its temporary files and any exact Key Vault firewall rule it added. It leaves an existing firewall rule in place.

If a VPN or proxy makes Key Vault reject the detected public IP, the script prints **only the denied client IPv4** from Azure's `ForbiddenByFirewall` error. Retry from the trusted terminal with that address:

```bash
OPERATOR_PUBLIC_IPV4='<denied IPv4 printed by the script>' \
SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98' \
ROTATE_ADMIN_CONFIRM=yes \
bash scripts/rotate-admin-credentials.sh
```

The Azure identity also needs permission to read and set these Key Vault secrets and to update the Container App and vault network rules. An authorized private network path may be used instead of opening a temporary public IP rule.

## Check the new login

Open the [admin login](https://twilio-comics-v2.kindriver-a0456aa8.eastus2.azurecontainerapps.io/admin/login) in a private browser window and sign in with the new password-manager entry. The script's readiness check confirms that the app is healthy, **not** that password sign-in has propagated. The Key Vault reference is versionless: [Container Apps can take up to 30 minutes to load a new version and restart active revisions](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets#key-vault-secret-uri-and-secret-rotation). If login initially rejects the new password, wait for propagation and retry without repeatedly triggering the 15-minute login rate limit. A change of password invalidates existing admin sessions once the new hash is in use.

If the script reports that it restored the previous credentials, use the **old** password-manager entry after propagation and investigate the failed Azure step before retrying. If it reports an **incomplete rollback**, stop changing credentials and repair the pair before another rotation. Key Vault keeps earlier versions; inspect their metadata without printing their values:

```bash
az keyvault secret list-versions --vault-name kv-twilio-comics-1a1d98 \
  --name admin-initial-password \
  --query '[].{id:id,updated:attributes.updated,enabled:attributes.enabled}' \
  --output table
az keyvault secret list-versions --vault-name kv-twilio-comics-1a1d98 \
  --name admin-password-hash \
  --query '[].{id:id,updated:attributes.updated,enabled:attributes.enabled}' \
  --output table
```

An operator with Key Vault secret access can download the matching prior versions into owner-only files, validate that the password matches its hash, then create new latest versions with `az keyvault secret set --file ... --expires ...` and restore the prior `ADMIN_USERNAME` with `az containerapp update --set-env-vars`. Do not use `--value` for plaintext credentials. Resolve an incomplete rollback as an incident because a new version can reach the app while the username or operator copy is out of sync. [Azure CLI supports file-based secret updates and version downloads](https://learn.microsoft.com/en-us/cli/azure/keyvault/secret).

Do not rerun `scripts/configure-runtime-secrets.sh` to rotate an existing admin login. That bootstrap script deliberately refuses changed admin credentials.
