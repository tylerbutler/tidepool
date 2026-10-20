# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Tidepool operators use one admin site to find documents and inspect their
server-side state across connected deployments. In the default Access mode,
one Cloudflare Access application authenticates users for all its connections
and token issuance. Explicit anonymous mode makes both public for disposable demos.
Users of the main deployment can also create and edit SharedMap documents in
the browser app, through the same Access application and token issuer.

## Product Purpose

Tidepool is an experimental Fluid Framework server on Cloudflare Workers,
SQLite-backed Durable Objects, and R2. The admin site makes document identity,
sequence state, summaries, connections, and logical storage use visible.
The separate SharedMap app provides a small collaboration client for the
deployed document and token services.

## Operating Context

The admin site lives at `/admin` on the token Worker in both deployment
configurations, including the standalone deploy-button template. It uses
server-rendered HTML and CSS with small browser scripts, not a frontend
framework. Access is the default sign-in boundary; anonymous mode deliberately
removes it for all configured connections. No additional user accounts or
per-document permissions are introduced. Each core Tidepool exports a
service-binding connector; the admin does not bind directly to its storage.

The main deployment serves the collaboration app at `/app/`. It uses the
official Fluid Routerlicious driver and requests tokens from same-origin
`/tokens`. The standalone admin/token deploy-button template does not include
this app. The build embeds app files in the Worker to avoid Cloudflare's
Static Assets router, which does not forward `ctx.access`. Requests must reach
the Access-authenticated Worker without that intermediate router.

## Capabilities and Constraints

- The admin site is read-only. It does not edit or delete documents.
- The SharedMap app creates and opens documents, shares links, and sets or
  deletes text values. Users admitted by Access can edit documents in the
  signing tenant; there are no per-document permissions.
- A native selector switches between statically configured, same-account
  Tidepools. Links and forms retain the selected deployment; switching clears
  the document selection, filter, and cursor.
- All admitted admin users can inspect all configured Tidepools. Connector
  bindings grant inspection, not token issuance or signing-key access.
- Anonymous mode makes the directory and metadata for all connections public.
  Its token issuer grants public access to every document in its signing tenant.
  Use only disposable resources and public data; requests can incur charges.
- An admin-only deployment does not require document signing credentials.
- A persistent directory lists documents registered after this feature is
  enabled. Existing documents enter the directory when accessed.
- An explicit document-ID lookup checks for an older document and registers
  it if it exists. The directory cannot enumerate untouched legacy objects.
- Document details show identity, sequence/checkpoint state, logical storage
  use, summary head, and connected-client counts.
- Logical storage use is not physical SQLite or R2 allocation.
- The server does not interpret DDS contents.
- Cloud deployment and resource changes require explicit approval.

## Evidence on Hand

`README.md` describes architecture, limits, authentication, and deployment
constraints. `token-service/src/worker.ts` and `token-service/src/admin.ts`
implement authentication, token issuance, and the admin site. `src/document.ts` and
`src/storage.ts` own document state.
`app/` implements the collaboration client. Local browser tests cover creation,
two-browser edits, deletion, and reload with anonymous token issuance. Access
unit tests use mocked contexts; they do not check Cloudflare's live login or
context delivery. The operator reported successful signed-in use of the deployed
app after the Static Assets routing fix. This manual smoke check does not cover
token renewal, cloud hibernation, sustained load, or billing.
`DESIGN.md` records the shared visual system. No raster image assets are present.

## Product Principles

- Reuse the existing authentication and tenant boundary.
- Show recorded state, not inferred health or document contents.
- State directory coverage and storage limits without hiding uncertainty.
- Keep inspection separate from document mutation.
