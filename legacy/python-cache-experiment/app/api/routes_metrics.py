"""Metrics exposition endpoint."""

from __future__ import annotations

from fastapi import APIRouter, Response, status

from app.obs.metrics import render_metrics

router = APIRouter(tags=["Metrics"])


@router.get("/metrics", status_code=status.HTTP_200_OK)
async def metrics() -> Response:
    """Expose Prometheus metrics in text exposition format."""
    payload, media_type = render_metrics()
    return Response(content=payload, media_type=media_type, status_code=status.HTTP_200_OK)
