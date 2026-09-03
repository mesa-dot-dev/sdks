# Virtual Filesystem

The Mesa Python SDK exposes remote repositories as a virtual filesystem. You
read, write, and run shell commands against repos without cloning them. The SDK
handles authentication, caching, and cleanup behind the scenes.

## Setup

```bash
pip install mesa-sdk
```

Set `MESA_PRIVATE_KEY` in your environment, or pass it directly:

```python
import asyncio
import os
from mesa_sdk import Mesa, repo

async def main():
    async with Mesa(private_key=os.environ["MESA_PRIVATE_KEY"]) as mesa:
        async with mesa.fs(
            layout={"/workspace": repo("my-repo", mode="rw")},
            authors=[{"name": "Mesa Bot", "email": "mesa-bot@example.com"}],
        ).mount() as fs:
            data = await fs.read("/workspace/README.md")
            print(data.decode())

asyncio.run(main())
```

## How mounting works

Every mount has a **layout**: a map of absolute paths to `repo(...)`
declarations. Call `mesa.fs(layout=..., authors=..., ttl=...)` to build a
`LayoutDefinition`, then `.mount()` to open it.

`definition.mount()` is an async context manager. When you enter it, the SDK:

1. Signs one short-lived, layout-scoped access token (JWT) locally from your
   private key. The token's repo scope is encoded as full
   `org/repo` names collected from the layout. Scopes are `["read"]` when every
   declaration is `"ro"`, otherwise `["read", "write"]`.
2. Connects to the Mesa VCS backend and yields a `MesaFileSystem` whose
   namespace is exactly the layout paths.

The mount uses that single token for its whole lifetime. There is no background
refresh and no credential hot-swap: when the token expires, the mount stops
authenticating. When the context exits (normally or on error), the SDK flushes
pending filesystem writes.

```python
async with mesa.fs(
    layout={"/workspace": repo("my-repo", mode="rw")},
    authors=[{"name": "Mesa Bot", "email": "mesa-bot@example.com"}],
).mount() as fs:
    # fs is a MesaFileSystem — use it here
    ...
# pending writes flushed, connection closed; the token self-expires
```

Paths inside the mount are whatever the layout declares — for example
`/workspace/src/main.py`, not `/org/repo/...`.

Private-key clients **require** `authors` on the definition. Access-token
clients reject `authors`.

### Token lifetime (`ttl`)

Pass `ttl` (seconds) on the definition to choose the lifetime of every token it
mints — both `token()` and the token used under the hood by `mount()`. Once it
expires, the mount stops authenticating, so pick a value that covers the work.

```python
# Mount for 4 hours
async with mesa.fs(
    layout={"/workspace": repo("my-repo", mode="rw")},
    authors=[{"name": "Mesa Bot"}],
    ttl=14_400,
).mount() as fs:
    ...
```

`ttl` defaults to `900` (15 minutes) and is capped at `14_400` (4 hours). A
value outside that range raises `InvalidOptionsError`.

### Minting a layout token without mounting

```python
definition = mesa.fs(
    layout={"/workspace": repo("my-repo", mode="rw")},
    authors=[{"name": "Mesa Bot"}],
    ttl=3600,
)
token = (await definition.token()).token
# Hand token + definition.layout() to a sandbox running `mesa mount --layout`
```

## Reading files

`read` returns the raw bytes of a file:

```python
raw = await fs.read("/workspace/config.json")
```

To work with text, decode the result:

```python
text = (await fs.read("/workspace/README.md")).decode()
```

There is no `read_text` method. Always use `read` and decode explicitly.

## Writing files

`write` replaces a file's contents, creating it if it does not exist. The
parent directory must already exist:

```python
await fs.write("/workspace/output.txt", b"hello")
```

`append` appends to an existing file or creates a new one:

```python
await fs.append("/workspace/log.txt", b"line 1\n")
await fs.append("/workspace/log.txt", b"line 2\n")
```

If the parent directory is missing, create it first:

