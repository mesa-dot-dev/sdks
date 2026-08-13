---
product: TypeScript SDK
---
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Common Changelog](https://common-changelog.org/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- **Breaking:** Remove `org` from the TypeScript SDK constructor and resource methods; the SDK derives the organization from the credential
- **Breaking:** Remove `vcsUrl` from the SDK and MesaFS configuration; VCS traffic now always uses the configured API origin

## [0.45.0] - 2026-08-11

### Changed

- Point package source and issue links to the public SDK repository
- **Breaking:** Remove top-level `RepoConfig.bookmark`, `RepoConfig.changeId`, and `RepoConfig.readOnly` (and the deprecated `FromRevision` type). Use `at` / `branchedFrom` and `mode` instead
- **Breaking:** Resolve `fs.change.new({ bookmark })` (and `edit` / mount `at.bookmark`) strictly against `refs/heads/<name>`. A string that is not a bookmark no longer falls through server-side revspec resolution to a change id; pass `changeId` to fork from a change

### Added

- Add mount `RepoConfig` fields `mode`, `at`, and `branchedFrom` to open an existing revision or fork a new revision at mount time (create change → optional `as.bookmark` → publish checkout; omit `as.bookmark` for an anonymous tip)

### Removed

- **Breaking:** Remove API-key authentication from the SDK, including `apiKey`, `MESA_API_KEY`, legacy HS256 token minting, and `MissingApiKeyError`; use `privateKey` or `auth.accessToken` instead

## [0.44.1] - 2026-08-09

### Changed

- Split native filesystem write batches to the server-advertised VCS operation and message-size limits

## [0.44.0] - 2026-08-07

### Changed

- Resolve the organization for `auth.accessToken` locally from its JWT issuer and reject opaque or malformed tokens instead of making an implicit `/whoami` request
- Limit signing-key token and commit attribution to 100 ordered authors
- Deprecate the `apiKey` client option, the `MESA_API_KEY` environment fallback, and the `apiKeys` resource in favor of private keys, and the `org` client option (the organization is derived from the credential); API keys remain supported
- Change native addon loading to fail with the actionable `Unable to load mesafs-napi native addon` error (original failure attached as `cause`) when the package is installed but no platform binary is present

### Added

- Allow private-key authentication to carry ordered commit authors, with explicit authors required for token creation, commit writes, and mounts
- Add custom mount layouts, created by calling `mesa.fs({ layout, ttl })`
- Add `token()` and `layout()` on the FS mount definition for serializing a token and layout file that can be passed into a sandbox
- Add `fs.change.checkpoint({ repo, message? })` to flush pending writes (serializing concurrent writes and tree mutations in the same repo), optionally describe the current change, create a new descendant change, and advance bookmarks onto that descendant (requires the checkout to already be on a bookmark). Concurrent bookmark-tip races raise a retryable conflict (distinct from not-on-a-bookmark and from a half-applied checkout failure). Omit `message` to preserve the existing description; pass `message: ''` to clear it; any other string overwrites. Returns `CheckpointResult` with `savedChangeOid` (saved change) and `activeChangeOid` (now-active empty descendant)

## [0.43.0] - 2026-08-02

### Added

- Allow private keys to authenticate normal SDK requests and MesaFS mounts with `new Mesa({ privateKey })`. Private-key clients can also mint scoped access tokens locally with `tokens.create()`, and those tokens can authenticate another client through `auth.accessToken`
- Add repository ID restrictions to locally signed access tokens with `mesa.tokens.create({ repo_ids: [...] })`

### Changed

- **Breaking:** Require REST and native filesystem bookmark moves to advance history by default; pass `allow_backwards` or `allowBackwards` to permit intentional backward or sideways moves
- **Breaking:** Change `Mesa.apiKey` from `string` to `string | undefined`; it remains a string for API-key clients and is undefined for private-key and access-token clients

## [0.39.0] - 2026-07-08

### Added

- Add structured tag filter objects to `mesa.repos.list()`, with `$`-prefixed case-insensitive operators (`$and`, `$or`, `$not`, `$eq`, `$in`, `$contains`, `$starts_with`, `$ends_with`, `$exists`) and case-insensitive tag matching

### Deprecated

- Deprecate legacy comma-separated repo tag filters in favor of structured tag filter objects

## [0.38.0] - 2026-06-22

### Fixed

- Fix files written through the SDK transiently disappearing during bursts of writes


## [0.37.0] - 2026-06-17

### Fixed

- Repeated filesystem operations on the same repository are now dramatically faster

## [0.36.0] - 2026-06-09

### Added

- Add `mesa.tokens.create()` to sign a self-expiring access token (JWT) locally from an API key, scoped to a subset of the key's scopes and to repositories given as full `org/repo` names. Signing is local with no network call; a `ttl_seconds` outside 1 second to 24 hours raises `InvalidOptionsError`
- Add a `ttl` option (seconds) to `fs.mount()` to set how long the mount lasts. The mount signs one access token for that lifetime and expires with it. Defaults to 1 hour, capped at 24 hours
- Add `MesaFileSystemConfig.credential` as the preferred name for the bearer-credential field, which accepts an access token (JWT) or an API key
- Add `MissingCredentialError` as the preferred name for the error thrown when the `Mesa` constructor is given no API key (and `MESA_API_KEY` is unset)

### Changed

- `fs.mount()` now signs a short-lived access token locally from your API key instead of creating an ephemeral API key on the server. No server-side credential is created or left behind, and the mount expires on its own when the token does

### Deprecated

- Deprecate `MesaFileSystemConfig.apiKey` in favor of `credential`. The `apiKey` field is still accepted; supply exactly one (`credential` wins if both are set)
- Deprecate `MissingApiKeyError` in favor of `MissingCredentialError`. The old name is retained as an alias of the same class, so `instanceof` checks under either name keep working

### Removed

- Remove the automatic API key cleanup that ran on process exit; `fs.mount()` no longer creates server-side keys

## [0.35.0] - 2026-06-07

### Changed

- Change `mesa.fs.mount()` native addon loading to use the `@mesadev/mesafs-napi` package while keeping `MESA_NAPI_PATH` as a local override

## [0.34.0] - 2026-06-01

### Added


- Changes in Mesa are now realtime by default. Concurrent editors mounted on the same change will see one another's modifications within a few seconds.
- Add `MesaFileSystem.subscribe(handler)` for filesystem invalidation callbacks across mounted changes. Call `unsubscribe()` on the returned subscription to stop.

### Removed

- Remove the experimental `multiplayer` filesystem APIs.

## [0.33.0] - 2026-05-26

### Added

- Add per-repo `readOnly?: boolean` to `RepoConfig` in `fs.mount(...)`. When `true`, the mesa daemon rejects writes to that repo with `EROFS`, so a single mount can carry a mix of writable and read-only repos.

### Changed

- Change responses now report parent change IDs instead of commit SHAs of prior versions of the same change.

### Removed

- **Breaking:** Remove the mount-wide `mode?: 'ro' | 'rw'` option from `fs.mount(...)` and `MesaFileSystem.create(...)`. Set `readOnly` on each `RepoConfig` instead. The minted API key always carries `read` and `write` scopes; read-only enforcement is performed client-side by the mesa daemon

## [0.32.0] - 2026-05-22

### Added

- Add `multiplayer.subscribe()` for event-emitter style multiplayer event streaming. Returns a `MultiplayerSubscription` that emits `remote-change` (with `generation`) and `peers-changed` (with `count`) events. Call `.unsubscribe()` to stop.
- Add `multiplayer.watch()` for `AsyncIterable`-based multiplayer event streaming. Yields `MultiplayerEvent` objects and supports `AbortSignal` for cancellation.

## [0.31.0] - 2026-05-21

### Added

- Add `setMetadata` / `getMetadata` / `clearMetadata` on `MesaFileSystem` for reading and writing per-file metadata as plain key/value pairs (e.g. `{ origin: 'notion:page_foo' }`). `setMetadata` merges per key; passing `null` or an empty string as a value deletes that key, so one call can mix sets and deletes. `getMetadata` returns all keys including the read-only `org`/`repo`. `clearMetadata` removes every key on a path.

### Changed

- **Breaking:** Rename the `client.repos.content.get(...)` metadata surface from `xattrs` to `metadata`. Responses now expose `metadata?: Record<string, string>` instead of `xattrs?`, and directory listings filter via `metadata` key/value pairs instead of `xattr` pairs.

## [0.30.0] - 2026-05-19

### Added

- Respond to `client.repos.content.get(...)` with optional `xattrs?: Record<string, string>` metadata for files, symlinks, directories, and directory entries when present.
- Add `xattr` filters to `client.repos.content.get(...)` directory listings, returning entries that match all supplied xattr `name:value` pairs.
- Add `message` support to `fs.change.new(...)` for setting the description of a newly created mounted-filesystem change.

### Changed

- `mesa.changes.create(...)` and `mesa.changes.patch(...)` now accept empty string descriptions. Omit `message` on create to create a change with no description, or omit it on patch to preserve the existing description; pass `""` to create or update a change with no description.
- `mesa.bookmarks.merge(...)` now accepts `message`; omit it to use the generated merge description, or pass `""` to create the merge with no description.

## [0.29.3] - 2026-05-18

### Fixed

- Make every `mesa.fs` write durable before the operation returns

## [0.29.2] - 2026-05-17

### Added

- Add `mesa.bookmarks.get({ repo, bookmark })` for direct bookmark lookup by name, and add `glob` filtering to `mesa.bookmarks.list({ repo, glob })`
- Add optional `ref_globs` filters to `mesa.repos.syncUpstream(...)`: omit it to sync all supported branches and tags, or pass branch/tag glob strings such as `{ branches: "main" }`

## [0.29.1] - 2026-05-16

### Fixed

- Fix `mesa.fs.mount()` native addon loading by restoring platform package entrypoints and falling back to direct `mesa-napi.node` resolution

## [0.29.0] - 2026-05-15

### Added

- Add `VIRTUAL_ROOT_CHANGE_ID` export for referencing the virtual-root sentinel change id from `@mesadev/sdk`
- Add `mesa.repos.syncUpstream({ repo, direction })` for triggering an sync with a repository's upstream. Returns the `sync` row; the worker processes it asynchronously. Read `repo.upstream.latest_sync`, call `mesa.repos.getUpstreamSync({ repo, syncId })`, list `mesa.repos.listUpstreamSyncs({ repo })`, or subscribe to `sync.{queued,in_progress,completed,failed}` webhooks
- Add `mesa.repos.{getUpstreamSync, listUpstreamSyncs}` for reading repository upstream sync history
- `mesa.repos.create` and `mesa.repos.update` accept an `upstream: { url, auth? }` field to add or replace the repository upstream. The `auth` payload is inline: `{ kind: 'token', token, token_username? }` or `{ kind: 'username_password', username, password }`. `mesa.repos.update` accepts `upstream: null` to remove. Repository responses include the `upstream` configuration with `latest_sync`; secrets are never returned
- Surface `sync.queued`, `sync.in_progress`, `sync.completed`, and `sync.failed` webhook event types

### Changed

- Resolving the default bookmark of a freshly created (never-written-to) repo continues to return the virtual root sentinel `change_id`. The server-side lazy-seed behavior is transparent to SDK consumers — the first write through any path advances the bookmark to a real change ([MES-1387](https://linear.app/mesa-dev/issue/MES-1387))

### Fixed

- Fix REST API errors to throw human-readable `MesaApiError` instances while preserving structured response metadata

### Removed

- **Breaking:** Remove the public `mesa.raw` generated REST operation namespace; use `@mesadev/rest` directly for low-level REST access

## [0.28.2] - 2026-05-07

### Added

- Add `fs.change.current({ repo })` to query the currently active change on a mounted repo. Returns `ChangeInfo` with `changeId` and `commitOid`.

## [0.28.1] - 2026-05-06

### Changed

- Rename `SIGNATURE_HEADER` export from `x-depot-signature` to `x-mesa-signature`. Consumers verifying webhook signatures must update to match the new header name.
- Coordinate `MesaFileSystem` cache budgets across instances in a single process;
  `disk_cache.max_size_bytes: null` now auto-sizes against system resources instead of being unbounded

### Fixed

- Fix `rg` and other tools that resolve `/..` by clamping `resolve_path` at the filesystem root.

## [0.28.0] - 2026-05-03

### Added

- Added support for conflicts in the FS interfaces. Conflicting files render `jj`-style conflict
  semantics.

### Fixed

- Surface `LOCK_CONFLICT` instead of `INTERNAL_ERROR` on concurrent bookmark writes.
- Fixed race condition in cache deallocation theoretically causing crashes.

## [0.27.0] - 2026-04-30

No user-facing changes.

## [0.26.0] - 2026-04-29


### Changed

- **Breaking:** Rename "upstreams" to "remotes" across all SDK interfaces.

### Fixed

- Fix repo list cache not being exercised through the SDK codepath, hitting an uncached API on every
  call.
