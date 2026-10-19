# Tidepool without R2

[![Deploy Tidepool without R2 to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tylerbutler/tidepool/tree/main/sqlite-only)

This template stores all document data in SQLite-backed Durable Objects.
It does not create or use an R2 bucket. Each document stores its own blobs
and trees; a separate Durable Object stores the document directory.
The logical document budget is 64 MiB, including content, commits, and operations.

Supply your own `JWT_SECRET` of at least 32 UTF-8 bytes. Generate one with
`openssl rand -hex 32`, keep a secure backup, and use the same key in your
trusted token issuer. Tidepool does not issue document tokens.
Use tenant `fluid` unless you change `TENANT_ID`.

The deploy button installs core only. Deploy the separate
[admin and token service](https://github.com/tylerbutler/tidepool/tree/main/token-service)
after core, and set its `TIDEPOOL` service target to your core Worker's name
(`tidepool-sqlite` by default). For token issuance, supply the same tenant
and signing key.

## Local setup

Use Node.js 24, pnpm 10, and Gleam 1.19.2 or later.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

The Linux x86_64 build can download and verify the pinned Gleam compiler
if none is installed. `pnpm build` bundles with Wrangler's dry-run mode;
it does not deploy or create cloud resources.

For local use, put `JWT_SECRET` in the ignored `.dev.vars` file and run
`pnpm dev`. Set `ALLOWED_ORIGIN` to your browser application's origin
when it differs from the Worker origin.

Cloud deployment needs approval and the intended Cloudflare account.
Check the deploy form's build command is `pnpm build` and its deploy command
is `pnpm run deploy`. After deployment, check `/health`, then verify
collaboration and summary reload with your client. The health endpoint
checks configuration, not persistence.

**Do not switch a populated deployment between SQLite-only and R2 storage.**
There is no content or directory migration. Keep the selected storage
configuration for retained documents.

See the [main README](https://github.com/tylerbutler/tidepool#readme)
for protocol support, limits, authentication, and deployment cautions.

## Maintaining this template

In the source Tidepool repository, edit the main source files, not their
copies here. Run `pnpm sync:sqlite-template` after source changes.
CI checks that the copies match and builds this directory in isolation.
The template's lockfile is maintained with pnpm in this directory.
