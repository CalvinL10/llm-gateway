"""FastAPI application entry point."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import redis.asyncio as aioredis
from fastapi import FastAPI

from app.api.routes_chat import router as chat_router
from app.api.routes_health import router as health_router
from app.api.routes_metrics import router as metrics_router
from app.cache.backend import RedisCacheBackend
from app.config import get_settings
from app.providers.mock import MockProvider


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application lifespan context manager."""
    settings = get_settings()

    if settings.SINGLEFLIGHT_WAIT_TIMEOUT_MS >= settings.SINGLEFLIGHT_LOCK_TTL_MS:
        raise ValueError(
            "SINGLEFLIGHT_WAIT_TIMEOUT_MS must be strictly less than SINGLEFLIGHT_LOCK_TTL_MS"
        )

    pool = aioredis.BlockingConnectionPool.from_url(
        settings.REDIS_URL,
        max_connections=settings.REDIS_MAX_CONNECTIONS,
        timeout=10,
    )
    redis_client = aioredis.Redis(connection_pool=pool)
    app.state.redis = redis_client
    app.state.cache_backend = RedisCacheBackend(redis_client)
    app.state.provider = MockProvider(latency_ms=settings.MOCK_LATENCY_MS)

    yield

    await redis_client.aclose()


def create_app() -> FastAPI:
    """Create and configure the FastAPI application instance."""
    settings = get_settings()
    application = FastAPI(
        title="llm-gateway",
        version=settings.VERSION,
        lifespan=lifespan,
    )
    application.state.provider = MockProvider(latency_ms=settings.MOCK_LATENCY_MS)

    # Register routers
    application.include_router(health_router)
    application.include_router(metrics_router)
    application.include_router(chat_router)

    return application


app = create_app()
