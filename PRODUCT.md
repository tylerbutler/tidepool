# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Tidepool operators use the admin site to find documents and inspect their
server-side state. The same Cloudflare Access application and users protect
the token service and the admin site.

## Product Purpose

Tidepool is an experimental Fluid Framework server on Cloudflare Workers,
SQLite-backed Durable Objects, and R2. The admin site makes document identity,
sequence state, summaries, connections, and logical storage use visible.

## Operating Context

The admin site lives at `/admin` on the existing token Worker. It uses
server-rendered HTML and CSS with small browser scripts, not a frontend
framework. Access remains the sign-in boundary. No additional user accounts
or per-document permissions are introduced.

## Capabilities and Constraints

- The admin site is read-only. It does not edit or delete documents.
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
constraints. `src/token-worker.ts` implements verified Cloudflare Access
authentication. `src/document.ts` and `src/storage.ts` own document state.
No existing frontend identity or image assets are present.

## Product Principles

- Reuse the existing authentication and tenant boundary.
- Show recorded state, not inferred health or document contents.
- State directory coverage and storage limits without hiding uncertainty.
- Keep inspection separate from document mutation.
