# @mesadev/sdk

Official Mesa TypeScript SDK.

This is the primary TypeScript SDK for Mesa. It includes ergonomic REST resources with default org inference.

Node.js runtime is required.

## Install

```bash
bun add @mesadev/sdk
```

## Usage

```ts
import { Mesa } from '@mesadev/sdk';

const mesa = new Mesa({
  apiKey: process.env.MESA_API_KEY,
});

// Uses org inferred from /whoami
const repo = await mesa.repos.create({ name: 'my-repo' });

// Optional constructor org bypasses /whoami default-org resolution
const mesaWithOrg = new Mesa({
  apiKey: process.env.MESA_API_KEY,
  org: 'acme',
});

await mesaWithOrg.repos.list();

// Per-call org override
await mesa.repos.list({ org: 'other-org' });

console.log(repo.name);
```

This package exposes org-inferred REST resources under `mesa.*`.

## Configuration

`Mesa` accepts:

- `apiKey?: string` (falls back to `MESA_API_KEY` in Node)
- `apiUrl?: string` (defaults to `https://api.mesa.dev/v1`)
- `vcsUrl?: string` (optional VCS gateway override; only use when self-hosting Mesa)
- `org?: string` (optional default org; bypasses `/whoami` resolution)
- `fetch?: typeof fetch`
- `userAgent?: string`
- `webhookSecret?: string` (used by `mesa.webhooks.receive(...)`)

## Webhook Handlers

Register typed handlers with `mesa.webhooks.on(...)` and pass the incoming
request to `mesa.webhooks.receive(...)`. `receive` verifies the signature,
parses the payload, and dispatches any registered handlers.

```ts
import { Hono } from 'hono';
import { Mesa } from '@mesadev/sdk';

const mesa = new Mesa({
  apiKey: process.env.MESA_API_KEY,
  webhookSecret: process.env.MESA_WEBHOOK_SECRET,
});

mesa.webhooks.on('push', (event) => {
  console.log('push:', event.data.updates[0]?.ref);
});

const app = new Hono();

app.post('/webhooks/mesa', async (c) => {
  await mesa.webhooks.receive(c.req.raw);
  return c.text('ok');
});
```

## Package Relationship

- `@mesadev/sdk` is the ergonomic, main SDK.
- `@mesadev/rest` is the generated REST package used under the hood.

## Low-Level REST Access

Use `@mesadev/rest` directly, or call the API with your own HTTP client, when you need low-level REST access beyond the resource namespaces.

## Migration Note

If you previously used the older generated `@mesadev/sdk` package:

- use `apiUrl` instead of `serverURL`
- rely on default org inference from `/whoami` or pass `org` per call
- use resource namespaces (`mesa.repos`, `mesa.changes`, etc.); install `@mesadev/rest` directly when you need generated REST operations
