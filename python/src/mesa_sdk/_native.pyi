"""Type stubs for :mod:`mesa_sdk`'s compiled types.

Public types like :class:`MesaConfig`, :class:`Bash`, and :class:`ExecResult`
are defined here and re-exported from :mod:`mesa_sdk`.
"""
from __future__ import annotations

from typing import Literal, Mapping, Sequence, final, overload

__all__ = [
    "Bash",
    "ChangeInfo",
    "CheckpointResult",
    "DiskCacheConfig",
    "ExecResult",
    "FsStat",
    "MesaConfig",
    "MountMode",
    "RepoConfig",
    "_NativeMesaFileSystemWatcher",
    "_NativeWatchEvent",
    "_NativeMesaFileSystem",
    "_uninstall_crash_handler",
    "validate_layout",
]

def _uninstall_crash_handler() -> None: ...

def validate_layout(layout_json: str) -> None:
    """Validate a serialized layout document against the core mount schema.

    Structural rules only: raises :exc:`ValueError` with the exact error a
    mount would report for a structurally invalid document. Repository
    names are not resolved here.
    """
    ...

# ---------------------------------------------------------------------------
# Config types
# ---------------------------------------------------------------------------

@final
class MountMode:
    """Whether a mounted repo accepts mutations.

    Use ``MountMode.rw`` / ``MountMode.ro``. The strings ``"rw"`` / ``"ro"``
    are also accepted where a mode is taken (e.g. :class:`RepoConfig`).
    """

    rw: MountMode
    ro: MountMode

    def __eq__(self, other: object) -> bool: ...
    def __int__(self) -> int: ...
    def __hash__(self) -> int: ...

@final
class RepoConfig:
    """Per-repo mount configuration.

    Open an existing revision with ``at`` / ``mode``, or fork a new
    revision at mount time with ``branched_from`` (writable only).
    ``at`` and ``branched_from`` are mutually exclusive. Pass
    ``as={"bookmark": ...}`` to name the fork, or omit ``as.bookmark`` for
    an anonymous tip. ``branched_from`` permits only ``MountMode.rw`` (or omit
    ``mode`` for the writable default).
    """

    name: str
    mode: MountMode | None

    @overload
    def __new__(
        cls,
        name: str,
        *,
        mode: MountMode | Literal["rw", "ro"] | None = None,
        at: Mapping[str, str] | None = None,
        branched_from: None = None,
    ) -> RepoConfig: ...
    @overload
    def __new__(
        cls,
        name: str,
        *,
        mode: MountMode | Literal["rw"] | None = None,
        at: None = None,
        branched_from: Mapping[str, object],
    ) -> RepoConfig: ...

@final
class DiskCacheConfig:
    """Optional on-disk cache backing the mounted filesystem.

    When ``None``, the mount uses an in-memory cache only. Set this for
    long-running processes that benefit from cache survival across
    restarts.
    """

    path: str
    max_size_bytes: int | None

    def __new__(
        cls,
        path: str,
        *,
        max_size_bytes: int | None = None,
    ) -> DiskCacheConfig: ...

@final
class MesaConfig:
    """Configuration for opening a :class:`MesaFileSystem`.

    Most users obtain a config indirectly through
    :meth:`mesa.fs.mount() <mesa_sdk.FsNamespace.mount>`. Construct this
    directly only when you manage the bearer credential's lifecycle yourself.

    :param org: The organization slug.
    :param api_key: API key or access token with access to every repo in
        ``repos``. Private keys are rejected.
    :param repos: Per-repo configuration. Each entry pins a repo to a
        bookmark or change.
    :param mounted_repos: Restrict the mount to these repo names.
        ``"all"`` or ``None`` mounts every repo the API key can access.
    :param disk_cache: Optional on-disk cache placement.
    :param api_base_url: Override the default API endpoint.
    :param vcs_url: Override the default VCS endpoint.
    """

    org: str
    api_key: str
    repos: list[RepoConfig]
    layout: str | None
    mounted_repos: list[str] | Literal["all"] | None
    disk_cache: DiskCacheConfig | None
    api_base_url: str | None
    vcs_url: str | None

    def __new__(
        cls,
        org: str,
        api_key: str,
        repos: Sequence[RepoConfig],
        *,
        layout: str | None = None,
        mounted_repos: list[str] | Literal["all"] | None = None,
        disk_cache: DiskCacheConfig | None = None,
        api_base_url: str | None = None,
        vcs_url: str | None = None,
    ) -> MesaConfig: ...

# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@final
class FsStat:
    """File metadata returned by :meth:`MesaFileSystem.stat` / :meth:`lstat`.

    Mirrors :class:`os.stat_result` but milliseconds-based and
    symlink-aware via the boolean flags.
    """

    is_file: bool
    is_directory: bool
    is_symbolic_link: bool
    mode: int
    size: int
    mtime_ms: float

