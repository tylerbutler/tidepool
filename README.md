# Tidepool

Tidepool is an experimental Fluid Framework server for Cloudflare Workers,
SQLite-backed Durable Objects, and R2. It supports the unmodified official
Routerlicious driver, one configured tenant, and multiple documents.

The server does not interpret DDS contents. The client's Fluid runtime handles
SharedMap, SharedTree, SharedString, and other DDS logic. The current container
acceptance test verifies SharedMap; it is not a DDS allowlist. Other DDSes and
their required runtime features still need compatibility tests.

Tidepool began as the Cloudflare prototype in
[Floodgate](https://github.com/tylerbutler/floodgate). This repository includes
its own build, test helpers, and official-client acceptance tests. You do not
need a Floodgate checkout or its client packages.

The test suite runs in local workerd. Tests cover SharedMap collaboration,
an updated summary and delta-tail reload, actual local object hibernation,
reset/reconnect, and storage failures. No cloud resources or deployment are
part of these tests. Cloud load limits, placement, and billing remain unverified.

## Architecture

```text
Official Routerlicious driver
    |
Worker: JWT, origin checks, REST and WebSocket routing
    |
DocumentDO: one object for JSON.stringify([tenant, document])
    |-- Gleam/JavaScript: validation, sequencing, messages, signals, framing
    |-- SQLite: operations, sequence checkpoint, clients, commits, refs, budget
    |-- Hibernatable WebSockets and heartbeat alarms
    |
    +-- R2: immutable tenant-shared blobs and trees
```

The TypeScript adapters handle Workers APIs, Web Crypto authentication, and
storage. Gleam calls Spillway for protocol decisions. The independent Gleam
manifest fixes Spillway to published revision
`49549eb65f67460d10d3bad2f8a35c3d3aafb050`. No dependency patches or forks
are necessary. The assertion harness runs on JavaScript and Erlang; the Worker
tests also execute the generated JavaScript inside workerd.

The DO commits operation sequence numbers, client sequence/reference state,
and the operation together. It sends acknowledgements and broadcasts after the
SQLite transaction. R2 uploads precede summary publication. One SQLite
transaction publishes the document-owned head and its sequenced summary ack.
A failed publication can leave staged immutable content, but cannot publish
an ack or head without the corresponding durable operations.

The DO restores client records and the sequence checkpoint from SQLite. It
does not replay the operation log on each wake. Hibernation keeps existing
writer memberships; connection loss and reset require catch-up/reconnection.
Heartbeat scheduling reads client records at most once per pass, rather than
once per authenticated socket. It reads no client records when no authenticated
sockets remain open.

Each document stores its initial protocol checkpoint. Summary preparation
replays proposals and minimum-sequence advances from that checkpoint through
the summary reference. The snapshot includes pending proposals and agreed
quorum settings at that reference; later approvals remain in the delta tail.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tylerbutler/tidepool)

Use this guided setup to deploy core Tidepool in your Cloudflare account.
Cloudflare copies this public repository to your Git account, then provisions
the Worker's R2 bucket and SQLite-backed Durable Objects. The button does not
install the admin/token Worker or configure Cloudflare Access.

**You must supply `JWT_SECRET`.** Generate your own signing key and enter it
in Cloudflare's deployment form. Tidepool does not generate this key. Use at
least 32 UTF-8 bytes, keep a secure backup, and give the same key to the trusted
backend that issues your document JWTs. Keep it out of browser code, Git, URLs,
and build logs.

1. Open the button and sign in to Cloudflare and your Git provider.
   You may need to enable R2 and complete account billing setup. Cloudflare
   usage can incur charges.
2. Choose repository, Worker, and storage names. Use unused resource names
   when creating a separate installation.
3. Generate a key outside Tidepool with `openssl rand -hex 32`, then enter it
   as `JWT_SECRET` in the setup form. The committed `.dev.vars.example`
   declares this input with an empty value; it contains no usable key.