```python
await fs.mkdir("/workspace/new-dir", recursive=True)
await fs.write("/workspace/new-dir/file.txt", b"content")
```

There is no `write_text` or `append_text` method. Encode strings before passing
them in:

```python
await fs.write("/workspace/notes.md", "some text".encode())
```

## Checking existence

```python
if await fs.exists("/workspace/config.yaml"):
    cfg = await fs.read("/workspace/config.yaml")
```

`exists` follows symlinks. It returns `False` for dangling symlinks.

## Listing directories

`readdir` returns entry names as plain strings:

```python
names = await fs.readdir("/workspace/src")
# ["main.py", "utils.py", "tests"]
```

Order is not guaranteed. Sort client-side if you need deterministic output.

## File metadata

`stat` returns an `FsStat` object and follows symlinks. `lstat` does not follow
symlinks, so you can inspect the symlink itself.

```python
info = await fs.stat("/workspace/src/main.py")
print(info.size)          # bytes
print(info.is_file)       # True
print(info.is_directory)  # False
print(info.mode)          # e.g. 0o100644
print(info.mtime_ms)      # milliseconds since epoch
```

`FsStat` fields:

| Field | Type | Description |
|---|---|---|
| `is_file` | `bool` | Regular file |
| `is_directory` | `bool` | Directory |
| `is_symbolic_link` | `bool` | Symlink (always `False` from `stat`, may be `True` from `lstat`) |
| `mode` | `int` | Permission bits |
| `size` | `int` | Size in bytes |
| `mtime_ms` | `float` | Modification time (milliseconds since epoch) |

## File operations

**Copy:**

```python
await fs.cp("/workspace/a.txt", "/workspace/b.txt")
await fs.cp("/workspace/src", "/workspace/src-backup", recursive=True)
```

**Move / rename:**

```python
await fs.mv("/workspace/old.txt", "/workspace/new.txt")
```

**Remove:**

```python
await fs.rm("/workspace/temp.txt")
await fs.rm("/workspace/build", recursive=True)
await fs.rm("/workspace/maybe-missing.txt", force=True)  # no error if absent
```

**Create directories:**

```python
await fs.mkdir("/workspace/out")
await fs.mkdir("/workspace/a/b/c", recursive=True)  # creates parents
```

## Symlinks

Create a symlink with `symlink`. The target is stored verbatim:

```python
await fs.symlink("../lib/utils.py", "/workspace/src/utils_link.py")
```

Read the raw target of a symlink:

```python
target = await fs.readlink("/workspace/src/utils_link.py")
# "../lib/utils.py"
```

Resolve a path through all symlinks to a canonical absolute path:

```python
real = await fs.realpath("/workspace/src/utils_link.py")
# "/workspace/lib/utils.py"
```

`resolve_path` joins and normalizes paths without any I/O:

```python
p = fs.resolve_path("/workspace/src", "../lib/utils.py")
# "/workspace/lib/utils.py"
```

> Hard links are not supported. Calling `fs.link()` raises `NotImplementedError`.

## Permissions and timestamps

Set permission bits with `chmod`:

```python
await fs.chmod("/workspace/run.sh", 0o755)
```

Set access and modification times with `utimes`:

```python
import time

now_ms = time.time() * 1000
await fs.utimes("/workspace/file.txt", atime_ms=now_ms, mtime_ms=now_ms)
```

> **Warning:** `utimes` takes **milliseconds** since the Unix epoch, not
> seconds. Multiply `time.time()` by 1000.

## Running shell commands

`fs.bash()` creates a `Bash` interpreter that runs commands against the mounted
filesystem. No host shell is spawned.

```python
bash = fs.bash(cwd="/workspace", env={"CI": "true"}, timeout_ms=60_000)
result = await bash.exec("ls src/ | wc -l")
print(result.stdout.decode().strip())
```

**`bash()` parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `env` | `Mapping[str, str] \| None` | empty | Environment variables. Host env is **not** inherited. |
| `cwd` | `str \| None` | `"/"` | Working directory inside the mount. |
| `timeout_ms` | `int \| None` | 30000 | Per-exec wall-clock timeout in milliseconds. |

