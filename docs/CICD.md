# CI/CD

## Validate Gate

`.github/workflows/ci.yml` runs on pull requests and as a reusable workflow called by `deploy.yml` on pushes to `main`. The deploy workflow waits for it before building a release image.

Parallel checks:

- ESLint and TypeScript
- Vitest unit tests
- Next.js production and Docker builds
- Dependency audit and Gitleaks secret scanning

The final job is named exactly `Validate`. Deployment cannot build or release an image unless this job succeeds.

CI uses Node.js 22 and pnpm 10.20.0, matching the production image.

## Dependency Updates

Dependabot checks npm and GitHub Actions weekly. Minor and patch updates are grouped. The auto-merge workflow approves and merges only non-major Dependabot updates after the `Validate` check succeeds.

Major updates always require manual review.

## Required Branch Settings

Protect `main` and require:

```text
Validate
```

Enable GitHub auto-merge and Dependabot security updates. Do not expose Azure or runtime secrets to the reusable CI workflow.

## Production Environment

Azure deployment credentials use GitHub OIDC. The `production` environment contains Azure identifiers and the database migration credential. Runtime service credentials are stored as Azure Container Apps secrets rather than embedded in the image.

## Migration Gate

After the image is built and before the public Container App or either Job is updated, deployment runs the read-only migration preflight described in [Deployment](DEPLOYMENT.md#database-migration-gate). It stops on an existing database without migration history, a changed historical migration hash, an incomplete journal, or schema drift. Only a passing preflight can run `pnpm db:migrate`.