@final
class ChangeInfo:
    """A change reachable from a repo's current checkout.

    Returned by :meth:`fs.changes.list <mesa_sdk.ChangesOps.list>`.
    """

    change_id: str
    commit_oid: str

@final
class CheckpointResult:
    """Result of :meth:`fs.changes.checkpoint <mesa_sdk.ChangesOps.checkpoint>`.

    Contains both the described (saved) change and the now-active empty
    descendant after the checkpoint fork.
    """

    saved_change_oid: str
    active_change_oid: str

@final
class _NativeWatchEvent:
    path: str
    recursive: bool

@final
class ExecResult:
    """Result of :meth:`Bash.exec`.

    Mirrors :class:`subprocess.CompletedProcess` with bytes output.
    """

    stdout: bytes
    stderr: bytes
    exit_code: int

# ---------------------------------------------------------------------------
# Internal — :class:`mesa_sdk.MesaFileSystem` is the supported user surface.
# ---------------------------------------------------------------------------

@final
class _NativeMesaFileSystem:
    @staticmethod
    async def connect(config: MesaConfig) -> _NativeMesaFileSystem: ...

    async def _close(self) -> None: ...

    # --- Byte I/O ---
    async def read(self, path: str) -> bytes: ...
    async def write(self, path: str, content: bytes) -> None: ...
    async def append(self, path: str, content: bytes) -> None: ...
    async def exists(self, path: str) -> bool: ...

    # --- Metadata + traversal ---
    async def stat(self, path: str) -> FsStat: ...
    async def lstat(self, path: str) -> FsStat: ...
    async def readdir(self, path: str) -> list[str]: ...
    async def realpath(self, path: str) -> str: ...
    async def readlink(self, path: str) -> str: ...
    def resolve_path(self, base: str, path: str) -> str: ...

    # --- Mutations ---
    async def mkdir(self, path: str, *, recursive: bool | None = None) -> None: ...
    async def rm(
        self,
        path: str,
        *,
        recursive: bool | None = None,
        force: bool | None = None,
    ) -> None: ...
    async def cp(
        self,
        src: str,
        dest: str,
        *,
        recursive: bool | None = None,
    ) -> None: ...
    async def mv(self, src: str, dest: str) -> None: ...
    async def chmod(self, path: str, mode: int) -> None: ...
    async def symlink(self, target: str, link: str) -> None: ...
    async def utimes(self, path: str, atime_ms: float, mtime_ms: float) -> None: ...

    # --- File metadata ---
    async def set_metadata(self, path: str, entries: dict[str, str | None]) -> None: ...
    async def get_metadata(self, path: str) -> dict[str, str]: ...
    async def clear_metadata(self, path: str) -> None: ...
    def watch(self) -> _NativeMesaFileSystemWatcher: ...

    # --- VCS: changes ---
    async def new_change(
        self,
        repo: str,
        *,
        bookmark: str | None = None,
        change_id: str | None = None,
        message: str | None = None,
    ) -> str: ...
    async def edit_change(
        self,
        repo: str,
        *,
        bookmark: str | None = None,
        change_id: str | None = None,
    ) -> str: ...
    async def list_changes(self, repo: str, *, limit: int = 50) -> list[ChangeInfo]: ...
    async def current_change(self, repo: str) -> ChangeInfo: ...

    # --- VCS: bookmarks ---
    async def create_bookmark(self, repo: str, name: str) -> None: ...
    async def move_bookmark(
        self,
        repo: str,
        name: str,
        change_id: str,
        allow_backwards: bool = False,
    ) -> None: ...
    async def checkpoint(self, repo: str, message: str | None = None) -> CheckpointResult: ...
    async def list_bookmarks(self, repo: str) -> list[str]: ...

    # --- Bash factory ---
    def bash(
        self,
        *,
        env: Mapping[str, str] | None = None,
        cwd: str | None = None,
        timeout_ms: int | None = None,
    ) -> Bash: ...

@final
class _NativeMesaFileSystemWatcher:
    async def next(self) -> _NativeWatchEvent | None: ...
    async def close(self) -> None: ...

# ---------------------------------------------------------------------------
# Bash
# ---------------------------------------------------------------------------

@final
class Bash:
    """Shell interpreter rooted at a mounted :class:`MesaFileSystem`.

    Build with :meth:`MesaFileSystem.bash`. Commands run against the
    mounted filesystem, no host shell is spawned.
    """

    async def exec(self, commands: str) -> ExecResult:
        """Run ``commands`` as a shell script.

        ``commands`` is a single string containing one or more shell
        statements (e.g. ``"ls -la /repo | wc -l"``), not an argv list.
        """
        ...
