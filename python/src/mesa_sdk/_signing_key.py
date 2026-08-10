"""Ed25519 private-key parsing and signing-key access-token minting.

The private key stays in the Python process. This module parses the canonical
Mesa private-key envelope, normalizes optional ordered authors, and signs the
JWT contract accepted by ``packages/core/src/auth/signing-key-access-token.ts``.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
import time
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal, NamedTuple, TypeAlias, TypedDict

from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from mesa_sdk._access_token import (
    ACCESS_TOKEN_AUD,
    ACCESS_TOKEN_TYP,
    SignedAccessToken,
)
from mesa_sdk.errors import InvalidOptionsError

#: Prefix for organization-bound Ed25519 signing private keys.
MESA_PRIVATE_KEY_PREFIX = "mesa_private_key_"
#: Default signing-key token lifetime.
SIGNING_KEY_ACCESS_TOKEN_DEFAULT_TTL_SECONDS = 15 * 60  # 15 minutes
#: Hard cap enforced by the signing-key verifier.
SIGNING_KEY_ACCESS_TOKEN_MAX_TTL_SECONDS = 4 * 60 * 60  # 4 hours
#: Maximum ordered commit authors accepted by the signing-key verifier.
MAX_SIGNING_KEY_AUTHORS = 100

_MESA_PRIVATE_KEY_BODY_PATTERN = re.compile(
    r"^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)_([A-Za-z0-9_-]+)$"
)
_ACCESS_TOKEN_ORG_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")
_PEM_PRIVATE_KEY_PATTERN = re.compile(
    r"^-----(?:BEGIN|END) (?:[A-Z0-9]+ )*PRIVATE KEY-----$",
    re.IGNORECASE | re.MULTILINE,
)


class NormalizedSigningKeyAuthor(NamedTuple):
    """One validated author. As a tuple it serializes to the claim's [name, email] pair."""

    name: str
    email: str | None


NormalizedSigningKeyAuthors: TypeAlias = tuple[NormalizedSigningKeyAuthor, ...]


class PublicJwk(TypedDict):
    """The RFC 7517 JWK for an Ed25519 public key, embedded in token headers.

    A plain dict at runtime: it is serialized verbatim into the JWT ``jwk``
    header field, so its shape is part of the wire contract.
    """

    kty: Literal["OKP"]
    crv: Literal["Ed25519"]
    x: str


@dataclass(frozen=True)
class PrivateKeyCredential:
    """Parsed organization-bound Ed25519 credential used for local signing."""

    org: str
    private_key: Ed25519PrivateKey = field(repr=False)
    public_jwk: PublicJwk


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _base64url_json(value: object) -> str:
    encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return _base64url_encode(encoded)


def _base64url_decode(value: str) -> bytes:
    """Decode a canonical unpadded base64url value."""
    if not value or re.fullmatch(r"[A-Za-z0-9_-]+", value) is None:
        raise ValueError("invalid base64url")
    try:
        decoded = base64.b64decode(
            value + "=" * (-len(value) % 4), altchars=b"-_", validate=True
        )
    except (binascii.Error, ValueError) as exc:
        raise ValueError("invalid base64url") from exc
    if _base64url_encode(decoded) != value:
        raise ValueError("non-canonical base64url")
    return decoded


def get_access_token_org(token: str) -> str:
    """Read and validate the organization issuer from a compact JWT."""
    try:
        parts = token.split(".")
        if len(parts) != 3 or any(not part for part in parts):
            raise ValueError("invalid compact JWT")
        encoded_payload = parts[1] + "=" * (-len(parts[1]) % 4)
        payload: object = json.loads(base64.urlsafe_b64decode(encoded_payload))
        if not isinstance(payload, Mapping):
            raise ValueError("invalid JWT payload")
        issuer = payload.get("iss")
        if not isinstance(issuer, str) or _ACCESS_TOKEN_ORG_PATTERN.fullmatch(
            issuer
        ) is None:
            raise ValueError("invalid organization issuer")
        return issuer
    except ValueError:
        raise InvalidOptionsError(
            "Access tokens must be compact JWTs with a valid organization `iss` claim."
        ) from None


def looks_like_private_key(value: str) -> bool:
    """Recognize private-key formats before an outbound boundary."""
    normalized = value.strip()
    return (
        MESA_PRIVATE_KEY_PREFIX in normalized.lower()
        or _PEM_PRIVATE_KEY_PATTERN.search(normalized) is not None
    )


