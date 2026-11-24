"""Unit tests for L1 exact cache read/write paths, TTL, schema versioning, and fail-open."""

from __future__ import annotations

import json
import logging
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from app.cache.keys import l1_key
from app.cache.l1 import l1_get, l1_set
from app.clock import now_ts
from app.config import Settings
from app.contracts.canonical import build_canonical_request, cache_key
from app.contracts.gateway import GatewayResult
from app.main import app
from app.providers.mock import MockProvider


class InMemoryCacheBackend:
    """Deterministic in-memory cache backend for zero-infrastructure unit testing."""

    def __init__(self) -> None:
        self.store: dict[str, bytes] = {}
        self.ttls: dict[str, int] = {}
        self.locks: dict[str, str] = {}
        self.last_set_ttl: int | None = None
        self.set_calls: list[tuple[str, bytes, int]] = []

    async def get(self, key: str) -> bytes | None:
        return self.store.get(key)

    async def set(self, key: str, value: bytes, ttl_seconds: int) -> None:
        self.store[key] = value
        self.ttls[key] = ttl_seconds
        self.last_set_ttl = ttl_seconds
        self.set_calls.append((key, value, ttl_seconds))

    async def delete(self, key: str) -> None:
        self.store.pop(key, None)
        self.locks.pop(key, None)

    async def exists(self, key: str) -> bool:
        return (key in self.store) or (key in self.locks)

    async def acquire_lock(self, key: str, token: str, ttl_ms: int) -> bool:
        if key in self.locks:
            return False
        self.locks[key] = token
        return True


class FailingCacheBackend:
    """Failing cache backend that raises an exception on every operation to verify fail-open."""

    async def get(self, key: str) -> bytes | None:
        raise RuntimeError("Redis failure on get")

    async def set(self, key: str, value: bytes, ttl_seconds: int) -> None:
        raise RuntimeError("Redis failure on set")

    async def delete(self, key: str) -> None:
        raise RuntimeError("Redis failure on delete")

    async def exists(self, key: str) -> bool:
        raise RuntimeError("Redis failure on exists")

    async def acquire_lock(self, key: str, token: str, ttl_ms: int) -> bool:
        raise RuntimeError("Redis failure on acquire_lock")


@pytest.mark.asyncio
async def test_l1_miss_then_hit_single_upstream_call() -> None:
    """L1 cache miss calls upstream; subsequent identical request hits cache and skips upstream."""
    backend = InMemoryCacheBackend()
    provider = MockProvider()
    app.state.cache_backend = backend
    app.state.provider = provider

    fixed_time = 1700000000
    app.dependency_overrides[now_ts] = lambda: fixed_time
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            payload = {
                "model": "mock-1",
                "messages": [{"role": "user", "content": "hello cache"}],
                "temperature": 0.0,
            }
            # First request: miss
            resp1 = await client.post("/v1/chat/completions", json=payload)
            assert resp1.status_code == 200
            assert resp1.headers.get("x-cache-tier") == "miss"
            assert resp1.headers.get("x-upstream-latency-ms") != "0.000"
            assert provider.calls == 1

            # Second request: L1 hit
            resp2 = await client.post("/v1/chat/completions", json=payload)
            assert resp2.status_code == 200
            assert resp2.headers.get("x-cache-tier") == "l1"
            assert resp2.headers.get("x-upstream-latency-ms") == "0.000"
            assert provider.calls == 1
    finally:
        app.dependency_overrides.pop(now_ts, None)


@pytest.mark.asyncio
async def test_l1_hit_body_is_byte_identical_to_first_response() -> None:
    """L1 cached response body is byte-for-byte identical to the original upstream response."""
    backend = InMemoryCacheBackend()
    provider = MockProvider()
    app.state.cache_backend = backend
    app.state.provider = provider

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        payload = {
            "model": "mock-1",
            "messages": [{"role": "user", "content": "byte identity test"}],
            "temperature": 0.0,
        }
        resp1 = await client.post("/v1/chat/completions", json=payload)
        resp2 = await client.post("/v1/chat/completions", json=payload)

        assert resp1.status_code == 200
        assert resp2.status_code == 200
        assert resp1.content == resp2.content


