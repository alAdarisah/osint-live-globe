import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class SourceState:
    name: str
    key_configured: bool
    last_success: float | None = None
    last_error: str | None = None
    # Bumped every time .data is reassigned (see the property below) -- a
    # free, exact substitute for hashing the payload to build an HTTP ETag
    # (see backend/app.py): the data can only actually change when a
    # poller assigns it, so "has the version changed" answers "did the data
    # change" without ever touching FIRMS' 100k+ point payload just to check.
    version: int = 0
    _data: Any = field(default_factory=list, repr=False)  # usually list[dict], but a GeoJSON FeatureCollection for "countries"

    @property
    def data(self) -> Any:
        return self._data

    @data.setter
    def data(self, value: Any) -> None:
        self._data = value
        self.version += 1

    def _item_count(self) -> int:
        if isinstance(self.data, dict) and "features" in self.data:
            return len(self.data["features"])
        try:
            return len(self.data)
        except TypeError:
            return 0

    def to_health(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "key_configured": self.key_configured,
            "item_count": self._item_count(),
            "version": self.version,
            "last_success": self.last_success,
            "seconds_since_success": (
                round(time.time() - self.last_success) if self.last_success else None
            ),
            "last_error": self.last_error,
        }


class SourceRegistry:
    def __init__(self) -> None:
        self._sources: dict[str, SourceState] = {}

    def register(self, name: str, key_configured: bool) -> SourceState:
        state = SourceState(name=name, key_configured=key_configured)
        self._sources[name] = state
        return state

    def health(self) -> dict[str, Any]:
        return {name: state.to_health() for name, state in self._sources.items()}

    def get(self, name: str) -> SourceState:
        return self._sources[name]

    def has(self, name: str) -> bool:
        return name in self._sources


registry = SourceRegistry()
