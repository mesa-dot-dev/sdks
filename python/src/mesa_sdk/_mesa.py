from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from mesa_rest.api.org import whoami as whoami_api

from mesa_sdk._signing_key import (
    NormalizedSigningKeyAuthors,
    PrivateKeyCredential,
    looks_like_private_key,
    normalize_signing_key_authors,
    parse_private_key,
    sign_private_key_access_token,
)
from mesa_sdk._client import BearerAuth, create_client, unwrap
from mesa_sdk._fs import FsNamespace
from mesa_sdk._resources import (
    Bookmarks,
    Changes,
    Content,
    Diffs,
    OrgResource,
    Repos,
    RequestAttribution,
    TokenCreateResult,
    WebhookTargets,
)
from mesa_sdk._webhooks import Webhooks
from mesa_sdk.errors import InvalidApiUrlError, InvalidOptionsError, MissingCredentialError
from mesa_sdk.types import SigningKeyAuthor

if TYPE_CHECKING:
    from mesa_rest.client import AuthenticatedClient
    from mesa_rest.models.whoami_response_200 import WhoamiResponse200

DEFAULT_API_URL = "https://api.mesa.dev/v1"
PRIVATE_KEY_ENV_VAR = "MESA_PRIVATE_KEY"
#: Default scopes for layout-scoped and MesaFS mount tokens.
DEFAULT_TOKEN_SCOPES = ["read", "write"]


def _resolve_private_key(private_key: str | None) -> PrivateKeyCredential:
    """Resolve an explicit private key or the environment fallback."""
    if private_key is not None:
        return parse_private_key(private_key)
    environment_private_key = os.environ.get(PRIVATE_KEY_ENV_VAR, "").strip()
    if environment_private_key:
        return parse_private_key(environment_private_key)

    raise MissingCredentialError(
        f"Missing credential. Pass a private key or set `{PRIVATE_KEY_ENV_VAR}`."
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
    org: OrgResource
    webhook_targets: WebhookTargets
    webhooks: Webhooks
    _credential: PrivateKeyCredential
    _client: AuthenticatedClient
    _cached_whoami: WhoamiResponse200 | None

    def __init__(
        self,
        *,
        private_key: str | None = None,
        api_url: str = DEFAULT_API_URL,
        user_agent: str | None = None,
        webhook_secret: str | None = None,
    ) -> None:
        """Construct a Mesa client.

        :param private_key: Organization-bound Ed25519 private key used to
            sign fresh request and filesystem credentials locally. Falls back
            to the ``MESA_PRIVATE_KEY`` environment variable.
        :param api_url: Override the default API endpoint.
        :param user_agent: Custom ``User-Agent`` header.
        :param webhook_secret: Secret used by ``mesa.webhooks.receive(...)``.

        :raises MissingCredentialError: If no credential is provided directly
            or through ``MESA_PRIVATE_KEY``.
        """
        credential = _resolve_private_key(private_key)
        self._credential = credential

        self.api_url = _normalize_url(api_url)
        if user_agent and looks_like_private_key(user_agent):
            raise InvalidOptionsError(
                "User-agent metadata must not contain Mesa private key material."
            )
        self._cached_whoami = None

        credential_org = credential.org
        bearer_auth = BearerAuth(
            lambda: sign_private_key_access_token(
                private_key=credential,
                authors=None,
                scopes=["admin"],
            ).token
        )
        request_attribution = RequestAttribution(
            sign=lambda authors: sign_private_key_access_token(
                private_key=credential,
                authors=authors,
                scopes=["admin"],
            ).token,
            auth=bearer_auth,
        )

        self._client = create_client(
            credential=bearer_auth,
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
        """Sign an access token locally from this client's root credential.

        Internal: the only public way to mint an exportable token is
        ``mesa.fs(layout=..., ttl=...).token()``, which routes here. Ordinary
        SDK calls do not need it -- a private-key client already signs a fresh
        organization-scoped token for every request it makes.
        """
        if authors is None:
            raise InvalidOptionsError(
                "Minted tokens require a nonempty `authors` option."
            )
        signed_private_key = sign_private_key_access_token(
            private_key=self._credential,
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

    async def _create_mount_token(
        self,
        *,
        scopes: list[str],
        repos: list[str],
        authors: NormalizedSigningKeyAuthors | None,
        ttl_seconds: int | None,
    ) -> str:
        """Return the bearer credential for a filesystem mount."""
        if authors is None:
            raise InvalidOptionsError(
                "Private-key mounts require a nonempty `authors` option."
            )
        return sign_private_key_access_token(
            private_key=self._credential,
            authors=authors,
            scopes=scopes,
            repos=repos,
            ttl_seconds=ttl_seconds,
        ).token

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
