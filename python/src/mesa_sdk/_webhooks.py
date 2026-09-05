"""Webhook verification and dispatch helpers."""

from __future__ import annotations

import hashlib
import hmac
import inspect
import json
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import TypeAlias

from mesa_sdk._webhook_events import (
    WEBHOOK_EVENT_NAMES,
    WebhookEvent,
    WebhookEventName,
    validate_webhook_event,
)
from mesa_sdk.errors import (
    InvalidOptionsError,
    MesaWebhookVerificationError,
    MissingWebhookSecretError,
    WebhookHandlerError,
)

SIGNATURE_HEADER = "x-mesa-signature"
WEBHOOK_TOLERANCE_SECONDS = 300
_SHA256_HEX_LENGTH = 64
_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")

WebhookHandler: TypeAlias = Callable[[WebhookEvent], Awaitable[None] | None]


def _body_bytes(raw_body: str | bytes) -> bytes:
    return raw_body if isinstance(raw_body, bytes) else raw_body.encode("utf-8")


def sign(secret: str, timestamp: int, raw_body: str | bytes) -> str:
    """Return the Mesa webhook HMAC for ``timestamp`` and ``raw_body``."""
    payload = f"{timestamp}.".encode("utf-8") + _body_bytes(raw_body)
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def _header(headers: Mapping[str, str], name: str) -> str | None:
    lowered = name.lower()
    for key, value in headers.items():
        if key.lower() == lowered:
            return value
    return None


def _parse_signature_header(value: str) -> tuple[int, str]:
    parts: dict[str, str] = {}
    for part in value.split(","):
        key, sep, part_value = part.partition("=")
        if sep:
            parts[key.strip()] = part_value.strip()

    try:
        timestamp = int(parts.get("t", ""))
    except ValueError as exc:
        raise MesaWebhookVerificationError("Malformed signature header") from exc

    signature = parts.get("sha256")
    if timestamp <= 0 or not signature:
        raise MesaWebhookVerificationError("Malformed signature header")
    if len(signature) != _SHA256_HEX_LENGTH or any(
        digit not in _HEX_DIGITS for digit in signature
    ):
        raise MesaWebhookVerificationError("Malformed signature header")
    return timestamp, signature.lower()


class Webhooks:
    """Inbound webhook verification and dispatch namespace."""

    def __init__(self, secret: str | None = None) -> None:
        self._secret = secret
        self._listeners: dict[str, list[WebhookHandler]] = {
            name: [] for name in WEBHOOK_EVENT_NAMES
        }

    def on(
        self,
        name: WebhookEventName | Sequence[WebhookEventName],
        handler: WebhookHandler,
    ) -> None:
        """Register ``handler`` for one or more Mesa webhook event types."""
        names = [name] if isinstance(name, str) else list(name)
        for event_name in names:
            if event_name not in self._listeners:
                raise InvalidOptionsError(f"Unknown webhook event type: {event_name}")
            self._listeners[event_name].append(handler)

    async def receive(self, body: str | bytes, headers: Mapping[str, str]) -> None:
        """Verify ``body`` and dispatch it to registered handlers.

        ``headers`` must include ``x-mesa-signature`` in the form
        ``t=<unix-seconds>,sha256=<hex-hmac>``.
        """
        if not self._secret:
            raise MissingWebhookSecretError()

        signature_header = _header(headers, SIGNATURE_HEADER)
        if not signature_header:
            raise MesaWebhookVerificationError("Missing signature header")

        timestamp, signature = _parse_signature_header(signature_header)
        if abs(int(time.time()) - timestamp) > WEBHOOK_TOLERANCE_SECONDS:
            raise MesaWebhookVerificationError(
                "Webhook timestamp outside tolerance window"
            )

        expected = sign(self._secret, timestamp, body)
        # hmac.compare_digest performs a timing-safe comparison for equal-type
        # inputs. The signature length is not secret; the HMAC value is.
        if not hmac.compare_digest(signature, expected):
            raise MesaWebhookVerificationError("Invalid webhook signature")

        try:
            parsed = json.loads(_body_bytes(body).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise MesaWebhookVerificationError(
                "Could not parse webhook payload as JSON"
            ) from exc

        event = validate_webhook_event(parsed)
        errors: list[Exception] = []
        for handler in self._listeners[event["type"]]:
            try:
                result = handler(event)
                if inspect.isawaitable(result):
                    await result
            except Exception as exc:
                errors.append(exc)

        if errors:
            raise WebhookHandlerError(errors)