4. Check the build and deploy commands. Use `pnpm build` and
   `pnpm run deploy`. The build helper downloads and verifies a pinned Gleam
   compiler if the Linux x86_64 build environment has none. The build also
   checks both optional admin/token configurations, but the deploy command
   deploys core only.
5. Open `https://<your-worker-host>/health` after deployment. A 200 response
   checks configuration; it does not verify collaboration or persistence.

**If the setup form does not ask for `JWT_SECRET`, set it yourself before
using Tidepool.** In the deployed Worker's dashboard, use **Settings >
Variables and Secrets** to add an encrypted runtime secret named `JWT_SECRET`.
From the cloned repository, you can instead run:

```sh
pnpm exec wrangler secret put JWT_SECRET --config wrangler.jsonc
```

A build-only environment variable does not configure this runtime secret.
Leave the example value empty in Git. If you deploy through the CLI rather
than the button, run `pnpm build` before `pnpm run deploy` and follow the
[manual deployment instructions](#cloud-deployment-only-after-approval).

Use tenant `fluid` unless you changed `TENANT_ID` during setup. For browser
clients on another origin, set `ALLOWED_ORIGIN` to the application origin as
described in [Local setup](#local-setup). Core Tidepool has no JWT issuer:
use trusted application code or install the separate
[token service](#token-service). The optional [admin site](#admin-site) also
requires its own deployment, with Access by default or explicit anonymous mode.

The button flow and its blank-secret prompt remain unverified in the live
Cloudflare dashboard. See Cloudflare's [deploy-button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
for account setup and supported resource provisioning.

## Local setup

Install Node.js 24, pnpm, and Gleam 1.19.2 or later. Erlang/OTP is necessary
only for the optional Erlang comparison. From the Tidepool repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm check
pnpm test
```

`pnpm test` runs the Gleam assertions, builds a Worker with Wrangler's dry-run
mode, runs platform/storage tests, then runs the official Fluid container test.
The tests use the published Fluid packages and start local workerd themselves.
No external server or opt-in environment variable is necessary. An explicit
acceptance run fails if its bundle/runtime is missing.

To start a local server, create the ignored secret file at the repository root:

```sh
umask 077
printf 'JWT_SECRET="%s"\n' "$(openssl rand -hex 32)" > .dev.vars
# Add ALLOWED_ORIGIN="http://localhost:5173" for that browser app, if needed.
pnpm dev
```

Wrangler listens on `http://127.0.0.1:8787` and keeps local state under
`.wrangler/state/`. `GET /health` checks configuration. Use
`TENANT_ID=fluid`, and sign HS256 tokens with the same secret. Tokens need
`tenantId`, `documentId`, `user.id`, `scopes`, `iat`, and `exp`. Use an empty
`documentId` for server-generated document creation. Only trusted application
code should hold the signing key. The document Worker has no token endpoint;
the optional [token Worker](#token-service) runs separately, with Access by
default or anonymous issuance for disposable public demos.

Set the client's orderer, delta stream, and storage origins to the Worker.
The [test client](test/client.ts) shows the complete official Loader and
Routerlicious configuration. This is a test helper, not a client SDK. The
verified Routerlicious policies use RestLess, disable whole-summary upload,
and disable polling downgrade. Both raw-JWT orderer Basic authentication and
base64 `tenant:JWT` storage Basic authentication work; Bearer also works.

Wrangler runs with local bindings by default. Do not use `--remote` for local
tests. To reset local documents, stop Wrangler and remove only this app's
`.wrangler/state/` directory in this repository. Keep that directory to preserve them.

Older persisted documents without the initial protocol checkpoint return
HTTP 409 and require recreation. There is no state migration or automatic
deletion. Any local reset must be an explicit action; do not reset cloud data
as part of an upgrade.

## Commands

Run these from the repository root:

| Command | Purpose |
| --- | --- |
| `pnpm build` | Gleam JavaScript build and dry-run core and both admin/token configurations |
| `pnpm build:protocol` | Compile protocol; bootstrap pinned Gleam if absent on Linux x86_64 |
| `pnpm build:admin` | Admin/token Worker dry-run bundle, without Gleam or R2 |
| `pnpm build:tokens` | Standalone admin/token Worker dry-run bundle, without Gleam or direct storage bindings |
| `pnpm run deploy` | Deploy core only; requires approval, cloud credentials, and a prior build |
| `pnpm typecheck` | Strict TypeScript boundary check |
| `pnpm check` / `pnpm format` | Biome and Gleam formatting |
| `pnpm test:protocol` | Assert protocol behavior on JavaScript |
| `pnpm test:workers` | Build and run local platform/storage tests |
| `pnpm test:acceptance` | Official SharedMap summary/reload test |
| `pnpm measure:local` | Print a bounded loopback workload measurement |
| `pnpm dev` | Persistent local Worker |

`cd protocol && gleam run --target erlang` runs the same protocol assertion
harness on Erlang. The CI workflow installs this package and runs the local
checks without cloud credentials. A separate Linux job builds from a fresh
checkout without Gleam, checks the downloaded-compiler path, and dry-run bundles
the core deploy command. Neither job deploys the Worker.

## Limits and failure behavior

| Limit | Value |
| --- | --- |
| Inbound WebSocket frame | 1 MiB of UTF-8 text |
| Stored encoded operation | 1 MiB, including sequenced metadata |
| HTTP request body | 16 MiB, enforced during streaming reads |
| Version-list aggregate reads / encoded response | 16 MiB each |
| Logical document budget | 64 MiB for operations, commits, and reserved R2 content |
| Cleanup reserve | 1 MiB of that budget, unavailable to new content/normal operations |
| Connections per document | 128, including unauthenticated sockets |
| Client metadata | 8 KiB |
| Messages per socket | 1,000 per second |
| Delta response | Complete requested sequence range, streamed; at most 64 MiB |
| Initial socket history | Up to 1,000 operations and 0.5 MiB |
| Refs per document | 32 |
| Admission deadline | 20 seconds |
| Server ping / pong deadline | 10 seconds / 20 seconds |

The encoded operation limit leaves less than 1 MiB for application contents.
The upload limit includes the transport body, including RestLess encoding.
Tree traversal and aggregate response reads also have bounds. Delta reads use
exclusive `from` and `to` sequence bounds. The service streams the complete
requested range at the request's checkpoint; it does not return short pages
that the official driver could mistake for the end of history. The driver can
continue its sequence-based pagination. The service retains the complete log.
Version lists count commit reads, including the search for an older version,
and requested snapshot reads against one shared read limit. The separate
response limit includes UTF-8 encoding, array punctuation, and generated URLs.
Either overflow returns HTTP 413 without a partial version list.

The budget counts encoded payload bytes, not SQLite page/index overhead.
The duplicate-retry index adds physical SQLite storage and an index write for
each appended operation; the logical budget does not include that overhead.
Each document reserves its reachable R2 content even when another document
already uploaded it. Retries of the same immutable key do not add another
charge. A failed R2 write keeps its reservation, so a retry can use it; abandoned
uploads and staged commits still consume budget. Conflicting encoded sizes for
the same reservation return an error. There is no garbage collector.

With a document token that includes `doc:read`,
`GET /documents/:tenant/:document` returns document identity, sequence number,
and logical capacity. For an empty document:

```json
{
  "id": "example",
  "tenantId": "fluid",
  "sequenceNumber": 0,
  "storage": {
    "usedBytes": 0,
    "budgetBytes": 67108864,
    "cleanupReserveBytes": 1048576,
    "remainingWriteBytes": 66060288
  }
}
```

`usedBytes` includes encoded operations, commits, and reserved R2 content.
`remainingWriteBytes` is
`max(0, budgetBytes - cleanupReserveBytes - usedBytes)`. Cleanup can consume the
reserve after normal writes reach their limit; remaining write capacity stays
at zero. These values do not measure physical SQLite or R2 allocation. A positive
remaining value does not guarantee that an operation or summary will fit: encoded
metadata, related content, and the other limits still apply.

Oversize input returns HTTP 413, a nack, or close code 1009, as applicable.
Budget exhaustion returns 507 or a nack. Storage failures return 503 or a nack.
Failed transactions do not advance the durable sequence or client CSN. Slow or
failed peer sends close the socket for reconnect/catch-up. The service closes
expired tokens and peers that miss the pong deadline.

Temporary storage/runtime failures include a one-second retry hint in the
fields expected by the official driver. HTTP responses also include
`Retry-After: 1`. Authorization, input, configuration, and hard-limit errors
do not receive these temporary-error hints.

Origins must match `ALLOWED_ORIGIN`, or the request origin when that binding
is absent. Requests without an Origin header still require document tokens.
Query parameters route socket upgrades; the DO verifies identity and scopes
when `connect_document` arrives. Anonymous upgrades cannot create a document
or join its membership.

Member `user` and `scopes` come from the verified token; member `mode` comes
from admission. Client metadata cannot override these fields. The 8 KiB
metadata limit applies after the server replaces them.

## Local evidence and remaining risk

The platform tests exercise actual Miniflare object eviction with
`webSockets: "hibernate"` and `"close"`. They check membership continuity,
durable CSNs, duplicate retries, contiguous operations after reset, authorization,
exact size/budget boundaries, and heartbeat cleanup. SQL triggers inject
operation/publication failures through Miniflare's test-only inspection API.
There is no production reset, fault, or debug endpoint.

The official container acceptance connects two clients to one SharedMap
container, requests a real updated Fluid summary, checks its accepted commit
and nonzero checkpoint, adds later edits, and loads a third container. It checks
that the snapshot includes the early edits and that bootstrap starts at that
checkpoint with a nonempty delta tail. It then restarts the local runtime
against the same SQLite/R2 directories and checks the accepted commit and
SharedMap state again. An agreed quorum setting must also survive summary
loading and the runtime restart.

One local macOS loopback run with two writers and 50 sequential 128-byte payloads
reported p50 fan-out latency of 1.33 ms and p95 of 1.72 ms. The first operation
after local hibernation took 3.14 ms. The 50 operations plus two joins occupied
18,272 logical bytes. `pnpm measure:local` reproduces this workload; these
numbers are observations, not capacity targets or live Cloudflare latency.

`pnpm measure:local` also runs a 32-client fan-out case and a duplicate-retry
case. Both fan-out cases send 50 sequential 128-byte payloads and record arrival
at one designated observer, including one hibernated wake. They check delivery
to all clients. The retry case measures 50 retries of one accepted operation
after another writer adds 2,000 operations. Setup stays outside the latency
samples; retries must leave the durable sequence and logical usage unchanged.

One Linux loopback comparison before and after the scheduling and index changes
reported these values, with 50 samples per workload:

| Workload | p50 before | p50 after | p95 before | p95 after |
| --- | --- | --- | --- | --- |
| 2-client fan-out | 1.24 ms | 1.10 ms | 1.89 ms | 1.84 ms |
| 32-client fan-out | 3.39 ms | 3.26 ms | 4.21 ms | 4.06 ms |
| Retry after 2,000 operations | 2.08 ms | 0.43 ms | 3.11 ms | 0.73 ms |

Logical usage matched before and after for each workload. These are single-run
local observations, not a general speedup guarantee or a Cloudflare cost estimate.
The measurement tests enforce delivery and state invariants, not latency targets.

An idle connected client still needs a server ping and client pong about six
times per minute. Alarms and pong events wake the DO. Hibernation correctness
does not establish idle billing savings; this prototype preserves the driver's
heartbeat rather than claiming zero-cost idle sockets.

This is a bounded Routerlicious prototype, not full Floodgate parity or a
production service. It omits Phoenix/Levee, dynamic tenants, blob attachments,
whole-summary upload, document deletion, and archival/garbage collection.
It serializes summary preparation with document socket events, so slow R2
work can delay edits. Live placement, platform limits under load, and cost need
a separate deployment test.

## Token service

The admin/token service serves `/tokens` and the read-only
[admin site](#admin-site) at `/admin`. Both deployment configurations use the
same implementation in `token-service/src/`. The existing deployment uses
`src/token-worker.ts` and `wrangler.admin.jsonc`, keeping the name `tidepool-auth`
to preserve its hostname, Access application, and secrets. The service uses
`jose` to mint HS256 tokens and service bindings to inspect the
[core connector](#core-connector) in one or more Tidepool Workers.

To deploy both the admin site and token issuer, use this second button:

[![Deploy admin and token service to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tylerbutler/tidepool/tree/main/token-service)

The self-contained [admin/token template](token-service/README.md) includes the
admin HTML and stylesheet. It connects to core through `TidepoolConnector`,
without direct storage bindings. Deploy core first in the same account. Set
the template's `TIDEPOOL` service target to that Worker's name; it defaults to
`tidepool`. Then supply core's
**exact `JWT_SECRET` and `TENANT_ID`** to this issuer. Reuse the signing key,
not a document JWT. Cloudflare cannot retrieve the existing secret for you;
you must enter it again. If the form does not prompt for it, add a runtime
secret through the dashboard or Wrangler as described in the template.
The live button form and blank-secret prompt remain unverified.

### Authentication modes

`TOKEN_AUTH_MODE` defaults to `access`. In this mode, protect the service
hostname with a self-hosted
[Cloudflare Access application](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).
Configure an explicit email allowlist and the desired login provider, such as
[email one-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/).
When token signing is configured, all users admitted by this Access application
can create, read, edit, and summarize any document in its configured token
tenant. They can also inspect all connected Tidepools. A connector binding grants
inspection, not token issuance. There are no per-document permissions.

Set `TOKEN_AUTH_MODE=anonymous` for a disposable public demo without a login.
This makes `/tokens` and **all admin routes public**.
Anyone can list document IDs and inspect metadata for every configured
Tidepool connection. The admin remains read-only, but the token endpoint lets
anyone create, read, edit, and summarize any document in its signing tenant.
Each issuance gets a new random `anonymous:` user ID, not a stable account.
`ACCESS_AUDIENCE` is not required in this mode.

**Use anonymous mode only for throwaway resources and public data.**
There is no tenant-wide rate or cost guard. Public requests can incur charges.
Do not share its signing key with a retained-data deployment or connect its
public admin to private Tidepools. CORS is not authentication: requests without
an Origin header remain permitted.

An existing Access application can still intercept requests before the Worker.
To use anonymous mode, use an unprotected hostname or remove the applicable
Access protection. Changing the Worker variable does not change Access policies.
An empty or unknown auth mode returns 503. Missing Access configuration never
enables anonymous access.

Set these bindings before using the service:

| Binding | Purpose |
| --- | --- |
| `TENANT_ID` | Token issuance only: the same tenant as its document Worker |
| `JWT_SECRET` | Token issuance only: a secret of at least 32 UTF-8 bytes, shared with its document Worker |
| `TOKEN_AUTH_MODE` | `access` by default; explicitly set `anonymous` to make token issuance and all configured admin connections public |
| `ACCESS_AUDIENCE` | Required in Access mode: the Access application's AUD tag |
| `ALLOWED_ORIGIN` | Optional browser app origin; defaults to the token service origin |
| `TIDEPOOLS` | Admin only: an array of connection IDs, labels, and service binding names |
| Named service bindings | Admin only: each targets a core Worker's `TidepoolConnector` entrypoint |

An admin-only deployment can omit both `TENANT_ID` and `JWT_SECRET`. Its admin
routes use the selected auth mode, `/tokens` returns 503, and
`/health` reports `"tokenEndpoint": null`. If either signing setting is present,
the health check requires both settings to be valid. Connecting more Tidepools
does not extend `/tokens`: that endpoint still signs for one configured tenant
and key.

In Access mode, the Worker requires Cloudflare's verified `ctx.access` context
and a matching audience. It derives `user.id` from the Access user's stable
`user_uuid`. Forged Access headers, another application's context, and requests that bypass Access
cannot mint tokens. Missing signing or audience configuration disables minting.
Invoke this Worker directly through its protected hostname; Access does not
forward `ctx.access` through service bindings or static-asset router Workers.

Sign in at the token service hostname if Access mode is enabled, then send:

```http
POST /tokens
Content-Type: application/json

{"documentId":"example"}
```

Use `{"documentId":""}` for a server-generated document creation token. The
request body may contain only `documentId`; callers cannot choose identity,
tenant, scopes, or token lifetime. The body limit is 2 KiB, enforced while
reading the stream. Document IDs may contain at most 256 UTF-8 bytes.

The response contains `{ "jwt": "...", "expiresAt": 1234567890 }`, where
`expiresAt` is a Unix timestamp in seconds. Tokens expire after 15 minutes and
grant `doc:read`, `doc:write`, and `summary:write`. Responses use
`Cache-Control: no-store`. Keep tokens out of logs and URLs.

A browser client's Fluid token provider can call the endpoint from both
`fetchOrdererToken` and `fetchStorageToken`:

```ts
async function fetchToken(_tenantId: string, documentId = "") {
  const response = await fetch("https://<token-host>/tokens", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId }),
  });
  if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
  return response.json();
}

const tokenProvider = {
  fetchOrdererToken: fetchToken,
  fetchStorageToken: fetchToken,
};
```

In Access mode, users must sign in at the issuer hostname before making these
requests. For another browser origin, set `ALLOWED_ORIGIN` and configure Access to
[bypass OPTIONS preflights to the Worker](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/).
The Worker handles preflights without minting tokens and permits credentials
only for the allowed origin. Cross-origin Access cookies remain subject to
browser restrictions; use a same-origin token route when integrating a browser
app. The document Worker closes expired sockets, so clients must obtain fresh
tokens when they reconnect.

### Deploying the admin/token Worker

Deployment requires approval and the intended Cloudflare account. It does not
create an R2 bucket or deploy the document Worker. Deploy each connected
document Worker first when using the admin site; the admin config refers to its
named `TidepoolConnector` entrypoint. An older Worker without that export must
be upgraded before the admin binding can use it.

1. Keep `TOKEN_AUTH_MODE=access` and create the Access application, its allowlist,
   and login provider in Cloudflare Zero Trust. Set `ACCESS_AUDIENCE` to its AUD
   tag. For a disposable public deployment instead, explicitly select
   `anonymous` and leave the hostname unprotected by Access.
2. For token issuance, set `JWT_SECRET` with
   `pnpm exec wrangler secret put JWT_SECRET --config wrangler.admin.jsonc`.
   Use the same secret when deploying the document Worker. Keep a secure backup;
   Cloudflare does not return stored Worker secrets.
3. Run `pnpm build:admin`, then
   `pnpm exec wrangler deploy --config wrangler.admin.jsonc`.
4. Sign in at the deployed hostname if using Access, check `/health`, and
   open `/admin`.
   If token issuance is configured, request a token. A direct request without
   verified Access context must not return a JWT or document inspection data
   in Access mode; anonymous mode intentionally permits both.

Wrangler's normal OAuth login can deploy Workers but may lack Access write
permissions. API provisioning needs `Access: Apps and Policies Write` and, for
email PIN setup, `Access: Organizations, Identity Providers, and Groups Write`.
If Access setup is unavailable in Access mode, the Worker can deploy with
minting disabled until its audience is configured. Local JWT tests do not
verify a live Access login. The committed admin configuration stays in Access
mode; selecting anonymous mode is an explicit deployment choice.

## Core connector

Every core Tidepool Worker exports the `TidepoolConnector` RPC entrypoint from
`src/connector.ts`. It uses that Worker's tenant, Durable Objects, and R2 bucket.
It does not depend on the admin site, Cloudflare Access, or the token Worker.
The public document HTTP handler exposes no connector routes.

| RPC method | Result on success |
| --- | --- |
| `describe()` | `{ apiVersion: 1, tenantId }` |
| `listDocuments({ prefix?, cursor? })` | `{ documents: [{ id, indexedAt }], cursor }` |
| `inspectDocument(documentId)` | The selected document's metadata |

Each method returns `{ ok: true, value }` or
`{ ok: false, error: { status, message, retryAfter? } }`. `retryAfter`, when
present, is a delay in seconds. The admin preserves the status and retry hint.
Unexpected storage/runtime errors are logged at the source and return a generic
503 error, not an empty directory. A missing document returns 404.

Listing returns at most 50 indexed documents; a null cursor marks the final
page. Prefixes and document IDs are limited to 256 UTF-8 bytes, and cursors to
2048 bytes. The connector derives the tenant from its own configuration.
Listing does not inspect or wake every document. Inspection does not append
operations, but can register an existing document in the directory.

**Trust boundary:** a service binding to this entrypoint grants inspection of
the entire configured tenant. Only give it to trusted caller Workers. The
connector does not receive a browser Access session or enforce user permissions;
the caller must enforce its selected access policy before calling it. The admin
verifies Access identity before every admin request in Access mode. Anonymous
mode deliberately grants public inspection of every configured connection.
All admitted admin users can inspect all configured connections, without a
second login. No document signing key is shared through the connector.

### Connecting multiple Tidepools

Connections use same-account Cloudflare service bindings. Configure the admin
Worker with one binding per core deployment and a matching `TIDEPOOLS` entry:

```jsonc
{
  "services": [
    {
      "binding": "POOL_STAGING",
      "service": "tidepool-staging",
      "entrypoint": "TidepoolConnector"
    },
    {
      "binding": "POOL_PRODUCTION",
      "service": "tidepool-production",
      "entrypoint": "TidepoolConnector"
    }
  ],
  "vars": {
    "ACCESS_AUDIENCE": "<admin Access application's AUD tag>",
    "TIDEPOOLS": [
      { "id": "staging", "label": "Staging", "binding": "POOL_STAGING" },
      { "id": "production", "label": "Production", "binding": "POOL_PRODUCTION" }
    ]
  }
}
```

Connection IDs must be unique, contain 1 to 64 lowercase ASCII letters, digits,
hyphens, or underscores, and start with a letter or digit. Keep these IDs stable:
admin links use them to distinguish deployments, even when tenant and document
IDs match. Adding or removing a connection requires an admin configuration
change and redeployment. The admin no longer needs direct `DOCUMENTS` or
`CONTENT` bindings. Cross-account HTTPS connectors and dynamic registration
are not supported.

## Admin site

Open `/admin` on the admin/token service hostname. The admin and
`/tokens` use the same `TOKEN_AUTH_MODE`. In Access mode, sign in through
Cloudflare Access; both use the same verified context, audience, and users.
Forged headers and requests that bypass Access cannot read the directory,
metadata, or stylesheet in that mode. In anonymous mode, all configured
connections and admin routes, including stylesheets, are public without a login.
The site does not introduce another login, permission tier, or browser JWT.

Choose a Tidepool and select **Connect** to browse that deployment. The first
configured connection is the default when no connection ID is supplied; an
unknown ID returns an explicit error. Switching connections clears the document
selection, filter, and page cursor. Document links, exact-ID lookup, refresh,
filters, and pagination keep the selected connection. An unavailable Tidepool
does not prevent switching to another one. There is no combined inventory.

The document directory shows up to 50 entries per page. Filter by a
case-sensitive document-ID prefix, follow the next-page link, or open an exact
document ID. Selecting a document reads its current sequence and minimum
sequence, summary checkpoint and head, stored ref count, logical storage
capacity, and authenticated reader/writer connection counts. Use **Refresh**
to get another snapshot. Only the selected document is queried; listing does
not wake every document. The server does not interpret or display DDS contents.
There are no edit or delete controls.

Directory entries are small R2 objects under `directory/v1/`, separate from
the historian's immutable content. Their storage is not part of a document's
64 MiB logical budget. New documents register after their creation is durable.
Existing documents register on authenticated REST access, WebSocket admission,
or a successful admin ID lookup. A durable registration flag avoids an R2 write
on each later access. The index timestamp is not a document creation timestamp;
creation dates are available only for documents created after this feature.

**Coverage limit:** Durable Objects cannot enumerate existing document names.
Untouched legacy documents are absent until accessed or opened by exact ID.
The directory is not an immediate inventory of all previously stored objects.
An unknown ID returns 404 without creating a document or directory entry.

Directory storage failures return an explicit error rather than an empty list.
If registration fails after a document's creation commits, creation returns a
retryable 503 even though the document exists. Open that document ID or access
it again to retry registration; repeating creation can return 409. Directory
registration and document creation cannot share a transaction across R2 and
SQLite. Neither an admin inspection nor registration appends document operations.

The interface is server-rendered and works without JavaScript. Forms, metadata,
and styles use `Cache-Control: no-store`; a restrictive Content Security Policy
blocks scripts and embedding. Local tests use simulated Access context to check
the boundary. They do not verify a live Access login. No cloud deployment is
part of building or testing this feature.

## Cloud deployment, only after approval

The following commands create cloud resources. Run them only after approval
and after you select the intended Cloudflare account:

```sh
pnpm exec wrangler login
pnpm exec wrangler r2 bucket create tidepool-content
pnpm exec wrangler secret put JWT_SECRET
pnpm build:protocol
pnpm exec wrangler deploy
```

The config binds `DOCUMENTS` to `DocumentDO`, creates its SQLite class with the
`v1` migration, and binds `CONTENT` to the named R2 bucket. Set `TENANT_ID`
and the permitted browser `ALLOWED_ORIGIN` in Wrangler's variables. If the token
Worker is deployed, reuse its existing `JWT_SECRET`; otherwise generate a strong
secret. Set it through `wrangler secret put`; do not put it in config or Git.
Changing the tenant or secret does not migrate existing documents or tokens.

After deployment, check `https://<worker-host>/health`, then run the official
client against that URL with tokens for the deployed tenant and secret.
Repeat collaboration, summary/reload, reconnect, and idle-heartbeat observations
on the live service before using it for retained data.

### Current deployment

| Service | URL |
| --- | --- |
| Document Worker | `https://tidepool.tyler-511.workers.dev` |
| Access-protected admin/token Worker | `https://tidepool-auth.tyler-511.workers.dev` |
| Admin site (same Access application) | `https://tidepool-auth.tyler-511.workers.dev/admin` |

Both Workers use tenant `fluid` and the same signing key. The document Worker
uses the `tidepool-content` R2 bucket and SQLite-backed `DocumentDO` objects.
Access protects only the token Worker; document requests and WebSocket
admission require document JWTs.

The core connector and service-binding admin were deployed on 2026-10-19,
with the core deployed first. The admin has one configured connection to
`tidepool`. Core `/health` returns 200, and the public `/connector` path returns
404. Anonymous requests to `/admin`, its stylesheet, `/tokens`, and the admin
`/health` redirect to the existing Access sign-in. Signed-in document browsing
remains unverified on the live service; no Access users or policies were changed
for this deployment.

The initial cloud deployment passed a bounded official-client SharedMap
collaboration and fresh-client reload check, plus an R2 blob upload/read.
One small canary document remains stored; the service has no document-delete
API. Access-authenticated token issuance, cloud hibernation/restarts, sustained
load, and billing remain unverified.

### Cleanup

For cleanup, first export any data you need. Deleting the Worker with
`pnpm exec wrangler delete --name tidepool` destroys its DO state.
Delete each owned R2 object with `pnpm exec wrangler r2 object delete <bucket>/<exact-key>`,
then delete the empty bucket with
`pnpm exec wrangler r2 bucket delete tidepool-content`.
Check the account and exact resource names before these destructive commands.
