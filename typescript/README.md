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

const mesa = new Mesa({ privateKey: process.env.MESA_PRIVATE_KEY });

// The organization comes from the key, so there is nothing to pass.
const repo = await mesa.repos.create({ name: 'my-repo' });

console.log(repo.name);
```

This package exposes org-inferred REST resources under `mesa.*`.

## Configuration

`Mesa` accepts one optional configuration object. When `privateKey` is omitted, the SDK reads `MESA_PRIVATE_KEY` in Node.

- `privateKey?: string`
- `apiUrl?: string` (defaults to `https://api.mesa.dev/v1`)
- `fetch?: typeof fetch`
- `userAgent?: string`
- `webhookSecret?: string` (used by `mesa.webhooks.receive(...)`)

The private key names its organization, so the client picks it up from the key.

### Scoped access tokens

Mint a token in your trusted process and hand only that token to the sandbox or job that needs it:

```ts
const { token } = await mesa.tokens.create({
  authors: [{ name: 'Mesa Bot', email: 'mesa-bot@example.com' }],
  scopes: ['read', 'write'],
  repos: ['acme/agent-workspace'],
  ttl_seconds: 60 * 60, // 1 hour
});
```

A token signed by a private key lasts 15 minutes by default and can be given up to 4 hours. Pass scoped tokens to the Mesa CLI, MesaFS, or direct REST requests instead of constructing a TypeScript SDK client with them.

## Webhook Handlers

Register typed handlers with `mesa.webhooks.on(...)` and pass the incoming
request to `mesa.webhooks.receive(...)`. `receive` verifies the signature,
parses the payload, and dispatches any registered handlers.

```ts
import { Hono } from 'hono';
import { Mesa } from '@mesadev/sdk';

const mesa = new Mesa({
  privateKey: process.env.MESA_PRIVATE_KEY,
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
- use the organization encoded in the private key
- use resource namespaces (`mesa.repos`, `mesa.changes`, etc.); install `@mesadev/rest` directly when you need generated REST operations
