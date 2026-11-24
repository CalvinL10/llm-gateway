"""Injected clock dependency for business logic."""

from __future__ import annotations

import time


def now_ts() -> int:
    """Return current wall-clock epoch timestamp in seconds.

    Injected via FastAPI Depends and overridable in tests through
    app.dependency_overrides. This is the only place in the codebase
    allowed to read the wall clock.
    """
    return int(time.time())
