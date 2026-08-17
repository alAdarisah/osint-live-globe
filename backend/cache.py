import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class SourceState:
    name: str
    key_configured: bool
    last_success: float | None = None
    last_error: str | None = None
    # How often this source actually reports, in seconds, or None when nothing has
    # measured it yet. Filled in by app.py from storage.observed_cadence() (or from
    # a mirrored job's own declared interval, which is authoritative where it
    # exists) and passed straight through to /api/health.
    #
    # It exists because the frontend had no yardstick. It was judging all 57
    # sources against one flat 1800-second threshold, and only 24 of them poll that
    # fast -- so the other 33 read as failing for most of their own correct
    # interval, and the headline count sat at 26/57 while almost nothing was
    # actually wrong. A 7-day reference set three hours past its last fetch is not
    # late; a 15-minute feed an hour past its last is. Nothing could tell those
    # apart without this.
    expected_every: float | None = None
    # The count the source itself recorded, when it and _item_count() disagree.
    # See to_health() for why that happens and which one wins.
    recorded_item_count: int | None = None
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
        # A payload that is a dict *of* lists is one source serving several
        # collections at once (cables.py's routes plus its landing points), and
        # the useful count is how many things it holds, not how many keys. A
        # plain dict -- outages.py's country -> record map -- keeps len().
        if isinstance(self.data, dict) and self.data and all(
            isinstance(v, list) for v in self.data.values()
        ):
            return sum(len(v) for v in self.data.values())
        try:
            return len(self.data)
        except TypeError:
            return 0

    def to_health(self) -> dict[str, Any]:
        # The source's own recorded count wins over _item_count()'s guess.
        #
        # _item_count() reads whatever shape `data` happens to be, and for a
        # source that publishes a *document* rather than a list of features it
        # counts the wrong thing entirely: gazetteer.py stores
        # [{"places": 272803}] and got 1, water_bodies.py stores
        # {"marine": n, "lakes": n, "rivers": n} and got 3 (its key count),
        # railways.py and power_lines.py store a four-key serialisation and got 4,
        # admin2_boundaries.py stores {iso3: count} and got its country count.
        #
        # Every one of those modules already computes the real number correctly and
        # passes it to record_source_health, so it was sitting in the database while
        # /api/health published the artefact. Five fully healthy layers read as
        # nearly empty, and "item_count" meant different units for different rows,
        # which makes the whole column unusable for comparison.
        #
        # Falls back to _item_count() when nothing has been recorded -- a source
        # that has published data this process but not yet written a health row.
        count = self.recorded_item_count if self.recorded_item_count is not None else self._item_count()
        return {
            "name": self.name,
            "key_configured": self.key_configured,
            "item_count": count,
            "version": self.version,
            "last_success": self.last_success,
            "seconds_since_success": (
                round(time.time() - self.last_success) if self.last_success else None
            ),
            "expected_every": self.expected_every,
            "last_error": self.last_error,
        }


class SourceRegistry:
    def __init__(self) -> None:
        self._sources: dict[str, SourceState] = {}

    def register(self, name: str, key_configured: bool) -> SourceState:
        state = SourceState(name=name, key_configured=key_configured)
        self._sources[name] = state
        return state

    def ensure(self, name: str, key_configured: bool) -> SourceState:
        """register(), but keeps an existing state instead of replacing it.

        register() is right for a poller that owns its own `while True` loop: it
        runs once, at the top, and everything after it holds the same object for
        the life of the process. A scheduled job has no such top -- the ingest
        scheduler re-enters a source's step from a fresh call every interval (see
        backend/ingest), so register() there would hand out a new state each time
        and throw away the version counter, last_success and last_error the
        previous run recorded. `key_configured` is refreshed on every call, since
        credentials can appear in the environment between runs.
        """
        state = self._sources.get(name)
        if state is None:
            return self.register(name, key_configured)
        state.key_configured = key_configured
        return state

    def health(self) -> dict[str, Any]:
        return {name: state.to_health() for name, state in self._sources.items()}

    def all(self) -> dict[str, SourceState]:
        """Every registered state, for the periodic pass that fills in the two
        facts a source cannot know about itself -- its own observed cadence and the
        item count it recorded (see app.py's _refresh_health_facts). A copy of the
        mapping, so a caller iterating it cannot be tripped by a source registering
        mid-loop; the states themselves are the live objects, which is the point.
        """
        return dict(self._sources)

    def get(self, name: str) -> SourceState:
        return self._sources[name]

    def has(self, name: str) -> bool:
        return name in self._sources


registry = SourceRegistry()
