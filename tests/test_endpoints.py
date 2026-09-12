"""Endpoint integration tests using httpx AsyncClient."""

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from app.config import get_settings


@pytest.mark.asyncio
async def test_healthz_endpoint(async_client: AsyncClient) -> None:
    """GET /healthz returns 200 with status ok and valid version string."""
    response = await async_client.get("/healthz")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert isinstance(data["version"], str)
    assert data["version"] == get_settings().VERSION


@pytest.mark.asyncio
async def test_readyz_endpoint_redis_offline(async_client: AsyncClient) -> None:
    """GET /readyz returns 503 when Redis is unreachable without raising unhandled error."""
    response = await async_client.get("/readyz")
    # In isolated test environment without running Redis, endpoint returns 503
    assert response.status_code == 503
    data = response.json()
    assert data["status"] == "not ready"
    assert "error" in data


@pytest.mark.asyncio
async def test_readyz_endpoint_redis_online(async_client: AsyncClient) -> None:
    """GET /readyz returns 200 when Redis is reachable."""
    with patch("redis.asyncio.from_url") as mock_from_url:
        mock_client = AsyncMock()
        mock_client.ping = AsyncMock(return_value=True)
        mock_client.aclose = AsyncMock()
        mock_from_url.return_value = mock_client

        response = await async_client.get("/readyz")
        assert response.status_code == 200
        assert response.json() == {"status": "ready"}
        mock_client.ping.assert_awaited_once()
        mock_client.aclose.assert_awaited_once()


@pytest.mark.asyncio
async def test_metrics_endpoint(async_client: AsyncClient) -> None:
    """GET /metrics returns 200 with Prometheus text format and does not 500."""
    response = await async_client.get("/metrics")
    assert response.status_code == 200
    assert "text/plain" in response.headers.get("content-type", "")
    assert isinstance(response.text, str)


@pytest.mark.asyncio
async def test_chat_completions_mock_success(async_client: AsyncClient) -> None:
    """POST /v1/chat/completions echoes response shaped like OpenAI chat completion."""
    payload = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "hi"}],
    }
    response = await async_client.post("/v1/chat/completions", json=payload)
    assert response.status_code == 200
    data = response.json()

    # Verify OpenAI chat completion schema fields
    assert data["object"] == "chat.completion"
    assert data["model"] == "mock-1"
    assert isinstance(data["id"], str)
    assert data["id"].startswith("chatcmpl-mock-")
    assert isinstance(data["created"], int)

    # Choices
    assert isinstance(data["choices"], list)
    assert len(data["choices"]) == 1
    choice = data["choices"][0]
    assert choice["index"] == 0
    assert choice["message"]["role"] == "assistant"
    assert isinstance(choice["message"]["content"], str)
    assert len(choice["message"]["content"]) > 0
    assert choice["finish_reason"] == "stop"

    # Usage
    usage = data["usage"]
    assert usage["prompt_tokens"] > 0
    assert usage["completion_tokens"] > 0
    assert usage["total_tokens"] == usage["prompt_tokens"] + usage["completion_tokens"]


@pytest.mark.asyncio
async def test_chat_completions_deterministic(async_client: AsyncClient) -> None:
    """Identical input body produces identical completion content and stable tokens."""
    payload = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "Deterministic test prompt"}],
        "temperature": 0.5,
    }

    res1 = await async_client.post("/v1/chat/completions", json=payload)
    res2 = await async_client.post("/v1/chat/completions", json=payload)

    assert res1.status_code == 200
    assert res2.status_code == 200

    data1 = res1.json()
    data2 = res2.json()

    # Content and usage must be identical
    assert data1["id"] == data2["id"]
    assert data1["choices"][0]["message"]["content"] == data2["choices"][0]["message"]["content"]
    assert data1["usage"] == data2["usage"]


@pytest.mark.asyncio
async def test_chat_completions_different_keys_different_content(
    async_client: AsyncClient,
) -> None:
    """Different inputs produce different mock completion contents."""
    res1 = await async_client.post(
        "/v1/chat/completions",
        json={"model": "mock-1", "messages": [{"role": "user", "content": "Prompt A"}]},
    )
    res2 = await async_client.post(
        "/v1/chat/completions",
        json={"model": "mock-1", "messages": [{"role": "user", "content": "Prompt B"}]},
    )

    assert res1.status_code == 200
    assert res2.status_code == 200
    assert res1.json()["id"] != res2.json()["id"]
    assert (
        res1.json()["choices"][0]["message"]["content"]
        != res2.json()["choices"][0]["message"]["content"]
    )


@pytest.mark.asyncio
async def test_chat_completions_custom_tenant_isolation(async_client: AsyncClient) -> None:
    """Different tenant headers isolate responses even with identical body."""
    body = {"model": "mock-1", "messages": [{"role": "user", "content": "Same prompt"}]}

    res1 = await async_client.post(
        "/v1/chat/completions",
        json=body,
        headers={"x-tenant-id": "tenant-corp-a"},
    )
    res2 = await async_client.post(
        "/v1/chat/completions",
        json=body,
        headers={"x-tenant-id": "tenant-corp-b"},
    )

    assert res1.status_code == 200
    assert res2.status_code == 200
    assert res1.json()["id"] != res2.json()["id"]


@pytest.mark.asyncio
async def test_chat_completions_missing_model(async_client: AsyncClient) -> None:
    """Invalid input missing model returns 422."""
    payload = {"messages": [{"role": "user", "content": "hi"}]}
    response = await async_client.post("/v1/chat/completions", json=payload)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_chat_completions_missing_messages(async_client: AsyncClient) -> None:
    """Invalid input missing messages returns 422."""
    payload = {"model": "mock-1"}
    response = await async_client.post("/v1/chat/completions", json=payload)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_chat_completions_empty_messages(async_client: AsyncClient) -> None:
    """Invalid input with empty messages list returns 422."""
    payload = {"model": "mock-1", "messages": []}
    response = await async_client.post("/v1/chat/completions", json=payload)
    assert response.status_code == 422
