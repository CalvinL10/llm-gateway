"""Cache lookup contracts."""

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class CacheLookupResult:
    tier: Literal["l1", "l2", "miss"]
    similarity: float | None
    entry_id: str | None
    age_seconds: int | None