**`ExecResult` fields:**

| Field | Type | Description |
|---|---|---|
| `stdout` | `bytes` | Standard output |
| `stderr` | `bytes` | Standard error |
| `exit_code` | `int` | Exit code (0 = success) |

Shell pipelines work as expected:

```python
result = await bash.exec("grep -r TODO /workspace/src | sort | head -20")
```

> **Binary files and `cat`:** If you `cat` a binary (non-UTF-8) file, the
> command fails with a non-zero exit code and stderr points you to
> `read` as the correct alternative. Use `read` for any file that
> might contain non-text content.

## Working with changes

A *change* in Mesa is analogous to a commit in git. The filesystem exposes
change operations through `fs.changes`.

Create a new change forked from a bookmark:

```python
change_id = await fs.changes.new("my-repo", bookmark="main")
```

Or fork from an existing change:

```python
child_id = await fs.changes.new("my-repo", change_id=change_id)
```

Check out an existing bookmark or change (never creates a new one):

```python
active_id = await fs.changes.edit("my-repo", change_id=change_id)
```

List recent changes:

```python
changes = await fs.changes.list("my-repo", limit=10)
for c in changes:
    print(c.change_id, c.commit_oid)
```

Get the currently active change:

```python
info = await fs.changes.current("my-repo")
print(info.change_id, info.commit_oid)
```

Flush pending writes (serializing concurrent writes and tree mutations in the
same repo), optionally describe the current change, fork a descendant, and
advance bookmarks onto that descendant (requires the checkout to already be on
a bookmark):

```python
result = await fs.changes.checkpoint("my-repo", message="did some work")
print(result.saved_change_oid, result.active_change_oid)
```

Omit `message` to preserve the existing description; pass `message=""` to
clear it.

`ChangeInfo` fields:

| Field | Type |
|---|---|
| `change_id` | `str` |
| `commit_oid` | `str` |

## Working with bookmarks

Bookmarks are named references analogous to git branches. The filesystem
exposes bookmark operations through `fs.bookmarks`.

List all bookmarks on a repo:

```python
names = await fs.bookmarks.list("my-repo")
```

Create a bookmark at the current change's commit:

```python
await fs.bookmarks.create("my-repo", "feature-x")
```

> `create` raises `FileExistsError` if the bookmark already exists.

Merge and move operations are available through the REST API resource
(`mesa.bookmarks.merge`, `mesa.bookmarks.move`), not through the filesystem
namespace.

## Multiple repositories and nesting

Declare several repositories in one layout. Each appears at the path you choose:

```python
async with mesa.fs(
    layout={
        "/frontend": repo("frontend", mode="rw"),
        "/backend": repo("backend", mode="rw"),
        "/shared": repo("shared", mode="ro"),
    },
    authors=[{"name": "Mesa Bot"}],
).mount() as fs:
    fe = await fs.read("/frontend/package.json")
    be = await fs.read("/backend/pyproject.toml")
    lib = await fs.readdir("/shared/src")
```

Nest repositories under another with `sub_paths`, or place several under one
directory with an array value (optionally with `alias`).

## Pinning and fork-on-open

Pin a declaration with `at={"bookmark": ...}` or `at={"change_id": ...}`. Use `branched_from` to fork a
new empty descendant at cold open (requires `mode="rw"`):

```python
async with mesa.fs(
    layout={
        "/workspace": repo(
            "my-repo",
            mode="rw",
            branched_from={
                "bookmark": "main",
                "as": {"bookmark": "run-27", "describe": "agent run"},
            },
        ),
        "/docs": repo("docs", mode="ro", at={"bookmark": "main"}),
    },
    authors=[{"name": "Mesa Bot"}],
).mount() as fs:
    ...
```

When neither pin nor `branched_from` is set, the mount checks out the
repository's default bookmark.

## Read-only repositories

`mode` is required on every `repo(...)`. Pass `mode="ro"` to reject writes with
`OSError: [Errno 30] Read-only file system`. A single layout can mix read-only
and writable repositories:

