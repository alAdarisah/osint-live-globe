"""The one object every collector writes into and every widget reads.

`Reading` exists because the dashboard is looked at when things are broken. A
collector that fails must leave the previous answer on screen, aged and dimmed,
rather than blanking its pane -- an empty pane and a healthy-but-idle pane look
identical, and the difference is the whole reason someone opened this.
"""

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Reading:
    """One collector's most recent successful value, plus what happened since."""

    value: Any = None
    # time.monotonic() of the last success. 0.0 means "never collected", which
    # is deliberately not the same as "collected and got nothing".
    updated_at: float = 0.0
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None and self.updated_at > 0.0

    def age(self, now: float) -> float:
        """Seconds since the data was true -- not since the last attempt."""
        return now - self.updated_at

    def succeeded(self, value: Any, now: float) -> "Reading":
        return Reading(value=value, updated_at=now, error=None)

    def failed(self, message: str, now: float) -> "Reading":
        # value and updated_at survive: see the module docstring.
        return Reading(value=self.value, updated_at=self.updated_at, error=message)


@dataclass
class State:
    """Mutable holder of the four readings. One instance per running app."""

    services: Reading = field(default_factory=Reading)
    sources: Reading = field(default_factory=Reading)
    metrics: Reading = field(default_factory=Reading)
    host: Reading = field(default_factory=Reading)
