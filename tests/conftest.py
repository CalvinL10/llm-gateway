"""Pytest fixtures for LLM Gateway test suite."""

from collections.abc import AsyncIterator, Iterator

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.fixture(autouse=True)
def restore_app_state() -> Iterator[None]:
    """Snapshot and restore app.state and app.dependency_overrides around every test."""
    saved_state = dict(app.state._state)
    saved_overrides = dict(app.dependency_overrides)
    try:
        yield
    finally:
        app.state._state.clear()
        app.state._state.update(saved_state)
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved_overrides)


@pytest.fixture
async def async_client() -> AsyncIterator[AsyncClient]:
    """Provide httpx AsyncClient using ASGITransport for in-memory ASGI testing."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client
