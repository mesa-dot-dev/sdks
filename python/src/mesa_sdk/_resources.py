from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import Enum, unique
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal, Protocol, Union

# assert_never is in `typing` only from 3.11; this package supports 3.10.
from typing_extensions import assert_never

from mesa_rest.api.bookmark import (
    create_bookmark,
    delete_bookmark,
    get_bookmark,
    list_bookmarks,
    merge_bookmark,
    move_bookmark,
)
from mesa_rest.api.change import (
    create_change,
    get_change,
    get_diff,
    list_changes,
    update_change,
)
from mesa_rest.api.content import get_content
from mesa_rest.api.org import (
    create_api_key,
    get_org,
    list_api_keys,
    revoke_api_key,
)
from mesa_rest.api.repo import (
    create_repo,
    delete_repo,
    get_repo,
    get_repo_upstream_sync,
    list_repo_upstream_syncs,
    list_repos,
    sync_upstream,
    update_repo,
)
from mesa_rest.api.webhook_target import (
    create_webhook_target,
    delete_webhook_target,
    list_webhook_targets,
    update_webhook_target,
)
from mesa_rest.models.create_api_key_body import CreateApiKeyBody
from mesa_rest.models.create_api_key_body_scopes_item import CreateApiKeyBodyScopesItem
from mesa_rest.models.create_bookmark_body import CreateBookmarkBody
from mesa_rest.models.create_change_body import CreateChangeBody
from mesa_rest.models.create_change_body_author import CreateChangeBodyAuthor
from mesa_rest.models.create_change_body_committer import CreateChangeBodyCommitter
from mesa_rest.models.create_change_body_files_item_type_0 import (
    CreateChangeBodyFilesItemType0,
)
from mesa_rest.models.create_change_body_files_item_type_1 import (
    CreateChangeBodyFilesItemType1,
)
from mesa_rest.models.create_repo_body import CreateRepoBody
from mesa_rest.models.create_repo_body_upstream import CreateRepoBodyUpstream
from mesa_rest.models.sync_upstream_body import SyncUpstreamBody
from mesa_rest.models.update_repo_body_upstream_type_0 import (
    UpdateRepoBodyUpstreamType0,
)
from mesa_rest.models.create_webhook_target_body import CreateWebhookTargetBody
from mesa_rest.models.create_webhook_target_body_events_item import (
    CreateWebhookTargetBodyEventsItem,
)
from mesa_rest.models.get_diff_conflicts import GetDiffConflicts
from mesa_rest.models.get_content_response_200_type_0 import GetContentResponse200Type0
from mesa_rest.models.get_content_response_200_type_1 import GetContentResponse200Type1
from mesa_rest.models.get_content_response_200_type_2 import GetContentResponse200Type2
from mesa_rest.models.merge_bookmark_body import MergeBookmarkBody
from mesa_rest.models.merge_bookmark_body_resolutions_item_type_0 import (
    MergeBookmarkBodyResolutionsItemType0,
)
from mesa_rest.models.merge_bookmark_body_resolutions_item_type_0_take import (
    MergeBookmarkBodyResolutionsItemType0Take,
)
from mesa_rest.models.merge_bookmark_body_resolutions_item_type_1 import (
    MergeBookmarkBodyResolutionsItemType1,
)
from mesa_rest.models.merge_bookmark_body_resolutions_item_type_1_hunks_item import (
    MergeBookmarkBodyResolutionsItemType1HunksItem,
)
from mesa_rest.models.merge_bookmark_body_resolutions_item_type_1_hunks_item_take import (
    MergeBookmarkBodyResolutionsItemType1HunksItemTake,
)
from mesa_rest.models.move_bookmark_body import MoveBookmarkBody
from mesa_rest.models.update_change_body import UpdateChangeBody
from mesa_rest.models.update_change_body_author import UpdateChangeBodyAuthor
from mesa_rest.models.update_change_body_committer import UpdateChangeBodyCommitter
from mesa_rest.models.update_change_body_files_item_type_0 import (
    UpdateChangeBodyFilesItemType0,
)
from mesa_rest.models.update_change_body_files_item_type_1 import (
    UpdateChangeBodyFilesItemType1,
)
from mesa_rest.models.update_change_body_resolutions_item_type_0 import (
    UpdateChangeBodyResolutionsItemType0,
)
from mesa_rest.models.update_change_body_resolutions_item_type_0_take import (
    UpdateChangeBodyResolutionsItemType0Take,
)
from mesa_rest.models.update_change_body_resolutions_item_type_1 import (
    UpdateChangeBodyResolutionsItemType1,
)
from mesa_rest.models.update_change_body_resolutions_item_type_1_hunks_item import (
    UpdateChangeBodyResolutionsItemType1HunksItem,
)
from mesa_rest.models.update_change_body_resolutions_item_type_1_hunks_item_take import (
    UpdateChangeBodyResolutionsItemType1HunksItemTake,
)
from mesa_rest.models.update_repo_body import UpdateRepoBody
from mesa_rest.models.update_webhook_target_body import UpdateWebhookTargetBody
from mesa_rest.models.update_webhook_target_body_events_item import (
    UpdateWebhookTargetBodyEventsItem,
)
from mesa_rest.types import UNSET, Unset

