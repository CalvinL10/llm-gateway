"""Gateway request and result data contracts."""

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class GatewayRequest:
    body: dict
    tenant_id: str
    request_id: str
    stream: bool


@dataclass(frozen=True)
class GatewayResult:
    body: dict
    provider: str
    model: str
    cache_tier: Literal["l1", "l2", "miss"]
    similarity: float | None
    upstream_latency_ms: float
    total_latency_ms: float
    retry_count: int
    degraded: bool
    degraded_reason: str | None
    usage: dict
    trace_id: str
