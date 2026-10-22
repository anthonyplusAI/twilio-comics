# Azure PostgreSQL for Twilio Comics

Twilio Comics uses Azure Database for PostgreSQL Flexible Server for its app data, admin analytics, and retained conversation history. An Azure Container Apps revision does not own this data, so replacing an image or scaling a replica does not reset the history. The database, its backup policy, and explicit deletion process need to be managed independently.

## Current state and required network change

The initial `cae-twilio-comics` environment was provisioned with Azure's managed network and a placeholder public app. Its network cannot reach the private V2 database. The deployment workflow runs preflight and Drizzle migrations through a manual Container Apps Job inside the new private network. Inspect the V2 resources and role Job before assuming a production database or live migration exists.

Use the pattern already present in the local `twilio-ai-photo-booth` project: one custom VNet with a Container Apps infrastructure subnet delegated to `Microsoft.App/environments`, a **different** subnet delegated to `Microsoft.DBforPostgreSQL/flexibleServers`, and a PostgreSQL private DNS zone linked to the VNet. Create a new workload profile Container Apps environment on the ACA subnet, with external HTTPS ingress for Twilio webhooks and the public landing page. Create Flexible Server with private VNet access and public network access disabled. The web app, event Job, recovery Job, and a manual migration Job all belong in the new environment. Keep the existing placeholder until the new environment and app are verified, then cut over the public URL and Twilio webhooks deliberately.

Before choosing address ranges, check the subscription's existing VNets and reserve nonoverlapping space that accommodates simultaneous old and new ACA revisions. The Container Apps and PostgreSQL subnets have different delegations and cannot be shared. Use the Azure PostgreSQL server FQDN, not an IP address, and link its private DNS zone to the VNet. Test name resolution and port 5432 from a Job **inside** the new Container Apps environment.

