"""Unit tests for canonical request cache-key derivation.

Tests the 10 load-bearing canonical cache-key rules:
  1. identical body + tenant          -> identical key
  2. temperature 0.0 -> 0.9           -> key CHANGES
  3. stream true -> false             -> key UNCHANGED
  4. tools list reordered             -> key UNCHANGED
  5. stop list reordered              -> key UNCHANGED
  6. messages reordered               -> key CHANGES
  7. different tenant_id              -> key CHANGES
  8. model alias vs resolved id       -> key CHANGES
  9. extra unknown field in body      -> key UNCHANGED
 10. whitespace-only difference in a user message -> key UNCHANGED
"""

from app.contracts.canonical import build_canonical_request, cache_key


def test_1_identical_body_and_tenant_yields_identical_key() -> None:
    """1. identical body + tenant -> identical key."""
    body = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "Hello, world!"}],
        "temperature": 0.7,
    }
    tenant = "tenant-prod-1"

    req1 = build_canonical_request(body, tenant)
    req2 = build_canonical_request(body, tenant)

    assert cache_key(req1) == cache_key(req2)


def test_2_temperature_change_changes_key() -> None:
    """2. temperature 0.0 -> 0.9 -> key CHANGES."""
    body_0_0 = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "Sample prompt"}],
        "temperature": 0.0,
    }
    body_0_9 = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "Sample prompt"}],
        "temperature": 0.9,
    }
    tenant = "tenant-1"

    req1 = build_canonical_request(body_0_0, tenant)
    req2 = build_canonical_request(body_0_9, tenant)

    assert cache_key(req1) != cache_key(req2)


def test_3_stream_true_vs_false_key_unchanged() -> None:
    """3. stream true -> false -> key UNCHANGED."""
    body_stream_true = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "Generate text"}],
        "stream": True,
    }
    body_stream_false = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "Generate text"}],
        "stream": False,
    }
    tenant = "tenant-1"

    req1 = build_canonical_request(body_stream_true, tenant)
    req2 = build_canonical_request(body_stream_false, tenant)

    assert cache_key(req1) == cache_key(req2)


def test_4_tools_list_reordered_key_unchanged() -> None:
    """4. tools list reordered -> key UNCHANGED."""
    tool_alpha = {
        "type": "function",
        "function": {
            "name": "lookup_weather",
            "description": "Lookup weather in location",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string"},
                    "unit": {"type": "string"},
                },
                "required": ["city"],
            },
        },
    }
    tool_beta = {
        "type": "function",
        "function": {
            "name": "search_database",
            "description": "Query internal database",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                },
            },
        },
    }

    body_order_1 = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "Check weather and search"}],
        "tools": [tool_alpha, tool_beta],
    }
    body_order_2 = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "Check weather and search"}],
        "tools": [tool_beta, tool_alpha],
    }
    tenant = "tenant-1"

    req1 = build_canonical_request(body_order_1, tenant)
    req2 = build_canonical_request(body_order_2, tenant)

    assert cache_key(req1) == cache_key(req2)


def test_5_stop_list_reordered_key_unchanged() -> None:
    """5. stop list reordered -> key UNCHANGED."""
    body_stop_1 = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "Stop test"}],
        "stop": ["END", "STOP", "TERMINATE"],
    }
    body_stop_2 = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "Stop test"}],
        "stop": ["TERMINATE", "END", "STOP"],
    }
    tenant = "tenant-1"

    req1 = build_canonical_request(body_stop_1, tenant)
    req2 = build_canonical_request(body_stop_2, tenant)

    assert cache_key(req1) == cache_key(req2)


def test_6_messages_reordered_key_changes() -> None:
    """6. messages reordered -> key CHANGES."""
    msg_user = {"role": "user", "content": "Question 1"}
    msg_assistant = {"role": "assistant", "content": "Answer 1"}

    body1 = {
        "model": "mock-1",
        "messages": [msg_user, msg_assistant],
    }
    body2 = {
        "model": "mock-1",
        "messages": [msg_assistant, msg_user],
    }
    tenant = "tenant-1"

    req1 = build_canonical_request(body1, tenant)
    req2 = build_canonical_request(body2, tenant)

    assert cache_key(req1) != cache_key(req2)


def test_7_different_tenant_id_key_changes() -> None:
    """7. different tenant_id -> key CHANGES."""
    body = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "Shared prompt across tenants"}],
    }

    req_tenant_a = build_canonical_request(body, "tenant-alpha")
    req_tenant_b = build_canonical_request(body, "tenant-beta")

    assert cache_key(req_tenant_a) != cache_key(req_tenant_b)


def test_8_model_alias_vs_resolved_id_key_changes() -> None:
    """8. model alias vs resolved id -> key CHANGES."""
    body_alias = {
        "model": "gpt-4",
        "messages": [{"role": "user", "content": "Identify model"}],
    }
    body_resolved = {
        "model": "gpt-4-0613",
        "messages": [{"role": "user", "content": "Identify model"}],
    }
    tenant = "tenant-1"

    req_alias = build_canonical_request(body_alias, tenant)
    req_resolved = build_canonical_request(body_resolved, tenant)

    assert cache_key(req_alias) != cache_key(req_resolved)


def test_9_extra_unknown_field_in_body_key_unchanged() -> None:
    """9. extra unknown field in body -> key UNCHANGED."""
    body_clean = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "Standard payload"}],
    }
    body_with_extras = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "Standard payload"}],
        "unknown_metadata": {"client_version": "v1.2.3", "debug": True},
        "random_param": 42,
        "request_id": "req-internal-abc",
        "user_agent": "Mozilla/5.0",
    }
    tenant = "tenant-1"

    req_clean = build_canonical_request(body_clean, tenant)
    req_extras = build_canonical_request(body_with_extras, tenant)

    assert cache_key(req_clean) == cache_key(req_extras)


def test_10_whitespace_only_difference_in_user_message_key_unchanged() -> None:
    """10. whitespace-only difference in a user message -> key UNCHANGED."""
    body_normal = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "hello world"}],
    }
    body_extra_whitespace = {
        "model": "mock-1",
        "messages": [{"role": "user", "content": "   hello    world  \n\t"}],
    }
    tenant = "tenant-1"

    req_normal = build_canonical_request(body_normal, tenant)
    req_extra_ws = build_canonical_request(body_extra_whitespace, tenant)

    assert cache_key(req_normal) == cache_key(req_extra_ws)
