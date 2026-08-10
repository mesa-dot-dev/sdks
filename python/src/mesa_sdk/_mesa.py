from __future__ import annotations

import asyncio
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from mesa_rest.api.org import whoami as whoami_api

from mesa_sdk._access_token import sign_legacy_access_token
from mesa_sdk._signing_key import (
    NormalizedSigningKeyAuthors,
    PrivateKeyCredential,
    get_access_token_org,
    looks_like_private_key,
    normalize_signing_key_authors,
    parse_private_key,
    sign_private_key_access_token,
)
from mesa_sdk._client import BearerAuth, CredentialKind, create_client, unwrap
from mesa_sdk._fs import FsNamespace
from mesa_sdk._resources import (
    AttributionKind,
    ApiKeys,
    Bookmarks,
    Changes,
    Content,
    Diffs,
    OrgResource,
    Repos,
    RequestAttribution,
    TokenCreateResult,
    Tokens,
    WebhookTargets,
)
from mesa_sdk._webhooks import Webhooks
from mesa_sdk.errors import (
    ApiError,
    InvalidApiUrlError,
    InvalidOptionsError,
    MissingCredentialError,
    OrgResolutionError,
)
from mesa_sdk.types import MesaAuth, SigningKeyAuthor

if TYPE_CHECKING:
    from mesa_rest.client import AuthenticatedClient
    from mesa_rest.models.whoami_response_200 import WhoamiResponse200

DEFAULT_API_URL = "https://api.mesa.dev/v1"
API_KEY_ENV_VAR = "MESA_API_KEY"
PRIVATE_KEY_ENV_VAR = "MESA_PRIVATE_KEY"
#: Default scopes for ``tokens.create()`` and for MesaFS mount tokens. The
#: server clamps API-key tokens to the key's actual scopes at verify time,
#: so requesting the full set just means "as much as this key allows".
DEFAULT_TOKEN_SCOPES = ["read", "write"]


@dataclass(frozen=True)
class _ResolvedCredential:
    kind: CredentialKind
    value: str | PrivateKeyCredential
    org: str | None = None


def _normalize_bearer_credential(credential: object) -> str:
    if not isinstance(credential, str) or not credential.strip():
        raise InvalidOptionsError("Bearer credentials must be non-empty strings.")
    normalized = credential.strip()
    if looks_like_private_key(normalized):
        raise InvalidOptionsError(
            "Received a Mesa private key where a bearer credential was expected. "
            "Configure it with `private_key` or `auth[\"private_key\"]`."
        )
    if re.match(r"^Bearer\s+", normalized, flags=re.IGNORECASE):
        raise InvalidOptionsError(
            "Pass only the token or API key value, without the `Bearer` scheme."
        )
    return normalized


def _resolve_credential(
    *,
    api_key: str | None,
    private_key: str | None,
    auth: Mapping[str, object] | None,
) -> _ResolvedCredential:
    """Resolve exactly one explicit or environment credential.

    The established API-key argument and environment variable keep their
    legacy blank-value fallback behavior. A non-empty API key remains
    authoritative when both environment variables are present.
    """
    effective_api_key = (
        None if isinstance(api_key, str) and not api_key.strip() else api_key
    )
    explicit_count = sum(
        value is not None for value in (effective_api_key, private_key, auth)
    )
    if explicit_count > 1:
        raise InvalidOptionsError(
            "Pass exactly one of `api_key`, `private_key`, or `auth`."
        )

    if auth is not None:
        if not isinstance(auth, Mapping) or set(auth) not in (
            {"private_key"},
            {"access_token"},
        ):
            raise InvalidOptionsError(
                "`auth` accepts exactly one non-empty `private_key` or `access_token`."
            )
        if "private_key" in auth:
            private_key_value = auth["private_key"]
            if not isinstance(private_key_value, str):
                raise InvalidOptionsError(
                    "`auth` accepts exactly one non-empty `private_key` or "
                    "`access_token`."
                )
            return _ResolvedCredential(
                kind=CredentialKind.PRIVATE_KEY, value=parse_private_key(private_key_value)
            )
        value = _normalize_bearer_credential(auth["access_token"])
        return _ResolvedCredential(
            kind=CredentialKind.ACCESS_TOKEN, value=value, org=get_access_token_org(value)
        )

    if private_key is not None:
        return _ResolvedCredential(
            kind=CredentialKind.PRIVATE_KEY, value=parse_private_key(private_key)
        )
    if effective_api_key is not None:
        return _ResolvedCredential(
            kind=CredentialKind.API_KEY, value=_normalize_bearer_credential(effective_api_key)
        )

    environment_api_key = os.environ.get(API_KEY_ENV_VAR, "").strip()
    if environment_api_key:
        return _ResolvedCredential(
            kind=CredentialKind.API_KEY,
            value=_normalize_bearer_credential(environment_api_key),
        )
    environment_private_key = os.environ.get(PRIVATE_KEY_ENV_VAR, "").strip()
    if environment_private_key:
        return _ResolvedCredential(
            kind=CredentialKind.PRIVATE_KEY,
            value=parse_private_key(environment_private_key),
        )

    raise MissingCredentialError(API_KEY_ENV_VAR, PRIVATE_KEY_ENV_VAR)


