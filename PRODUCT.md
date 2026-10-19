# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Tidepool operators use one admin site to find documents and inspect their
server-side state across connected deployments. In the default Access mode,
one Cloudflare Access application authenticates users for all its connections
and token issuance. Explicit anonymous mode makes both public for disposable demos.

## Product Purpose

Tidepool is an experimental Fluid Framework server on Cloudflare Workers,
SQLite-backed Durable Objects, and R2. The admin site makes document identity,
sequence state, summaries, connections, and logical storage use visible.

## Operating Context

The admin site lives at `/admin` on the existing token Worker. It uses
server-rendered HTML and CSS with small browser scripts, not a frontend
framework. Access is the default sign-in boundary; anonymous mode deliberately
removes it for all configured connections. No additional user accounts or
per-document permissions are introduced. Each core Tidepool exports a
service-binding connector; the admin does not bind directly to its storage.

## Capabilities and Constraints

- The admin site is read-only. It does not edit or delete documents.
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
constraints. `src/token-worker.ts` and `token-service/src/worker.ts` implement
the shared authentication mode and token issuance. `src/document.ts` and
`src/storage.ts` own document state.
No existing frontend identity or image assets are present.

## Product Principles

- Reuse the existing authentication and tenant boundary.
- Show recorded state, not inferred health or document contents.
- State directory coverage and storage limits without hiding uncertainty.
- Keep inspection separate from document mutation.
