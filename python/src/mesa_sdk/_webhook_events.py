"""Webhook event payload validation."""

from __future__ import annotations

from typing import Annotated, Any, Literal, TypeAlias, get_args

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from mesa_sdk.errors import MesaWebhookVerificationError

WebhookEventName: TypeAlias = Literal[
    "repo.created",
    "repo.updated",
    "repo.deleted",
    "bookmark.created",
    "bookmark.deleted",
    "bookmark.moved",
    "bookmark.merged",
    "change.created",
    "change.evolved",
    "push",
    "sync.queued",
    "sync.in_progress",
    "sync.completed",
    "sync.failed",
]
WebhookEvent: TypeAlias = dict[str, Any]


class _WebhookModel(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)


class _Organization(_WebhookModel):
    id: str
    slug: str
    name: str


class _Repository(_WebhookModel):
    id: str
    name: str
    url: str


class _RepoInfo(_WebhookModel):
    id: str
    name: str
    default_bookmark: str
    head_change_id: str
    created_at: str
    tags: dict[str, str]


class _RepoSnapshot(_WebhookModel):
    name: str
    default_bookmark: str
    tags: dict[str, str]


class _BookmarkInfo(_WebhookModel):
    name: str
    is_default: bool
    change_id: str
    commit_oid: str


class _BookmarkPosition(_WebhookModel):
    change_id: str
    commit_oid: str


class _Author(_WebhookModel):
    name: str
    email: str
    date: str | None = None


class _ChangeInfo(_WebhookModel):
    id: str
    current_commit_oid: str
    message: str
    author: _Author
    committer: _Author
    parents: list[str]
    created_at: str
    updated_at: str


class _PushUpdate(_WebhookModel):
    ref: str
    bookmark: str
    before: str | None
    after: str | None
    action: Literal["created", "updated", "deleted"]


class _PushReconciliation(_WebhookModel):
    reconciled_commit_count: int | float
    touched_change_count: int | float
    changes_created_count: int | float
    evolog_inserted_count: int | float
    invalid_change_id_header_count: int | float
    dirty_change_skip_count: int | float


class _SyncRefGlobs(_WebhookModel):
    branches: str
    tags: str


class _SyncStatsRef(_WebhookModel):
    name: str
    before: str | None
    after: str
    outcome: Literal["updated", "unchanged", "filtered", "rejected"]


class _SyncStats(_WebhookModel):
    refs: list[_SyncStatsRef]


class _RepoCreatedData(_WebhookModel):
    repo: _RepoInfo


class _RepoUpdatedData(_WebhookModel):
    repo: _RepoInfo
    before: _RepoSnapshot
    after: _RepoSnapshot


class _BookmarkData(_WebhookModel):
    bookmark: _BookmarkInfo


class _BookmarkMovedData(_WebhookModel):
    bookmark: _BookmarkInfo
    from_: _BookmarkPosition = Field(alias="from")


class _ChangeCreatedData(_WebhookModel):
    change: _ChangeInfo


class _ChangeEvolvedData(_WebhookModel):
    change: _ChangeInfo
    previous_current_commit_oid: str


class _PushData(_WebhookModel):
    updates: list[_PushUpdate]
    reconciliation: _PushReconciliation


class _SyncBase(_WebhookModel):
    id: str
    repo_id: str
    direction: Literal["pull", "push"]
    attempt: int | float
    ref_globs: _SyncRefGlobs
    created_at: str


class _SyncQueued(_SyncBase):
    status: Literal["queued"]
    stats: None
    error: None
    started_at: None
    finished_at: None


class _SyncInProgress(_SyncBase):
    status: Literal["in_progress"]
    stats: None
    error: None
    started_at: str
    finished_at: None


class _SyncCompleted(_SyncBase):
    status: Literal["completed"]
    stats: _SyncStats
    error: None
    started_at: str | None
    finished_at: str


class _SyncFailed(_SyncBase):
    status: Literal["failed"]
    stats: _SyncStats | None
    error: str
    started_at: str | None
    finished_at: str


