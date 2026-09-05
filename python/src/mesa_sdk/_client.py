from __future__ import annotations

from collections.abc import Callable, Generator, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import TYPE_CHECKING, TypeVar

import httpx

from mesa_rest.client import AuthenticatedClient

from mesa_sdk._version import __version__
from mesa_sdk.errors import raise_for_status

if TYPE_CHECKING:
    from mesa_rest.types import Response

T = TypeVar("T")

SDK_USER_AGENT = f"mesa-sdk-python/{__version__}"


class BearerAuth(httpx.Auth):
    """Mint a fresh bearer credential for each HTTP request.

    Private-key clients don't hold a fixed bearer secret: they sign a
    short-lived access token per request. ``credential`` is a zero-argument
    minting function rather than a string so each request gets a current
    token, and so this transport module stays decoupled from the signing
    module that knows how to produce one (mirroring the TS SDK, whose REST
    client takes ``string | (() => string)``).
    """

    def __init__(self, credential: Callable[[], str]) -> None:
        self._credential = credential
        self._credential_override: ContextVar[str | None] = ContextVar(
            "mesa_request_credential", default=None
        )

    @contextmanager
    def override(self, credential: str) -> Iterator[None]:
        token = self._credential_override.set(credential)
        try:
            yield
        finally:
            self._credential_override.reset(token)

    def auth_flow(
        self, request: httpx.Request
    ) -> Generator[httpx.Request, httpx.Response, None]:
        credential = self._credential_override.get() or self._credential()
        request.headers["Authorization"] = f"Bearer {credential}"
        yield request


@contextmanager
def request_credential(auth: BearerAuth, credential: str | None) -> Iterator[None]:
    """Override one private-key request without mutating shared client state."""
    if credential is None:
        yield
        return

    with auth.override(credential):
        yield


def create_client(
    *,
    credential: BearerAuth,
    api_url: str,
    user_agent: str | None = None,
) -> AuthenticatedClient:
    """Create an AuthenticatedClient configured for the Mesa API."""
    suffix = user_agent.strip() if user_agent else ""
    ua = f"{SDK_USER_AGENT} {suffix}" if suffix else SDK_USER_AGENT
    headers = {"User-Agent": ua}

    return AuthenticatedClient(
        base_url=api_url,
        token="",
        prefix="",
        headers=headers,
        raise_on_unexpected_status=False,
        httpx_args={"auth": credential},
    )


def unwrap(response: Response[T]) -> T:
    """Extract the parsed response body, raising a typed error for non-2xx status codes."""
    raise_for_status(response.status_code, response.parsed)
    return response.parsed  # type: ignore[return-value]
