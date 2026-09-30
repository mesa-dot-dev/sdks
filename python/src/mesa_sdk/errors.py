from __future__ import annotations

from http import HTTPStatus
from typing import Any, ClassVar, Literal

ErrorClass = Literal["transient", "bad-input", "fatal"]
"""How a caller should react to a failed filesystem operation.

The same three classes drive the ``mesa`` CLI's exit codes and the
TypeScript SDK's ``MesaFileSystemError.errorClass``.
"""


class MesaFileSystemError(Exception):
    """Base for classified filesystem failures.

    Catch MesaTransientError, MesaBadInputError, or MesaFatalError to
    handle a recovery category, or this base to handle all three. The original
    exception is available as ``__cause__`` and its errno as ``errno``.
    """

    error_class: ClassVar[ErrorClass | None] = None

    def __init__(self, message: str, *, cause: Exception | None = None) -> None:
        super().__init__(message)
        # Assigning __cause__, even None, hides the exception being handled.
        if cause is not None:
            self.__cause__ = cause

    @property
    def errno(self) -> int | None:
        # Read from __cause__ so `raise ... from oserror` also sets it.
        cause = self.__cause__
        return cause.errno if isinstance(cause, OSError) else None

    def __reduce__(self) -> tuple[Any, ...]:
        # Exception's default reduction omits the original cause.
        return (
            _restore_filesystem_error,
            (type(self), str(self), self.__cause__),
            self.__dict__,
        )


def _restore_filesystem_error(
    cls: type[MesaFileSystemError],
    message: str,
    cause: Exception | None,
) -> MesaFileSystemError:
    return cls(message, cause=cause)


class MesaTransientError(MesaFileSystemError):
    """The same filesystem operation may succeed on retry."""

    error_class: ClassVar[ErrorClass] = "transient"


class MesaBadInputError(MesaFileSystemError):
    """The caller must change arguments, credentials, or state before retrying."""

    error_class: ClassVar[ErrorClass] = "bad-input"


class MesaFatalError(MesaFileSystemError):
    """A Mesa bug or a failure the caller cannot fix; report it."""

    error_class: ClassVar[ErrorClass] = "fatal"


_FILESYSTEM_ERROR_TYPES: dict[ErrorClass, type[MesaFileSystemError]] = {
    "transient": MesaTransientError,
    "bad-input": MesaBadInputError,
    "fatal": MesaFatalError,
}


def _filesystem_error(error_class: ErrorClass, cause: Exception) -> MesaFileSystemError:
    return _FILESYSTEM_ERROR_TYPES[error_class](str(cause), cause=cause)



class MesaError(Exception):
    """Base exception for SDK-layer errors: HTTP API failures, missing
    credentials, invalid URLs, and org resolution.

    Classified native filesystem failures inherit from ``MesaFileSystemError``.
    Bash failures use built-in exceptions. Neither inherits from ``MesaError``.
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
