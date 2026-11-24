"""Circuit breaker contracts."""

from dataclasses import dataclass
from enum import Enum


class CircuitStateName(str, Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


@dataclass(frozen=True)
class CircuitState:
    state: CircuitStateName
    failure_count: int
    opened_at_ms: int | None
    backoff_ms: int
