"""In-process sliding-window rate limiter for auth endpoints.

MVP default: process-local memory (no Redis required). Suitable for the
single-process platform-api deployment (~50 users). Multi-worker /
multi-host deployments should later swap in a Redis-backed store via
``REDIS_URL`` — the interface below stays the same.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Deque, Dict


@dataclass(frozen=True)
class RateLimitConfig:
    max_failures: int = 5
    window_seconds: float = 300.0


class SlidingWindowLimiter:
    """Count failures per key inside a rolling time window."""

    def __init__(self, config: RateLimitConfig | None = None) -> None:
        self._config = config or RateLimitConfig()
        self._lock = threading.Lock()
        self._events: Dict[str, Deque[float]] = defaultdict(deque)

    def is_blocked(self, key: str, *, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            self._prune(key, now)
            return len(self._events[key]) >= self._config.max_failures

    def record_failure(self, key: str, *, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        with self._lock:
            self._prune(key, now)
            self._events[key].append(now)

    def clear(self, key: str) -> None:
        with self._lock:
            self._events.pop(key, None)

    def remaining(self, key: str, *, now: float | None = None) -> int:
        now = time.monotonic() if now is None else now
        with self._lock:
            self._prune(key, now)
            used = len(self._events[key])
            return max(0, self._config.max_failures - used)

    def _prune(self, key: str, now: float) -> None:
        cutoff = now - self._config.window_seconds
        q = self._events[key]
        while q and q[0] < cutoff:
            q.popleft()
        if not q and key in self._events:
            del self._events[key]


_LOGIN_LIMITER: SlidingWindowLimiter | None = None
_LOGIN_LIMITER_LOCK = threading.Lock()


def get_login_rate_limiter(
    *,
    max_failures: int | None = None,
    window_seconds: float | None = None,
) -> SlidingWindowLimiter:
    """Process-wide login limiter (lazy singleton)."""
    global _LOGIN_LIMITER
    with _LOGIN_LIMITER_LOCK:
        if _LOGIN_LIMITER is None:
            import os

            mf = max_failures
            if mf is None:
                mf = int(os.environ.get("PLATFORM_LOGIN_MAX_FAILURES", "5"))
            ws = window_seconds
            if ws is None:
                ws = float(os.environ.get("PLATFORM_LOGIN_WINDOW_SECONDS", "300"))
            _LOGIN_LIMITER = SlidingWindowLimiter(
                RateLimitConfig(max_failures=mf, window_seconds=ws)
            )
        return _LOGIN_LIMITER


def reset_login_rate_limiter_for_tests() -> None:
    """Drop the singleton so tests can reconfigure via env."""
    global _LOGIN_LIMITER
    with _LOGIN_LIMITER_LOCK:
        _LOGIN_LIMITER = None
