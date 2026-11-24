"""Health and readiness probe endpoints."""

from __future__ import annotations

from typing import Annotated

import redis
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, status
from fastapi.responses import JSONResponse

from app.config import Settings, get_settings

router = APIRouter(tags=["Health"])


@router.get("/healthz", status_code=status.HTTP_200_OK)
async def healthz(
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, str]:
    """Liveness probe returning application status and version."""
    return {"status": "ok", "version": settings.VERSION}


@router.get("/readyz")
async def readyz(
    settings: Annotated[Settings, Depends(get_settings)],
) -> JSONResponse:
    """Readiness probe verifying Redis connectivity."""
    client = aioredis.from_url(
        settings.REDIS_URL,
        socket_timeout=1.0,
        socket_connect_timeout=1.0,
    )
    try:
        await client.ping()
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={"status": "ready"},
        )
    except (redis.RedisError, OSError, TimeoutError, Exception) as exc:  # noqa: BLE001
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"status": "not ready", "error": str(exc) or "redis unreachable"},
        )
    finally:
        await client.aclose()
