"""Filesystem namespace on the Mesa client."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from typing import (
    TYPE_CHECKING,
    AsyncIterator,
    Awaitable,
    Callable,
    Literal,
    Mapping,
    NoReturn,
    overload,
    Sequence,
    TypedDict,
    TypeAlias,
)

from mesa_sdk._client import CredentialKind
from mesa_sdk._signing_key import (
    NormalizedSigningKeyAuthors,
    looks_like_private_key,
    normalize_signing_key_authors,
)
from mesa_sdk._native import (
    Bash,
    ChangeInfo,
    CheckpointResult,
    DiskCacheConfig,
    FsStat,
    MesaConfig,
    _NativeMesaFileSystem,  # pyright: ignore[reportPrivateUsage]
    validate_layout,
)
from mesa_sdk._resources import TokenCreateResult
from mesa_sdk.errors import InvalidOptionsError
from mesa_sdk.types import SigningKeyAuthor

if TYPE_CHECKING:
    from mesa_sdk._mesa import Mesa

__all__ = [
    "BookmarksOps",
    "ChangesOps",
    "FsNamespace",
    "Layout",
    "LayoutDefinition",
    "LayoutSpec",
    "MesaFileSystem",
    "MesaFileSystemSubscription",
    "Repo",
    "RepoName",
    "RepoSelector",
    "WatchEvent",
    "WatchEventHandler",
    "repo",
]

_logger = logging.getLogger(__name__)

# Layout JSON uses lowercase string modes; the native :class:`~mesa_sdk.MountMode`
# enum is for :class:`~mesa_sdk.RepoConfig`.
_LayoutMountMode: TypeAlias = Literal["ro", "rw"]


class RepoName(TypedDict):
    """The mapping input form of :func:`repo`: a repository selected by name."""

    name: str


# Select a repository by name, as a string or a mapping containing ``name``.
RepoSelector = str | RepoName


class _RepoRequired(TypedDict):
    kind: Literal["repo"]
    name: str
    mode: _LayoutMountMode


class Repo(_RepoRequired, total=False):
    """One repository declaration in serialized :class:`LayoutSpec` form.

    ``kind``, ``name``, and ``mode`` are always present; the remaining keys
    are optional and omitted from the serialized form when unset.
    """

    at: Mapping[str, object]
    branchedFrom: Mapping[str, object]
    alias: str
    subPaths: Mapping[str, "Repo | Sequence[Repo]"]


# The mount-layout schema: a pure path map. Every key is an absolute
# ("/"-prefixed) namespace path; the organization is not part of the
# document — it comes from mount context (the client, or MESA_ORG for a
# CLI mount). The Rust core validates the authoritative schema and
# rejects any stray non-absolute key.
LayoutSpec = Mapping[str, "Repo | Sequence[Repo]"]


@dataclass(frozen=True)
class Layout:
    """A serializable local layout for ``mesa mount --layout``."""

    spec: LayoutSpec

    def __post_init__(self) -> None:
        # Snapshot to a real dict: json serialization requires one, and the
        # layout must not alias the caller's mutable mapping.
        object.__setattr__(self, "spec", dict(self.spec))

    def __str__(self) -> str:
        """Serialize the layout as deterministic, pretty-printed JSON."""
        return json.dumps(self.spec, ensure_ascii=False, indent=2, sort_keys=True) + "\n"

    def to_json(self) -> LayoutSpec:
        """Return the canonical :class:`LayoutSpec`."""
        return self.spec


def _reject_unknown_keys(
    mapping: Mapping[str, object], allowed: set[str], where: str
) -> None:
    """Fail on keys the layout schema does not carry.

    The serialized layout is ``deny_unknown_fields`` on the Rust side, so a
    misspelled key must not be silently dropped on the way there.
    """
    unknown = sorted(set(mapping) - allowed)
    if unknown:
        raise ValueError(
            f"repo(): {where} has unknown key(s) {unknown}; "
            f"expected {sorted(allowed)}"
        )


@overload
def repo(
    selector: RepoSelector,
    *,
    mode: _LayoutMountMode,
    at: Mapping[str, object],
    branched_from: None = None,
    alias: str | None = None,
    sub_paths: Mapping[str, Repo | Sequence[Repo]] | None = None,
) -> Repo: ...


@overload
def repo(
    selector: RepoSelector,
    *,
    mode: _LayoutMountMode,
    at: None = None,
    branched_from: Mapping[str, object] | None = None,
    alias: str | None = None,
    sub_paths: Mapping[str, Repo | Sequence[Repo]] | None = None,
) -> Repo: ...


def repo(
    selector: RepoSelector,
    *,
    mode: _LayoutMountMode,
    at: Mapping[str, object] | None = None,
    branched_from: Mapping[str, object] | None = None,
    alias: str | None = None,
    sub_paths: Mapping[str, Repo | Sequence[Repo]] | None = None,
) -> Repo:
    """Declare one repository in a local mount layout.

    Select the repository by name, either as a string or a mapping
    containing ``name``. Names are resolved to their canonical repository at
    the service boundary.

    ``at`` pins an existing revision: ``{"bookmark": ...}`` or
    ``{"change_id": ...}``. ``branched_from`` forks a new empty descendant at
    cold open (writable only):
    ``{"bookmark"|"change_id": ..., "as": {"bookmark"?: str, "describe"?: str}}``.
    The two are mutually exclusive.
    """
    if isinstance(selector, str):
        name = selector
    elif "name" in selector:
        name = selector["name"]
    else:
        raise ValueError("repo(): selector must contain 'name'")
    if not name:
        raise ValueError("repo(): repository name must not be empty")
    if "/" in name:
        # A layout entry names a repository within the client's organization,
        # so a slash can only be an "org/repo" selector. Left unchecked it is
        # signed into the token verbatim and fails as an opaque repo-not-found
        # at mount time.
        raise ValueError(
            f"repo(): repository name {name!r} must not contain '/'. "
            "Cross-org mounts are not supported; pass "
            f"'{name.split('/', 1)[1]}' without the organization prefix."
        )

    if mode not in ("ro", "rw"):
        raise ValueError("repo(): mode must be 'ro' or 'rw'")
    if at is not None and branched_from is not None:
        raise ValueError("repo(): at and branched_from are mutually exclusive")
    if at is not None:
        _reject_unknown_keys(at, {"bookmark", "change_id"}, "at")
        at_bookmark = at.get("bookmark")
        at_change_id = at.get("change_id")
        if at_bookmark is not None and at_change_id is not None:
            raise ValueError("repo(): at.bookmark and at.change_id are mutually exclusive")
        if at_bookmark is None and at_change_id is None:
            raise ValueError("repo(): at requires a bookmark or change_id")
    if branched_from is not None:
        if mode != "rw":
            raise ValueError('repo(): branched_from requires mode "rw"')
        _reject_unknown_keys(
            branched_from, {"bookmark", "change_id", "as"}, "branched_from"
        )
        parent_bookmark = branched_from.get("bookmark")
        parent_change_id = branched_from.get("change_id")
        if parent_bookmark is not None and parent_change_id is not None:
            raise ValueError(
                "repo(): branched_from.bookmark and branched_from.change_id "
                "are mutually exclusive"
            )
        if parent_bookmark is None and parent_change_id is None:
            raise ValueError(
                "repo(): branched_from requires a parent bookmark or change_id"
            )
        as_fields = branched_from.get("as")
        if as_fields is not None:
            if not isinstance(as_fields, Mapping):
                raise ValueError("repo(): branched_from['as'] must be a mapping")
            _reject_unknown_keys(
                as_fields, {"bookmark", "describe"}, "branched_from['as']"
            )

    declaration: Repo = {"kind": "repo", "name": name, "mode": mode}
    if at is not None:
        serialized_at: dict[str, object] = {}
        if "bookmark" in at:
            serialized_at["bookmark"] = at["bookmark"]
        if "change_id" in at:
            serialized_at["changeId"] = at["change_id"]
        declaration["at"] = serialized_at
    if branched_from is not None:
        branch: dict[str, object] = {}
        if "bookmark" in branched_from:
            branch["bookmark"] = branched_from["bookmark"]
        if "change_id" in branched_from:
            branch["changeId"] = branched_from["change_id"]
        as_fields = branched_from.get("as")
        if isinstance(as_fields, Mapping):
            serialized_as: dict[str, object] = {}
            if "bookmark" in as_fields:
                serialized_as["bookmark"] = as_fields["bookmark"]
            if "describe" in as_fields:
                serialized_as["describe"] = as_fields["describe"]
            if serialized_as:
                branch["as"] = serialized_as
        declaration["branchedFrom"] = branch
    if alias is not None:
        declaration["alias"] = alias
    if sub_paths is not None:
        declaration["subPaths"] = sub_paths
    return declaration


@dataclass(frozen=True)
class WatchEvent:
    """A filesystem invalidation emitted after the change is visible through MesaFS."""

    path: str
    recursive: bool


WatchEventHandler = Callable[[WatchEvent], None | Awaitable[None]]


class MesaFileSystemSubscription:
    """Subscription returned by :meth:`MesaFileSystem.subscribe`."""

    def __init__(self, native, handler: WatchEventHandler) -> None:
        self._native = native
        self._closed = False
        self._task = asyncio.create_task(self._pump(handler))

    async def _pump(self, handler: WatchEventHandler) -> None:
        try:
            while not self._closed:
                event = await self._native.next()
                if event is None:
                    self._closed = True
                    return
                result = handler(
                    WatchEvent(
                        path=event.path,
                        recursive=event.recursive,
                    )
                )
                if inspect.isawaitable(result):
                    await result
        finally:
            await self.unsubscribe()

    async def unsubscribe(self) -> None:
        """Unsubscribe from filesystem invalidations."""
        if self._closed:
            return
        self._closed = True
        await self._native.close()


class ChangesOps:
    """Change-management operations: ``fs.changes``.

    Exactly one of ``bookmark`` or ``change_id`` must be supplied to
    :meth:`new` / :meth:`edit`.
    """

    def __init__(self, fs: _NativeMesaFileSystem) -> None:
        self._fs = fs

    async def new(
        self,
        repo: str,
        *,
        bookmark: str | None = None,
        change_id: str | None = None,
        message: str | None = None,
    ) -> str:
        """Create a new change forked from a bookmark or existing change.

        Returns the new change's hex ID. Raises :exc:`FileNotFoundError`
        if the source bookmark or change doesn't exist.
        """
        return await self._fs.new_change(
            repo,
            bookmark=bookmark,
            change_id=change_id,
            message=message,
        )

    async def edit(
        self,
        repo: str,
        *,
        bookmark: str | None = None,
        change_id: str | None = None,
    ) -> str:
        """Check out an existing bookmark or change. Never creates a new one.

        Returns the now-active change's hex ID. Raises
        :exc:`FileNotFoundError` if the bookmark or change doesn't exist.
        """
        return await self._fs.edit_change(repo, bookmark=bookmark, change_id=change_id)

    async def list(self, repo: str, *, limit: int = 50) -> list[ChangeInfo]:
        """List changes reachable from the current checkout, most-recent first."""
        return await self._fs.list_changes(repo, limit=limit)

    async def current(self, repo: str) -> ChangeInfo:
        """Return the currently active change for ``repo``."""
        return await self._fs.current_change(repo)

    async def checkpoint(self, repo: str, message: str | None = None) -> CheckpointResult:
        """Flush pending writes, optionally describe the current change, create
        a new descendant change, and advance bookmarks onto that descendant.

        Requires the current checkout to be on a bookmark. Omit ``message`` to
        preserve the existing description; pass a string (including ``""``) to
        overwrite. Returns both the described (saved) change and the
        now-active empty descendant.
        """
        return await self._fs.checkpoint(repo, message)


class BookmarksOps:
    """Bookmark-management operations: ``fs.bookmarks``.

    Bookmarks are named refs analogous to git branches.
    """

    def __init__(self, fs: _NativeMesaFileSystem) -> None:
        self._fs = fs

    async def create(self, repo: str, name: str) -> None:
        """Create a bookmark at the active change's commit.

        Raises :exc:`FileExistsError` if ``name`` already exists.
        """
        return await self._fs.create_bookmark(repo, name)

    async def move(
        self,
        repo: str,
        name: str,
        *,
        change_id: str,
        allow_backwards: bool = False,
    ) -> None:
        """Move ``name`` to ``change_id``.

        Moves must advance history unless ``allow_backwards`` is true.
        """
        return await self._fs.move_bookmark(
            repo,
            name,
            change_id,
            allow_backwards,
        )

    async def list(self, repo: str) -> list[str]:
        """Return every bookmark name on ``repo``."""
        return await self._fs.list_bookmarks(repo)


class MesaFileSystem:
    """Mesa virtual filesystem.

    Construct via :meth:`mesa.fs(layout=...).mount() <LayoutDefinition.mount>`.

    Filesystem errors raise Python's built-in exceptions
    (:exc:`FileNotFoundError`, :exc:`IsADirectoryError`,
    :exc:`PermissionError`, etc.).
    """

    changes: ChangesOps
    """Change-management namespace."""

    bookmarks: BookmarksOps
    """Bookmark-management namespace."""

    def __init__(self, _native: _NativeMesaFileSystem, org: str | None = None) -> None:
        self._native = _native
        self._org = org
        self.changes = ChangesOps(_native)
        self.bookmarks = BookmarksOps(_native)

    async def _close(self) -> None:
        """Flush pending writes before mount teardown.

        This is intentionally private; :meth:`LayoutDefinition.mount`
        owns the lifecycle for user-facing mounts.
        """
        await self._native._close()

    @classmethod
    async def connect(cls, config: MesaConfig) -> "MesaFileSystem":
        """Open a filesystem from a :class:`MesaConfig`.

        Most users want :meth:`mesa.fs(layout=...).mount() <LayoutDefinition.mount>`,
        which manages credentials for you. Use this only when you already
        own the credential's lifecycle.
        """
        if looks_like_private_key(config.api_key):
            raise InvalidOptionsError(
                "MesaConfig.api_key must contain a bearer credential, not a private key."
            )
        return cls(await _NativeMesaFileSystem.connect(config), config.org)

    # -- Byte I/O --
    async def read(self, path: str) -> bytes:
        """Read ``path`` as :class:`bytes`."""
        return await self._native.read(path)

    async def write(self, path: str, content: bytes) -> None:
        """Replace the contents of ``path``. Creates the file if missing.

        Parent directory must exist, call :meth:`mkdir` with
        ``recursive=True`` first if needed. Raises :exc:`OSError` on a
        read-only repo.
        """
        await self._native.write(path, content)

    async def append(self, path: str, content: bytes) -> None:
        """Append ``content`` to ``path``, creating it if absent."""
        await self._native.append(path, content)

    async def exists(self, path: str) -> bool:
        """Return ``True`` if ``path`` exists (follows symlinks)."""
        return await self._native.exists(path)

    # -- Metadata + traversal --
    async def stat(self, path: str) -> FsStat:
        """Return :class:`FsStat` metadata for ``path``, following symlinks."""
        return await self._native.stat(path)

    async def lstat(self, path: str) -> FsStat:
        """Like :meth:`stat`, but does not follow symlinks."""
        return await self._native.lstat(path)

    async def readdir(self, path: str) -> list[str]:
        """Return entry names in directory ``path``.

        Order is not guaranteed; sort client-side if you need
        deterministic output.
        """
        return await self._native.readdir(path)

    async def realpath(self, path: str) -> str:
        """Resolve symlinks and ``..`` segments to a canonical path."""
        return await self._native.realpath(path)

    async def readlink(self, path: str) -> str:
        """Return the target of the symlink at ``path``."""
        return await self._native.readlink(path)

    def resolve_path(self, base: str, path: str) -> str:
        """Join and normalize ``path`` against ``base`` without touching disk."""
        return self._native.resolve_path(base, path)

    # -- Mutations --
    async def mkdir(self, path: str, *, recursive: bool | None = None) -> None:
        """Create the directory ``path``.

        With ``recursive=True``, creates missing parents and is a no-op
        if ``path`` already exists as a directory.
        """
        await self._native.mkdir(path, recursive=recursive)

    async def rm(
        self,
        path: str,
        *,
        recursive: bool | None = None,
        force: bool | None = None,
    ) -> None:
        """Remove the file or directory at ``path``.

        ``recursive=True`` is required for non-empty directories.
        ``force=True`` ignores missing paths.
        """
        await self._native.rm(path, recursive=recursive, force=force)

    async def cp(self, src: str, dest: str, *, recursive: bool | None = None) -> None:
        """Copy ``src`` to ``dest``. ``recursive=True`` for directories."""
        await self._native.cp(src, dest, recursive=recursive)

    async def mv(self, src: str, dest: str) -> None:
        """Move ``src`` to ``dest``."""
        await self._native.mv(src, dest)

    async def chmod(self, path: str, mode: int) -> None:
        """Set permission bits on ``path`` (e.g. ``0o755``)."""
        await self._native.chmod(path, mode)

    async def symlink(self, target: str, link: str) -> None:
        """Create a symlink at ``link`` pointing at ``target``.

        ``target`` is stored verbatim, relative targets resolve against
        the parent of ``link`` at read time.
        """
        await self._native.symlink(target, link)

    async def utimes(self, path: str, atime_ms: float, mtime_ms: float) -> None:
        """Set access and modification times of ``path``.

        .. warning::
           Times are **milliseconds since the Unix epoch**, not seconds.
           Multiply :func:`time.time` by 1000 to convert.
        """
        await self._native.utimes(path, atime_ms, mtime_ms)

    # -- File metadata --
    async def set_metadata(self, path: str, entries: dict[str, str | None]) -> None:
        """Apply metadata changes to ``path`` (merge semantics). Keys are plain
        names (no namespace). A non-empty string value sets the key; ``None``
        or an empty string (``""``) deletes it. Existing keys not in ``entries``
        are left untouched; a single call may mix sets and deletes. ``org`` /
        ``repo`` are reserved and raise ``ValueError`` if named.
        """
        await self._native.set_metadata(path, entries)

    async def get_metadata(self, path: str) -> dict[str, str]:
        """Return all metadata on ``path`` as a ``dict[str, str]``,
        including the read-only synthetic ``org``/``repo`` keys.
        """
        return await self._native.get_metadata(path)

    async def clear_metadata(self, path: str) -> None:
        """Remove all metadata on ``path`` in one shot. Idempotent: clearing a
        path with no metadata is a no-op. The read-only synthetic ``org`` /
        ``repo`` keys are computed, not stored, so they survive a clear.
        """
        await self._native.clear_metadata(path)

    def subscribe(self, handler: WatchEventHandler) -> MesaFileSystemSubscription:
        """Subscribe to filesystem changes.

        The handler is called after the changed state is visible through this
        filesystem instance. Unsubscribe from the returned subscription to stop.
        """
        return MesaFileSystemSubscription(self._native.watch(), handler)

    def link(self, existing: str, new: str) -> NoReturn:
        """Hard links are not supported. Use :meth:`symlink` instead."""
        del existing, new
        raise NotImplementedError("hard links are not supported")

    # -- Bash factory --
    def bash(
        self,
        *,
        env: Mapping[str, str] | None = None,
        cwd: str | None = None,
        timeout_ms: int | None = None,
    ) -> Bash:
        """Build a :class:`Bash` interpreter rooted at this filesystem.

        Runs commands against the mounted filesystem, no host shell is spawned.
        ``await bash.exec("...")`` returns an :class:`~mesa_sdk.ExecResult`.

        :param env: Environment for the shell. Defaults to empty,
            the host process environment is **not** inherited.
        :param cwd: Working directory. Must exist within the mount.
            Defaults to ``"/"``.
        :param timeout_ms: Per-:meth:`Bash.exec` wall-clock timeout.
            Defaults to 30s.
        """
        return self._native.bash(env=env, cwd=cwd, timeout_ms=timeout_ms)


class LayoutDefinition:
    """A layout bundled with its scoped operations: ``mesa.fs(layout=...)``.

    Every member is a pure delegation to the existing ``mesa.fs`` helpers;
    no derivation happens here. The definition's ``ttl`` is the lifetime of
    every token minted from it, whether by :meth:`token` or under the hood
    by :meth:`mount`.

    Example::

        definition = mesa.fs(layout={"/workspace": repo("proj-1", mode="rw")}, ttl=3600)
        async with definition.mount() as fs:  # app mount
            ...

        # or hand the same definition to a CLI mount in a sandbox:
        sandbox.upload_file("layout.json", str(definition.layout()))
        token = (await definition.token()).token
        # MESA_ORG names the CLI's organization; the token is only the
        # credential.
        sandbox.exec(
            "mesa mount --layout=layout.json",
            env={"MESA_ORG": "my-org", "MESA_ACCESS_TOKEN": token},
        )
    """

    def __init__(
        self,
        fs: "FsNamespace",
        layout: Layout,
        ttl: int | None,
        authors: list[SigningKeyAuthor] | None = None,
    ) -> None:
        self._fs = fs
        self._layout = layout
        self._ttl = ttl
        self._authors = authors

    def layout(self) -> Layout:
        """The prepared layout, built from the raw path map the definition was given."""
        return self._layout

    def mount(
        self,
        *,
        disk_cache: DiskCacheConfig | None = None,
    ) -> AbstractAsyncContextManager[MesaFileSystem]:
        """Mount this layout as the complete namespace.

        Accepts the non-token mount options; the mount's token lifetime is
        the definition's ``ttl``.
        """
        return self._fs._mount_layout(self._layout, self._ttl, disk_cache, self._authors)

    async def token(self) -> TokenCreateResult:
        """Mint the layout-scoped, least-privilege access token with the definition's ``ttl``."""
        return await self._fs._mint_layout_token(self._layout, self._ttl, self._authors)


