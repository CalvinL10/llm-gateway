"""Base Provider Protocol and helper utilities."""

from __future__ import annotations

import json
from typing import Any, Protocol

from app.contracts.canonical import CanonicalRequest


def normalize_tool_calls(tool_calls: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Normalize tool calls structure into standard OpenAI schema."""
    if not tool_calls:
        return []

    normalized: list[dict[str, Any]] = []
    for idx, tc in enumerate(tool_calls):
        call_id = str(tc.get("id") or f"call_{idx}")
        call_type = str(tc.get("type") or "function")

        raw_func = tc.get("function")
        if isinstance(raw_func, dict):
            func_name = str(raw_func.get("name") or "")
            raw_args = raw_func.get("arguments", "{}")
            if isinstance(raw_args, (dict, list)):
                func_args = json.dumps(raw_args, sort_keys=True)
            else:
                func_args = str(raw_args)
        else:
            func_name = str(tc.get("name") or "")
            func_args = "{}"

        normalized.append(
            {
                "id": call_id,
                "type": call_type,
                "function": {
                    "name": func_name,
                    "arguments": func_args,
                },
            }
        )

    return normalized


class Provider(Protocol):
    """Protocol representing an LLM upstream provider adapter."""

    async def complete(
        self,
        req: CanonicalRequest,
        key: str,
        *,
        now_ts: int | None = None,
    ) -> dict[str, Any]:
        """Execute non-streaming chat completion."""
        ...