from mesa_sdk._client import BearerAuth, request_credential, unwrap
from mesa_sdk._content_helpers import install_content_model_helpers
from mesa_sdk._signing_key import (
    NormalizedSigningKeyAuthors,
    normalize_signing_key_authors,
)
from mesa_sdk.errors import InvalidOptionsError
from mesa_sdk.types import (
    Author,
    DiffConflictFilter,
    FileChange,
    FileDelete,
    HunkResolution,
    Resolution,
    SigningKeyAuthor,
    UpstreamAuth,
    UpstreamConfig,
    UsernamePasswordAuth,
)

if TYPE_CHECKING:
    from mesa_rest.client import AuthenticatedClient
    from mesa_rest.models.create_api_key_response_201 import CreateApiKeyResponse201
    from mesa_rest.models.create_bookmark_response_201 import CreateBookmarkResponse201
    from mesa_rest.models.create_change_response_201 import CreateChangeResponse201
    from mesa_rest.models.create_repo_response_201 import CreateRepoResponse201
    from mesa_rest.models.get_repo_upstream_sync_response_200 import (
        GetRepoUpstreamSyncResponse200,
    )
    from mesa_rest.models.list_repo_upstream_syncs_response_200 import (
        ListRepoUpstreamSyncsResponse200,
    )
    from mesa_rest.models.create_webhook_target_response_201 import (
        CreateWebhookTargetResponse201,
    )
    from mesa_rest.models.delete_bookmark_response_200 import DeleteBookmarkResponse200
    from mesa_rest.models.delete_repo_response_200 import DeleteRepoResponse200
    from mesa_rest.models.delete_webhook_target_response_200 import (
        DeleteWebhookTargetResponse200,
    )
    from mesa_rest.models.get_change_response_200 import GetChangeResponse200
    from mesa_rest.models.get_bookmark_response_200 import GetBookmarkResponse200
    from mesa_rest.models.get_diff_response_200 import GetDiffResponse200
    from mesa_rest.models.get_org_response_200 import GetOrgResponse200
    from mesa_rest.models.get_repo_response_200 import GetRepoResponse200
    from mesa_rest.models.list_api_keys_response_200 import ListApiKeysResponse200
    from mesa_rest.models.list_bookmarks_response_200 import ListBookmarksResponse200
    from mesa_rest.models.list_changes_response_200 import ListChangesResponse200
    from mesa_rest.models.list_repos_response_200 import ListReposResponse200
    from mesa_rest.models.list_webhook_targets_response_200 import (
        ListWebhookTargetsResponse200,
    )
    from mesa_rest.models.merge_bookmark_response_200 import MergeBookmarkResponse200
    from mesa_rest.models.move_bookmark_response_200 import MoveBookmarkResponse200
    from mesa_rest.models.revoke_api_key_response_200 import RevokeApiKeyResponse200
    from mesa_rest.models.sync_upstream_response_201 import SyncUpstreamResponse201
    from mesa_rest.models.update_change_response_200 import UpdateChangeResponse200
    from mesa_rest.models.update_repo_response_200 import UpdateRepoResponse200
    from mesa_rest.models.update_webhook_target_response_200 import (
        UpdateWebhookTargetResponse200,
    )


@unique
class AttributionKind(Enum):
    """How commit-producing REST requests carry author attribution."""

    #: API-key clients: the legacy ``author`` request-body field.
    REQUEST = "request"
    #: Private-key clients: authors signed into a per-request token.
    PRIVATE_KEY = "private_key"
    #: Access-token clients: authors fixed when the token was minted.
    FIXED_TOKEN = "fixed_token"


@dataclass(frozen=True)
class RequestAttribution:
    """The credential-appropriate author handling for this client's requests."""

    kind: AttributionKind
    sign: Callable[[NormalizedSigningKeyAuthors], str] | None = None
    auth: BearerAuth | None = None


def _prepare_commit_request(
    *,
    attribution: RequestAttribution,
    author: Author | None,
    authors: list[SigningKeyAuthor] | None,
    preserve_existing_authors: bool = False,
) -> tuple[Author | None, str | None]:
    if author is not None and authors is not None:
        raise InvalidOptionsError("Pass exactly one of `author` or `authors`.")

    match attribution.kind:
        case AttributionKind.REQUEST:
            if authors is not None:
                raise InvalidOptionsError(
                    "Ordered `authors` require a private-key client."
                )
            return author, None

        case AttributionKind.FIXED_TOKEN:
            if author is not None or authors is not None:
                raise InvalidOptionsError(
                    "Access-token authors are fixed when the token is minted."
                )
            return None, None

        case AttributionKind.PRIVATE_KEY:
            if preserve_existing_authors:
                if author is not None or authors is not None:
                    raise InvalidOptionsError(
                        "Conflict-resolution patches preserve the existing "
                        "commit authors."
                    )
                return None, None

            if author is None and authors is None:
                raise InvalidOptionsError(
                    "Private-key commit operations require exactly one of "
                    "`author` or `authors`."
                )
            if author is not None and author.date is not None:
                raise InvalidOptionsError(
                    "Private-key request authors do not accept a `date` value."
                )

            if authors is not None:
                normalized_authors = normalize_signing_key_authors(authors)
            else:
                assert author is not None
                normalized_authors = normalize_signing_key_authors(
                    [{"name": author.name, "email": author.email}]
                )
            assert attribution.sign is not None
            return None, attribution.sign(normalized_authors)

        case _:
            assert_never(attribution.kind)

