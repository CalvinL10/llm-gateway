"""Single-flight coordination tests covering wait-timeout fail-open and 200-concurrency stampede prevention."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest
import redis.asyncio as aioredis
from httpx import ASGITransport, AsyncClient

from app.cache.backend import RedisCacheBackend
from app.cache.singleflight import get_or_fill
from app.config import Settings, get_settings
from app.contracts.canonical import build_canonical_request
from app.contracts.gateway import GatewayResult
from app.main import app
from app.providers.mock import MockProvider


class PermanentlyLockedBackend:
    """Fake cache backend where a lock is permanently held and cache is never populated."""

    async def get(self, key: str) -> bytes | None:
        return None

    async def set(self, key: str, value: bytes, ttl_seconds: int) -> None:
        pass

    async def delete(self, key: str) -> None:
        pass

    async def exists(self, key: str) -> bool:
        # Lock is never released
        return True

    async def acquire_lock(self, key: str, token: str, ttl_ms: int) -> bool:
        # Loser: lock already held by another request
        return False


@pytest.mark.asyncio
async def test_singleflight_wait_timeout_fails_open_without_hanging() -> None:
    """Waiter whose lock is never released times out, does not exceed hop budget, and fails open."""
    backend = PermanentlyLockedBackend()
    cfg = Settings(
        SINGLEFLIGHT_LOCK_TTL_MS=5000,
        SINGLEFLIGHT_WAIT_TIMEOUT_MS=4500,
        SINGLEFLIGHT_POLL_INTERVAL_MS=25,
    )
    hop_budget = int(cfg.SINGLEFLIGHT_WAIT_TIMEOUT_MS / cfg.SINGLEFLIGHT_POLL_INTERVAL_MS)

    sleep_invocations = 0

    async def noop_sleep(_delay: float) -> None:
        nonlocal sleep_invocations
        sleep_invocations += 1

    # Static clock that never advances; loop termination relies strictly on hop budget
    def static_clock() -> float:
        return 100.0

    fetch_called = 0

    async def fake_fetch() -> GatewayResult:
        nonlocal fetch_called
        fetch_called += 1
        return GatewayResult(
            body={"test": "ok"},
            provider="mock",
            model="mock-1",
            cache_tier="miss",
            similarity=None,
            upstream_latency_ms=1.0,
            total_latency_ms=1.0,
            retry_count=0,
            degraded=False,
            degraded_reason=None,
            usage={},
            trace_id="tr-test",
        )

    req = build_canonical_request(
        {"model": "mock-1", "messages": [{"role": "user", "content": "hang test"}], "temperature": 0.0},
        tenant_id="default",
    )

    result = await get_or_fill(
        backend=backend,
        req=req,
        now_ts=1700000000,
        cfg=cfg,
        cache_policy="default",
        fetch=fake_fetch,
        sleep=noop_sleep,
        clock=static_clock,
    )

    # Assertions: call returns, fails open, and does not exceed hop budget
    assert fetch_called == 1
    assert result.body == {"test": "ok"}
    assert result.cache_tier == "miss"
    assert sleep_invocations <= hop_budget
    assert sleep_invocations > 0


@pytest.mark.redis
@pytest.mark.asyncio
async def test_singleflight_200_concurrent_identical_requests_hit_upstream_once() -> None:
    """200 concurrent identical requests hit upstream exactly once; 1 miss and 199 L1 hits with byte-identical bodies."""
    settings = get_settings()
    # Check Redis connectivity; skip cleanly if Redis is not running
    try:
        pool = aioredis.BlockingConnectionPool.from_url(
            settings.REDIS_URL,
            max_connections=settings.REDIS_MAX_CONNECTIONS,
            timeout=10,
        )
        redis_client = aioredis.Redis(connection_pool=pool)
        await redis_client.ping()
    except Exception:  # noqa: BLE001
        pytest.skip(f"Redis is not available at {settings.REDIS_URL}")

    try:
        await redis_client.flushdb()

        backend = RedisCacheBackend(redis_client)
        provider = MockProvider(latency_ms=200)
        app.state.redis = redis_client
        app.state.cache_backend = backend
        app.state.provider = provider

        payload: dict[str, Any] = {
            "model": "mock-1",
            "messages": [{"role": "user", "content": "concurrent stampede test"}],
            "temperature": 0.0,
        }

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            tasks = [client.post("/v1/chat/completions", json=payload) for _ in range(200)]
            t_start = time.perf_counter()
            responses = await asyncio.gather(*tasks)
            elapsed_s = time.perf_counter() - t_start

        # Verify waiters actually waited for the upstream latency window (>= 200ms)
        assert (
            elapsed_s >= 0.190
        ), f"Gather elapsed time {elapsed_s:.3f}s was less than provider latency 0.200s"

        # 1. MockProvider.calls is exactly 1
        assert provider.calls == 1

        # 2. Exactly one response has x-cache-tier: miss; the other 199 have l1
        cache_tiers = [r.headers.get("x-cache-tier") for r in responses]
        assert cache_tiers.count("miss") == 1
        assert cache_tiers.count("l1") == 199

        # 3. All 200 response bodies are byte-identical
        first_content = responses[0].content
        for r in responses:
            assert r.status_code == 200
            assert r.content == first_content
    finally:
        try:
            await redis_client.flushdb()
            await redis_client.aclose()
        except Exception:  # noqa: BLE001, S110
            pass
