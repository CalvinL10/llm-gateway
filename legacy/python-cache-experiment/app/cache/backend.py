"""Cache backend protocol and Redis implementation."""

from __future__ import annotations

from typing import Any, Protocol


class CacheBackend(Protocol):
    """Protocol representing a cache storage backend."""

    async def get(self, key: str) -> bytes | None:
        """Retrieve binary value by key, returning None if absent."""
        ...

    async def set(self, key: str, value: bytes, ttl_seconds: int) -> None:
        """Set binary value under key with an expiration TTL in seconds."""
        ...

    async def delete(self, key: str) -> None:
        """Delete key from cache backend."""
        ...

    async def exists(self, key: str) -> bool:
        """Check whether key exists in backend."""
        ...

    async def acquire_lock(self, key: str, token: str, ttl_ms: int) -> bool:
        """Acquire single-flight mutual exclusion lock with millisecond expiration.

        Returns True if the lock was successfully acquired, False otherwise.
        """
        ...


class RedisCacheBackend:
    """Redis-backed cache backend implementation over a shared async client."""

    def __init__(self, redis: Any) -> None:
        self._redis = redis

    async def get(self, key: str) -> bytes | None:
        return await self._redis.get(key)

    async def set(self, key: str, value: bytes, ttl_seconds: int) -> None:
        await self._redis.set(key, value, ex=ttl_seconds)

    async def delete(self, key: str) -> None:
        await self._redis.delete(key)

    async def exists(self, key: str) -> bool:
        res = await self._redis.exists(key)
        return bool(res)

    async def acquire_lock(self, key: str, token: str, ttl_ms: int) -> bool:
        res = await self._redis.set(key, token, nx=True, px=ttl_ms)
        return bool(res)
