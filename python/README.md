# mesa-sdk

Official Mesa Python SDK.

This is the primary Python SDK for Mesa. It wraps the generated [`mesa-rest`](https://pypi.org/project/mesa-rest/) client with ergonomic async resource namespaces and automatic org inference.

Python 3.10+ is required.

## Install

```bash
pip install mesa-sdk
```

## Quick Start

```python
import asyncio
from mesa_sdk import Mesa

async def main():
    async with Mesa(api_key="mk_...") as mesa:
        repos = await mesa.repos.list()
        print(repos)

asyncio.run(main())
```

## Usage

### Org Resolution

The SDK resolves your default organization automatically via `/whoami` on first use. You can bypass this by passing `org` to the constructor or overriding per-call:

```python
# Default: org inferred from /whoami (lazy, cached)
mesa = Mesa(api_key="mk_...")
repos = await mesa.repos.list()

# Constructor org bypasses /whoami entirely
mesa = Mesa(api_key="mk_...", org="acme")
repos = await mesa.repos.list()

# Per-call override
repos = await mesa.repos.list(org="other-org")
```

### Repositories

```python
# List
repos = await mesa.repos.list()

# Create
repo = await mesa.repos.create(name="my-repo")

# Get
repo = await mesa.repos.get(repo="my-repo")

# Update
repo = await mesa.repos.update(repo="my-repo", name="renamed")

# Delete
await mesa.repos.delete(repo="my-repo")
```

### Bookmarks

```python
bookmarks = await mesa.bookmarks.list(repo="my-repo")
await mesa.bookmarks.create(repo="my-repo", name="feature-x", change_id="abc123")
await mesa.bookmarks.move(repo="my-repo", bookmark="feature-x", change_id="def456")
await mesa.bookmarks.merge(repo="my-repo", source="feature-x", target="main", message="Merge feature-x into main")
await mesa.bookmarks.delete(repo="my-repo", bookmark="feature-x")
```

### Changes

```python
from mesa_sdk import Author, FileUpsert

changes = await mesa.changes.list(repo="my-repo")
change = await mesa.changes.create(
    repo="my-repo",
    base_change_id="abc123",
    message="Add feature",
    author=Author(name="Alice", email="alice@example.com"),
    files=[FileUpsert(path="hello.txt", content="Hello, world!")],
)
change = await mesa.changes.get(repo="my-repo", change_id="def456")
```

### Content & Diffs

```python
content = await mesa.content.get(repo="my-repo", change_id="abc123")
diff = await mesa.diffs.get(
    repo="my-repo",
    base_change_id="abc123",
    head_change_id="def456",
)
```

### API Keys

```python
keys = await mesa.api_keys.list()
key = await mesa.api_keys.create(name="ci-key", scopes=["read", "write"])
await mesa.api_keys.revoke(key_id=key.id)
```

### Webhook Targets

```python
endpoints = await mesa.webhook_targets.list()
endpoint = await mesa.webhook_targets.create(url="https://example.com/hook", events=["change.created"])
await mesa.webhook_targets.update(webhook_target_id=endpoint.id, events=["push"])
await mesa.webhook_targets.delete(webhook_target_id=endpoint.id)
```

### Webhook Handlers

Register handlers with `mesa.webhooks.on(...)` and pass the raw request body
and headers to `mesa.webhooks.receive(...)`. `receive` verifies the signature,
parses the payload, and dispatches registered handlers.

```python
from fastapi import FastAPI, Request
from mesa_sdk import Mesa

app = FastAPI()
mesa = Mesa(api_key="mk_...", org="acme", webhook_secret="whsec_...")

mesa.webhooks.on("push", lambda event: print(event["data"]["updates"]))

@app.post("/webhooks/mesa")
async def mesa_webhook(request: Request):
    await mesa.webhooks.receive(await request.body(), request.headers)
    return {"ok": True}
```

### Virtual Filesystem

Mount repositories as a local filesystem for direct file I/O. The `mount()` context manager handles setup and teardown automatically.

```python
async with mesa.fs.mount(repos=["my-repo"]) as fs:
    data = await fs.read("/my-repo/src/main.py")
    await fs.write("/my-repo/src/new_file.py", b"print('hello')")
    entries = await fs.readdir("/my-repo/src")
```

### Read-only Repos

Pass `RepoConfig(..., mode="ro")` to mount a repo read-only. Writes to it raise `OSError: [Errno 30] Read-only file system`. A single mount can mix read-only and writable repos.

```python
from mesa_sdk import RepoConfig

async with mesa.fs.mount(repos=[RepoConfig("my-repo", mode="ro")]) as fs:
    data = await fs.read("/my-repo/README.md")
```

### Multiple Repos

Mount several repositories at once. Each repo appears as a top-level directory.

```python
async with mesa.fs.mount(repos=["repo-a", "repo-b"]) as fs:
    a = await fs.read("/repo-a/file.txt")
    b = await fs.read("/repo-b/file.txt")
```

### Pin to Bookmark or Change

Use `RepoConfig` with `at` to pin a mount to a specific bookmark or change.

```python
from mesa_sdk import RepoConfig

async with mesa.fs.mount(repos=[
    RepoConfig("my-repo", at={"bookmark": "feature-x"}),
    RepoConfig("other-repo", at={"change_id": "abc123"}),
]) as fs:
    data = await fs.read("/my-repo/file.txt")
```

### Bash

Run shell commands inside the mounted filesystem with `fs.bash()`.

```python
async with mesa.fs.mount(repos=["my-repo"]) as fs:
    bash = fs.bash(env={"FOO": "bar"}, cwd="/my-repo", timeout_ms=30000)
    result = await bash.exec("ls -la")
    print(result.stdout, result.stderr, result.exit_code)
```

`bash.exec()` returns an `ExecResult` with `stdout: bytes`, `stderr: bytes`, and `exit_code: int`.

### Changes and Bookmarks (on the Filesystem)

Create and manage changes and bookmarks directly from a mounted filesystem.

```python
async with mesa.fs.mount(repos=["my-repo"]) as fs:
    # Changes
    change = await fs.changes.new("my-repo", bookmark="main")
    change = await fs.changes.edit("my-repo", change_id="abc123")
    changes = await fs.changes.list("my-repo", limit=50)
    result = await fs.changes.checkpoint("my-repo", message="did some work")

    # Bookmarks
    await fs.bookmarks.create("my-repo", "feature-y")
    await fs.bookmarks.move("my-repo", "main", change_id=change)
    bookmarks = await fs.bookmarks.list("my-repo")
```

### Disk Cache

Enable on-disk caching to speed up repeated mounts.

```python
from mesa_sdk import DiskCacheConfig

async with mesa.fs.mount(
    repos=["my-repo"],
    disk_cache=DiskCacheConfig(path="/tmp/mesa-cache", max_size_bytes=1_000_000_000),
) as fs:
    data = await fs.read("/my-repo/file.txt")
```

### Filesystem Errors

Filesystem operations raise standard Python exceptions:

| Exception | Condition |
|-----------|-----------|
| `FileNotFoundError` | Path does not exist |
| `FileExistsError` | Path already exists (e.g. `mkdir` without parents) |
| `IsADirectoryError` | Expected a file, got a directory |
| `NotADirectoryError` | Expected a directory, got a file |
| `OSError` | General I/O failure; read-only repos use the read-only filesystem errno |
| `NotImplementedError` | Operation not supported (e.g. `link`) |

### Low-Level REST Access

For operations not covered by the resource namespaces, install and use `mesa-rest` directly, or call the API with your own HTTP client:

```python
from mesa_rest.api.repo import list_repos
from mesa_rest.client import AuthenticatedClient

client = AuthenticatedClient(
    base_url="https://api.mesa.dev/v1",
    token="mk_...",
    prefix="Bearer",
)
response = await list_repos.asyncio_detailed("acme", client=client)
```

## Configuration

`Mesa` accepts the following keyword arguments:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `api_key` | `str \| None` | `MESA_API_KEY` env var | API key for authentication |
| `api_url` | `str` | `https://api.mesa.dev/v1` | Base URL for the Mesa API |
| `vcs_url` | `str \| None` | `None` | Optional VCS gateway override. Only use when self-hosting Mesa. |
| `org` | `str \| None` | Resolved from `/whoami` | Default organization slug |
| `user_agent` | `str \| None` | `None` | Custom user agent suffix |
| `webhook_secret` | `str \| None` | `None` | Secret used by `mesa.webhooks.receive(...)` |

## Error Handling

The SDK raises typed exceptions for API errors:

```python
from mesa_sdk import Mesa, NotFoundError, AuthenticationError

async with Mesa() as mesa:
    try:
        repo = await mesa.repos.get(repo="nonexistent")
    except NotFoundError:
        print("Repo not found")
    except AuthenticationError:
        print("Invalid API key")
```

| Exception | HTTP Status | Description |
|-----------|-------------|-------------|
| `ValidationError` | 400, 406 | Invalid request parameters |
| `AuthenticationError` | 401 | Invalid or missing API key |
| `AuthorizationError` | 403 | Insufficient permissions |
| `NotFoundError` | 404 | Resource not found |
| `ConflictError` | 409 | Resource conflict |
| `RateLimitError` | 429 | Rate limit exceeded |
| `ServerError` | 5xx | Server-side error |

All API exceptions inherit from `ApiError`, which inherits from `MesaError`.

## Package Relationship

- `mesa-sdk` is the ergonomic, main SDK.
- `mesa-rest` is the generated REST client used under the hood.

Use `mesa-rest` directly, or call the API with your own HTTP client, when you need low-level REST access beyond the resource namespaces.
