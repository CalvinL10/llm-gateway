"""Chat completions route proxying to mock provider."""

from __future__ import annotations

import dataclasses
import time
import uuid
from typing import Annotated, Any

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app.cache.backend import RedisCacheBackend
from app.cache.singleflight import get_or_fill
from app.clock import now_ts
from app.config import Settings, get_settings
from app.contracts.canonical import build_canonical_request, cache_key
from app.contracts.gateway import GatewayRequest, GatewayResult
from app.providers.mock import MockProvider

router = APIRouter(prefix="/v1", tags=["Chat"])


class ChatMessage(BaseModel):
    """Chat message schema."""

    role: str
    content: Any = None
    name: str | None = None
    tool_call_id: str | None = None
    model_config = ConfigDict(extra="allow")


class ChatCompletionRequestBody(BaseModel):
    """Chat completion request payload."""

    model: str = Field(..., min_length=1, description="Model identifier")
    messages: list[ChatMessage] = Field(..., min_length=1, description="Message sequence")
    stream: bool | None = False

    model_config = ConfigDict(extra="allow")


@router.post("/chat/completions", status_code=status.HTTP_200_OK)
async def chat_completions(
    raw_request: Request,
    body: ChatCompletionRequestBody,
    x_tenant_id: Annotated[str | None, Header(alias="x-tenant-id")] = None,
    x_request_id: Annotated[str | None, Header(alias="x-request-id")] = None,
    settings: Annotated[Settings, Depends(get_settings)] = None,  # type: ignore[assignment]
    now: Annotated[int | None, Depends(now_ts)] = None,  # type: ignore[assignment]
) -> JSONResponse:
    """Non-streaming chat completions endpoint proxying to mock provider with L1 cache."""
    t_start = time.perf_counter()
    try:
        raw_body = await raw_request.json()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid JSON payload",
        ) from exc

    tenant_id = x_tenant_id or "default"
    request_id = x_request_id or str(uuid.uuid4())
    stream_flag = bool(raw_body.get("stream", False))

    gateway_req = GatewayRequest(
        body=raw_body,
        tenant_id=tenant_id,
        request_id=request_id,
        stream=stream_flag,
    )

    canonical_req = build_canonical_request(gateway_req.body, tenant_id=gateway_req.tenant_id)
    key = cache_key(canonical_req)

    effective_settings = settings or get_settings()
    current_now_ts = now if now is not None else now_ts()
    cache_policy = str(raw_body.get("cache_policy") or "default")
    trace_id = x_request_id if x_request_id else uuid.uuid4().hex

    # Resolve shared provider
    provider = getattr(raw_request.app.state, "provider", None)
    if provider is None:
        provider = MockProvider(latency_ms=effective_settings.MOCK_LATENCY_MS)
        raw_request.app.state.provider = provider

    # Resolve shared cache backend
    backend = getattr(raw_request.app.state, "cache_backend", None)
    if backend is None:
        redis_client = getattr(raw_request.app.state, "redis", None)
        if redis_client is None:
            pool = aioredis.BlockingConnectionPool.from_url(
                effective_settings.REDIS_URL,
                max_connections=effective_settings.REDIS_MAX_CONNECTIONS,
                timeout=10,
            )
            redis_client = aioredis.Redis(connection_pool=pool)
            raw_request.app.state.redis = redis_client
        backend = RedisCacheBackend(redis_client)
        raw_request.app.state.cache_backend = backend

    async def fetch_upstream() -> GatewayResult:
        t_upstream_start = time.perf_counter()
        completion = await provider.complete(canonical_req, key)
        up_ms = (time.perf_counter() - t_upstream_start) * 1000.0
        return GatewayResult(
            body=completion,
            provider="mock",
            model=canonical_req.model,
            cache_tier="miss",
            similarity=None,
            upstream_latency_ms=up_ms,
            total_latency_ms=0.0,
            retry_count=0,
            degraded=False,
            degraded_reason=None,
            usage=completion.get("usage", {}),
            trace_id=trace_id,
        )

    result = await get_or_fill(
        backend=backend,
        req=canonical_req,
        now_ts=current_now_ts,
        cfg=effective_settings,
        cache_policy=cache_policy,
        fetch=fetch_upstream,
    )

    total_latency_ms = (time.perf_counter() - t_start) * 1000.0
    result = dataclasses.replace(
        result,
        trace_id=trace_id,
        total_latency_ms=total_latency_ms,
    )

    headers = {
        "x-cache-tier": result.cache_tier,
        "x-request-id": gateway_req.request_id,
        "x-trace-id": result.trace_id,
        "x-upstream-latency-ms": f"{result.upstream_latency_ms:.3f}",
        "x-total-latency-ms": f"{result.total_latency_ms:.3f}",
    }

    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content=result.body,
        headers=headers,
    )

