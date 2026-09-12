"""Prometheus metrics registry and rendering helper."""

from __future__ import annotations

from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, generate_latest

# Round 1: Empty CollectorRegistry frozen. Metrics definitions are SCOPE-OUT.
REGISTRY = CollectorRegistry()


def render_metrics(registry: CollectorRegistry = REGISTRY) -> tuple[bytes, str]:
    """Render metrics in Prometheus exposition text format."""
    return generate_latest(registry), CONTENT_TYPE_LATEST
