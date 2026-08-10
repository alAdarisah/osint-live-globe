"""What each pane puts on a row, tested without a terminal.

The row builders are pure on purpose: rendering is the part a snapshot test
covers badly and a unit test covers exactly.
"""

from ops.cc.collectors.compose import ServiceState
from ops.cc.collectors.health import SourceState
from ops.cc.collectors.host import HostSnapshot
from ops.cc.collectors.prom import MetricSnapshot
from ops.cc.theme import GLYPH
from ops.cc.widgets.host import format_bytes, host_lines
from ops.cc.widgets.services import service_row
from ops.cc.widgets.sources import source_row


def test_a_healthy_service_row():
    row = service_row(ServiceState("backend", "osint-backend-1", "running", "healthy", 0,
                                   cpu_percent=1.2, mem_bytes=268435456, mem_percent=1.6))
    assert row[0] == GLYPH["ok"]
    assert row[1] == "backend"
    assert "healthy" in row[2]
    assert "256" in row[3] and "1.2%" in row[3]


def test_a_restarting_service_shows_its_restart_count():
    """Three restarts is the difference between "it is up" and "it keeps
    dying", and `docker compose ps` alone cannot tell you which."""
    row = service_row(ServiceState("ingest", "osint-ingest-1", "restarting", "", 1, restarts=3))
    assert row[0] == GLYPH["warn"]
    assert "×3" in row[2]


def test_a_stopped_service_says_its_exit_code():
    row = service_row(ServiceState("frontend", "osint-frontend-1", "exited", "", 137))
    assert row[0] == GLYPH["down"]
    assert "137" in row[2]


def test_a_service_with_no_stats_yet_shows_no_number():
    """Blank, not 0.0% -- see collectors/stats.py."""
    assert service_row(ServiceState("refine", "osint-refine-1", "running", "", 0))[3].strip() == ""


def test_a_producing_source_row():
    row = source_row(SourceState("firms", 9133, 120, None, True))
    assert row[0] == GLYPH["ok"]
    assert row[2] == "9,133"
    assert row[3] == "2m ago"


def test_a_source_that_has_never_polled_shows_a_dash_not_a_zero():
    row = source_row(SourceState("cables", 0, None, None, True))
    assert row[0] == GLYPH["starting"]
    assert row[2] == "—"
    assert row[3] == "never"


def test_a_failing_source_shows_its_error_not_its_age():
    """The age of a dead source is the least useful thing about it."""
    row = source_row(SourceState("ais", 0, 2820, "ingest: aisstream closed the socket", True))
    assert row[0] == GLYPH["down"]
    assert "aisstream" in row[3]


def test_byte_formatting_is_readable_at_every_scale():
    assert format_bytes(0) == "0B"
    assert format_bytes(8_123_456_789) == "7.6G"
    assert format_bytes(256 * 1024 * 1024) == "256M"
    assert format_bytes(None) == "—"


def test_the_host_line_shows_connections_against_the_limit():
    lines = host_lines(
        HostSnapshot(34.2, 61.0, 44.0, 1.25, "arch-box"),
        MetricSnapshot(values={"db_size": 8_123_456_789, "connections": 12,
                               "connection_limit": 100, "oldest_transaction": 4.0,
                               "scrapes_up": 3, "scrapes_total": 3, "alerts_active": 0},
                       series={"request_rate": (1.0, 2.0, 3.0)}),
    )
    joined = " ".join(lines)
    assert "34%" in joined and "12/100" in joined and "7.6G" in joined and "3/3" in joined


def test_unmeasured_prometheus_values_render_as_dashes():
    """Prometheus is unreachable until `s` is pressed; the host pane must say
    that rather than reporting a database of size zero."""
    lines = host_lines(
        HostSnapshot(34.2, 61.0, 44.0, 1.25, "arch-box"),
        MetricSnapshot(values={key: None for key in
                               ("db_size", "connections", "connection_limit",
                                "oldest_transaction", "scrapes_up", "scrapes_total",
                                "alerts_active")},
                       series={"request_rate": ()}),
    )
    joined = " ".join(lines)
    assert "34%" in joined, "the host half keeps working when Prometheus does not"
    assert "—" in joined
