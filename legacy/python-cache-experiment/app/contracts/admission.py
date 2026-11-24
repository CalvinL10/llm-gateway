"""Admission control contracts."""

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class AdmissionDecision:
    allowed: bool
    remaining_tokens: int
    remaining_quota: int
    retry_after_ms: int | None
    limit_kind: Literal["rate", "quota"] | None
