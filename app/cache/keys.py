"""Cache key namespacing and derivation functions."""

from __future__ import annotations

from app.contracts.canonical import CanonicalRequest, cache_key


def l1_key(req: CanonicalRequest) -> str:
    """Generate namespaced Redis key for L1 exact cache entries.

    Dual Tenant Inclusion Rationale:
    1. Inside the hashed canonical payload (via req.ns): ensures two tenants
       can never produce colliding SHA-256 digests even with identical request bodies.
    2. Literal prefix (f"gw:l1:{req.ns}:..."): allows infrastructure operators to inspect,
       audit, and manage per-tenant isolation boundaries using Redis KEYS or SCAN patterns.
    """
    return f"gw:l1:{req.ns}:{cache_key(req)}"


def lock_key(req: CanonicalRequest) -> str:
    """Generate namespaced Redis key for single-flight distributed lock.

    Dual Tenant Inclusion Rationale:
    1. Inside the hashed canonical payload (via req.ns): prevents lock collisions
       between distinct tenants submitting identical payloads concurrently.
    2. Literal prefix (f"gw:lock:{req.ns}:..."): permits targeted operational auditing
       and eviction of stuck locks on a per-tenant basis using Redis SCAN patterns.
    """
    return f"gw:lock:{req.ns}:{cache_key(req)}"
