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

The prototype runs in local workerd. Tests cover SharedMap collaboration,
an updated summary and delta-tail reload, actual local object hibernation,
reset/reconnect, and storage failures. No cloud resources or deployment are
part of these tests. Live Cloudflare behavior and billing remain unverified.

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

Each document stores its initial protocol checkpoint. Summary preparation
replays proposals and minimum-sequence advances from that checkpoint through
the summary reference. The snapshot includes pending proposals and agreed
quorum settings at that reference; later approvals remain in the delta tail.

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
code should mint tokens; this prototype has no public token endpoint.

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
| `pnpm build` | Gleam JavaScript build and Wrangler dry-run bundle |
| `pnpm typecheck` | Strict TypeScript boundary check |
| `pnpm check` / `pnpm format` | Biome and Gleam formatting |
| `pnpm test:protocol` | Assert protocol behavior on JavaScript |
| `pnpm test:workers` | Build and run local platform/storage tests |
| `pnpm test:acceptance` | Official SharedMap summary/reload test |
| `pnpm measure:local` | Print a bounded loopback workload measurement |
| `pnpm dev` | Persistent local Worker |

`cd protocol && gleam run --target erlang` runs the same protocol assertion
harness on Erlang. The CI workflow installs this package and runs the local
checks without cloud credentials. It does not deploy the Worker.

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
Each document reserves its reachable R2 content even when another document
already uploaded it. Retries of the same immutable key do not add another
charge. A failed R2 write keeps its reservation, so a retry can use it; abandoned
uploads and staged commits still consume budget. Conflicting encoded sizes for
the same reservation return an error. There is no garbage collector.

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

## Cloud deployment, only after approval

No command above creates cloud resources. These commands do; run them only
after approval and after you select the intended Cloudflare account:

```sh
pnpm exec wrangler login
pnpm exec wrangler r2 bucket create tidepool-content
pnpm exec wrangler secret put JWT_SECRET
pnpm build:protocol
pnpm exec wrangler deploy
```

The config binds `DOCUMENTS` to `DocumentDO`, creates its SQLite class with the
`v1` migration, and binds `CONTENT` to the named R2 bucket. Set `TENANT_ID`
and the permitted browser `ALLOWED_ORIGIN` in Wrangler's variables. Supply a
strong secret through `wrangler secret put`; do not put it in config or Git.
Changing the tenant or secret does not migrate existing documents or tokens.

After deployment, check `https://<worker-host>/health`, then run the official
client against that URL with tokens for the deployed tenant and secret.
Repeat collaboration, summary/reload, reconnect, and idle-heartbeat observations
on the live service before using it for retained data.

For cleanup, first export any data you need. Deleting the Worker with
`pnpm exec wrangler delete --name tidepool` destroys its DO state.
Delete each owned R2 object with `pnpm exec wrangler r2 object delete <bucket>/<exact-key>`,
then delete the empty bucket with
`pnpm exec wrangler r2 bucket delete tidepool-content`.
Check the account and exact resource names before these destructive commands.