```python
async with mesa.fs(
    layout={
        "/workspace": repo("app", mode="rw"),
        "/skills": repo("skills", mode="ro"),
    },
    authors=[{"name": "Mesa Bot"}],
).mount() as fs:
    data = await fs.read("/skills/README.md")  # works
    await fs.write("/skills/x.txt", b"nope")   # raises OSError
```

## Disk caching

By default the mount uses an in-memory cache only. For long-running processes or
repeated mounts, enable on-disk caching on `.mount(...)`:

```python
from mesa_sdk import DiskCacheConfig

async with mesa.fs(
    layout={"/workspace": repo("my-repo", mode="rw")},
    authors=[{"name": "Mesa Bot"}],
).mount(
    disk_cache=DiskCacheConfig("/tmp/mesa-cache", max_size_bytes=1_000_000_000),
) as fs:
    ...
```

`DiskCacheConfig` accepts `path` as a positional argument. `max_size_bytes` is
keyword-only and optional:

```python
DiskCacheConfig("/tmp/mesa-cache")                          # no size limit
DiskCacheConfig("/tmp/mesa-cache", max_size_bytes=500_000_000)  # 500 MB cap
```

Use disk caching when you mount the same repos frequently (e.g., in a CI
pipeline or a long-lived agent) and want to avoid re-fetching unchanged data.

## Error handling

Filesystem operations raise standard Python exceptions, not `MesaError`:

```python
import errno

try:
    data = await fs.read("/workspace/missing.txt")
except FileNotFoundError:
    print("file does not exist")

try:
    await fs.mkdir("/workspace/existing-dir")
except FileExistsError:
    print("directory already exists")

try:
    await fs.write("/workspace/file.txt", b"data")
except OSError as exc:
    if exc.errno == errno.EROFS:
        print("repo is read-only")
    else:
        raise
```

| Exception | When raised |
|---|---|
| `FileNotFoundError` | Path does not exist |
| `FileExistsError` | Path already exists (e.g., `mkdir` without `recursive`, duplicate bookmark) |
| `IsADirectoryError` | Expected a file, got a directory |
| `NotADirectoryError` | Expected a directory, got a file |
| `OSError` | General I/O failure; read-only repos use the read-only filesystem errno |
| `NotImplementedError` | `link()` (hard links not supported) |

## Multiprocessing

The Mesa filesystem is **not fork-safe**. If you use `multiprocessing`, set the
start method before creating any Mesa objects:

```python
import multiprocessing

multiprocessing.set_start_method("spawn")  # or "forkserver"
```

## Complete example

This script creates a change on a repo, writes a Python module, runs its tests
with `bash`, and prints the results:

```python
import asyncio
import os
from mesa_sdk import Mesa, repo

async def main():
    async with Mesa(private_key=os.environ["MESA_PRIVATE_KEY"]) as mesa:
        async with mesa.fs(
            layout={"/workspace": repo("my-repo", mode="rw")},
            authors=[{"name": "Mesa Bot", "email": "mesa-bot@example.com"}],
        ).mount() as fs:
            # Create a new change from the main bookmark
            change_id = await fs.changes.new("my-repo", bookmark="main")
            print(f"working on change {change_id}")

            # Write a module and a test
            await fs.mkdir("/workspace/src", recursive=True)
            await fs.write("/workspace/src/greet.py", b"""\
def greet(name: str) -> str:
    return f"Hello, {name}!"
""")

            await fs.mkdir("/workspace/tests", recursive=True)
            await fs.write("/workspace/tests/test_greet.py", b"""\
from src.greet import greet

def test_greet():
    assert greet("World") == "Hello, World!"
""")

            # Run pytest via bash
            bash = fs.bash(
                cwd="/workspace",
                env={"PYTHONPATH": "/workspace"},
                timeout_ms=60_000,
            )
            result = await bash.exec("python -m pytest tests/ -v")
            print(result.stdout.decode())

            if result.exit_code != 0:
                print("tests failed")
                print(result.stderr.decode())
            else:
                print("tests passed")

asyncio.run(main())
```

