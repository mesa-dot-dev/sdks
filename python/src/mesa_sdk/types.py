"""Public types for the Mesa SDK."""

from __future__ import annotations

import datetime
from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict, Union

from mesa_rest.types import UNSET, Unset


class _SigningKeyAuthorRequired(TypedDict):
    name: str


class SigningKeyAuthor(_SigningKeyAuthorRequired, total=False):
    """Commit attribution carried by a signing-key access token.

    ``name`` is required at runtime. ``email`` is optional and defaults to
    ``None``.
    """

    email: str | None


@dataclass
class Author:
    """Commit author or committer identity."""

    name: str
    email: str
    date: datetime.datetime | None = None


@dataclass
class CommitIdentity:
    """One contributor in a change's ordered commit attribution."""

    name: str
    email: str | None


@dataclass
class CommitSignature:
    """Committer identity and timestamp returned for a change."""

    name: str
    email: str
    date: datetime.datetime | None


@dataclass(kw_only=True)
class Change:
    """A Mesa change returned by the high-level SDK.

    The REST API still returns a deprecated singular ``author`` so older
    clients keep working; the SDK exposes only ``authors`` and ``authored_at``.
    Fields the SDK does not model are kept in ``additional_properties``.
    """

    id: str
    current_commit_oid: str
    is_conflicted: bool
    message: str
    authors: list[CommitIdentity]
    authored_at: datetime.datetime
    committer: CommitSignature
    parents: list[str]
    created_at: datetime.datetime
    updated_at: datetime.datetime
    additional_properties: dict[str, Any] = field(default_factory=dict)


@dataclass(kw_only=True)
class ChangeDetails(Change):
    """A Mesa change with its changed and conflicted paths."""

    files: list[str]
    conflicts: list[str]


@dataclass(kw_only=True)
class ChangesPage:
    """One paginated page of Mesa changes."""

    next_cursor: str | None
    has_more: bool
    changes: list[Change]
    additional_properties: dict[str, Any] = field(default_factory=dict)


@dataclass
class FileUpsert:
    """A file to create or update in a change."""

    path: str
    content: str
    encoding: Literal["base64"] | None = "base64"
    action: Literal["upsert"] | None = None
    mode: str | None = None


@dataclass
class FileDelete:
    """A file to delete in a change."""

    path: str
    action: Literal["delete"] = "delete"


#: A file modification within a change: either an upsert or a delete.
FileChange = Union[FileUpsert, FileDelete]


#: Which side of a conflict to take as the resolution.
ConflictSide = Literal["target", "source"]


@dataclass
class WholeFileResolution:
    """Resolve a conflicted path by supplying full replacement content or picking a side.

    Exactly one of ``content`` or ``take`` must be set. The server rejects the
    request otherwise. When ``take`` is used and that side has no content at this
    path (add/delete conflict), the path is deleted from the merge output.
    """

    path: str
    content: str | None = None
    take: ConflictSide | None = None
    encoding: Literal["base64"] | None = "base64"


@dataclass
class HunkFix:
    """Resolve a single conflict hunk within a file.

    Exactly one of ``content`` or ``take`` must be set. ``hunk_id`` must match
    a hunk from the prior MERGE_CONFLICT error response.
    """

    hunk_id: str
    content: str | None = None
    take: ConflictSide | None = None
    encoding: Literal["base64"] | None = "base64"


@dataclass
class HunkResolution:
    """Resolve a conflicted path by supplying per-hunk replacements.

    Every hunk from the prior MERGE_CONFLICT error for this path must be covered.
    """

    path: str
    hunks: list[HunkFix]


#: A conflict resolution: either whole-file or per-hunk.
Resolution = Union[WholeFileResolution, HunkResolution]

#: Controls how conflicts appear in diff responses.
DiffConflictFilter = Literal["include", "only", "exclude"]


@dataclass
class UsernamePasswordAuth:
    """Username/password authentication for an upstream remote."""

    username: str
    password: str


@dataclass
class TokenAuth:
    """Personal access token authentication for an upstream remote.

    ``token_username`` is required by some forges that distinguish the user the
    token belongs to from the token itself (e.g. GitHub's fine-grained tokens).
    """

    token: str
    token_username: str | None = None


#: Authentication payload for an upstream remote.
UpstreamAuth = Union[UsernamePasswordAuth, TokenAuth]


@dataclass
class UpstreamConfig:
    """Upstream git remote configuration for a repository.

    ``auth`` is tri-state and mirrors how the REST surface treats the field:

    - ``UNSET`` (default): on ``Repos.update``, leave any existing stored
      credential untouched; on ``Repos.create``, the new upstream is public.
    - ``None``: explicitly clear the stored credential — the upstream becomes
      public. On create this is equivalent to ``UNSET``.
    - :class:`TokenAuth` or :class:`UsernamePasswordAuth`: set or replace the
      stored credential.

    Individual fields inside a chosen auth object (``token``, ``password``,
    etc.) are atomic — when rotating a credential, build a fresh
    :class:`TokenAuth` or :class:`UsernamePasswordAuth` rather than mutating
    one in place.
    """

    url: str
    auth: UpstreamAuth | None | Unset = field(default=UNSET)
