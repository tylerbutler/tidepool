# Agent Instructions

## Scope

Tidepool is a TypeScript Cloudflare Worker that implements a bounded
Routerlicious server with a SQLite-backed Durable Object and R2 storage.
Protocol decisions and framing are implemented in Gleam and compiled to
JavaScript.

Read `README.md` before changing behavior. It is the source of truth for
setup, architecture, limits, failure behavior, and deployment cautions.

## Repository map

- `src/worker.ts`: Worker entry point, HTTP/WebSocket routing, and bindings.
- `src/document.ts`: Durable Object lifecycle, collaboration, sequencing, and
  persistence.
- `src/auth.ts`, `src/storage.ts`, `src/historian.ts`: authentication,
  R2/SQLite storage, and operation history.
- `src/protocol.ts`, `src/common.ts`: TypeScript protocol adapters and shared
  helpers.
- `protocol/src/`: Gleam protocol implementation and assertions.
- `test/`: platform, protocol, and official Fluid client tests.
- `wrangler.jsonc`: Worker, Durable Object, migration, and R2 configuration.

Do not edit generated files under `protocol/build/`, `dist/`, or
`.wrangler/`. Do not commit secrets, `.dev.vars`, local state, or generated
artifacts.

## Development

Use Node.js 24, pnpm 10, and Gleam 1.19.2 or later. Install dependencies with:

```sh
pnpm install --frozen-lockfile
```

Run the checks from the repository root:

```sh
pnpm typecheck
pnpm check
pnpm test
```

Use focused commands when iterating:

```sh
pnpm test:protocol
pnpm test:workers
pnpm test:acceptance
pnpm build
```

`pnpm test` runs the Gleam assertions, builds the Worker, runs platform and
storage tests, and runs the official Fluid acceptance test in local workerd.
Tests do not require cloud resources. Use `pnpm dev` only for local manual
testing; do not use Wrangler `--remote` for local tests.

## Change rules

- Preserve strict TypeScript settings and existing error handling.
- Keep protocol validation and sequencing behavior consistent between Gleam
  and its generated JavaScript adapter.
- Add or update focused tests for behavior changes, especially size limits,
  authorization, retries, persistence, hibernation, and failure paths.
- Keep Durable Object writes transactional. Do not publish acknowledgements,
  heads, or broadcasts before the related durable write succeeds.
- Follow existing Biome and Gleam formatting. Run `pnpm format` only when
  intentionally formatting files.
- Cloud deployment and resource deletion require explicit approval. Never run
  `wrangler deploy`, resource creation, or destructive cleanup as part of
  routine validation.
