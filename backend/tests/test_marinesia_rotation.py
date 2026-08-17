"""Marinesia's one-request-an-hour rotation.

The collector was written against a documented "up to 5 requests per minute" and
swept eight boxes 13 seconds apart. The real budget for this key is one request an
hour -- every response carries `x-ratelimit-limit: 1` with a reset ~3600s out -- so
it spent the hour's request on the first box and took 429s for the other seven,
every five minutes. The layer held ten hulls from the single box that got through.

Three things had to be true to fix it, and all three are asserted here: one request
per sweep aimed at the box we know least about, a staleness window wider than a full
rotation, and the API key never reaching a log line.
"""

import time

from backend import config
from backend.sources import marinesia


def test_the_attempt_cadence_is_shorter_than_the_budget_window():
    """Attempting twice per window, on purpose.

    Equal was the obvious choice and has a race: the collector returns without a
    request until the remembered reset instant passes, so an attempt landing a second
    early skips -- and the next is a whole window later, halving the throughput of a
    budget that is already one request an hour. The early attempt costs nothing
    because it makes no request.
    """
    assert config.MARINESIA_POLL_INTERVAL < config.MARINESIA_BUDGET_INTERVAL
    assert config.MARINESIA_BUDGET_INTERVAL >= 3600


def test_the_staleness_window_outlasts_a_full_rotation():
    """The requirement the ten-vessel layer violated.

    Each sweep refreshes one box, so what the map holds is the union of every box
    still inside the staleness window. If that window is shorter than
    boxes x interval, a box expires before the rotation returns to it and the layer
    holds exactly one box's worth however long the process runs.
    """
    rotation = len(config.MARINESIA_BBOXES) * config.MARINESIA_BUDGET_INTERVAL
    assert config.ENTITY_STALE_AFTER["marinesia"] > rotation, (
        f"{len(config.MARINESIA_BBOXES)} boxes x {config.MARINESIA_BUDGET_INTERVAL}s "
        f"= {rotation}s of rotation, but rows expire after "
        f"{config.ENTITY_STALE_AFTER['marinesia']}s"
    )


def test_the_box_list_is_short_enough_to_stay_current():
    """Positions can be as old as a whole rotation, and a hull makes ~19 knots.
    Eight boxes at one an hour is an eight-hour-old picture; the trade for a
    fallback is fewer boxes, fresher."""
    rotation_hours = len(config.MARINESIA_BBOXES) * config.MARINESIA_BUDGET_INTERVAL / 3600
    assert rotation_hours <= 4, f"a {rotation_hours:.0f}-hour-old ship position is not a position"


def test_choose_box_prefers_one_never_polled():
    """An unseen box outranks any stale one, so a fresh deployment fills the
    rotation out rather than re-polling whatever it happened to start with."""
    boxes = [(40, 27, 47, 42), (24, 48, 30, 57), (10, 43, 15, 52)]
    now = time.time()
    # A recent fix inside box 0 only.
    stored = [(43.0, 30.0, now - 60)]
    box, index, age = marinesia.choose_box(boxes, stored, now)
    assert index in (1, 2), "a box with no fixes at all must win"
    assert age is None


def test_choose_box_takes_the_stalest_when_all_have_been_seen():
    boxes = [(40, 27, 47, 42), (24, 48, 30, 57), (10, 43, 15, 52)]
    now = time.time()
    stored = [
        (43.0, 30.0, now - 600),     # box 0, ten minutes old
        (27.0, 52.0, now - 9000),    # box 1, two and a half hours old
        (12.0, 47.0, now - 1800),    # box 2, half an hour old
    ]
    box, index, age = marinesia.choose_box(boxes, stored, now)
    assert index == 1
    assert 8000 < age < 10000


def test_choose_box_is_derived_rather_than_counted():
    """Called twice with the same stored state it answers the same box, which is what
    makes it a function of the data instead of a cursor.

    A cursor in this process resets to zero on restart, so a nightly redeploy would
    re-poll the first box forever and never reach the last -- and this runs once an
    hour, so it would take days to notice.
    """
    boxes = [(40, 27, 47, 42), (24, 48, 30, 57)]
    now = time.time()
    stored = [(43.0, 30.0, now - 60)]
    first = marinesia.choose_box(boxes, stored, now)
    second = marinesia.choose_box(boxes, stored, now)
    assert first[1] == second[1] == 1


def test_choose_box_survives_a_fix_in_no_box_at_all():
    """Rows outside every current box -- left over from a wider MARINESIA_BBOXES --
    must not stop the rotation working."""
    boxes = [(40, 27, 47, 42)]
    now = time.time()
    stored = [(-33.0, 18.0, now - 60)]  # off Cape Town, in none of the boxes
    box, index, age = marinesia.choose_box(boxes, stored, now)
    assert index == 0
    assert age is None


def test_the_key_never_reaches_a_log_line(monkeypatch):
    """Marinesia take the key as a query parameter -- their design -- so every httpx
    error message carries the full URL, key and all.

    The module docstring claimed that pinning httpx's logger to WARNING kept request
    URLs out of the log. True of httpx's own logging, false of ours: logging an
    HTTPStatusError prints the URL httpx put in the message, and during this outage
    that happened several times a minute.
    """
    monkeypatch.setattr(config, "MARINESIA_API_KEY", "s3cret-key-value")
    message = (
        "Client error '429 Too Many Requests' for url "
        "'https://api.marinesia.com/api/v2/vessel/area?lat_min=40.0&key=s3cret-key-value'"
    )
    scrubbed = marinesia._scrub(message)
    assert "s3cret-key-value" not in scrubbed
    assert "<key>" in scrubbed
    # Everything else survives, or the log line stops being useful.
    assert "429" in scrubbed
    assert "api.marinesia.com" in scrubbed


def test_scrub_is_safe_with_no_key_configured():
    """A deployment with no key still logs, and must not crash trying to redact
    nothing."""
    assert marinesia._scrub("plain message") == "plain message"


def test_reset_at_reads_the_providers_own_number():
    """Honouring the reset instant is what stops every later sweep rediscovering the
    wall -- and it is an absolute epoch here, not a duration."""

    class Response:
        def __init__(self, headers):
            self.headers = headers

    future = time.time() + 3577
    assert abs(marinesia._reset_at(Response({"x-ratelimit-reset": str(int(future))})) - future) < 2

    # Seconds-from-now, which other vendors send under the same header name.
    got = marinesia._reset_at(Response({"x-ratelimit-reset": "120"}))
    assert time.time() + 100 < got < time.time() + 140

    # Retry-After as the fallback, then an hour if there is nothing at all.
    got = marinesia._reset_at(Response({"retry-after": "90"}))
    assert time.time() + 70 < got < time.time() + 110
    got = marinesia._reset_at(Response({}))
    assert got > time.time() + marinesia.RATE_LIMIT_BACKOFF - 5