@pytest.mark.asyncio
async def test_l1_write_uses_configured_ttl() -> None:
    """L1 write path delegates expiration to Redis EX using configured CACHE_TTL_SECONDS."""
    backend = InMemoryCacheBackend()
    provider = MockProvider()
    app.state.cache_backend = backend
    app.state.provider = provider

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        payload = {
            "model": "mock-1",
            "messages": [{"role": "user", "content": "ttl test"}],
            "temperature": 0.0,
        }
        resp = await client.post("/v1/chat/completions", json=payload)
        assert resp.status_code == 200
        assert backend.last_set_ttl == Settings().CACHE_TTL_SECONDS


@pytest.mark.asyncio
async def test_l1_ttl_override_applies_per_model() -> None:
    """Per-model TTL override in CACHE_TTL_OVERRIDE_JSON takes precedence over default TTL."""
    backend = InMemoryCacheBackend()
    provider = MockProvider()
    app.state.cache_backend = backend
    app.state.provider = provider

    custom_settings = Settings(
        CACHE_TTL_SECONDS=86400,
        CACHE_TTL_OVERRIDE_JSON=json.dumps({"fast-model": 3600, "slow-model": 7200}),
    )

    from app.config import get_settings

    app.dependency_overrides[get_settings] = lambda: custom_settings
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            resp = await client.post(
                "/v1/chat/completions",
                json={
                    "model": "fast-model",
                    "messages": [{"role": "user", "content": "override test"}],
                    "temperature": 0.0,
                },
            )
            assert resp.status_code == 200
            assert backend.last_set_ttl == 3600
    finally:
        app.dependency_overrides.pop(get_settings, None)


@pytest.mark.asyncio
async def test_l1_corrupt_entry_is_treated_as_miss() -> None:
    """Unparseable / non-JSON cache entry is treated as absent miss without raising."""
    backend = InMemoryCacheBackend()
    req = build_canonical_request(
        {"model": "mock-1", "messages": [{"role": "user", "content": "corrupt"}]},
        tenant_id="default",
    )
    key = l1_key(req)
    await backend.set(key, b"invalid{json:data--bytes", ttl_seconds=60)

    lookup_result, entry = await l1_get(backend, req, now_ts=1700000000)
    assert lookup_result.tier == "miss"
    assert lookup_result.entry_id is None
    assert lookup_result.age_seconds is None
    assert entry is None


@pytest.mark.asyncio
async def test_l1_wrong_version_entry_is_treated_as_miss() -> None:
    """Cache entry with schema version != 1 is treated as miss and overwritten safely."""
    backend = InMemoryCacheBackend()
    req = build_canonical_request(
        {"model": "mock-1", "messages": [{"role": "user", "content": "version mismatch"}]},
        tenant_id="default",
    )
    key = l1_key(req)
    payload = {
        "v": 999,  # Unsupported schema version
        "created_at": 1700000000,
        "provider": "mock",
        "model": "mock-1",
        "usage": {},
        "body": {"id": "old"},
    }
    await backend.set(key, json.dumps(payload).encode(), ttl_seconds=60)

    lookup_result, entry = await l1_get(backend, req, now_ts=1700000000)
    assert lookup_result.tier == "miss"
    assert lookup_result.entry_id is None
    assert entry is None


@pytest.mark.asyncio
async def test_cross_tenant_isolation_never_shares_entries() -> None:
    """Cache entries are strictly isolated by tenant boundary; tenant B never hits tenant A's cache."""
    backend = InMemoryCacheBackend()
    provider = MockProvider()
    app.state.cache_backend = backend
    app.state.provider = provider

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        payload = {
            "model": "mock-1",
            "messages": [{"role": "user", "content": "shared content"}],
            "temperature": 0.0,
        }
        # Tenant A populates cache
        resp_a = await client.post(
            "/v1/chat/completions",
            json=payload,
            headers={"x-tenant-id": "tenant-alpha"},
        )
        assert resp_a.status_code == 200
        assert resp_a.headers.get("x-cache-tier") == "miss"
        assert provider.calls == 1

        # Tenant B requests identical payload
        resp_b = await client.post(
            "/v1/chat/completions",
            json=payload,
            headers={"x-tenant-id": "tenant-beta"},
        )
        assert resp_b.status_code == 200
        assert resp_b.headers.get("x-cache-tier") == "miss"
        assert provider.calls == 2


