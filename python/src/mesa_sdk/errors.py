from __future__ import annotations

from http import HTTPStatus
from typing import Any


class MesaError(Exception):
    """Base exception for SDK-layer errors: HTTP API failures, missing
    credentials, invalid URLs, and org resolution.

    Errors raised by the native filesystem/bash surface (``MesaFileSystem``,
    ``Bash``) use Python's built-in exception hierarchy instead —
    ``FileNotFoundError``, ``FileExistsError``, ``IsADirectoryError``,
    ``NotADirectoryError``, ``PermissionError``, ``ValueError``,
    ``NotImplementedError``, ``OSError``. Catch those directly rather than
    ``MesaError``.
    """

    code: str

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


class MissingCredentialError(MesaError):
    def __init__(self, message: str = "Missing credential.") -> None:
        super().__init__(
            "MISSING_CREDENTIAL",
            message,
        )


class InvalidApiUrlError(MesaError):
    def __init__(self, api_url: str) -> None:
        super().__init__("INVALID_API_URL", f"Invalid API URL: {api_url}")


class OrgResolutionError(MesaError):
    def __init__(self, message: str) -> None:
        super().__init__("ORG_RESOLUTION_FAILED", message)


class InvalidOptionsError(MesaError, ValueError):
    def __init__(self, message: str) -> None:
        super().__init__("INVALID_OPTIONS", message)


class MissingWebhookSecretError(MesaError):
    def __init__(self) -> None:
        super().__init__(
            "MISSING_WEBHOOK_SECRET",
            "Missing webhook secret. Pass `webhook_secret` to the Mesa constructor.",
        )


class MesaWebhookVerificationError(MesaError):
    def __init__(self, message: str) -> None:
        super().__init__("WEBHOOK_VERIFICATION_FAILED", message)


class WebhookHandlerError(MesaError):
    """Raised when one or more webhook handlers fail.

    All handlers registered for the event are still invoked; failures are
    collected in :attr:`errors`.
    """

    errors: list[Exception]

    def __init__(self, errors: list[Exception]) -> None:
        self.errors = errors
        super().__init__(
            "WEBHOOK_HANDLER_FAILED",
            f"{len(errors)} webhook handler(s) failed",
        )


class ApiError(MesaError):
    """Base exception for HTTP API errors. Contains the status code and raw response."""

    status_code: int
    body: Any

    def __init__(self, status_code: int, body: Any) -> None:
        self.status_code = status_code
        self.body = body
        # Try to extract a message from the error body
        message = str(body)
        if hasattr(body, "error") and hasattr(body.error, "message"):
            message = body.error.message
        super().__init__(f"API_ERROR_{status_code}", message)


class AuthenticationError(ApiError):
    """Raised on 401 responses."""


class AuthorizationError(ApiError):
    """Raised on 403 responses."""


class NotFoundError(ApiError):
    """Raised on 404 responses."""


class ValidationError(ApiError):
    """Raised on 400 responses."""


class ConflictError(ApiError):
    """Raised on 409 responses."""


class RateLimitError(ApiError):
    """Raised on 429 responses."""


class ServerError(ApiError):
    """Raised on 5xx responses."""


_STATUS_TO_ERROR: dict[int, type[ApiError]] = {
    400: ValidationError,
    401: AuthenticationError,
    403: AuthorizationError,
    404: NotFoundError,
    406: ValidationError,
    409: ConflictError,
    429: RateLimitError,
}


def raise_for_status(status_code: int | HTTPStatus, parsed: Any) -> None:
    """Raise a typed ApiError if the status code indicates an error."""
    code = int(status_code)
    if HTTPStatus.OK <= code < HTTPStatus.MULTIPLE_CHOICES:
        return

    error_cls = _STATUS_TO_ERROR.get(code)
    if error_cls is None and code >= HTTPStatus.INTERNAL_SERVER_ERROR:
        error_cls = ServerError
    if error_cls is None:
        error_cls = ApiError

    raise error_cls(code, parsed)