## API reference

### LayoutDefinition (`mesa.fs(...)`)

| Member | Signature | Returns |
|---|---|---|
| `layout` | `()` | `Layout` |
| `mount` | `(*, disk_cache: DiskCacheConfig \| None = None)` | async context manager → `MesaFileSystem` |
| `token` | `()` | `TokenCreateResult` |

### `repo(...)`

| Parameter | Type | Notes |
|---|---|---|
| `selector` | `str \| RepoName` | Repository name |
| `mode` | `"rw" \| "ro"` | **Required** |
| `at` | `Mapping \| None` | Pin: `{"bookmark": ...}` or `{"change_id": ...}`; mutually exclusive with `branched_from` |
| `branched_from` | `Mapping \| None` | Fork-on-open; requires `mode="rw"` |
| `alias` | `str \| None` | Array-element directory name override |
| `sub_paths` | `Mapping \| None` | Nested layout under this repo |

### MesaFileSystem

| Method | Signature | Returns |
|---|---|---|
| `read` | `(path: str)` | `bytes` |
| `write` | `(path: str, content: bytes)` | `None` |
| `append` | `(path: str, content: bytes)` | `None` |
| `exists` | `(path: str)` | `bool` |
| `stat` | `(path: str)` | `FsStat` |
| `lstat` | `(path: str)` | `FsStat` |
| `readdir` | `(path: str)` | `list[str]` |
| `realpath` | `(path: str)` | `str` |
| `readlink` | `(path: str)` | `str` |
| `resolve_path` | `(base: str, path: str)` | `str` |
| `mkdir` | `(path: str, *, recursive: bool \| None = None)` | `None` |
| `rm` | `(path: str, *, recursive: bool \| None = None, force: bool \| None = None)` | `None` |
| `cp` | `(src: str, dest: str, *, recursive: bool \| None = None)` | `None` |
| `mv` | `(src: str, dest: str)` | `None` |
| `chmod` | `(path: str, mode: int)` | `None` |
| `symlink` | `(target: str, link: str)` | `None` |
| `utimes` | `(path: str, atime_ms: float, mtime_ms: float)` | `None` |
| `link` | `(existing: str, new: str)` | raises `NotImplementedError` |
| `bash` | `(*, env: Mapping[str, str] \| None = None, cwd: str \| None = None, timeout_ms: int \| None = None)` | `Bash` |

All methods except `resolve_path`, `link`, and `bash` are `async`.

### Bash

| Method | Signature | Returns |
|---|---|---|
| `exec` | `(commands: str)` | `ExecResult` |

`exec` is `async`.

### ExecResult

| Field | Type |
|---|---|
| `stdout` | `bytes` |
| `stderr` | `bytes` |
| `exit_code` | `int` |

### ChangesOps (`fs.changes`)

| Method | Signature | Returns |
|---|---|---|
| `new` | `(repo: str, *, bookmark: str \| None = None, change_id: str \| None = None, message: str \| None = None)` | `str` (change hex ID) |
| `edit` | `(repo: str, *, bookmark: str \| None = None, change_id: str \| None = None)` | `str` (change hex ID) |
| `list` | `(repo: str, *, limit: int = 50)` | `list[ChangeInfo]` |
| `current` | `(repo: str)` | `ChangeInfo` |
| `checkpoint` | `(repo: str, message: str \| None = None)` | `CheckpointResult` |

All methods are `async`.

### BookmarksOps (`fs.bookmarks`)

| Method | Signature | Returns |
|---|---|---|
| `create` | `(repo: str, name: str)` | `None` |
| `move` | `(repo: str, name: str, *, change_id: str, allow_backwards: bool = False)` | `None` |
| `list` | `(repo: str)` | `list[str]` |

All methods are `async`.

### Config types

| Type | Constructor |
|---|---|
| `DiskCacheConfig` | `(path: str, *, max_size_bytes: int \| None = None)` |
