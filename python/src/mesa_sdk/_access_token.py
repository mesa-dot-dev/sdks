"""Local access-token signing. Access tokens are short-lived HS256 JWTs whose
signing secret is derived from the raw API key the client holds, so a client
that holds an API key can sign them entirely offline — no network round-trip to
the server.

This is the SDK-side counterpart to the server's reference verifier in
``packages/core/src/auth/access-token-legacy.ts`` and the TypeScript SDK's
``packages/sdk/ts/src/api/access-token.ts``. The cross-language contract lives
in ``context/auth/legacy-access-token-protocol.md``; each signer verifies
against the same server, so byte-identical output across languages is not
required — only that the produced token verifies.

Secret derivation::

    secret = base64url_nopad(SHA-256(utf8(raw_api_key)))

This is byte-identical to the value stored in the server's ``apikey.key``
column. The HMAC key is the UTF-8 bytes of this base64url string.

The token carries NO org and NO user info: the server derives both from the API
key row at verification time, and clamps the requested scopes/repos to the
key's current permissions. New callers should use canonical ``repo_ids``;
the backward-compatible ``repos`` claim continues to carry full ``org/repo`` names.

Implemented with the Python standard library only (``hmac``, ``hashlib``,
``base64``, ``json``, ``uuid``, ``time``) — the published SDK takes no JWT
dependency.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from mesa_sdk.errors import InvalidOptionsError

#: Audience claim: access tokens are only valid when presented to the Mesa API.
ACCESS_TOKEN_AUD = "mesa-api"
#: JOSE ``typ`` header (RFC 9068 style) distinguishing access tokens.
ACCESS_TOKEN_TYP = "mesa-at+jwt"
#: JWA algorithm: HMAC-SHA256, keyed by the per-key derived secret.
LEGACY_ACCESS_TOKEN_ALG = "HS256"
#: Secret-derivation version, encoded into the ``kid`` header as
#: ``<api_key_id>.<version>``. Bump on the server and here together if the
#: derivation ever changes.
LEGACY_ACCESS_TOKEN_DERIVATION_VERSION = "v1"

#: Default token lifetime when the caller does not request one.
LEGACY_ACCESS_TOKEN_DEFAULT_TTL_SECONDS = 60 * 60  # 1 hour
#: Hard cap on token lifetime; the server rejects anything longer at verify time.
LEGACY_ACCESS_TOKEN_MAX_TTL_SECONDS = 24 * 60 * 60  # 24 hours


@dataclass(frozen=True)
class SignedAccessToken:
    """A locally signed access token plus the effective claims encoded into it."""

    token: str
    """The compact JWS access token string."""
    expires_at: datetime
    """Exact expiry, as a timezone-aware UTC ``datetime``."""
    scopes: list[str]
    """Effective scopes encoded into the token."""
    repos: list[str] | None
    """Backward-compatible full ``org/repo`` name restriction, when used."""
    repo_ids: list[str] | None
    """Canonical repository-ID restriction, when used."""
    jti: str
    """The token's unique id (``jti``), for auditing without re-decoding the JWT."""


def derive_legacy_access_token_signing_secret(raw_api_key: str) -> str:
    """Derive the HMAC signing secret from a raw API key.

    Byte-identical to the value stored in the server's ``apikey.key`` column.
    The HMAC key is the UTF-8 bytes of the returned base64url-nopad string.
    """
    digest = hashlib.sha256(raw_api_key.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _build_legacy_kid(api_key_id: str) -> str:
    """The ``kid`` header: ``<api_key_id>.<derivation_version>``."""
    return f"{api_key_id}.{LEGACY_ACCESS_TOKEN_DERIVATION_VERSION}"


def _base64url_json(value: object) -> str:
    """Compact-JSON-encode ``value`` and base64url-nopad it.

    Compact separators (no whitespace) and the caller-controlled dict key order
    are what make the encoded segment byte-identical across languages.
    """
    encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(encoded).rstrip(b"=").decode("ascii")


def sign_legacy_access_token(
    *,
    api_key_id: str,
    raw_api_key: str,
    scopes: list[str],
    repos: list[str] | None = None,
    repo_ids: list[str] | None = None,
    ttl_seconds: int | None = None,
    _iat: int | None = None,
    _jti: str | None = None,
) -> SignedAccessToken:
    """Sign an access token with HS256 entirely client-side.

    Emits a standard compact JWS:

    - header:  ``{alg, typ, kid}``
    - payload: ``{scopes, repos|repo_ids, iss, aud, iat, exp, jti}``

    :param api_key_id: The API key id that signs this token; encoded into
        ``kid`` and carried as the ``iss`` claim.
    :param raw_api_key: The raw API key (``mesa_...``) the client holds; the
        signing secret is derived from it.
    :param scopes: Requested scopes; clamped to the key's current scopes at
        verify time.
    :param repos: Backward-compatible restriction as full ``org/repo`` names.
    :param repo_ids: Canonical repository-ID restriction. Mutually exclusive with
        ``repos``.
    :param ttl_seconds: Token lifetime in seconds. Defaults to
        :data:`LEGACY_ACCESS_TOKEN_DEFAULT_TTL_SECONDS`.
    :param _iat: Test-only override for the issued-at timestamp, so the
        deterministic signature can be asserted against the cross-language
        vectors. Not part of the public API.
    :param _jti: Test-only override for the token's ``jti``. Not part of the
        public API.

    :raises InvalidOptionsError: If ``ttl_seconds`` is not a positive integer
        within the 24-hour cap.
    """
    ttl = (
        ttl_seconds
        if ttl_seconds is not None
        else LEGACY_ACCESS_TOKEN_DEFAULT_TTL_SECONDS
    )
    if (
        not isinstance(ttl, int)
        or ttl <= 0
        or ttl > LEGACY_ACCESS_TOKEN_MAX_TTL_SECONDS
    ):
        raise InvalidOptionsError(
            f"Token TTL must be an integer between 1 and "
            f"{LEGACY_ACCESS_TOKEN_MAX_TTL_SECONDS} seconds"
        )

    if repos is not None and repo_ids is not None:
        raise InvalidOptionsError(
            "Token repos and repo_ids restrictions are mutually exclusive"
        )

    iat = _iat if _iat is not None else int(time.time())
    exp = iat + ttl
    jti = _jti if _jti is not None else str(uuid.uuid4())

    header = {
        "alg": LEGACY_ACCESS_TOKEN_ALG,
        "typ": ACCESS_TOKEN_TYP,
        "kid": _build_legacy_kid(api_key_id),
    }
    repo_restriction = {"repo_ids": repo_ids} if repo_ids is not None else {"repos": repos}
    payload = {
        "scopes": scopes,
        **repo_restriction,
        "iss": api_key_id,
        "aud": ACCESS_TOKEN_AUD,
        "iat": iat,
        "exp": exp,
        "jti": jti,
    }

    signing_input = f"{_base64url_json(header)}.{_base64url_json(payload)}"
    secret = derive_legacy_access_token_signing_secret(raw_api_key)
    signature_bytes = hmac.new(
        secret.encode("utf-8"), signing_input.encode("utf-8"), hashlib.sha256
    ).digest()
    signature = base64.urlsafe_b64encode(signature_bytes).rstrip(b"=").decode("ascii")
    token = f"{signing_input}.{signature}"

    return SignedAccessToken(
        token=token,
        expires_at=datetime.fromtimestamp(exp, tz=timezone.utc),
        scopes=scopes,
        repos=repos if repo_ids is None else None,
        repo_ids=repo_ids,
        jti=jti,
    )
