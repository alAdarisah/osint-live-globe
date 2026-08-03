"""Time-filtering for the replay timeline's conflict/fires/news layers.
Unlike ships/aircraft (see history.py), these three already carry a
real-world timestamp per item straight from ACLED/UCDP, FIRMS/HMS, and
GDELT -- replaying them is just "keep whatever was already true at or
before the scrubbed time," no extra storage required.
"""

from datetime import datetime, timezone


def _to_epoch(dt: datetime | None) -> float | None:
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc).timestamp()


def acled_ts(item: dict) -> float | None:
    # ACLED/UCDP both write the shared "date" field as "YYYY-MM-DD" (see
    # backend/sources/acled.py) -- day granularity, no time-of-day.
    raw = item.get("date")
    if not raw:
        return None
    try:
        return _to_epoch(datetime.strptime(raw, "%Y-%m-%d"))
    except ValueError:
        return None


def firms_ts(item: dict) -> float | None:
    date, acq_time = item.get("acq_date"), item.get("acq_time")
    if not date:
        return None
    time_str = str(acq_time or "0").zfill(4)
    try:
        return _to_epoch(datetime.strptime(f"{date} {time_str}", "%Y-%m-%d %H%M"))
    except ValueError:
        return None


def gdelt_ts(item: dict) -> float | None:
    # "YYYYMMDDHHMMSS" UTC, no separators (see backend/sources/gdelt.py).
    raw = item.get("date_added")
    if not raw or len(raw) < 14:
        return None
    try:
        return _to_epoch(datetime.strptime(raw[:14], "%Y%m%d%H%M%S"))
    except ValueError:
        return None


def filter_up_to(items: list[dict], ts_fn, cutoff: float) -> list[dict]:
    # An item whose timestamp can't be parsed is kept rather than dropped --
    # same lenient default the rest of this codebase uses for malformed
    # upstream data (see regions.filter_points' lat/lon handling).
    out = []
    for item in items:
        ts = ts_fn(item)
        if ts is None or ts <= cutoff:
            out.append(item)
    return out