def parse_private_key(private_key: str) -> PrivateKeyCredential:
    """Parse and validate a Mesa Ed25519 private key once for repeated signing."""
    if not isinstance(private_key, str):
        raise InvalidOptionsError(
            "Expected a private key beginning with `mesa_private_key_`."
        )
    value = private_key.strip()
    if not value.startswith(MESA_PRIVATE_KEY_PREFIX):
        raise InvalidOptionsError(
            "Expected a private key beginning with `mesa_private_key_`."
        )

    match = _MESA_PRIVATE_KEY_BODY_PATTERN.fullmatch(
        value[len(MESA_PRIVATE_KEY_PREFIX) :]
    )
    if match is None:
        raise InvalidOptionsError("Expected `mesa_private_key_<organization>_<key>`.")

    org, encoded_key = match.groups()
    try:
        key_bytes = _base64url_decode(encoded_key)
        parsed_key = serialization.load_der_private_key(key_bytes, password=None)
    except (TypeError, UnsupportedAlgorithm, ValueError):
        raise InvalidOptionsError("The private key is not a valid Ed25519 key.") from None

    if not isinstance(parsed_key, Ed25519PrivateKey):
        raise InvalidOptionsError("The private key must use Ed25519.")

    canonical_key_bytes = parsed_key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    if canonical_key_bytes != key_bytes:
        raise InvalidOptionsError(
            "The private key must use canonical Ed25519 PKCS#8 DER encoding."
        )

    public_key_bytes = parsed_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return PrivateKeyCredential(
        org=org,
        private_key=parsed_key,
        public_jwk={
            "kty": "OKP",
            "crv": "Ed25519",
            "x": _base64url_encode(public_key_bytes),
        },
    )


def normalize_signing_key_authors(
    authors: Sequence[Mapping[str, object]],
) -> NormalizedSigningKeyAuthors:
    """Validate authors and return an immutable ordered representation."""
    if (
        isinstance(authors, (str, bytes))
        or not isinstance(authors, Sequence)
        or not authors
    ):
        raise InvalidOptionsError("Invalid authors: at least one author is required.")
    if len(authors) > MAX_SIGNING_KEY_AUTHORS:
        raise InvalidOptionsError(
            f"Invalid authors: At most {MAX_SIGNING_KEY_AUTHORS} authors are allowed."
        )

    normalized: list[NormalizedSigningKeyAuthor] = []
    for index, author in enumerate(authors):
        if not isinstance(author, Mapping):
            raise InvalidOptionsError(
                f"Invalid authors.{index}: expected `name` and optional `email`."
            )

        name = author.get("name")
        if not isinstance(name, str) or not name.strip():
            raise InvalidOptionsError(
                f"Invalid authors.{index}.name: Author names must not be blank."
            )
        normalized_name = name.strip()
        if re.search(r"[<>\r\n]", normalized_name):
            raise InvalidOptionsError(
                f"Invalid authors.{index}.name: Author names must not contain "
                "angle brackets or newlines."
            )

        email = author.get("email")
        if email is not None and not isinstance(email, str):
            raise InvalidOptionsError(
                f"Invalid authors.{index}.email: Author emails must be strings or null."
            )
        normalized_email = email.strip() or None if isinstance(email, str) else None
        if normalized_email is not None and re.search(r"[<>\r\n]", normalized_email):
            raise InvalidOptionsError(
                f"Invalid authors.{index}.email: Author emails must not contain "
                "angle brackets or newlines."
            )
        normalized.append(
            NormalizedSigningKeyAuthor(normalized_name, normalized_email)
        )

    return tuple(normalized)


def _normalize_signing_key_scopes(scopes: Sequence[str]) -> list[str]:
    if isinstance(scopes, (str, bytes)) or not scopes:
        raise InvalidOptionsError("Invalid scopes: at least one scope is required.")

    normalized: list[str] = []
    for index, scope in enumerate(scopes):
        if scope not in ("read", "write", "admin"):
            raise InvalidOptionsError(
                f"Invalid scopes.{index}: expected `read`, `write`, or `admin`."
            )
        if scope not in normalized:
            normalized.append(scope)
    return normalized


