"""L1 exact cache storage and retrieval operations."""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

from app.cache.keys import l1_key
from app.contracts.cache import CacheLookupResult
from app.contracts.canonical import CanonicalRequest, cache_key
from app.contracts.gateway import GatewayResult

if TYPE_CHECKING:
    from app.cache.backend import CacheBackend

logger = logging.getLogger(__name__)


async def l1_get(
    backend: CacheBackend,
    req: CanonicalRequest,
    *,
    now_ts: int,
) -> tuple[CacheLookupResult, GatewayResult | None]:
    """Retrieve entry from L1 exact cache.

    Returns:
        (CacheLookupResult, GatewayResult | None)
    """
    key = l1_key(req)
    try:
        raw_bytes = await backend.get(key)
    except Exception as exc:  # noqa: BLE001
        # Fail-open: backend failure is treated as a clean miss
        logger.warning("Cache backend read failed for key %s: %s", key, exc)
        return CacheLookupResult(tier="miss", similarity=None, entry_id=None, age_seconds=None), None

    if not raw_bytes:
        return CacheLookupResult(tier="miss", similarity=None, entry_id=None, age_seconds=None), None

    try:
        payload = json.loads(raw_bytes.decode("utf-8"))
        if not isinstance(payload, dict) or payload.get("v") != 1:
            # Corrupt payload or version mismatch; treat as absent
            logger.warning("Cache entry corrupt or schema version mismatch for key %s", key)
            return (
                CacheLookupResult(tier="miss", similarity=None, entry_id=None, age_seconds=None),
                None,
            )

        created_at = int(payload.get("created_at", now_ts))
        age_seconds = max(0, now_ts - created_at)
        entry_id = cache_key(req)

        lookup_result = CacheLookupResult(
            tier="l1",
            similarity=None,
            entry_id=entry_id,
            age_seconds=age_seconds,
        )

        gateway_result = GatewayResult(
            body=payload["body"],
            provider=str(payload.get("provider", "mock")),
            model=str(payload.get("model", req.model)),
            cache_tier="l1",
            similarity=None,
            upstream_latency_ms=0.0,
            total_latency_ms=0.0,
            retry_count=0,
            degraded=False,
            degraded_reason=None,
            usage=payload.get("usage", {}),
            trace_id="",
        )
        return lookup_result, gateway_result
    except Exception as exc:  # noqa: BLE001
        # Any deserialization failure is treated as miss
        logger.warning("Cache entry deserialization failed for key %s: %s", key, exc)
        return CacheLookupResult(tier="miss", similarity=None, entry_id=None, age_seconds=None), None


async def l1_set(
    backend: CacheBackend,
    req: CanonicalRequest,
    result: GatewayResult,
    *,
    now_ts: int,
    ttl_seconds: int,
) -> None:
    """Write entry to L1 exact cache using schema version 1."""
    key = l1_key(req)
    payload = {
        "v": 1,
        "created_at": now_ts,
        "provider": result.provider,
        "model": result.model,
        "usage": result.usage,
        "body": result.body,
    }
    try:
        val_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        await backend.set(key, val_bytes, ttl_seconds=ttl_seconds)
    except Exception as exc:  # noqa: BLE001
        # Fail-open: write failure must never bubble up or fail the request
        logger.warning("Cache backend write failed for key %s: %s", key, exc)