def _opt(value: object) -> Any:
    return UNSET if value is None else value


def _serialize_tags_filter(tags: str | Mapping[str, Any] | None) -> str | None:
    if tags is None or isinstance(tags, str):
        return tags
    return json.dumps(tags, separators=(",", ":"))


def _upstream_auth_to_dict(auth: UpstreamAuth) -> dict[str, Any]:
    if isinstance(auth, UsernamePasswordAuth):
        return {
            "kind": "username_password",
            "username": auth.username,
            "password": auth.password,
        }
    payload: dict[str, Any] = {"kind": "token", "token": auth.token}
    if auth.token_username is not None:
        payload["token_username"] = auth.token_username
    return payload


def _to_create_repo_upstream(c: UpstreamConfig) -> CreateRepoBodyUpstream:
    body = CreateRepoBodyUpstream(url=c.url)
    # On POST there is no existing row, so ``UNSET`` and ``None`` are equivalent
    # — both mean "no auth, public upstream." Only emit the key when an actual
    # credential object was provided.
    if not isinstance(c.auth, Unset) and c.auth is not None:
        body.additional_properties["auth"] = _upstream_auth_to_dict(c.auth)
    return body


def _to_update_repo_upstream(
    value: UpstreamConfig | None | Unset,
) -> UpdateRepoBodyUpstreamType0 | None | Unset:
    """Three-state mapper for the PATCH ``upstream`` field: ``UNSET`` leaves
    the upstream untouched, ``None`` removes it, an :class:`UpstreamConfig`
    sets or replaces it.

    The same three-state pattern applies one level deeper, on
    :attr:`UpstreamConfig.auth`:

    - ``UNSET``: omit the ``auth`` key — server leaves any existing
      stored credential alone.
    - ``None``: emit ``"auth": null`` — server clears the credential.
    - object: emit the encrypted-on-the-server credential payload.
    """
    if isinstance(value, Unset):
        return UNSET
    if value is None:
        return None
    body = UpdateRepoBodyUpstreamType0(url=value.url)
    if isinstance(value.auth, Unset):
        pass  # Omit ``auth`` from the body → preserve existing credential.
    elif value.auth is None:
        body.additional_properties["auth"] = None  # Explicit clear.
    else:
        body.additional_properties["auth"] = _upstream_auth_to_dict(value.auth)
    return body


def _to_create_author(a: Author) -> CreateChangeBodyAuthor:
    return CreateChangeBodyAuthor(name=a.name, email=a.email, date=_opt(a.date))


def _to_create_committer(c: Author) -> CreateChangeBodyCommitter:
    return CreateChangeBodyCommitter(name=c.name, email=c.email, date=_opt(c.date))


def _to_create_file(
    f: FileChange,
) -> CreateChangeBodyFilesItemType0 | CreateChangeBodyFilesItemType1:
    if isinstance(f, FileDelete):
        return CreateChangeBodyFilesItemType1(path=f.path, action="delete")
    return CreateChangeBodyFilesItemType0(
        path=f.path,
        content=f.content,
        encoding=_opt(f.encoding),
        action=_opt(f.action),
        mode=_opt(f.mode),
    )


def _to_update_author(a: Author) -> UpdateChangeBodyAuthor:
    return UpdateChangeBodyAuthor(name=a.name, email=a.email, date=_opt(a.date))


def _to_update_committer(c: Author) -> UpdateChangeBodyCommitter:
    return UpdateChangeBodyCommitter(name=c.name, email=c.email, date=_opt(c.date))


def _to_update_file(
    f: FileChange,
) -> UpdateChangeBodyFilesItemType0 | UpdateChangeBodyFilesItemType1:
    if isinstance(f, FileDelete):
        return UpdateChangeBodyFilesItemType1(path=f.path, action="delete")
    return UpdateChangeBodyFilesItemType0(
        path=f.path,
        content=f.content,
        encoding=_opt(f.encoding),
        action=_opt(f.action),
        mode=_opt(f.mode),
    )


def _take_or_unset(take: str | None, enum_cls: type) -> Any:
    return enum_cls(take) if take is not None else UNSET


def _to_merge_resolution(
    r: Resolution,
) -> MergeBookmarkBodyResolutionsItemType0 | MergeBookmarkBodyResolutionsItemType1:
    if isinstance(r, HunkResolution):
        return MergeBookmarkBodyResolutionsItemType1(
            path=r.path,
            hunks=[
                MergeBookmarkBodyResolutionsItemType1HunksItem(
                    hunk_id=h.hunk_id,
                    content=_opt(h.content),
                    take=_take_or_unset(
                        h.take, MergeBookmarkBodyResolutionsItemType1HunksItemTake
                    ),
                    encoding=_opt(h.encoding),
                )
                for h in r.hunks
            ],
        )
    return MergeBookmarkBodyResolutionsItemType0(
        path=r.path,
        content=_opt(r.content),
        take=_take_or_unset(r.take, MergeBookmarkBodyResolutionsItemType0Take),
        encoding=_opt(r.encoding),
    )