def _normalize_url(url: str) -> str:
    if looks_like_private_key(url):
        raise InvalidApiUrlError("Mesa private keys cannot be used as URLs")
    try:
        parsed = urlparse(url.strip())
    except ValueError as exc:
        raise InvalidApiUrlError(url) from exc

    if parsed.scheme not in ("https", "http"):
        raise InvalidApiUrlError(url)

    return url.strip().rstrip("/")


def _url_origin(url: str) -> str:
    parsed = urlparse(url)
    if parsed.hostname is None:
        raise InvalidApiUrlError(url)
    hostname = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    try:
        port = f":{parsed.port}" if parsed.port is not None else ""
    except ValueError as exc:
        raise InvalidApiUrlError(url) from exc
    return f"{parsed.scheme}://{hostname}{port}"


class Mesa:
    """Async Mesa SDK client.

    Usage::

        async with Mesa(api_key="mk_...") as mesa:
            repos = await mesa.repos.list()
    """

    api_key: str | None
    """The API key for an API-key client, otherwise ``None``."""
    api_url: str
    vcs_url: str

    repos: Repos
    bookmarks: Bookmarks
    changes: Changes
    content: Content
    diffs: Diffs
    tokens: Tokens
    api_keys: ApiKeys
    org: OrgResource
    webhook_targets: WebhookTargets
    webhooks: Webhooks
    _credential: _ResolvedCredential
    _client: AuthenticatedClient
    _cached_org: str | None
    _cached_whoami: WhoamiResponse200 | None
    _cached_key_id: str | None
    _key_id_resolution: asyncio.Task[str] | None

    def __init__(
        self,
        *,
        api_key: str | None = None,
        private_key: str | None = None,
        auth: MesaAuth | None = None,
        api_url: str = DEFAULT_API_URL,
        vcs_url: str | None = None,
        org: str | None = None,
        user_agent: str | None = None,
        webhook_secret: str | None = None,
    ) -> None:
        """Construct a Mesa client.

        :param api_key: Long-lived API key (``mesa_...``). Falls back to the
            ``MESA_API_KEY`` environment variable (the fallback is deprecated
            alongside the parameter). API-key clients sign access tokens
            locally and transparently mint filesystem credentials.
            Deprecated: use ``private_key`` instead. API keys remain
            supported for existing integrations.
        :param private_key: Organization-bound Ed25519 private key used to
            sign fresh request and filesystem credentials locally. Falls back
            to the ``MESA_PRIVATE_KEY`` environment variable.
        :param auth: Grouped credential containing exactly one ``private_key``
            or compact JWT ``access_token``.
        :param api_url: Override the default API endpoint.
        :param vcs_url: Override the VCS endpoint derived from ``api_url``.
            Set this only when gRPC is served from a different origin.
        :param org: Default organization slug. When omitted, read locally from
            a private key or access token, or resolved lazily for an API key.
            Deprecated: the organization is derived from the private key or
            access token. Only API-key clients (also deprecated) need it.
        :param user_agent: Custom ``User-Agent`` header.
        :param webhook_secret: Secret used by ``mesa.webhooks.receive(...)``.

        :raises MissingCredentialError: If no credential is provided directly
            or through ``MESA_API_KEY`` or ``MESA_PRIVATE_KEY``.
        """
        resolved_credential = _resolve_credential(
            api_key=api_key, private_key=private_key, auth=auth
        )
        self._credential = resolved_credential
        self.api_key = (
            resolved_credential.value
            if resolved_credential.kind is CredentialKind.API_KEY
            and isinstance(resolved_credential.value, str)
            else None
        )

        self.api_url = _normalize_url(api_url)
        self.vcs_url = _normalize_url(vcs_url) if vcs_url else _url_origin(self.api_url)
        if user_agent and looks_like_private_key(user_agent):
            raise InvalidOptionsError(
                "User-agent metadata must not contain Mesa private key material."
            )
        provided_org = org.strip() if org else None
        if provided_org and looks_like_private_key(provided_org):
            raise InvalidOptionsError(
                "Organization options must not contain Mesa private key material."
            )
        if resolved_credential.kind is CredentialKind.PRIVATE_KEY:
            assert isinstance(resolved_credential.value, PrivateKeyCredential)
            if provided_org and provided_org != resolved_credential.value.org:
                raise InvalidOptionsError(
                    "The `org` option must match the organization encoded in the private key."
                )
            self._cached_org = resolved_credential.value.org
        elif resolved_credential.kind is CredentialKind.ACCESS_TOKEN:
            assert resolved_credential.org is not None
            if provided_org and provided_org != resolved_credential.org:
                raise InvalidOptionsError(
                    "The `org` option must match the organization encoded in the access token."
                )
            self._cached_org = resolved_credential.org
        else:
            self._cached_org = provided_org
        self._cached_whoami = None
        self._cached_key_id = None
        self._key_id_resolution = None

        if resolved_credential.kind is CredentialKind.PRIVATE_KEY:
            private_key_credential = resolved_credential.value
            assert isinstance(private_key_credential, PrivateKeyCredential)
            bearer_auth = BearerAuth(
                lambda: sign_private_key_access_token(
                    private_key=private_key_credential,
                    authors=None,
                    scopes=["admin"],
                ).token
            )
            client_credential: str | BearerAuth = bearer_auth
            request_attribution = RequestAttribution(
                kind=AttributionKind.PRIVATE_KEY,
                sign=lambda authors: sign_private_key_access_token(
                    private_key=private_key_credential,
                    authors=authors,
                    scopes=["admin"],
                ).token,
                auth=bearer_auth,
            )
        else:
            assert isinstance(resolved_credential.value, str)
            client_credential = resolved_credential.value
            request_attribution = RequestAttribution(
                kind=AttributionKind.FIXED_TOKEN
                if resolved_credential.kind is CredentialKind.ACCESS_TOKEN
                else AttributionKind.REQUEST
            )

        self._client = create_client(
            credential=client_credential,
            api_url=self.api_url,
            user_agent=user_agent,
        )

        self.repos = Repos(self._client, self.resolve_org)
        self.bookmarks = Bookmarks(
            self._client, self.resolve_org, request_attribution
        )
        self.changes = Changes(self._client, self.resolve_org, request_attribution)
        self.content = Content(self._client, self.resolve_org)
        self.diffs = Diffs(self._client, self.resolve_org)
        self.tokens = Tokens(self._sign_token)
        self.api_keys = ApiKeys(self._client, self.resolve_org)
        self.org = OrgResource(self._client, self.resolve_org)
        self.webhook_targets = WebhookTargets(self._client, self.resolve_org)
        self.webhooks = Webhooks(webhook_secret)

    async def _sign_token(
        self,
        *,
        scopes: list[str] | None,
        repos: list[str] | None,
        repo_ids: list[str] | None,
        authors: list[SigningKeyAuthor] | None,
        ttl_seconds: int | None,
    ) -> TokenCreateResult:
        """Sign an access token locally from this client's root credential."""
        if self._credential.kind is CredentialKind.PRIVATE_KEY:
            if authors is None:
                raise InvalidOptionsError(
                    "Private-key tokens require a nonempty `authors` option."
                )
            assert isinstance(self._credential.value, PrivateKeyCredential)
            signed_private_key = sign_private_key_access_token(
                private_key=self._credential.value,
                authors=normalize_signing_key_authors(authors),
                scopes=scopes if scopes is not None else list(DEFAULT_TOKEN_SCOPES),
                repos=repos,
                repo_ids=repo_ids,
                ttl_seconds=ttl_seconds,
            )
            return TokenCreateResult(
                token=signed_private_key.token,
                expires_at=signed_private_key.expires_at,
                scopes=signed_private_key.scopes,
                repos=signed_private_key.repos,
                repo_ids=signed_private_key.repo_ids,
            )

        if self._credential.kind is CredentialKind.ACCESS_TOKEN:
            raise InvalidOptionsError(
                "Access-token clients cannot mint another access token. "
                "Use an API key or private key."
            )

        if authors is not None:
            raise InvalidOptionsError(
                "Token authors can only be supplied for a private-key client."
            )
        assert isinstance(self._credential.value, str)
        key_id = await self._resolve_key_id()
        signed = sign_legacy_access_token(
            api_key_id=key_id,
            raw_api_key=self._credential.value,
            scopes=scopes if scopes is not None else list(DEFAULT_TOKEN_SCOPES),
            repos=repos,
            repo_ids=repo_ids,
            ttl_seconds=ttl_seconds,
        )
        return TokenCreateResult(
            token=signed.token,
            expires_at=signed.expires_at,
            scopes=signed.scopes,
            repos=signed.repos,
            repo_ids=signed.repo_ids,
        )

    async def _create_mount_token(
        self,
        *,
        scopes: list[str],
        repos: list[str],
        authors: NormalizedSigningKeyAuthors | None,
        ttl_seconds: int | None,
    ) -> str:
        """Return the bearer credential for a filesystem mount."""
        if self._credential.kind is CredentialKind.ACCESS_TOKEN:
            if authors is not None:
                raise InvalidOptionsError(
                    "Mount authors require a private-key client."
                )
            if ttl_seconds is not None:
                raise InvalidOptionsError(
                    "The lifetime of an existing access token cannot be changed "
                    "by `fs.mount()`."
                )
            assert isinstance(self._credential.value, str)
            return self._credential.value

        if self._credential.kind is CredentialKind.PRIVATE_KEY:
            if authors is None:
                raise InvalidOptionsError(
                    "Private-key mounts require a nonempty `authors` option."
                )
            assert isinstance(self._credential.value, PrivateKeyCredential)
            return sign_private_key_access_token(
                private_key=self._credential.value,
                authors=authors,
                scopes=scopes,
                repos=repos,
                ttl_seconds=ttl_seconds,
            ).token

        if authors is not None:
            raise InvalidOptionsError("Mount authors require a private-key client.")
        signed = await self.tokens.create(
            scopes=scopes,
            repos=repos,
            ttl_seconds=ttl_seconds,
        )
        return signed.token

    async def _resolve_key_id(self) -> str:
        """Resolve and cache this client's API key id, needed to build the access
        token ``kid`` header.

        Sourced from ``GET /whoami``, which returns the id of the key the
        request authenticated with. Lazily fetched and cached for the life of
        the client. Concurrent signs share a single in-flight ``/whoami`` rather
        than each kicking off their own.
        """
        if self._cached_key_id:
            return self._cached_key_id

        if self._key_id_resolution is None:
            self._key_id_resolution = asyncio.ensure_future(self._fetch_key_id())

        try:
            return await self._key_id_resolution
        except BaseException:
            # Allow a later sign to retry rather than caching the failure forever.
            self._key_id_resolution = None
            raise

    async def _fetch_key_id(self) -> str:
        whoami = await self.whoami()
        if not whoami.key_id:
            raise OrgResolutionError(
                "Unable to resolve API key id from /whoami; cannot sign access tokens."
            )
        # ``whoami()`` already caches ``key_id`` on this path, so no need to write it again.
        return whoami.key_id

    @property
    def fs(self) -> FsNamespace:
        """Filesystem namespace for mounting repos as a virtual filesystem.

        Use :meth:`mesa.fs.mount() <FsNamespace.mount>` to open a
        :class:`MesaFileSystem`.
        """
        if not hasattr(self, "_fs"):
            self._fs = FsNamespace(self)
        return self._fs

    async def resolve_org(self, org: str | None = None) -> str:
        """Return ``org`` if given, otherwise the client's default org.

        The default is taken from the private key, access token, or constructor's
        ``org`` parameter when available. API-key clients otherwise resolve it
        from ``/whoami`` on first use and cache it. Raises
        :exc:`OrgResolutionError` if no default can be determined.
        """
        requested_org = org.strip() if org else None
        if requested_org and looks_like_private_key(requested_org):
            raise InvalidOptionsError(
                "Organization options must not contain Mesa private key material."
            )
        if self._credential.kind is CredentialKind.PRIVATE_KEY:
            assert isinstance(self._credential.value, PrivateKeyCredential)
            if requested_org and requested_org != self._credential.value.org:
                raise InvalidOptionsError(
                    "Private-key clients are bound to the organization encoded in the key."
                )
            return self._credential.value.org
        if self._credential.kind is CredentialKind.ACCESS_TOKEN:
            assert self._credential.org is not None
            if requested_org and requested_org != self._credential.org:
                raise InvalidOptionsError(
                    "Access-token clients are bound to the organization encoded in the token."
                )
            return self._credential.org
        if requested_org:
            return requested_org
        if self._cached_org:
            return self._cached_org
        try:
            whoami = await self.whoami()
        except ApiError:
            raise
        except Exception as exc:
            raise OrgResolutionError(
                "Unable to resolve default organization. "
                "Provide `org` per call or verify your credential scopes."
            ) from exc
        self._cached_org = whoami.org.slug
        return self._cached_org

    async def whoami(self) -> WhoamiResponse200:
        """Return the identity tied to the credential. Cached after first call."""
        if self._cached_whoami is not None:
            return self._cached_whoami

        resp = await whoami_api.asyncio_detailed(client=self._client)
        result = unwrap(resp)
        self._cached_whoami = result
        self._cached_org = result.org.slug
        if result.key_id:
            self._cached_key_id = result.key_id
        return result

    async def __aenter__(self) -> Mesa:
        await self._client.__aenter__()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self._client.__aexit__(*args)
