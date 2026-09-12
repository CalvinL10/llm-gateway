"""Canonical request representation and cache-key derivation."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CanonicalRequest:
    ns: str                  # tenant id; hard isolation boundary
    model: str               # resolved model id, never an alias
    messages: tuple[dict, ...]
    temperature: float
    top_p: float | None
    max_tokens: int | None
    stop: tuple[str, ...]    # sorted
    tools: tuple[dict, ...]  # canonicalized: sorted by name, schema keys sorted
    response_format: dict | None


def _sort_dict_recursive(d: Any) -> Any:
    """Recursively sort dictionary keys for deterministic serialization."""
    if isinstance(d, dict):
        return {k: _sort_dict_recursive(v) for k, v in sorted(d.items())}
    if isinstance(d, (list, tuple)):
        return [_sort_dict_recursive(item) for item in d]
    return d


def _canonicalize_message(msg: dict) -> dict:
    """Canonicalize a single chat message dict."""
    canonical: dict[str, Any] = {}
    for k, v in sorted(msg.items()):
        if k == "content":
            if isinstance(v, str):
                canonical[k] = " ".join(v.split())
            elif isinstance(v, list):
                normalized_parts = []
                for part in v:
                    if isinstance(part, dict):
                        part_canon = {}
                        for pk, pv in sorted(part.items()):
                            if pk == "text" and isinstance(pv, str):
                                part_canon[pk] = " ".join(pv.split())
                            elif isinstance(pv, dict):
                                part_canon[pk] = _sort_dict_recursive(pv)
                            else:
                                part_canon[pk] = pv
                        normalized_parts.append(part_canon)
                    else:
                        normalized_parts.append(part)
                canonical[k] = normalized_parts
            else:
                canonical[k] = v
        elif isinstance(v, (dict, list, tuple)):
            canonical[k] = _sort_dict_recursive(v)
        else:
            canonical[k] = v
    return canonical


def canonicalize_tools(tools: list[dict]) -> tuple[dict, ...]:
    """Sort tools by name and recursively sort schema keys."""
    if not tools:
        return ()

    def get_tool_sort_key(tool: dict) -> tuple[str, str]:
        fn = tool.get("function")
        if isinstance(fn, dict) and "name" in fn:
            name = str(fn["name"])
        elif "name" in tool:
            name = str(tool["name"])
        else:
            name = ""
        sorted_tool = _sort_dict_recursive(tool)
        return (name, json.dumps(sorted_tool, sort_keys=True))

    sorted_tools = sorted(tools, key=get_tool_sort_key)
    return tuple(_sort_dict_recursive(t) for t in sorted_tools)


def build_canonical_request(body: dict, tenant_id: str) -> CanonicalRequest:
    """Build a CanonicalRequest from raw body and tenant ID."""
    ns = str(tenant_id)
    model = str(body.get("model", ""))

    raw_messages = body.get("messages") or []
    messages = tuple(_canonicalize_message(m) for m in raw_messages)

    raw_temp = body.get("temperature")
    temperature = float(raw_temp) if raw_temp is not None else 1.0

    raw_top_p = body.get("top_p")
    top_p = float(raw_top_p) if raw_top_p is not None else None

    raw_max_tokens = body.get("max_tokens")
    if raw_max_tokens is None:
        raw_max_tokens = body.get("max_completion_tokens")
    max_tokens = int(raw_max_tokens) if raw_max_tokens is not None else None

    raw_stop = body.get("stop")
    if raw_stop is None:
        stop = ()
    elif isinstance(raw_stop, str):
        stop = (raw_stop,)
    elif isinstance(raw_stop, (list, tuple)):
        stop = tuple(sorted(str(s) for s in raw_stop))
    else:
        stop = ()

    raw_tools = body.get("tools") or []
    tools = canonicalize_tools(raw_tools)

    raw_rf = body.get("response_format")
    response_format = _sort_dict_recursive(raw_rf) if isinstance(raw_rf, dict) else None

    return CanonicalRequest(
        ns=ns,
        model=model,
        messages=messages,
        temperature=temperature,
        top_p=top_p,
        max_tokens=max_tokens,
        stop=stop,
        tools=tools,
        response_format=response_format,
    )


def canonical_json(req: CanonicalRequest) -> bytes:
    """Serialize CanonicalRequest to deterministic UTF-8 JSON bytes."""
    payload = {
        "ns": req.ns,
        "model": req.model,
        "messages": list(req.messages),
        "temperature": req.temperature,
        "top_p": req.top_p,
        "max_tokens": req.max_tokens,
        "stop": list(req.stop),
        "tools": list(req.tools),
        "response_format": req.response_format,
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def cache_key(req: CanonicalRequest) -> str:
    """Generate canonical SHA-256 cache key hex digest."""
    return hashlib.sha256(canonical_json(req)).hexdigest()