The same pattern is documented by [Container Apps custom VNet setup](https://learn.microsoft.com/en-us/azure/container-apps/workload-profiles-manage-cli) and [PostgreSQL private access networking](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private). An existing managed network ACA environment is not a substitute for this private route.

## Database and credentials

1. Register `Microsoft.DBforPostgreSQL` and verify Flexible Server availability in `eastus2`. Create the server and a dedicated `twilio_comics` database. Set an explicit backup retention period and confirm point in time restore before accepting real users. Prefer private access at creation; this network mode cannot later be moved to another VNet or subnet.
2. Run the private role bootstrap below. It creates `comics_migrator` and `comics_runtime`. The migration role can create and change `public` tables and the `drizzle` schema. The runtime role can read and modify application rows and use sequences, but cannot create database or schema objects. The migration role sets default grants on tables and sequences it creates, so future Drizzle migrations remain usable by the runtime role. The bootstrap fails if imported `public` objects have another owner; review and repair the import before rerunning.
3. Store runtime and migration connection URLs as Key Vault secrets consumed through managed identities. The role bootstrap wires `DATABASE_URL=secretref:...` separately on the public app, generation Job, recovery Job, and manual migration Job. During role bootstrap, only the one-off private Job retrieves the administrator password from Key Vault. Do not put passwords in Git, GitHub variables, shell arguments, command output, or image layers.
4. Use a URL-encoded password and the server FQDN. Example shape: `postgresql://comics_runtime:<encoded-password>@<server>.postgres.database.azure.com/twilio_comics?sslmode=verify-full`. The app's `pg` Pool and read-only migration preflight enforce certificate verification for remote hosts. `drizzle-kit migrate` consumes `DATABASE_URL` directly, so retain `sslmode=verify-full` for that command as well.

The runtime Pool is bounded to four connections per app or Job process, has a five second connection timeout, and lets short lived Jobs exit when idle. Size the Flexible Server connection limit for the sum of active web replicas and Job executions, then monitor connection pressure.

### One-time role bootstrap and V2 workload wiring

Run `scripts/provision-private-platform.sh` first, then create the V2 web app and generation/recovery Job placeholders and identities with `scripts/provision-azure.sh` as described in [infrastructure setup](INFRA_SETUP.md). The bootstrap needs those V2 workloads to exist so it can bind their database references. It checks that the ACA environment uses the new private subnet, PostgreSQL has no public access, and Key Vault uses RBAC, purge protection, and a deny-by-default firewall.

Build the role bootstrap and migration images from the committed source. The build helper assembles minimal allowlisted contexts; local `.env` files and unrelated artifacts are not uploaded to ACR. It prints **digest-pinned** image references; copy its two `export` lines into the current shell:

```bash
export SUBSCRIPTION_ID='b001fc6f-ea19-456a-8401-63971a1a1d98'
bash scripts/build-azure-postgres-images.sh
# Copy the printed BOOTSTRAP_IMAGE and MIGRATION_IMAGE export lines here.
PROVISION_POSTGRES_ROLES_CONFIRM=yes bash scripts/provision-postgres-roles.sh
```

The one-off `twilio-comics-db-bootstrap-v2` Job runs `Dockerfile.bootstrap` in `cae-twilio-comics-v2`. Its user-assigned identity temporarily receives Key Vault Secrets Officer so it can fetch `postgres-bootstrap-password` and write two new URL secrets. `scripts/provision-postgres-roles.sh` revokes that vault role on exit, including a failed Job. If a process is forcibly killed, inspect and remove any residual Secrets Officer assignment for `id-twilio-comics-pg-bootstrap` before retrying. The role provisioning command does not connect from the operator's machine to private PostgreSQL or retrieve a database password.

The Job saves `postgres-comics-runtime-url` and `postgres-comics-migration-url` in `kv-twilio-comics-1a1d98`. Their passwords are generated inside the Job, URL encoded, and stored with `sslmode=verify-full`. The V2 web identity `id-twilio-comics-v2-web` and worker identity `id-twilio-comics-v2-worker` each receive Key Vault Secrets User only on the **runtime** URL secret. `id-twilio-comics-pg-migrate` receives that role only on the **migration** URL secret. The old V1 placeholder identities receive no database access. The provisioning script binds versionless Key Vault references and `DATABASE_URL` environment variables on the V2 web app, generation Job, recovery Job, and one-container manual migration Job. New Key Vault secret versions are picked up by ACA; review a password rotation and its application restarts as an operational change.

If a Key Vault secret reference fails immediately after creating an identity or role assignment, wait for Azure RBAC propagation and rerun the script. Existing URL secrets are reused; a rerun does not rotate their passwords. The bootstrap Job validates migration login and runtime DDL restrictions before publishing new URL secrets.

## Migration execution inside the VNet

The production `Dockerfile` contains the web and worker runtime. `Dockerfile.migrate` builds a separate image containing the checked-in migrations, read-only preflight, and Drizzle CLI. Give a manual Container Apps Job that image, the migration role's `DATABASE_URL`, and no public ingress. Its command runs the read-only preflight first and `pnpm db:migrate` only if preflight succeeds. The deployment workflow keeps serial production concurrency so two schema changes cannot run at once.

GitHub Actions authenticates to Azure using the existing OIDC identity, starts that Job, waits for a successful terminal execution, and **stops the deployment** if it fails. It does not run preflight or DDL on the GitHub hosted runner against a private database. Triggering a Job through the Azure management API does not require the runner to route to PostgreSQL. A self-hosted runner within the VNet is another possible migration path, but the manual ACA Job keeps the migration network path aligned with the app.

For a fresh empty database, all checked-in Drizzle migrations apply in order. If moving an existing database, run `node --import tsx scripts/check-migration-preflight.ts` from the migration Job first; its journal and schema assessment can block migration until a reviewed baseline or data repair is complete. `pnpm drizzle-kit push` is for a development database, not production schema rollout.

If a previous Neon database contains real stories or history, inventory it before switching URLs. Back it up, restore its data and schema into the new Azure database with a reviewed PostgreSQL migration procedure, and verify row counts, image references, and migration journal state. Do not run the initial migrations against restored app tables or point the public app at an empty replacement database. No source database credentials are available in this workspace, so this cutover has not been performed.

## Acceptance checks

- From the manual Job, resolve `<server>.postgres.database.azure.com` to a private address and connect with verify-full TLS. Confirm a deliberately incorrect server name or certificate fails to connect.
- Run migration preflight, then apply migrations on a fresh empty database. Re-run preflight and confirm zero pending migrations.
- Launch web, event Job, and recovery Job in the new environment and complete one SMS and one Conversation Relay comic. Confirm `/admin` shows their saved records. Roll an image revision and confirm the same records remain.
- Verify PostgreSQL backup and restore settings and rehearse the [user deletion procedure](DATA_DELETION.md). A deletion from the active database does not retroactively edit existing point in time backups; document their expiry and restore handling.

The private network environment, database roles and secrets, and configured migration Job are prerequisites before a production rollout. Keep `PRODUCTION_RELEASE_READY` unset until they and the Twilio sender are ready. Provisioning code alone does not establish a live production migration; verify the Azure Job execution and application readiness before enabling traffic.