def test_cross_tenant_l1_keys_differ() -> None:
    """Two canonical requests differing only by tenant_id generate distinct L1 keys."""
    body: dict[str, Any] = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "key separation"}],
        "temperature": 0.0,
    }
    req_a = build_canonical_request(body, "tenant-a")
    req_b = build_canonical_request(body, "tenant-b")

    key_a = l1_key(req_a)
    key_b = l1_key(req_b)

    assert key_a != key_b
    assert "gw:l1:tenant-a:" in key_a
    assert "gw:l1:tenant-b:" in key_b


def test_stream_flag_does_not_affect_l1_key() -> None:
    """The stream flag is excluded from canonical request derivation and does not affect L1 key."""
    body1 = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "stream key invariance"}],
        "stream": True,
    }
    body2 = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "stream key invariance"}],
        "stream": False,
    }
    req1 = build_canonical_request(body1, "tenant-1")
    req2 = build_canonical_request(body2, "tenant-1")

    assert l1_key(req1) == l1_key(req2)


@pytest.mark.asyncio
async def test_cache_fail_open_when_backend_raises() -> None:
    """When the cache backend raises on every method, the request returns 200 and calls upstream once."""
    backend = FailingCacheBackend()
    provider = MockProvider()
    app.state.cache_backend = backend
    app.state.provider = provider

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        payload = {
            "model": "mock-1",
            "messages": [{"role": "user", "content": "failing backend"}],
            "temperature": 0.0,
        }
        resp = await client.post("/v1/chat/completions", json=payload)
        assert resp.status_code == 200
        assert resp.headers.get("x-cache-tier") == "miss"
        assert provider.calls == 1


@pytest.mark.asyncio
async def test_cache_fail_open_logs_warning(caplog: pytest.LogCaptureFixture) -> None:
    """Backend failure emits a WARNING log on cache logger and fails open to miss / HTTP 200."""
    backend = FailingCacheBackend()
    provider = MockProvider()
    app.state.cache_backend = backend
    app.state.provider = provider

    caplog.set_level(logging.WARNING)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        payload = {
            "model": "mock-1",
            "messages": [{"role": "user", "content": "failing backend warning test"}],
            "temperature": 0.0,
        }
        resp = await client.post("/v1/chat/completions", json=payload)
        assert resp.status_code == 200
        assert resp.headers.get("x-cache-tier") == "miss"
        assert provider.calls == 1

    # Assert at least one WARNING record was emitted on a cache module logger
    warning_records = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and r.name.startswith("app.cache")
    ]
    assert len(warning_records) >= 1


@pytest.mark.asyncio
async def test_l1_hit_cache_lookup_result_fields() -> None:
    """L1 cache hit returns CacheLookupResult with entry_id == cache_key and deterministic age_seconds."""
    backend = InMemoryCacheBackend()
    req = build_canonical_request(
        {"model": "mock-1", "messages": [{"role": "user", "content": "hit fields test"}]},
        tenant_id="test-tenant",
    )
    created_at = 1700000000
    gw_res = GatewayResult(
        body={"choices": [{"message": {"content": "cached response"}}]},
        provider="mock",
        model=req.model,
        cache_tier="miss",
        similarity=None,
        upstream_latency_ms=10.0,
        total_latency_ms=10.0,
        retry_count=0,
        degraded=False,
        degraded_reason=None,
        usage={"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
        trace_id="test-trace",
    )
    await l1_set(backend, req, gw_res, now_ts=created_at, ttl_seconds=3600)

    # 1. Normal hit path: now_ts > created_at
    lookup_now = 1700000042
    lookup_result, entry = await l1_get(backend, req, now_ts=lookup_now)

    assert lookup_result.tier == "l1"
    assert lookup_result.entry_id == cache_key(req)
    assert lookup_result.age_seconds == lookup_now - created_at
    assert lookup_result.age_seconds == 42
    assert lookup_result.similarity is None
    assert entry is not None
    assert entry.cache_tier == "l1"
    assert entry.body == {"choices": [{"message": {"content": "cached response"}}]}

    # 2. Clock skew edge case: now_ts < created_at -> age_seconds clamped to 0 via max(0, now_ts - created_at)
    skewed_now = 1699999990
    lookup_result_skewed, _ = await l1_get(backend, req, now_ts=skewed_now)
    assert lookup_result_skewed.tier == "l1"
    assert lookup_result_skewed.entry_id == cache_key(req)
    assert lookup_result_skewed.age_seconds == 0

