from __future__ import annotations

from typing import Any

from mesa_rest.models.get_content_response_200_type_0 import GetContentResponse200Type0
from mesa_rest.models.get_content_response_200_type_1 import GetContentResponse200Type1
from mesa_rest.models.get_content_response_200_type_2 import GetContentResponse200Type2


def _content_type(self: Any) -> str:
    return self.type_


def _is_file(self: Any) -> bool:
    return self.type_ == "file"


def _is_dir(self: Any) -> bool:
    return self.type_ == "dir"


def _is_symlink(self: Any) -> bool:
    return self.type_ == "symlink"


def _install_helpers(model_cls: type[Any]) -> None:
    setattr(model_cls, "type", property(_content_type))
    setattr(model_cls, "is_file", _is_file)
    setattr(model_cls, "is_dir", _is_dir)
    setattr(model_cls, "is_symlink", _is_symlink)


def install_content_model_helpers() -> None:
    """Patch only the top-level ``mesa.content.get`` response variants."""
    for model_cls in (
        GetContentResponse200Type0,
        GetContentResponse200Type1,
        GetContentResponse200Type2,
    ):
        _install_helpers(model_cls)