def _to_update_resolution(
    r: Resolution,
) -> UpdateChangeBodyResolutionsItemType0 | UpdateChangeBodyResolutionsItemType1:
    if isinstance(r, HunkResolution):
        return UpdateChangeBodyResolutionsItemType1(
            path=r.path,
            hunks=[
                UpdateChangeBodyResolutionsItemType1HunksItem(
                    hunk_id=h.hunk_id,
                    content=_opt(h.content),
                    take=_take_or_unset(
                        h.take, UpdateChangeBodyResolutionsItemType1HunksItemTake
                    ),
                    encoding=_opt(h.encoding),
                )
                for h in r.hunks
            ],
        )
    return UpdateChangeBodyResolutionsItemType0(
        path=r.path,
        content=_opt(r.content),
        take=_take_or_unset(r.take, UpdateChangeBodyResolutionsItemType0Take),
        encoding=_opt(r.encoding),
    )


class _ContentKindHelpers(Protocol):
    @property
    def type(self) -> Literal["file", "symlink", "dir"]: ...

    def is_file(self) -> bool: ...

    def is_dir(self) -> bool: ...

    def is_symlink(self) -> bool: ...


if TYPE_CHECKING:

    class ContentFileResponse(_ContentKindHelpers, Protocol):
        type_: Literal["file"]
        name: str
        path: str
        sha: str
        is_conflicted: bool | Unset
        size: float
        encoding: Literal["base64"]
        content: str
        mode: Any
        metadata: Any

        def to_dict(self) -> dict[str, Any]: ...

    class ContentSymlinkResponse(_ContentKindHelpers, Protocol):
        type_: Literal["symlink"]
        name: str
        path: str
        sha: str
        is_conflicted: bool | Unset
        size: float
        encoding: Literal["base64"]
        content: str
        mode: Any
        metadata: Any

        def to_dict(self) -> dict[str, Any]: ...

    class ContentDirResponse(_ContentKindHelpers, Protocol):
        type_: Literal["dir"]
        name: str
        path: str
        sha: str
        child_count: int
        entries: list[Any]
        metadata: Any

        def to_dict(self) -> dict[str, Any]: ...

    ContentResponse = Union[
        ContentFileResponse,
        ContentSymlinkResponse,
        ContentDirResponse,
    ]
else:
    ContentResponse = Union[
        GetContentResponse200Type0,
        GetContentResponse200Type1,
        GetContentResponse200Type2,
    ]

install_content_model_helpers()


class OrgResolver(Protocol):
    async def __call__(self, org: str | None = None) -> str: ...


class OrgResource:
    """Organization details: ``mesa.org``."""

    def __init__(self, client: AuthenticatedClient, resolve_org: OrgResolver) -> None:
        self._client = client
        self._resolve_org = resolve_org

    async def get(self, *, org: str | None = None) -> GetOrgResponse200:
        resolved = await self._resolve_org(org)
        resp = await get_org.asyncio_detailed(resolved, client=self._client)
        return unwrap(resp)


@dataclass(frozen=True)
class TokenCreateResult:
    """Result of :meth:`Tokens.create`.

    Shape-compatible with the response the deleted ``POST /v1/:org/tokens``
    endpoint returned, so existing callers keep working unchanged.
    """

    token: str
    """The compact JWS access token string."""
    expires_at: datetime
    """Exact expiry, as a timezone-aware UTC ``datetime``."""
    scopes: list[str]
    """Effective scopes encoded into the token."""
    repos: list[str] | None
    """Effective repo restriction as full ``org/repo`` names. ``None`` = unrestricted."""
    repo_ids: list[str] | None
    """Effective canonical repository-ID restriction. ``None`` = not used."""


class TokenSigner(Protocol):
    async def __call__(
        self,
        *,
        scopes: list[str] | None,
        repos: list[str] | None,
        repo_ids: list[str] | None,
        authors: list[SigningKeyAuthor] | None,
        ttl_seconds: int | None,
    ) -> TokenCreateResult: ...


class Tokens:
    """Access-token signing: ``mesa.tokens``.

    Tokens are short-lived JWTs that expire on their own and cannot be revoked
    or refreshed — sign a new one instead. Signing is entirely local. API-key
    clients use the legacy HS256 format; private-key clients use Ed25519.
    """

    def __init__(self, sign_token: TokenSigner) -> None:
        self._sign_token = sign_token

    async def create(
        self,
        *,
        org: str | None = None,
        scopes: list[str] | None = None,
        repos: list[str] | None = None,
        repo_ids: list[str] | None = None,
        authors: list[SigningKeyAuthor] | None = None,
        ttl_seconds: int | None = None,
    ) -> TokenCreateResult:
        """Sign a short-lived access token (JWT) carrying at most this client's
        scopes and repository restrictions.

        API-key tokens are clamped to the key's permissions at verification.
        Private-key clients must pass a non-empty ordered ``authors`` list.
        Static access-token clients cannot mint another token. ``org`` remains
        accepted and ignored for source compatibility with prior versions.

        :param scopes: Token scopes (``"read"``, ``"write"``, ``"admin"``).
            Clamped to the calling API key's scopes at verify time. Defaults to
            ``["read", "write"]``.
        :param repos: Restrict the token to these repos, as full ``org/repo``
            names. Resolved to ids and clamped to the calling API key's
            repository restrictions at verify time. Defaults to no extra
            restriction.
        :param repo_ids: Restrict the token by canonical repository ID.
            Mutually exclusive with ``repos``.
        :param authors: Ordered commit attribution for a private-key token.
        :param ttl_seconds: Token lifetime in seconds. API-key tokens default
            to 3600 and allow up to 86400. Private-key tokens default to 900
            and allow up to 14400.
        :param org: Deprecated and ignored. The signing credential supplies the
            token's organization.

        :raises InvalidOptionsError: If ``ttl_seconds`` is out of range.
        """
        del org  # Deprecated: the signing credential supplies the token's org.
        return await self._sign_token(
            scopes=scopes,
            repos=repos,
            repo_ids=repo_ids,
            authors=authors,
            ttl_seconds=ttl_seconds,
        )


