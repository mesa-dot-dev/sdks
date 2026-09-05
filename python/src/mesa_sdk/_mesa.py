from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from mesa_rest.api.org import whoami as whoami_api

from mesa_sdk._signing_key import (
    NormalizedSigningKeyAuthors,
    PrivateKeyCredential,
    SignedAccessToken,
    SigningKeyAccess,
    looks_like_private_key,
    parse_private_key,
    sign_automatic_private_key_access_token,
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
    WebhookTargets,
)
from mesa_sdk._webhooks import Webhooks
from mesa_sdk.errors import (
    InvalidApiUrlError,
    InvalidOptionsError,
    MissingCredentialError,
)

if TYPE_CHECKING:
    from mesa_rest.client import AuthenticatedClient
    from mesa_rest.models.whoami_response_200 import WhoamiResponse200

DEFAULT_API_URL = "https://api.mesa.dev/v1"
PRIVATE_KEY_ENV_VAR = "MESA_PRIVATE_KEY"


def _resolve_private_key(private_key: str | None) -> PrivateKeyCredential:
    """Resolve an explicit or environment private key."""
    if private_key is not None:
        return parse_private_key(private_key)
    environment_private_key = os.environ.get(PRIVATE_KEY_ENV_VAR, "").strip()
    if environment_private_key:
        return parse_private_key(environment_private_key)

    raise MissingCredentialError(
        "Missing credential. Pass `private_key` or set "
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
        private_key_credential = _resolve_private_key(private_key)
        self._credential = private_key_credential

        self.api_url = _normalize_url(api_url)
        if user_agent and looks_like_private_key(user_agent):
            raise InvalidOptionsError(
                "User-agent metadata must not contain Mesa private key material."
            )
        self._cached_whoami = None

        credential_org = private_key_credential.org
        bearer_auth = BearerAuth(
            lambda: (
                sign_automatic_private_key_access_token(
                    private_key=private_key_credential,
                    admin=True,
                ).token
            )
        )
        request_attribution = RequestAttribution(
            sign=lambda authors: (
                sign_automatic_private_key_access_token(
                    private_key=private_key_credential,
                    authors=authors,
                    admin=True,
                ).token
            ),
            auth=bearer_auth,
        )

        self._client = create_client(
            credential=bearer_auth,
            api_url=self.api_url,
            user_agent=user_agent,
        )

        self.repos = Repos(self._client, credential_org)
        self.bookmarks = Bookmarks(self._client, credential_org, request_attribution)
        self.changes = Changes(self._client, credential_org, request_attribution)
        self.content = Content(self._client, credential_org)
        self.diffs = Diffs(self._client, credential_org)
        self.org = OrgResource(self._client, credential_org)
        self.webhook_targets = WebhookTargets(self._client, credential_org)
        self.webhooks = Webhooks(webhook_secret)

    async def _create_mount_token(
        self,
        *,
        access: SigningKeyAccess,
        authors: NormalizedSigningKeyAuthors,
        ttl_seconds: int | None,
    ) -> str:
        """Return the bearer credential for a filesystem mount."""
        return self._sign_layout_token(
            access=access,
            authors=authors,
            ttl_seconds=ttl_seconds,
        ).token

    def _sign_layout_token(
        self,
        *,
        access: SigningKeyAccess,
        authors: NormalizedSigningKeyAuthors,
        ttl_seconds: int | None,
    ) -> SignedAccessToken:
        """Sign a private-key filesystem layout credential."""
        return sign_automatic_private_key_access_token(
            private_key=self._credential,
            authors=authors,
            access=access,
            ttl_seconds=ttl_seconds,
        )

    @property
    def fs(self) -> FsNamespace:
        """Filesystem namespace for mounting repos as a virtual filesystem.

        Use :meth:`mesa.fs(layout=...).mount() <mesa_sdk.FilesystemDefinition.mount>`
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
