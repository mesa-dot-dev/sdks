from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from mesa_rest.api.org import whoami as whoami_api

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
from mesa_sdk.errors import InvalidApiUrlError, InvalidOptionsError, MissingCredentialError
from mesa_sdk.types import MesaAuth, SigningKeyAuthor

if TYPE_CHECKING:
    from mesa_rest.client import AuthenticatedClient
    from mesa_rest.models.whoami_response_200 import WhoamiResponse200

DEFAULT_API_URL = "https://api.mesa.dev/v1"
PRIVATE_KEY_ENV_VAR = "MESA_PRIVATE_KEY"
#: Default scopes for ``tokens.create()`` and MesaFS mount tokens.
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
            "Pass only the access token value, without the `Bearer` scheme."
        )
    return normalized


def _resolve_credential(
    *,
    private_key: str | None,
    auth: Mapping[str, object] | None,
) -> _ResolvedCredential:
    """Resolve exactly one explicit or environment credential."""
    explicit_count = sum(value is not None for value in (private_key, auth))
    if explicit_count > 1:
        raise InvalidOptionsError("Pass exactly one of `private_key` or `auth`.")

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
    environment_private_key = os.environ.get(PRIVATE_KEY_ENV_VAR, "").strip()
    if environment_private_key:
        return _ResolvedCredential(
            kind=CredentialKind.PRIVATE_KEY,
            value=parse_private_key(environment_private_key),
        )

    raise MissingCredentialError(
        "Missing credential. Pass `private_key` or `auth`, or set "
        f"`{PRIVATE_KEY_ENV_VAR}` in your environment."
    )


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


class Mesa:
    """Async Mesa SDK client.

    Usage::

        async with Mesa(private_key="mesa_private_key_acme_...") as mesa:
            repos = await mesa.repos.list()
    """

    api_url: str

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
    _cached_whoami: WhoamiResponse200 | None

    def __init__(
        self,
        *,
        private_key: str | None = None,
        auth: MesaAuth | None = None,
        api_url: str = DEFAULT_API_URL,
        user_agent: str | None = None,
        webhook_secret: str | None = None,
    ) -> None:
        """Construct a Mesa client.

        :param private_key: Organization-bound Ed25519 private key used to
            sign fresh request and filesystem credentials locally. Falls back
            to the ``MESA_PRIVATE_KEY`` environment variable.
        :param auth: Grouped credential containing exactly one ``private_key``
            or compact JWT ``access_token``.
        :param api_url: Override the default API endpoint.
        :param user_agent: Custom ``User-Agent`` header.
        :param webhook_secret: Secret used by ``mesa.webhooks.receive(...)``.

        :raises MissingCredentialError: If no credential is provided directly
            or through ``MESA_PRIVATE_KEY``.
        """
        resolved_credential = _resolve_credential(private_key=private_key, auth=auth)
        self._credential = resolved_credential

        self.api_url = _normalize_url(api_url)
        if user_agent and looks_like_private_key(user_agent):
            raise InvalidOptionsError(
                "User-agent metadata must not contain Mesa private key material."
            )
        self._cached_whoami = None

        if resolved_credential.kind is CredentialKind.PRIVATE_KEY:
            private_key_credential = resolved_credential.value
            assert isinstance(private_key_credential, PrivateKeyCredential)
            credential_org = private_key_credential.org
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
            assert resolved_credential.org is not None
            credential_org = resolved_credential.org
            client_credential = resolved_credential.value
            request_attribution = RequestAttribution(
                kind=AttributionKind.FIXED_TOKEN
            )

        self._client = create_client(
            credential=client_credential,
            api_url=self.api_url,
            user_agent=user_agent,
        )

        self.repos = Repos(self._client, credential_org)
        self.bookmarks = Bookmarks(
            self._client, credential_org, request_attribution
        )
        self.changes = Changes(self._client, credential_org, request_attribution)
        self.content = Content(self._client, credential_org)
        self.diffs = Diffs(self._client, credential_org)
        self.tokens = Tokens(self._sign_token)
        self.api_keys = ApiKeys(self._client, credential_org)
        self.org = OrgResource(self._client, credential_org)
        self.webhook_targets = WebhookTargets(self._client, credential_org)
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

        raise InvalidOptionsError(
            "Access-token clients cannot mint another access token. Use a private key."
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
                    "The lifetime of an existing access token cannot be changed."
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

        raise AssertionError("unreachable credential kind")

    @property
    def fs(self) -> FsNamespace:
        """Filesystem namespace for mounting repos as a virtual filesystem.

        Use :meth:`mesa.fs(layout=...).mount() <mesa_sdk.LayoutDefinition.mount>`
        to open a :class:`MesaFileSystem`.
        """
        if not hasattr(self, "_fs"):
            self._fs = FsNamespace(self)
        return self._fs

    async def whoami(self) -> WhoamiResponse200:
        """Return the identity tied to the credential. Cached after first call."""
        if self._cached_whoami is not None:
            return self._cached_whoami

        resp = await whoami_api.asyncio_detailed(client=self._client)
        result = unwrap(resp)
        self._cached_whoami = result
        return result

    async def __aenter__(self) -> Mesa:
        await self._client.__aenter__()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self._client.__aexit__(*args)
