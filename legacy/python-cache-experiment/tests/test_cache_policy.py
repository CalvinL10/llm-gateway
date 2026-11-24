"""Unit tests for temperature caching policy and cache_policy request parameter."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.contracts.canonical import build_canonical_request, cache_key
from app.main import app
from app.providers.mock import MockProvider
from tests.test_cache_l1 import InMemoryCacheBackend


def test_cache_policy_field_does_not_affect_cache_key() -> None:
    """The cache_policy body field is a control knob and does not alter canonical cache key."""
    body_default = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "policy test"}],
        "cache_policy": "default",
    }
    body_opt_in = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "policy test"}],
        "cache_policy": "allow_nondeterministic",
    }
    body_absent = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "policy test"}],
    }

    req_default = build_canonical_request(body_default, "tenant-1")
    req_opt_in = build_canonical_request(body_opt_in, "tenant-1")
    req_absent = build_canonical_request(body_absent, "tenant-1")

    assert cache_key(req_default) == cache_key(req_opt_in)
    assert cache_key(req_default) == cache_key(req_absent)


@pytest.mark.asyncio
async def test_cache_policy_default_bypasses_cache_when_temperature_positive() -> None:
    """By default, temperature > 0 bypasses cache: no read, no write, always calls provider."""
    backend = InMemoryCacheBackend()
    provider = MockProvider()
    app.state.cache_backend = backend
    app.state.provider = provider

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        payload = {
            "model": "mock-1",
            "messages": [{"role": "user", "content": "randomized output"}],
            "temperature": 0.7,
        }
        # First call: bypasses cache
        resp1 = await client.post("/v1/chat/completions", json=payload)
        assert resp1.status_code == 200
        assert resp1.headers.get("x-cache-tier") == "miss"
        assert provider.calls == 1
        assert len(backend.store) == 0  # No cache write occurred

        # Second call: still bypasses cache
        resp2 = await client.post("/v1/chat/completions", json=payload)
        assert resp2.status_code == 200
        assert resp2.headers.get("x-cache-tier") == "miss"
        assert provider.calls == 2
        assert len(backend.store) == 0


@pytest.mark.asyncio
async def test_cache_policy_opt_in_allows_l1_when_temperature_positive() -> None:
    """Setting cache_policy to allow_nondeterministic enables caching even when temperature > 0."""
    backend = InMemoryCacheBackend()
    provider = MockProvider()
    app.state.cache_backend = backend
    app.state.provider = provider

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        payload = {
            "model": "mock-1",
            "messages": [{"role": "user", "content": "opt-in caching"}],
            "temperature": 0.7,
            "cache_policy": "allow_nondeterministic",
        }
        # First call: miss and populates cache
        resp1 = await client.post("/v1/chat/completions", json=payload)
        assert resp1.status_code == 200
        assert resp1.headers.get("x-cache-tier") == "miss"
        assert provider.calls == 1
        assert len(backend.store) == 1

        # Second call: L1 hit
        resp2 = await client.post("/v1/chat/completions", json=payload)
        assert resp2.status_code == 200
        assert resp2.headers.get("x-cache-tier") == "l1"
        assert provider.calls == 1


@pytest.mark.asyncio
async def test_temperature_zero_is_cached_by_default() -> None:
    """Requests with temperature == 0.0 are cached by default without needing explicit cache_policy."""
    backend = InMemoryCacheBackend()
    provider = MockProvider()
    app.state.cache_backend = backend
    app.state.provider = provider

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        payload = {
            "model": "mock-1",
            "messages": [{"role": "user", "content": "deterministic zero temp"}],
            "temperature": 0.0,
        }
        resp1 = await client.post("/v1/chat/completions", json=payload)
        assert resp1.status_code == 200
        assert resp1.headers.get("x-cache-tier") == "miss"
        assert provider.calls == 1

        resp2 = await client.post("/v1/chat/completions", json=payload)
        assert resp2.status_code == 200
        assert resp2.headers.get("x-cache-tier") == "l1"
        assert provider.calls == 1