class _SyncQueuedData(_WebhookModel):
    sync: _SyncQueued


class _SyncInProgressData(_WebhookModel):
    sync: _SyncInProgress


class _SyncCompletedData(_WebhookModel):
    sync: _SyncCompleted


class _SyncFailedData(_WebhookModel):
    sync: _SyncFailed


class _EventEnvelope(_WebhookModel):
    id: str
    occurred_at: str
    organization: _Organization
    repository: _Repository | None


class _RepoCreatedEvent(_EventEnvelope):
    type: Literal["repo.created"]
    data: _RepoCreatedData


class _RepoUpdatedEvent(_EventEnvelope):
    type: Literal["repo.updated"]
    data: _RepoUpdatedData


class _RepoDeletedEvent(_EventEnvelope):
    type: Literal["repo.deleted"]
    data: _RepoCreatedData


class _BookmarkCreatedEvent(_EventEnvelope):
    type: Literal["bookmark.created"]
    data: _BookmarkData


class _BookmarkDeletedEvent(_EventEnvelope):
    type: Literal["bookmark.deleted"]
    data: _BookmarkData


class _BookmarkMovedEvent(_EventEnvelope):
    type: Literal["bookmark.moved"]
    data: _BookmarkMovedData


class _BookmarkMergedEvent(_EventEnvelope):
    type: Literal["bookmark.merged"]
    data: _BookmarkData


class _ChangeCreatedEvent(_EventEnvelope):
    type: Literal["change.created"]
    data: _ChangeCreatedData


class _ChangeEvolvedEvent(_EventEnvelope):
    type: Literal["change.evolved"]
    data: _ChangeEvolvedData


class _PushEvent(_EventEnvelope):
    type: Literal["push"]
    data: _PushData


class _SyncQueuedEvent(_EventEnvelope):
    type: Literal["sync.queued"]
    data: _SyncQueuedData


class _SyncInProgressEvent(_EventEnvelope):
    type: Literal["sync.in_progress"]
    data: _SyncInProgressData


class _SyncCompletedEvent(_EventEnvelope):
    type: Literal["sync.completed"]
    data: _SyncCompletedData


class _SyncFailedEvent(_EventEnvelope):
    type: Literal["sync.failed"]
    data: _SyncFailedData


_WebhookEventModel = Annotated[
    _RepoCreatedEvent
    | _RepoUpdatedEvent
    | _RepoDeletedEvent
    | _BookmarkCreatedEvent
    | _BookmarkDeletedEvent
    | _BookmarkMovedEvent
    | _BookmarkMergedEvent
    | _ChangeCreatedEvent
    | _ChangeEvolvedEvent
    | _PushEvent
    | _SyncQueuedEvent
    | _SyncInProgressEvent
    | _SyncCompletedEvent
    | _SyncFailedEvent,
    Field(discriminator="type"),
]

WEBHOOK_EVENT_NAMES: tuple[str, ...] = get_args(WebhookEventName)
_WEBHOOK_EVENT_ADAPTER = TypeAdapter(_WebhookEventModel)


def _validation_path(error: dict[str, Any]) -> str:
    parts = [str(part) for part in error["loc"] if isinstance(part, (str, int))]
    if len(parts) > 1 and parts[0] in WEBHOOK_EVENT_NAMES:
        parts = parts[1:]
    return ".".join(parts) or "payload"


def _format_validation_error(error: ValidationError) -> str:
    first = error.errors()[0]
    return f"Invalid webhook payload at {_validation_path(first)}: {first['msg']}"


def validate_webhook_event(value: Any) -> WebhookEvent:
    """Validate and return a Mesa webhook event dict."""
    try:
        event = _WEBHOOK_EVENT_ADAPTER.validate_python(value)
    except ValidationError as exc:
        raise MesaWebhookVerificationError(_format_validation_error(exc)) from exc

    return _WEBHOOK_EVENT_ADAPTER.dump_python(event, by_alias=True)
