"""Motion is a claim on someone's attention. These are the cases where it lies.

Every test here is a way a moving character could say something untrue: a
spinner on a state that is not transitional, a heartbeat that keeps beating for
a collector that died, a flash on a number that did not change. The phase
arithmetic is tested too, but it is the least interesting part -- a spinner one
frame out of step is a cosmetic bug, and a heartbeat that beats through an
outage is the failure this module exists to avoid.
"""

from ops.cc.motion import (
    SPINNER,
    STALE_INTERVALS,
    Flashes,
    breath,
    heartbeat,
    spinner,
)


def test_spinner_visits_every_frame_across_one_period():
    """A spinner that skips frames reads as a stutter rather than a rotation."""
    seen = {spinner(t / 100.0) for t in range(0, 200)}
    assert seen == set(SPINNER)


def test_spinner_is_on_the_same_beat_everywhere():
    """Phase comes from the clock, not from a per-row counter. Independent
    counters drift apart, and a pane of spinners at different phases looks like
    it is buffering rather than working."""
    assert spinner(12.3456) == spinner(12.3456)


def test_spinner_survives_a_zero_period():
    """A caller passing 0 gets a still glyph, not a ZeroDivisionError taking the
    pane down. Nothing in the app does this today, which is exactly why it would
    not be noticed until it did."""
    assert spinner(5.0, period=0) == SPINNER[0]


def test_breath_is_half_on_and_half_off():
    on = sum(breath(t / 100.0, period=2.0) for t in range(0, 200))
    assert 95 <= on <= 105


def test_a_collector_that_never_ran_does_not_beat():
    """updated_at of 0.0 means "never collected", which state.Reading is careful
    to distinguish from "collected and got nothing". A marker beating before the
    first successful tick would claim a liveness nothing has established."""
    assert heartbeat(updated_at=0.0, interval=2.0, now=100.0) is None


def test_a_stalled_collector_stops_beating():
    """The alarm in this module. A collector overdue by more than STALE_INTERVALS
    of its own period has stopped, and the marker must hold still rather than
    keep beating on a value that is no longer being refreshed."""
    interval = 10.0
    now = 1000.0
    dead = now - interval * STALE_INTERVALS - 0.1
    assert heartbeat(updated_at=dead, interval=interval, now=now) is None


def test_one_late_tick_is_not_a_stall():
    """A single slow `docker compose ps` is not a dead collector. Crying wolf on
    every hiccup is how a status light gets ignored."""
    interval = 10.0
    now = 1000.0
    late = now - interval * 1.5
    assert heartbeat(updated_at=late, interval=interval, now=now) is not None


def test_a_healthy_collector_beats():
    assert heartbeat(updated_at=999.0, interval=10.0, now=1000.0) is not None


def test_the_first_sighting_of_a_value_is_not_a_change():
    """Otherwise every number on screen lights up on the first tick after
    launch, announcing that all of it just happened about a screen that has
    merely been drawn for the first time."""
    flashes = Flashes()
    flashes.update({("acled", "items"): 4201}, now=100.0)
    assert not flashes.lit(("acled", "items"), now=100.0)


def test_a_changed_value_lights_up():
    flashes = Flashes()
    flashes.update({("acled", "items"): 4201}, now=100.0)
    flashes.update({("acled", "items"): 4380}, now=102.0)
    assert flashes.lit(("acled", "items"), now=102.0)


def test_an_unchanged_value_stays_dark():
    """The whole point: a pane redrawing every two seconds must not light up
    every number every time it redraws."""
    flashes = Flashes()
    flashes.update({("acled", "items"): 4201}, now=100.0)
    flashes.update({("acled", "items"): 4201}, now=102.0)
    assert not flashes.lit(("acled", "items"), now=102.0)


def test_a_flash_expires():
    flashes = Flashes()
    flashes.update({("acled", "items"): 4201}, now=100.0)
    flashes.update({("acled", "items"): 4380}, now=102.0)
    assert not flashes.lit(("acled", "items"), now=200.0)


def test_a_value_that_goes_back_and_forth_flashes_both_times():
    """Down is as interesting as up. A connection count dropping is the thing
    worth seeing, and treating only increases as news would hide it."""
    flashes = Flashes()
    flashes.update({("db", "conn"): 12}, now=100.0)
    flashes.update({("db", "conn"): 9}, now=102.0)
    assert flashes.lit(("db", "conn"), now=102.0)
    flashes.update({("db", "conn"): 12}, now=104.0)
    assert flashes.lit(("db", "conn"), now=104.0)


def test_rows_that_leave_the_screen_are_forgotten():
    """A pane whose rows churn must not grow a timestamp for every row it has
    ever shown -- this program runs for days on a server."""
    flashes = Flashes()
    flashes.update({("gone", "items"): 1, ("stays", "items"): 1}, now=100.0)
    flashes.update({("gone", "items"): 2, ("stays", "items"): 2}, now=102.0)
    flashes.update({("stays", "items"): 3}, now=104.0)
    assert flashes._changed_at.keys() == {("stays", "items")}


def test_a_row_that_returns_is_not_treated_as_changed():
    """A source dropping out of /api/health and coming back has no history to
    be compared against, so its first value back is a first sighting."""
    flashes = Flashes()
    flashes.update({("flaky", "items"): 10}, now=100.0)
    flashes.update({}, now=102.0)
    flashes.update({("flaky", "items"): 99}, now=104.0)
    assert not flashes.lit(("flaky", "items"), now=104.0)
