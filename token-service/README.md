# Tidepool admin and token service

[![Deploy admin and token service to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tylerbutler/tidepool/tree/main/token-service)

Deploy this admin site and token issuer after you deploy
[core Tidepool](https://github.com/tylerbutler/tidepool#deploy-to-cloudflare).
This directory is a self-contained Worker template. It needs no Gleam compiler,
direct storage bindings, or files from the parent repository. The same Worker
serves `/admin`, its stylesheet, and `/tokens`.

## Connect core Tidepool

The admin uses a same-account service binding to core's `TidepoolConnector`.
Deploy core first. In `wrangler.jsonc`, set the `TIDEPOOL` binding's `service`
to your core Worker's name, normally `tidepool`. Keep the `TidepoolConnector`
entrypoint and the matching `TIDEPOOLS` entry. If the deployment form does not
let you choose this target, edit the copied repository's config and rebuild.
The button does not deploy another core Worker.

This service binding grants inspection of core's entire configured tenant,
not access to its signing key. To inspect more deployments, add their service
bindings and `TIDEPOOLS` entries as described in
[Connecting multiple Tidepools](https://github.com/tylerbutler/tidepool#connecting-multiple-tidepools).
No R2 or Durable Object bindings are needed in this template.

## Signing key and tenant

**Supply the exact `JWT_SECRET` used by core Tidepool**, not a document JWT.
Enter it in Cloudflare's deployment form, and use the same `TENANT_ID`
(normally `fluid`). The key must contain at least 32 UTF-8 bytes.
Tidepool does not generate or retrieve this key. Keep a secure backup.
Cloudflare does not return stored Worker secrets.

If the form does not ask for the key, add an encrypted runtime secret named
`JWT_SECRET` in the deployed Worker's **Settings > Variables and Secrets**.
From this directory, the CLI alternative is:

```sh
pnpm exec wrangler secret put JWT_SECRET --config wrangler.jsonc
```

A build-only variable is not a runtime secret. Leave `.dev.vars.example` empty
in Git. Never put the signing key in client code, logs, URLs, or Wrangler vars.

## Choose authentication

`TOKEN_AUTH_MODE` defaults to `access`. An empty or unknown value returns 503;
missing Access configuration does not enable anonymous issuance.

| Mode | Required setup |
| --- | --- |
| `access` | Protect the hostname with a Cloudflare Access application, set an explicit allowlist, and set `ACCESS_AUDIENCE` to its AUD tag |
| `anonymous` | Set `TOKEN_AUTH_MODE` explicitly to `anonymous` to make both token issuance and the admin public; `ACCESS_AUDIENCE` is not required |

For Access mode, the Worker requires Cloudflare's verified `ctx.access`
context. Forged Access headers cannot authenticate a caller. All admitted users
can inspect all configured connections and request tokens for any document in
the signing tenant.

**Anonymous mode is for disposable public demos. Anyone can obtain tokens to
create, read, edit, and summarize any document in the signing tenant. The admin
also exposes document IDs and metadata for every configured connection.**
There is no per-document allowlist or tenant-wide rate or cost guard.
Requests can incur Cloudflare charges. Do not use private documents or
credentials shared with a retained-data deployment, or connect private Tidepools.

An existing Access application can still block requests before they reach this
Worker. For an anonymous demo, use an unprotected hostname or remove the
applicable Access protection. `ALLOWED_ORIGIN` controls browser CORS, not
authentication: callers without an Origin header can still request tokens.
Anonymous user IDs are generated for each issuance; they are not stable accounts.

## Deploy and use

The button copies only this directory into a new repository. Use Node.js 24,
pnpm 10, build command `pnpm build`, and deploy command `pnpm run deploy`.
Set the core service target, tenant, authentication mode, audience when required,
and signing key.
The button does not deploy core Tidepool or create an Access application.
Cloudflare account setup and usage can incur charges.

For a CLI deployment from this directory:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
# After account selection and approval:
pnpm run deploy
pnpm exec wrangler secret put JWT_SECRET --config wrangler.jsonc
```

Set the intended variables in `wrangler.jsonc` before deployment. Its committed
default is Access mode, not anonymous mode. For local tests, copy
`.dev.vars.example` to `.dev.vars` and set your test key there.

Check `/health` after setup. A 200 response with `"tokenEndpoint": "/tokens"`
checks signing configuration, not Access login or connector connectivity.
After signing in when Access mode is enabled, open `/admin` and select a
document to check inspection. The admin is read-only and does not edit or
delete documents. To request a token:

```http
POST /tokens
Content-Type: application/json

{"documentId":"example"}
```

Use an empty document ID for a server-generated document creation token.
The body may contain only `documentId`, at most 256 UTF-8 bytes. The body limit
is 2 KiB. The response is `{ "jwt": "...", "expiresAt": 1234567890 }`, with a
Unix timestamp in seconds. Tokens expire after 15 minutes and grant
`doc:read`, `doc:write`, and `summary:write`. Responses use `Cache-Control:
no-store`.

For a browser app on another origin, add `ALLOWED_ORIGIN` with its exact origin.
In Access mode, configure Access to
[bypass OPTIONS preflights](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/).
See the main repository's
[token-provider example](https://github.com/tylerbutler/tidepool#token-service).

The live Cloudflare button form and blank-secret prompt remain unverified.
