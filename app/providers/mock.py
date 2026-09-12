"""Deterministic mock LLM provider implementation."""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any

from app.contracts.canonical import CanonicalRequest


class MockProvider:
    """Mock provider conforming to OpenAI chat completion specification.

    Deterministic given canonical cache key, with zero external network dependencies.
    """

    def __init__(self, latency_ms: int = 0) -> None:
        self.latency_ms = latency_ms
        self.calls: int = 0

    async def complete(
        self,
        req: CanonicalRequest,
        key: str,
        *,
        now_ts: int | None = None,
    ) -> dict[str, Any]:
        """Generate deterministic chat completion response from canonical key."""
        self.calls += 1
        if self.latency_ms > 0:
            await asyncio.sleep(self.latency_ms / 1000.0)

        # Derive deterministic content from sha256 hash of canonical key
        digest = hashlib.sha256(f"mock-completion:{key}".encode()).hexdigest()
        completion_id = f"chatcmpl-mock-{digest[:16]}"
        content = f"Mock completion for {req.model} [id: {digest[:8]}]"

        # Deterministic, non-zero token accounting
        # Prompt tokens derived stably from message content
        total_prompt_chars = sum(len(str(m.get("content", ""))) for m in req.messages)
        prompt_tokens = max(1, total_prompt_chars // 4 + 4)
        completion_tokens = max(1, len(content) // 4 + 2)
        total_tokens = prompt_tokens + completion_tokens

        created_val = 1700000000 if now_ts is None else now_ts

        return {
            "id": completion_id,
            "object": "chat.completion",
            "created": created_val,
            "model": req.model,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": content,
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": total_tokens,
            },
        }
