"""What a pane shows when its collector has just failed.

Every case here is a way for the dashboard to lie during an outage, which is
the exact moment it is being read: a value that blanks looks like "nothing is
happening", and a value that resets to zero looks like a measurement.
"""

from ops.cc.state import Reading, State


def test_a_fresh_reading_is_not_ok():
    """Never-collected and collected-successfully must be distinguishable."""
    assert Reading().ok is False


def test_success_records_the_value_and_the_time():
    reading = Reading().succeeded(["backend"], now=100.0)
    assert reading.value == ["backend"]
    assert reading.updated_at == 100.0
    assert reading.error is None
    assert reading.ok is True


def test_failure_keeps_the_last_good_value():
    reading = Reading().succeeded(["backend"], now=100.0).failed("timeout", now=140.0)
    assert reading.value == ["backend"], "a failed collector must not blank the pane"
    assert reading.updated_at == 100.0, "the age shown is the age of the data, not of the attempt"
    assert reading.error == "timeout"
    assert reading.ok is False


def test_age_is_measured_from_the_last_success():
    reading = Reading().succeeded(1, now=100.0).failed("boom", now=140.0)
    assert reading.age(now=160.0) == 60.0


def test_recovery_clears_the_error():
    reading = Reading().succeeded(1, now=100.0).failed("boom", now=140.0).succeeded(2, now=180.0)
    assert reading.error is None
    assert reading.value == 2


def test_state_starts_with_four_empty_readings():
    state = State()
    assert [r.ok for r in (state.services, state.sources, state.metrics, state.host)] == [False] * 4