class FsNamespace:
    """Filesystem namespace exposed as ``mesa.fs``."""

    def __init__(self, mesa: "Mesa") -> None:
        self._mesa = mesa

    async def _mint_layout_token(
        self,
        layout: Layout,
        ttl: int | None,
        authors: list[SigningKeyAuthor] | None = None,
    ) -> TokenCreateResult:
        """Sign the least-privilege access token for a definition's layout.

        Applies the exact derivation the layout mount uses: repositories
        collected from every declaration and scoped by name, read-only
        scopes when every mode is ``"ro"``, read/write otherwise. Signing is
        entirely local.

        Authors and ``ttl`` are validated against the client's credential at
        definition time, in :meth:`__call__`.
        """
        # Run the core structural validator before minting so a malformed
        # layout fails here with the mount's own error. Repository names
        # resolve only at mount time.
        validate_layout(str(layout))
        _, _, scopes, repo_names = await self._layout_token_request(
            layout, "mesa.fs(layout=...).token()"
        )
        if authors is not None:
            return await self._mesa.tokens.create(
                scopes=scopes,
                repos=repo_names,
                authors=authors,
                ttl_seconds=ttl,
            )
        return await self._mesa.tokens.create(
            scopes=scopes,
            repos=repo_names,
            ttl_seconds=ttl,
        )

    def __call__(
        self,
        *,
        layout: Mapping[str, Repo | Sequence[Repo]],
        authors: list[SigningKeyAuthor] | None = None,
        ttl: int | None = None,
    ) -> LayoutDefinition:
        """Bundle a layout with its mount and token operations.

        The raw path mapping builds eagerly, so an invalid mapping fails
        here at definition time. The returned definition is the only way to
        mount a layout or mint its token: ``layout()`` serializes for
        ``mesa mount --layout``, ``mount()`` opens the in-process
        filesystem, and ``token()`` mints the layout-scoped credential.
        ``ttl`` is the lifetime of every token the definition mints. The
        call is synchronous, so the one-shot form needs no extra await:
        ``async with mesa.fs(layout={...}).mount() as fs``.
        """
        if authors is not None:
            normalize_signing_key_authors(authors)
            if self._mesa._credential.kind is not CredentialKind.PRIVATE_KEY:
                raise InvalidOptionsError(
                    "Layout authors require a private-key client."
                )
        elif self._mesa._credential.kind is CredentialKind.PRIVATE_KEY:
            raise InvalidOptionsError(
                "Private-key layout definitions require a nonempty `authors` option."
            )
        if self._mesa._credential.kind is CredentialKind.ACCESS_TOKEN and ttl is not None:
            raise InvalidOptionsError(
                "The lifetime of an existing access token cannot be changed."
            )
        for path in layout:
            if not path.startswith("/"):
                raise ValueError(
                    f"mesa.fs(): top-level path '{path}' must be absolute"
                )
        return LayoutDefinition(self, Layout(layout), ttl, authors)

    @asynccontextmanager
    async def _mount_layout(
        self,
        layout: Layout,
        ttl: int | None,
        disk_cache: DiskCacheConfig | None,
        authors: list[SigningKeyAuthor] | None = None,
    ) -> AsyncIterator[MesaFileSystem]:
        """Mount a definition's layout as the complete namespace.

        Presents repositories at their declared workspace paths, replacing
        the canonical browse tree, with a token scoped to the layout's
        repositories by name. Authors and ``ttl`` are validated against the
        client's credential at definition time, in :meth:`__call__`.
        """
        normalized_authors = (
            normalize_signing_key_authors(authors) if authors is not None else None
        )
        layout, org, scopes, repo_names = await self._layout_token_request(
            layout, "mesa.fs(layout=...).mount()"
        )

        # Names are signed offline; no repository lookup is needed to mint the token.
        credential = await self._mesa._create_mount_token(
            scopes=scopes,
            repos=repo_names,
            authors=normalized_authors,
            ttl_seconds=ttl,
        )

        config = MesaConfig(
            org=org,
            api_key=credential,
            repos=[],
            layout=str(layout),
            mounted_repos="all",
            api_base_url=self._mesa.api_url,
            disk_cache=disk_cache,
        )
        async with self._connect_and_flush(config) as fs:
            yield fs

    async def _layout_token_request(
        self,
        layout: Layout,
        caller: str,
    ) -> tuple[Layout, str, list[str], list[str]]:
        """Derive the least-privilege token request for ``layout``.

        Returns ``(layout, org, scopes, repo_names)``: the prepared layout, the
        client organization, the narrowest scopes the declared modes allow, and
        the layout's repositories as full ``org/repo`` names. Shared by
        :meth:`_mount_layout` and :meth:`_mint_layout_token` so the derivation
        exists exactly once.
        """
        # The layout carries no organization of its own; the client's
        # organization scopes the token.
        org = self._mesa.org.slug
        declarations: list[Repo] = []

        def visit(entries: Mapping[str, Repo | Sequence[Repo]]) -> None:
            for entry in entries.values():
                nested = entry if isinstance(entry, Sequence) else [entry]
                for declaration in nested:
                    declarations.append(declaration)
                    sub_paths = declaration.get("subPaths")
                    if sub_paths is not None:
                        visit(sub_paths)

        # The spec is a pure path map: every entry is a declaration.
        visit(layout.spec)
        if not declarations:
            raise InvalidOptionsError(
                f"{caller} requires at least one layout repository"
            )
        repo_names = list(
            dict.fromkeys(
                f"{org}/{declaration['name']}" for declaration in declarations
            )
        )
        scopes = (
            ["read", "write"]
            if any(declaration["mode"] == "rw" for declaration in declarations)
            else ["read"]
        )
        return layout, org, scopes, repo_names

    @asynccontextmanager
    async def _connect_and_flush(
        self, config: MesaConfig
    ) -> AsyncIterator[MesaFileSystem]:
        fs: MesaFileSystem | None = None
        try:
            fs = await MesaFileSystem.connect(config)
            yield fs
        except BaseException:
            # The mount body raised. Still flush pending writes, but a flush
            # failure must never mask the user's original exception — log it
            # and let the original propagate.
            if fs is not None:
                try:
                    await fs._close()
                except Exception:
                    _logger.exception("failed to flush mount during teardown")
            raise
        else:
            # Clean exit: flush pending writes. Tokens self-expire, so there is
            # no revocation to perform; flush failures surface to the caller.
            if fs is not None:
                await fs._close()
