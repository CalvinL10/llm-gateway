"""Contract freeze snapshot tests.

Asserts line-by-line contract stability: no fields added, renamed, or deleted,
and all contracts remain strictly frozen.
"""

import inspect
from dataclasses import FrozenInstanceError, fields, is_dataclass

import pytest

from app.contracts.admission import AdmissionDecision
from app.contracts.cache import CacheLookupResult
from app.contracts.canonical import (
    CanonicalRequest,
    build_canonical_request,
    cache_key,
    canonical_json,
    canonicalize_tools,
)
from app.contracts.circuit import CircuitState, CircuitStateName
from app.contracts.gateway import GatewayRequest, GatewayResult


def test_canonical_request_contract_frozen() -> None:
    """CanonicalRequest contract snapshot."""
    assert is_dataclass(CanonicalRequest)
    assert CanonicalRequest.__dataclass_params__.frozen is True

    field_names = [f.name for f in fields(CanonicalRequest)]
    assert field_names == [
        "ns",
        "model",
        "messages",
        "temperature",
        "top_p",
        "max_tokens",
        "stop",
        "tools",
        "response_format",
    ]

    # Immutability verification
    instance = CanonicalRequest(
        ns="t1",
        model="m1",
        messages=(),
        temperature=1.0,
        top_p=None,
        max_tokens=None,
        stop=(),
        tools=(),
        response_format=None,
    )
    with pytest.raises(FrozenInstanceError):
        instance.temperature = 0.5  # type: ignore[misc]


def test_gateway_request_contract_frozen() -> None:
    """GatewayRequest contract snapshot."""
    assert is_dataclass(GatewayRequest)
    assert GatewayRequest.__dataclass_params__.frozen is True

    field_names = [f.name for f in fields(GatewayRequest)]
    assert field_names == ["body", "tenant_id", "request_id", "stream"]

    instance = GatewayRequest(body={}, tenant_id="t1", request_id="r1", stream=False)
    with pytest.raises(FrozenInstanceError):
        instance.stream = True  # type: ignore[misc]


def test_gateway_result_contract_frozen() -> None:
    """GatewayResult contract snapshot."""
    assert is_dataclass(GatewayResult)
    assert GatewayResult.__dataclass_params__.frozen is True

    field_names = [f.name for f in fields(GatewayResult)]
    assert field_names == [
        "body",
        "provider",
        "model",
        "cache_tier",
        "similarity",
        "upstream_latency_ms",
        "total_latency_ms",
        "retry_count",
        "degraded",
        "degraded_reason",
        "usage",
        "trace_id",
    ]

    instance = GatewayResult(
        body={},
        provider="mock",
        model="m1",
        cache_tier="miss",
        similarity=None,
        upstream_latency_ms=0.0,
        total_latency_ms=0.0,
        retry_count=0,
        degraded=False,
        degraded_reason=None,
        usage={},
        trace_id="tr-1",
    )
    with pytest.raises(FrozenInstanceError):
        instance.provider = "openai"  # type: ignore[misc]


def test_admission_decision_contract_frozen() -> None:
    """AdmissionDecision contract snapshot."""
    assert is_dataclass(AdmissionDecision)
    assert AdmissionDecision.__dataclass_params__.frozen is True

    field_names = [f.name for f in fields(AdmissionDecision)]
    assert field_names == [
        "allowed",
        "remaining_tokens",
        "remaining_quota",
        "retry_after_ms",
        "limit_kind",
    ]

    instance = AdmissionDecision(
        allowed=True,
        remaining_tokens=100,
        remaining_quota=100,
        retry_after_ms=None,
        limit_kind=None,
    )
    with pytest.raises(FrozenInstanceError):
        instance.allowed = False  # type: ignore[misc]


def test_cache_lookup_result_contract_frozen() -> None:
    """CacheLookupResult contract snapshot."""
    assert is_dataclass(CacheLookupResult)
    assert CacheLookupResult.__dataclass_params__.frozen is True

    field_names = [f.name for f in fields(CacheLookupResult)]
    assert field_names == ["tier", "similarity", "entry_id", "age_seconds"]

    instance = CacheLookupResult(tier="miss", similarity=None, entry_id=None, age_seconds=None)
    with pytest.raises(FrozenInstanceError):
        instance.tier = "l1"  # type: ignore[misc]


def test_circuit_state_contracts_frozen() -> None:
    """CircuitState and CircuitStateName contract snapshots."""
    assert issubclass(CircuitStateName, str)
    assert CircuitStateName.CLOSED == "closed"
    assert CircuitStateName.OPEN == "open"
    assert CircuitStateName.HALF_OPEN == "half_open"

    assert is_dataclass(CircuitState)
    assert CircuitState.__dataclass_params__.frozen is True

    field_names = [f.name for f in fields(CircuitState)]
    assert field_names == ["state", "failure_count", "opened_at_ms", "backoff_ms"]

    instance = CircuitState(
        state=CircuitStateName.CLOSED,
        failure_count=0,
        opened_at_ms=None,
        backoff_ms=1000,
    )
    with pytest.raises(FrozenInstanceError):
        instance.failure_count = 1  # type: ignore[misc]


def test_canonical_function_signatures_snapshot() -> None:
    """Verify signatures of canonical module functions."""
    sig_tools = inspect.signature(canonicalize_tools)
    assert list(sig_tools.parameters.keys()) == ["tools"]

    sig_build = inspect.signature(build_canonical_request)
    assert list(sig_build.parameters.keys()) == ["body", "tenant_id"]

    sig_json = inspect.signature(canonical_json)
    assert list(sig_json.parameters.keys()) == ["req"]

    sig_key = inspect.signature(cache_key)
    assert list(sig_key.parameters.keys()) == ["req"]