class ApiKeys:
    """API key management: ``mesa.api_keys``."""

    def __init__(self, client: AuthenticatedClient, resolve_org: OrgResolver) -> None:
        self._client = client
        self._resolve_org = resolve_org

    async def list(
        self,
        *,
        org: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> ListApiKeysResponse200:
        resolved = await self._resolve_org(org)
        resp = await list_api_keys.asyncio_detailed(
            resolved,
            client=self._client,
            cursor=_opt(cursor),
            limit=_opt(limit),
        )
        return unwrap(resp)

    async def create(
        self,
        *,
        org: str | None = None,
        name: str | None = None,
        scopes: list[str] | None = None,
        repo_ids: list[str] | None = None,
        expires_in_seconds: int | None = None,
    ) -> CreateApiKeyResponse201:
        """Mint a new API key.

        :param scopes: Permission scopes (``"read"``, ``"write"``).
            Defaults to ``["read", "write"]`` when omitted.
        :param repo_ids: Restrict the key to these repos. Defaults to
            all repos in the organization.
        :param expires_in_seconds: Server-side TTL. Without this, the
            key never expires until revoked.
        """
        resolved = await self._resolve_org(org)
        body = CreateApiKeyBody(
            name=_opt(name),
            scopes=[CreateApiKeyBodyScopesItem(s) for s in scopes]
            if scopes is not None
            else UNSET,
            repo_ids=_opt(repo_ids),
            expires_in_seconds=_opt(expires_in_seconds),
        )
        resp = await create_api_key.asyncio_detailed(
            resolved,
            client=self._client,
            body=body,
        )
        return unwrap(resp)

    async def revoke(
        self, *, key_id: str, org: str | None = None
    ) -> RevokeApiKeyResponse200:
        """Revoke ``key_id``. Subsequent requests using the key fail with 401."""
        resolved = await self._resolve_org(org)
        resp = await revoke_api_key.asyncio_detailed(
            resolved,
            key_id,
            client=self._client,
        )
        return unwrap(resp)


class Repos:
    """Repository management: ``mesa.repos``."""

    def __init__(self, client: AuthenticatedClient, resolve_org: OrgResolver) -> None:
        self._client = client
        self._resolve_org = resolve_org

    async def list(
        self,
        *,
        org: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
        tags: str | Mapping[str, Any] | None = None,
    ) -> ListReposResponse200:
        resolved = await self._resolve_org(org)
        resp = await list_repos.asyncio_detailed(
            resolved,
            client=self._client,
            cursor=_opt(cursor),
            limit=_opt(limit),
            tags=_opt(_serialize_tags_filter(tags)),
        )
        return unwrap(resp)

    async def create(
        self,
        *,
        org: str | None = None,
        name: str | None = None,
        default_bookmark: str | None = None,
        upstream: UpstreamConfig | None = None,
    ) -> CreateRepoResponse201:
        """``default_bookmark`` defaults to ``"main"`` if omitted.

        :param upstream: Optional upstream git remote to attach at create
            time. Equivalent to creating the repo and then calling
            :meth:`update` with the same ``upstream`` value.
        """
        resolved = await self._resolve_org(org)
        body = CreateRepoBody(
            name=_opt(name),
            default_bookmark=_opt(default_bookmark),
            upstream=_to_create_repo_upstream(upstream)
            if upstream is not None
            else UNSET,
        )
        resp = await create_repo.asyncio_detailed(
            resolved,
            client=self._client,
            body=body,
        )
        return unwrap(resp)

    async def get(self, *, repo: str, org: str | None = None) -> GetRepoResponse200:
        """Raises :exc:`NotFoundError` if ``repo`` doesn't exist."""
        resolved = await self._resolve_org(org)
        resp = await get_repo.asyncio_detailed(
            resolved,
            repo,
            client=self._client,
        )
        return unwrap(resp)

    async def update(
        self,
        *,
        repo: str,
        org: str | None = None,
        name: str | None = None,
        default_bookmark: str | None = None,
        upstream: UpstreamConfig | None | Unset = UNSET,
    ) -> UpdateRepoResponse200:
        """Update fields on ``repo``. Omitted keyword arguments are left
        unchanged.

        :param upstream: Pass an :class:`UpstreamConfig` to set or replace
            the upstream remote, ``None`` to remove it, or omit to leave
            the existing upstream untouched. To update only the URL while
            keeping the stored credential, pass
            ``UpstreamConfig(url=..., auth=UNSET)`` — the default. To clear
            just the credential and keep the upstream, pass
            ``UpstreamConfig(url=..., auth=None)``.
        """
        resolved = await self._resolve_org(org)
        body = UpdateRepoBody(
            name=_opt(name),
            default_bookmark=_opt(default_bookmark),
            upstream=_to_update_repo_upstream(upstream),
        )
        resp = await update_repo.asyncio_detailed(
            resolved,
            repo,
            client=self._client,
            body=body,
        )
        return unwrap(resp)

    async def delete(
        self, *, repo: str, org: str | None = None
    ) -> DeleteRepoResponse200:
        """Delete ``repo`` and its history. Irreversible."""
        resolved = await self._resolve_org(org)
        resp = await delete_repo.asyncio_detailed(
            resolved,
            repo,
            client=self._client,
        )
        return unwrap(resp)

    async def sync_upstream(
        self,
        *,
        repo: str,
        direction: str,
        ref_globs: dict[str, str] | None = None,
        org: str | None = None,
    ) -> SyncUpstreamResponse201:
        """Sync the repository upstream."""
        resolved = await self._resolve_org(org)
        body: dict[str, Any] = {"direction": direction}
        if ref_globs is not None:
            body["ref_globs"] = ref_globs
        resp = await sync_upstream.asyncio_detailed(
            resolved,
            repo,
            client=self._client,
            body=SyncUpstreamBody.from_dict(body),
        )
        return unwrap(resp)

    async def get_upstream_sync(
        self,
        *,
        repo: str,
        sync_id: str,
        org: str | None = None,
    ) -> GetRepoUpstreamSyncResponse200:
        """Get one sync for the repository upstream."""
        resolved = await self._resolve_org(org)
        resp = await get_repo_upstream_sync.asyncio_detailed(
            resolved,
            repo,
            sync_id,
            client=self._client,
        )
        return unwrap(resp)

    async def list_upstream_syncs(
        self,
        *,
        repo: str,
        org: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> ListRepoUpstreamSyncsResponse200:
        """List syncs for the repository upstream, newest first."""
        resolved = await self._resolve_org(org)
        resp = await list_repo_upstream_syncs.asyncio_detailed(
            resolved,
            repo,
            client=self._client,
            cursor=_opt(cursor),
            limit=_opt(limit),
        )
        return unwrap(resp)


class Content:
    """Repo content browsing: ``mesa.content``."""

    def __init__(self, client: AuthenticatedClient, resolve_org: OrgResolver) -> None:
        self._client = client
        self._resolve_org = resolve_org

    async def get(
        self,
        *,
        repo: str,
        org: str | None = None,
        change_id: str | None = None,
        path: str | None = None,
        depth: int | None = None,
    ) -> ContentResponse:
        """Fetch a file or directory listing from ``repo``.

        :param change_id: Read at this change. Defaults to the repo's
            default bookmark.
        :param path: Repo-relative path. Defaults to the repo root.
        :param depth: Directory listing depth. ``1`` returns immediate
            children; higher values recurse.
        """
        resolved = await self._resolve_org(org)
        resp = await get_content.asyncio_detailed(
            resolved,
            repo,
            client=self._client,
            change_id=_opt(change_id),
            path=_opt(path),
            depth=_opt(depth),
        )
        return unwrap(resp)


class Bookmarks:
    """Bookmark management: ``mesa.bookmarks``.

    Bookmarks are named refs analogous to git branches. For mounted-FS
    bookmark operations, see ``mesa.fs.mount(...).bookmarks`` instead.
    """

    def __init__(
        self,
        client: AuthenticatedClient,
        resolve_org: OrgResolver,
        request_attribution: RequestAttribution,
    ) -> None:
        self._client = client
        self._resolve_org = resolve_org
        self._request_attribution = request_attribution

    async def list(
        self,
        *,
        repo: str,
        org: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
        glob: str | None = None,
    ) -> ListBookmarksResponse200:
        resolved = await self._resolve_org(org)
        resp = await list_bookmarks.asyncio_detailed(
            resolved,
            repo,
            client=self._client,
            cursor=_opt(cursor),
            limit=_opt(limit),
            glob=_opt(glob),
        )
        return unwrap(resp)

    async def get(
        self,
        *,
        repo: str,
        bookmark: str,
        org: str | None = None,
    ) -> GetBookmarkResponse200:
        resolved = await self._resolve_org(org)
        resp = await get_bookmark.asyncio_detailed(
            resolved,
            repo,
            bookmark,
            client=self._client,
        )
        return unwrap(resp)

    async def create(
        self,
        *,
        repo: str,
        name: str,
        change_id: str,
        org: str | None = None,
    ) -> CreateBookmarkResponse201:
        resolved = await self._resolve_org(org)
        body = CreateBookmarkBody(name=name, change_id=change_id)
        resp = await create_bookmark.asyncio_detailed(
            resolved,
            repo,
            client=self._client,
            body=body,
        )
        return unwrap(resp)

    async def delete(
        self,
        *,
        repo: str,
        bookmark: str,
        org: str | None = None,
    ) -> DeleteBookmarkResponse200:
        resolved = await self._resolve_org(org)
        resp = await delete_bookmark.asyncio_detailed(
            resolved,
            repo,
            bookmark,
            client=self._client,
        )
        return unwrap(resp)

    async def move(
        self,
        *,
        repo: str,
        bookmark: str,
        change_id: str,
        allow_backwards: bool = False,
        org: str | None = None,
    ) -> MoveBookmarkResponse200:
        """Repoint ``bookmark`` to ``change_id``.

        Moves must advance history unless ``allow_backwards`` is true.
        """
        resolved = await self._resolve_org(org)
        body = MoveBookmarkBody(
            change_id=change_id,
            allow_backwards=allow_backwards,
        )
        resp = await move_bookmark.asyncio_detailed(
            resolved,
            repo,
            bookmark,
            client=self._client,
            body=body,
        )
        return unwrap(resp)

    async def merge(
        self,
        *,
        repo: str,
        source: str,
        target: str,
        delete_source: bool | None = None,
        allow_conflicted: bool | None = None,
        message: str | None = None,
        resolutions: list[Resolution] | None = None,
        author: Author | None = None,
        authors: list[SigningKeyAuthor] | None = None,
        org: str | None = None,
    ) -> MergeBookmarkResponse200:
        """Merge ``source`` into ``target``.

        ``delete_source=True`` removes the source bookmark on success.

        :param allow_conflicted: When ``True``, a merge that produces textual
            conflicts is accepted and the target bookmark is moved to a
            conflicted merge commit. When ``False`` (default), the merge is
            rejected with :exc:`ConflictError`.
        :param message: Description for the resulting merge change. Pass
            ``None`` to use the server-generated merge description; pass ``""``
            for no description.
        :param resolutions: Conflict resolutions applied before conflict
            detection. Each resolution targets one path — either the full file
            or a set of per-hunk replacements.
        :param author: Singular commit attribution for a private-key client.
        :param authors: Ordered commit attribution for a private-key client.
        """
        if self._request_attribution.kind is AttributionKind.REQUEST and author is not None:
            raise InvalidOptionsError(
                "Bookmark merge authors require a private-key client."
            )
        _, credential = _prepare_commit_request(
            attribution=self._request_attribution,
            author=author,
            authors=authors,
        )
        resolved = await self._resolve_org(org)
        body = MergeBookmarkBody(
            source=source,
            target=target,
            delete_source=_opt(delete_source),
            allow_conflicted=_opt(allow_conflicted),
            resolutions=[_to_merge_resolution(r) for r in resolutions]
            if resolutions is not None
            else UNSET,
        )
        if message is not None:
            body["message"] = message
        with request_credential(self._request_attribution.auth, credential):
            resp = await merge_bookmark.asyncio_detailed(
                resolved,
                repo,
                client=self._client,
                body=body,
            )
        return unwrap(resp)


class Changes:
    """Change management via the REST API: ``mesa.changes``.

    For mounted-FS change operations, see ``mesa.fs.mount(...).changes``.
    """

    def __init__(
        self,
        client: AuthenticatedClient,
        resolve_org: OrgResolver,
        request_attribution: RequestAttribution,
    ) -> None:
        self._client = client
        self._resolve_org = resolve_org
        self._request_attribution = request_attribution

    async def list(
        self,
        *,
        repo: str,
        org: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
        bookmark: str | None = None,
    ) -> ListChangesResponse200:
        """Pass ``bookmark`` to restrict to changes reachable from that bookmark."""
        resolved = await self._resolve_org(org)
        resp = await list_changes.asyncio_detailed(
            resolved,
            repo,
            client=self._client,
            cursor=_opt(cursor),
            limit=_opt(limit),
            bookmark=_opt(bookmark),
        )
        return unwrap(resp)

    async def create(
        self,
        *,
        repo: str,
        base_change_id: str,
        org: str | None = None,
        message: str | None = None,
        author: Author | None = None,
        authors: list[SigningKeyAuthor] | None = None,
        committer: Author | None = None,
        files: list[FileChange] | None = None,
    ) -> CreateChangeResponse201:
        """Create a change forked from ``base_change_id``.

        :param files: File operations to apply atomically. Each entry is
            an :class:`~mesa_sdk.FileUpsert` or :class:`~mesa_sdk.FileDelete`.
        :param author: Singular commit attribution. Private-key clients sign it
            into a request credential instead of sending it in the body.
        :param authors: Ordered commit attribution for a private-key client.
        :param committer: When omitted, the server falls back to ``author``.
        """
        body_author, credential = _prepare_commit_request(
            attribution=self._request_attribution,
            author=author,
            authors=authors,
        )
        resolved = await self._resolve_org(org)
        body = CreateChangeBody(
            base_change_id=base_change_id,
            message=_opt(message),
            author=_to_create_author(body_author)
            if body_author is not None
            else UNSET,
            committer=_to_create_committer(committer)
            if committer is not None
            else UNSET,
            files=[_to_create_file(f) for f in files] if files is not None else UNSET,
        )
        with request_credential(self._request_attribution.auth, credential):
            resp = await create_change.asyncio_detailed(
                resolved,
                repo,
                client=self._client,
                body=body,
            )
        return unwrap(resp)

    async def get(
        self,
        *,
        repo: str,
        change_id: str,
        org: str | None = None,
    ) -> GetChangeResponse200:
        resolved = await self._resolve_org(org)
        resp = await get_change.asyncio_detailed(
            resolved,
            repo,
            change_id,
            client=self._client,
        )
        return unwrap(resp)

    async def patch(
        self,
        *,
        repo: str,
        change_id: str,
        org: str | None = None,
        message: str | None = None,
        author: Author | None = None,
        authors: list[SigningKeyAuthor] | None = None,
        committer: Author | None = None,
        files: list[FileChange] | None = None,
        base_commit_oid: str | None = None,
        resolutions: list[Resolution] | None = None,
    ) -> UpdateChangeResponse200:
        """Amend ``change_id``: edit message, identities, or apply more file ops.

        :param base_commit_oid: Optimistic-concurrency token. When set,
            the patch fails with :exc:`ConflictError` if the change has
            advanced past this commit. Omit to skip the check.
        :param resolutions: Conflict resolutions to apply to a conflicted
            change. Mutually exclusive with ``files``.
        :param author: Singular commit attribution. Private-key clients sign it
            into a request credential instead of sending it in the body.
        :param authors: Ordered commit attribution for a private-key client.
        """
        body_author, credential = _prepare_commit_request(
            attribution=self._request_attribution,
            author=author,
            authors=authors,
            preserve_existing_authors=bool(resolutions),
        )
        resolved = await self._resolve_org(org)
        body = UpdateChangeBody(
            message=_opt(message),
            author=_to_update_author(body_author)
            if body_author is not None
            else UNSET,
            committer=_to_update_committer(committer)
            if committer is not None
            else UNSET,
            files=[_to_update_file(f) for f in files] if files is not None else UNSET,
            base_commit_oid=_opt(base_commit_oid),
            resolutions=[_to_update_resolution(r) for r in resolutions]
            if resolutions is not None
            else UNSET,
        )
        with request_credential(self._request_attribution.auth, credential):
            resp = await update_change.asyncio_detailed(
                resolved,
                repo,
                change_id,
                client=self._client,
                body=body,
            )
        return unwrap(resp)


class Diffs:
    """Diff inspection: ``mesa.diffs``."""

    def __init__(self, client: AuthenticatedClient, resolve_org: OrgResolver) -> None:
        self._client = client
        self._resolve_org = resolve_org

    async def get(
        self,
        *,
        repo: str,
        base_change_id: str,
        head_change_id: str,
        conflicts: DiffConflictFilter | None = None,
        org: str | None = None,
    ) -> GetDiffResponse200:
        resolved = await self._resolve_org(org)
        resp = await get_diff.asyncio_detailed(
            resolved,
            repo,
            client=self._client,
            base_change_id=base_change_id,
            head_change_id=head_change_id,
            conflicts=GetDiffConflicts(conflicts) if conflicts is not None else UNSET,
        )
        return unwrap(resp)


class WebhookTargets:
    """Webhook delivery targets: ``mesa.webhook_targets``."""

    def __init__(self, client: AuthenticatedClient, resolve_org: OrgResolver) -> None:
        self._client = client
        self._resolve_org = resolve_org

    async def list(
        self,
        *,
        org: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> ListWebhookTargetsResponse200:
        resolved = await self._resolve_org(org)
        resp = await list_webhook_targets.asyncio_detailed(
            resolved,
            client=self._client,
            cursor=_opt(cursor),
            limit=_opt(limit),
        )
        return unwrap(resp)

    async def create(
        self,
        *,
        url: str,
        org: str | None = None,
        name: str | None = None,
        events: list[str] | None = None,
        repo_ids: list[str] | None = None,
    ) -> CreateWebhookTargetResponse201:
        """Register a webhook target.

        :param events: Event types to subscribe to. Defaults to
            ``["push"]`` when omitted.
        :param repo_ids: Restrict deliveries to these repos. Defaults to
            all repos in the organization.
        """
        resolved = await self._resolve_org(org)
        body = CreateWebhookTargetBody(
            url=url,
            name=_opt(name),
            events=[CreateWebhookTargetBodyEventsItem(e) for e in events]
            if events is not None
            else UNSET,
            repo_ids=_opt(repo_ids),
        )
        resp = await create_webhook_target.asyncio_detailed(
            resolved,
            client=self._client,
            body=body,
        )
        return unwrap(resp)

    async def update(
        self,
        *,
        webhook_target_id: str,
        org: str | None = None,
        url: str | None = None,
        name: str | None = None,
        events: list[str] | None = None,
        repo_ids: list[str] | None = None,
    ) -> UpdateWebhookTargetResponse200:
        """Only fields you pass are modified; omitted fields are left as-is."""
        resolved = await self._resolve_org(org)
        body = UpdateWebhookTargetBody(
            url=_opt(url),
            name=_opt(name),
            events=[UpdateWebhookTargetBodyEventsItem(e) for e in events]
            if events is not None
            else UNSET,
            repo_ids=_opt(repo_ids),
        )
        resp = await update_webhook_target.asyncio_detailed(
            resolved,
            webhook_target_id,
            client=self._client,
            body=body,
        )
        return unwrap(resp)

    async def clear_repo_filter(
        self,
        *,
        webhook_target_id: str,
        org: str | None = None,
    ) -> UpdateWebhookTargetResponse200:
        """Remove the per-repo filter so the target receives every repo's events."""
        resolved = await self._resolve_org(org)
        body = UpdateWebhookTargetBody(repo_ids=None)
        resp = await update_webhook_target.asyncio_detailed(
            resolved,
            webhook_target_id,
            client=self._client,
            body=body,
        )
        return unwrap(resp)

    async def delete(
        self,
        *,
        webhook_target_id: str,
        org: str | None = None,
    ) -> DeleteWebhookTargetResponse200:
        resolved = await self._resolve_org(org)
        resp = await delete_webhook_target.asyncio_detailed(
            resolved,
            webhook_target_id,
            client=self._client,
        )
        return unwrap(resp)