def _validate_signing_key_restrictions(
    repos: Sequence[str] | None,
    repo_ids: Sequence[str] | None,
) -> tuple[list[str] | None, list[str] | None]:
    if repos is not None and repo_ids is not None:
        raise InvalidOptionsError(
            "Token repos and repo_ids restrictions are mutually exclusive"
        )

    if isinstance(repos, (str, bytes)):
        raise InvalidOptionsError("Invalid repos: expected a list of repository names.")
    if isinstance(repo_ids, (str, bytes)):
        raise InvalidOptionsError("Invalid repo_ids: expected a list of repository IDs.")

    normalized_repos = list(repos) if repos is not None else None
    normalized_repo_ids = list(repo_ids) if repo_ids is not None else None
    if normalized_repos is not None:
        for index, repo in enumerate(normalized_repos):
            if not isinstance(repo, str) or not repo:
                raise InvalidOptionsError(
                    f"Invalid repos.{index}: Token repos must not be empty."
                )
            if looks_like_private_key(repo):
                raise InvalidOptionsError(
                    f"Invalid repos.{index}: Token repos must not contain Mesa private keys."
                )
    if normalized_repo_ids is not None:
        if len(normalized_repo_ids) > 250:
            raise InvalidOptionsError(
                "Invalid repo_ids: Token repo_ids may contain at most 250 IDs."
            )
        for index, repo_id in enumerate(normalized_repo_ids):
            if not isinstance(repo_id, str) or not repo_id:
                raise InvalidOptionsError(
                    f"Invalid repo_ids.{index}: Token repo IDs must not be empty."
                )
            if looks_like_private_key(repo_id):
                raise InvalidOptionsError(
                    f"Invalid repo_ids.{index}: Token repo IDs must not contain Mesa private keys."
                )
    return normalized_repos, normalized_repo_ids


def sign_private_key_access_token(
    *,
    private_key: PrivateKeyCredential,
    authors: NormalizedSigningKeyAuthors | None,
    scopes: Sequence[str],
    repos: Sequence[str] | None = None,
    repo_ids: Sequence[str] | None = None,
    ttl_seconds: int | None = None,
    _iat: int | None = None,
    _jti: str | None = None,
) -> SignedAccessToken:
    """Sign an Ed25519 access token with normalized optional authors."""
    ttl = (
        ttl_seconds
        if ttl_seconds is not None
        else SIGNING_KEY_ACCESS_TOKEN_DEFAULT_TTL_SECONDS
    )
    if (
        type(ttl) is not int
        or ttl <= 0
        or ttl > SIGNING_KEY_ACCESS_TOKEN_MAX_TTL_SECONDS
    ):
        raise InvalidOptionsError(
            "Token TTL must be an integer between 1 and "
            f"{SIGNING_KEY_ACCESS_TOKEN_MAX_TTL_SECONDS} seconds"
        )

    normalized_scopes = _normalize_signing_key_scopes(scopes)
    normalized_repos, normalized_repo_ids = _validate_signing_key_restrictions(
        repos, repo_ids
    )
    iat = _iat if _iat is not None else int(time.time())
    exp = iat + ttl
    jti = _jti if _jti is not None else str(uuid.uuid4())
    header = {
        "alg": "EdDSA",
        "typ": ACCESS_TOKEN_TYP,
        "jwk": private_key.public_jwk,
    }
    payload = {
        "iss": private_key.org,
        "aud": ACCESS_TOKEN_AUD,
        **(
            {}
            if authors is None
            else {"author": [list(author) for author in authors]}
        ),
        "scopes": normalized_scopes,
        **(
            {"repo_ids": normalized_repo_ids}
            if normalized_repo_ids is not None
            else {"repos": normalized_repos}
        ),
        "iat": iat,
        "exp": exp,
        "jti": jti,
    }

    signing_input = f"{_base64url_json(header)}.{_base64url_json(payload)}"
    signature = _base64url_encode(private_key.private_key.sign(signing_input.encode()))
    return SignedAccessToken(
        token=f"{signing_input}.{signature}",
        expires_at=datetime.fromtimestamp(exp, tz=timezone.utc),
        scopes=normalized_scopes,
        repos=normalized_repos if normalized_repo_ids is None else None,
        repo_ids=normalized_repo_ids,
        jti=jti,
    )
