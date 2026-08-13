---
product: Python SDK
---
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Common Changelog](https://common-changelog.org/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- **Breaking:** Remove `org` from the Python SDK constructor and resource methods; the SDK derives the organization from the credential
- **Breaking:** Remove `vcs_url` from the SDK and MesaFS configuration; VCS traffic now always uses the configured API origin

## [0.45.0] - 2026-08-11

### Changed

- Point package source and issue links to the public SDK repository
- **Breaking:** Remove top-level `RepoConfig.bookmark`, `RepoConfig.change_id`, and `RepoConfig.read_only`. Use `at` and `mode` instead
- **Breaking:** `RepoConfig.mode` is now a `MountMode` enum (`MountMode.rw` / `MountMode.ro`); the strings `"rw"` / `"ro"` remain accepted. The public `MountMode` name is this enum (layout JSON still uses `"ro"` / `"rw"` string literals)
- **Breaking:** Resolve `fs.changes.new(..., bookmark=...)` (and `edit` / mount `at={"bookmark": ...}`) strictly against `refs/heads/<name>`. A string that is not a bookmark no longer falls through server-side revspec resolution to a change id; pass `change_id` to fork from a change

### Added

- Add mount `RepoConfig` fields `mode`, `at`, and `branched_from` to open an existing revision or fork a new revision at mount time (create change → optional `as.bookmark` → publish checkout; omit `as.bookmark` for an anonymous tip)

### Removed

- **Breaking:** Remove API-key authentication from the SDK, including `api_key`, `MESA_API_KEY`, legacy HS256 token minting, and `MissingApiKeyError`; use `private_key` or `auth["access_token"]` instead

## [0.44.1] - 2026-08-09

### Changed

- Split native filesystem write batches to the server-advertised VCS operation and message-size limits

## [0.44.0] - 2026-08-07

### Changed

- Resolve the organization for `auth["access_token"]` locally from its JWT issuer and reject opaque or malformed tokens instead of making an implicit `/whoami` request

### Added

- Add custom mount layouts, created by calling `mesa.fs(layout=..., ttl=...)`
- Add `token()` and `layout()` on the FS mount definition for serializing a token and layout file that can be passed into a sandbox
- Add `await fs.changes.checkpoint(repo, message=None)` to flush pending writes (serializing concurrent writes and tree mutations in the same repo), optionally describe the current change, create a new descendant change, and advance bookmarks onto that descendant (requires the checkout to already be on a bookmark). Concurrent bookmark-tip races raise a retryable conflict (distinct from not-on-a-bookmark and from a half-applied checkout failure). Omit `message` to preserve the existing description; pass `message=""` to clear it; any other string overwrites. Returns `CheckpointResult` with `saved_change_oid` (saved change) and `active_change_oid` (now-active empty descendant)
- Add private-key authentication and local Ed25519 token signing. Token minting, commit-producing REST operations, and MesaFS mounts require operation-level ordered authors; non-authoring REST credentials remain authorless

## [0.43.0] - 2026-08-02

### Changed

- **Breaking:** Require REST bookmark moves to advance history unless `allow_backwards` is set
- **Breaking:** Require native filesystem bookmark moves to advance history by default and add an `allow_backwards` override

### Added

- Add repository ID restrictions to locally signed access tokens with `mesa.tokens.create(repo_ids=[...])`

## [0.39.0] - 2026-07-08

### Added

- Add structured tag filter dictionaries to `mesa.repos.list()`, with `$`-prefixed case-insensitive operators (`$and`, `$or`, `$not`, `$eq`, `$in`, `$contains`, `$starts_with`, `$ends_with`, `$exists`) and case-insensitive tag matching

### Deprecated

- Deprecate legacy comma-separated repo tag filters in favor of structured tag filter dictionaries

## [0.38.0] - 2026-06-22

### Fixed
- Fix files written through the SDK transiently disappearing during bursts of writes

## [0.37.0] - 2026-06-17

### Fixed

- Repeated filesystem operations on the same repository are now dramatically faster
## [0.36.0] - 2026-06-09

### Added

- Add `mesa.tokens.create(...)` to sign a self-expiring access token (JWT) locally from an API key, scoped to a subset of the key's scopes and to repositories by full `org/repo` name. Signing is local with no network call; a `ttl_seconds` outside 1 second to 24 hours raises `InvalidOptionsError`
- Add a `ttl` option to `mesa.fs.mount()` to set how long the mount lasts, in seconds (default 3600, max 86400). The mount signs one access token for that lifetime and expires with it
- Add `MissingCredentialError` as the preferred name for the error raised when no API key is provided (directly or via `MESA_API_KEY`)

### Changed

- `mesa.fs.mount()` now signs a short-lived access token locally from your API key instead of creating an ephemeral API key on the server. Repos are scoped by full `org/repo` name so signing needs no network round-trip, no server-side credential is created or left behind, and the mount expires on its own when the token does

### Deprecated

- Deprecate `MissingApiKeyError` in favor of `MissingCredentialError`. The old name is retained as an alias of the same class, so `except MissingApiKeyError` keeps working

## [0.34.0] - 2026-06-01


### Added

- Changes in Mesa are now realtime by default. Concurrent editors mounted on the same change will see one another's modifications within a few seconds.
- Add `MesaFileSystem.subscribe(handler)` for filesystem invalidation callbacks across mounted changes. Call `unsubscribe()` on the returned subscription to stop.

### Removed

- Remove the experimental `multiplayer` filesystem APIs.

## [0.33.0] - 2026-05-26

### Added

- Add `read_only` to `RepoConfig`. Pass `RepoConfig(name="my-repo", read_only=True)` to `fs.mount(...)` and the mesa daemon rejects writes to that repo with an `OSError` whose `errno` is `errno.EROFS`, so a single mount can carry a mix of writable and read-only repos.
- Add `type` aliases and `is_file()`, `is_dir()`, and `is_symlink()` helpers to generated content response models

### Changed

- Change responses now report parent change IDs instead of commit SHAs of prior versions of the same change.

### Removed

- **Breaking:** Remove the mount-wide `mode` parameter from `fs.mount(...)` and `MesaConfig`. Set `read_only` on each `RepoConfig` instead. The minted API key always carries `read` and `write` scopes; read-only enforcement is performed client-side by the mesa daemon

## [0.32.0] - 2026-05-22

### Added

- Add `multiplayer.watch()` for async-iterator multiplayer event streaming. Returns a `MultiplayerEventStream` usable as an async context manager; yields `RemoteChangeEvent` (with `generation`) and `PeersChangedEvent` (with `count`).
- Add `multiplayer.on()` for callback-based multiplayer event streaming. Accepts a sync or async callback; returns an unsubscribe callable.

## [0.31.0] - 2026-05-21

### Added

- Add `set_metadata` / `get_metadata` / `clear_metadata` on `MesaFileSystem` for per-file metadata as plain key/value pairs. `set_metadata` merges per key; passing `None` or an empty string as a value deletes that key, so one call can mix sets and deletes. `get_metadata` returns all keys including the read-only `org`/`repo`. `clear_metadata` removes every key on a path. Naming a reserved key raises `ValueError`.

### Changed

- **Breaking:** Rename the `mesa.content.get(...)` metadata surface from `xattrs` to `metadata`. Responses now expose optional `metadata` instead of `xattrs`, and directory listings filter via `metadata` key/value pairs instead of `xattr` pairs.

## [0.30.0] - 2026-05-19

### Added

- Add `mesa.webhooks.on(...)` and `mesa.webhooks.receive(...)` for verifying and dispatching inbound Mesa webhooks
- Add `fs.bookmarks.move(repo, name, change_id=...)` for moving bookmarks from a mounted filesystem
- `mesa.content.get(...)` responses now expose optional `xattrs` metadata for files, symlinks, directories, and directory entries when present.
- Add `message` support to `fs.changes.new(...)` for setting the description of a newly created mounted-filesystem change

### Changed

- `mesa.changes.create(...)` and `mesa.changes.patch(...)` now accept empty string descriptions. Pass `None` to omit the field; pass `""` to create or update a change with no description.
- `mesa.bookmarks.merge(...)` now accepts `message`; pass `None` to use the generated merge description, or pass `""` to create the merge with no description.

## [0.29.3] - 2026-05-18

### Fixed

- Make every `mesa.fs` write durable before the operation returns

## [0.29.2] - 2026-05-17

### Added

- Add `mesa.bookmarks.get(repo=..., bookmark=...)` for direct bookmark lookup by name, and add `glob` filtering to `mesa.bookmarks.list(repo=..., glob=...)`
- Add optional `ref_globs` filters to `mesa.repos.sync_upstream(...)`: omit it to sync all supported branches and tags, or pass branch/tag glob strings such as `{"branches": "main"}`

### Fixed

- Fix `mesa.fs.mount()` dropping recently written file bytes by flushing pending mount writes before revoking the scoped API key

## [0.29.0] - 2026-05-15

### Added

- Add `VIRTUAL_ROOT_CHANGE_ID` export for referencing the virtual-root sentinel change id from `mesa_sdk`
- Add `mesa.repos.sync_upstream(repo=..., direction=...)` to enqueue a sync with a repository's configured upstream. Returns the `sync` row; the worker processes it asynchronously. Read `repo.upstream.latest_sync`, call `mesa.repos.get_upstream_sync(repo=..., sync_id=...)`, list `mesa.repos.list_upstream_syncs(repo=...)`, or subscribe to `sync.{queued,in_progress,completed,failed}` webhooks
- Add `mesa.repos.get_upstream_sync(repo=..., sync_id=...)` and `mesa.repos.list_upstream_syncs(repo=...)` for reading repository upstream sync history
- `mesa.repos.create()` and `mesa.repos.update()` accept `upstream=UpstreamConfig(url=..., auth=...)` to set or replace the upstream remote inline. On `update()`, pass `upstream=None` to remove the upstream entirely, or omit the argument to leave it unchanged. Repository responses include the upstream configuration with `latest_sync`; secrets are never returned
- `UpstreamConfig.auth` is tri-state, mirroring the REST surface: default `UNSET` (on `update()` leaves any stored credential untouched; on `create()` produces a public upstream); `None` explicitly clears the stored credential; a `TokenAuth` or `UsernamePasswordAuth` sets or replaces it. Individual fields inside the auth object (`token`, `password`, `username`, `token_username`) are atomic and must be sent in full
- New public types in `mesa_sdk.types`: `UpstreamConfig`, `UsernamePasswordAuth`, `TokenAuth`, and the `UpstreamAuth` union

### Changed

- Resolving the default bookmark of a freshly created (never-written-to) repo continues to return the virtual root sentinel `change_id`. The server-side lazy-seed behavior is transparent to SDK consumers — the first write through any path advances the bookmark to a real change ([MES-1387](https://linear.app/mesa-dev/issue/MES-1387))

### Removed

- **Breaking:** Remove the public `mesa.raw` generated REST client attribute; use `mesa-rest` directly for low-level REST access

## [0.28.2] - 2026-05-07

### Added

- Add `fs.changes.current(repo)` to query the currently active change on a mounted repo. Returns `ChangeInfo` with `change_id` and `commit_oid`.

## [0.28.1] - 2026-05-06

### Changed

- Coordinate `MesaFileSystem` cache budgets across instances in a single process;
  `disk_cache.max_size_bytes=None` now auto-sizes against system resources instead of being unbounded

### Fixed

- Fix segfault on process exit caused by crash handler outliving the Python interpreter. The native extension now uninstalls the crash handler via `atexit` before teardown.
- Fix `rg` and other tools that resolve `/..` by clamping `resolve_path` at the filesystem root.

## [0.28.0] - 2026-05-03

### Added

- Added support for conflicts in the FS interfaces. Conflicting files render `jj`-style conflict
  semantics.

### Fixed

- Raise `ConflictError` instead of a generic API error on concurrent bookmark writes.
- Fixed race condition in cache deallocation causing crashes on binding destruction.

## [0.27.0] - 2026-04-30

### Changed

- Replace pure-Python wheel with platform-specific wheels containing a native
  extension (manylinux, musllinux, macOS arm64). Python 3.10+ required.
- Filesystem errors use Python's built-in exception hierarchy
  (`FileNotFoundError`, `IsADirectoryError`, `PermissionError`, etc.) instead of
  `MesaError` subclasses.

### Added

- Add `mesa.fs.mount()` async context manager for mounting repos as a virtual
  filesystem. Automatically mints a scoped API key on entry and revokes it on
  exit (with a 1-hour server-side TTL fallback).
- Add `MesaFileSystem` python interface with full async file I/O: `read`,
  `write`, `append`, `exists`, `stat`, `lstat`, `readdir`, `mkdir`, `rm`, `cp`,
  `mv`, `chmod`, `symlink`, `readlink`, `realpath`, and `utimes`.
- Add `fs.changes` namespace for change management on a mounted filesystem:
  `new`, `edit`, and `list`.
- Add `fs.bookmarks` namespace for bookmark management on a mounted filesystem:
  `create` and `list`.
- Add `Bash` class for running shell commands against a mounted filesystem via
  `fs.bash()`. Supports `env`, `cwd`, and `timeout_ms`.

## [0.26.0] - 2026-04-29

### Fixed


- Fix repo list cache not being exercised through the SDK codepath, hitting an uncached API on every
  call.
