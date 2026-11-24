"""Single-flight cache coordination preventing cache stampedes."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from app.cache.keys import lock_key
from app.cache.l1 import l1_get, l1_set
from app.config import Settings
from app.contracts.canonical import CanonicalRequest
from app.contracts.gateway import GatewayResult

if TYPE_CHECKING:
    from app.cache.backend import CacheBackend

logger = logging.getLogger(__name__)


async def get_or_fill(
    backend: CacheBackend,
    req: CanonicalRequest,
    *,
    now_ts: int,
    cfg: Settings,
    cache_policy: str,
    fetch: Callable[[], Awaitable[GatewayResult]],
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    clock: Callable[[], float] = time.perf_counter,
) -> GatewayResult:
    """Coordinate cache read, single-flight locking, and cache filling.

    Policies:
    - Temperature policy (D5): if req.temperature > 0 and cache_policy != "allow_nondeterministic",
      bypass cache entirely (no read, no write).
    - Single-flight (D4): on cache miss, exactly one request acquires the distributed lock
      and fetches from upstream. Waiters poll until entry is available or deadline expires.
    - Fail-open (D4, Scope 6): backend errors or timeout gracefully fall back to calling upstream.
    """
    # 1. Temperature cache policy
    if req.temperature > 0 and cache_policy != "allow_nondeterministic":
        return await fetch()

    # 2. Check L1 cache first
    _, cached = await l1_get(backend, req, now_ts=now_ts)
    if cached is not None:
        return cached

    # Resolve model-specific TTL override
    try:
        overrides = json.loads(cfg.CACHE_TTL_OVERRIDE_JSON)
        if isinstance(overrides, dict) and req.model in overrides:
            ttl_seconds = int(overrides[req.model])
        else:
            ttl_seconds = cfg.CACHE_TTL_SECONDS
    except Exception:  # noqa: BLE001
        ttl_seconds = cfg.CACHE_TTL_SECONDS

    # 3. Attempt single-flight lock acquisition
    l_key = lock_key(req)
    token = uuid.uuid4().hex

    try:
        acquired = await backend.acquire_lock(l_key, token, cfg.SINGLEFLIGHT_LOCK_TTL_MS)
    except Exception as exc:  # noqa: BLE001
        # Fail-open if Redis lock acquisition errors
        logger.warning("Single-flight lock acquisition failed for key %s: %s", l_key, exc)
        return await fetch()

    if acquired:
        # Lock winner: call upstream provider, populate cache, release lock
        try:
            result = await fetch()
            await l1_set(backend, req, result, now_ts=now_ts, ttl_seconds=ttl_seconds)
        finally:
            try:
                await backend.delete(l_key)
            except Exception:  # noqa: BLE001, S110
                pass
        return result

    # Waiter: poll until cache is populated, lock released, or deadline/hop budget reached
    deadline = clock() + (cfg.SINGLEFLIGHT_WAIT_TIMEOUT_MS / 1000.0)
    poll_interval_s = cfg.SINGLEFLIGHT_POLL_INTERVAL_MS / 1000.0
    max_hops = max(1, int(cfg.SINGLEFLIGHT_WAIT_TIMEOUT_MS / cfg.SINGLEFLIGHT_POLL_INTERVAL_MS))
    hops = 0

    while clock() < deadline and hops < max_hops:
        hops += 1
        try:
            _, entry = await l1_get(backend, req, now_ts=now_ts)
            if entry is not None:
                return entry

            if not await backend.exists(l_key):
                # Winner released early or died; check cache once more before breaking
                _, entry = await l1_get(backend, req, now_ts=now_ts)
                if entry is not None:
                    return entry
                break
        except Exception as exc:  # noqa: BLE001
            # Fail-open on polling error
            logger.warning("Single-flight polling loop error for key %s: %s", l_key, exc)
            break

        await sleep(poll_interval_s)

    # Fail-open: no cache read, no cache write, straight upstream
    return await fetch()
