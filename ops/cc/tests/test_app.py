"""What each pane puts on a row, tested without a terminal.

The row builders are pure on purpose: rendering is the part a snapshot test
covers badly and a unit test covers exactly.
"""

import asyncio

import pytest

from ops.cc import __main__ as cli
from ops.cc.app import supervise
from ops.cc.collectors.compose import ServiceState
from ops.cc.collectors.health import SourceState
from ops.cc.collectors.host import HostSnapshot
from ops.cc.collectors.prom import MetricSnapshot
from ops.cc.run import CollectorError
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


def test_supervise_applies_each_successful_collection():
    seen = []
    calls = {"n": 0}

    async def collect():
        calls["n"] += 1
        if calls["n"] > 2:
            raise asyncio.CancelledError
        return f"value-{calls['n']}"

    async def sleep(_seconds):
        return None

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(supervise(collect, seen.append, 1.0, sleep=sleep))
    assert seen == ["value-1", "value-2"]


def test_supervise_keeps_running_after_a_collector_error():
    """One failing docker call must not end the pane's updates for the session."""
    outcomes = []
    calls = {"n": 0}

    async def collect():
        calls["n"] += 1
        if calls["n"] == 1:
            raise CollectorError("permission denied")
        if calls["n"] > 2:
            raise asyncio.CancelledError
        return "recovered"

    async def sleep(_seconds):
        return None

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(supervise(collect, outcomes.append, 1.0, sleep=sleep,
                              on_error=lambda msg: outcomes.append(("error", msg))))
    assert outcomes[0] == ("error", "permission denied")
    assert outcomes[1] == "recovered"


def test_the_app_mounts_with_its_theme_variables_resolved():
    """The regression this pins: App.CSS is parsed on the way into the first
    frame, so a theme registered in on_mount arrives too late and every start
    dies with "reference to undefined variable '$cc-border'". Nothing else in
    the suite touches the stylesheet, and the app never got as far as a pane.
    """
    from pathlib import Path

    from ops.cc.app import CommandCenter
    from ops.cc.widgets.host import HostPane
    from ops.cc.widgets.logs import LogPane
    from ops.cc.widgets.services import ServicesPane
    from ops.cc.widgets.sources import SourcesPane

    async def boot():
        # read_only, so mounting this cannot start or stop anything on the
        # machine running the tests.
        app = CommandCenter(Path("."), read_only=True)
        async with app.run_test() as pilot:
            await pilot.pause()
            for pane in (ServicesPane, SourcesPane, HostPane, LogPane):
                assert app.query_one(pane) is not None
            assert app.theme == "claude-dark"

    asyncio.run(boot())


def test_the_panes_render_the_rows_they_are_given():
    """The regression this pins: the boot test above only ever proved the app
    starts *empty*. Every row put a theme token through Rich's markup parser
    (`[$cc-ok]●[/]`), which cannot read one and raises MarkupError -- so the
    app died on the first frame after docker or the backend answered, and the
    whole suite stayed green. Rows, an alert and a log line, then a real frame.
    """
    from pathlib import Path

    from ops.cc.app import CommandCenter
    from ops.cc.collectors.health import Alert, SourcesSnapshot
    from ops.cc.collectors.logs import LogLine
    from ops.cc.state import Reading
    from ops.cc.widgets.logs import LogPane
    from ops.cc.widgets.services import ServicesPane
    from ops.cc.widgets.sources import SourcesPane

    services = [
        ServiceState("backend", "osint-backend-1", "running", "healthy", 0,
                     cpu_percent=1.2, mem_bytes=268435456, mem_percent=1.6),
        ServiceState("ingest", "osint-ingest-1", "restarting", "", 1, restarts=3),
        ServiceState("frontend", "osint-frontend-1", "exited", "", 137),
        ServiceState("refine", "osint-refine-1", "running", "", 0),
    ]
    sources = SourcesSnapshot(
        sources=(
            SourceState("firms", 9133, 120, None, True),
            SourceState("cables", 0, None, None, True),
            # A bracket in the error text: upstream strings are not markup, and
            # a pane that dies on one dies exactly when it is being read.
            SourceState("ais", 0, 2820, "ingest: closed [1006] no status", True),
        ),
        alerts=(Alert("redis", "evicting", "critical", "maxmemory reached", 3, 0.0),),
    )

    async def boot():
        app = CommandCenter(Path("."), read_only=True)
        async with app.run_test() as pilot:
            await pilot.pause()
            now = 100.0
            app.query_one(ServicesPane).update_from(Reading(services, now), now)
            app.query_one(SourcesPane).update_from(Reading(sources, now), now)
            for level in ("info", "warn", "error"):
                app.query_one(LogPane).append(LogLine("backend", f"a {level} line", level))
            # The frame the markup was parsed in. Without it the rows sit in the
            # table unrendered and this passes with the bug present.
            await pilot.pause()
            assert app.query_one(ServicesPane).row_count == len(services)
            assert app.query_one(SourcesPane).row_count == 4  # three sources, one alert
            # Selection still reads back as plain text now the cells are Text.
            assert app.query_one(ServicesPane).selected == "backend"
            assert app.query_one(SourcesPane).selected == "ais"

    asyncio.run(boot())


def test_no_pane_renders_wider_than_the_window_it_is_in():
    """Measured at 80x24, the smallest window anyone actually uses. A 304-char
    error had sized SOURCES to 230 cells inside a 100-cell pane, so every row's
    glyph and name sat off-screen behind a horizontal scrollbar.
    """
    from pathlib import Path

    from ops.cc.app import CommandCenter
    from ops.cc.collectors.health import Alert, SourcesSnapshot
    from ops.cc.state import Reading
    from ops.cc.widgets.services import ServicesPane
    from ops.cc.widgets.sources import SourcesPane

    services = [ServiceState("postgres-exporter-replica", "osint-per-1", "exited", "", 137,
                             restarts=9, cpu_percent=12.5, mem_bytes=268435456)]
    sources = SourcesSnapshot(
        sources=(SourceState("ais", 0, 2820, "ingest: " + "aisstream closed " * 20, True),),
        alerts=(Alert("redis", "evicting", "critical", "maxmemory " * 20, 3, 0.0),),
    )

    async def boot():
        app = CommandCenter(Path("."), read_only=True)
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            now = 100.0
            app.query_one(ServicesPane).update_from(Reading(services, now), now)
            app.query_one(SourcesPane).update_from(Reading(sources, now), now)
            await pilot.pause()
            for pane in (app.query_one(ServicesPane), app.query_one(SourcesPane)):
                # Against the scrollable region, not size: a table sized to
                # `size` fits exactly and then has its last two cells covered by
                # its own vertical scrollbar -- which is where the ellipsis
                # marking a trimmed message lives.
                drawable = pane.scrollable_content_region.width
                assert pane.virtual_size.width <= drawable, (
                    f"{type(pane).__name__} is {pane.virtual_size.width} cells wide "
                    f"in {drawable} drawable cells"
                )

    asyncio.run(boot())


def test_the_host_pane_grows_for_the_line_that_explains_itself():
    """`height: 4` fitted exactly the two normal lines, so the third one --
    "prometheus unreachable, press s to start the stack" -- was cut off in the
    one situation where the pane has something to say beyond numbers.
    """
    from pathlib import Path

    from ops.cc.app import CommandCenter
    from ops.cc.state import Reading
    from ops.cc.widgets.host import HostPane, host_lines

    async def boot():
        app = CommandCenter(Path("."), read_only=True)
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            pane = app.query_one(HostPane)
            # An unmeasured Prometheus: never collected, no error yet.
            pane.update_from(Reading(None), Reading(), 0.0)
            await pilot.pause()
            wanted = len(host_lines(None, None)) + 1  # the explanation line
            assert pane.size.height >= wanted, f"{pane.size.height} rows for {wanted} lines"

    asyncio.run(boot())


def test_the_app_shadows_none_of_textuals_own_methods():
    """The regression this pins: __init__ assigned `self.run_action`, which is
    App's own method -- the one Textual calls to dispatch every action string it
    resolves. Keys still worked, so nothing looked wrong until a mouse touched a
    scrollbar, whose "@mouse.down: grab" then reached a subprocess runner:
    "_run() takes 1 positional argument but 2 were given".

    Written as a sweep rather than as `assert not hasattr(...)` on one name,
    because the next collision will be with a different method.
    """
    from pathlib import Path

    from ops.cc.app import CommandCenter

    app = CommandCenter(Path("."), read_only=True)
    shadowed = {
        name for name in vars(app)
        if not name.startswith("__") and callable(getattr(type(app), name, None))
    }
    assert shadowed == set(), f"instance attributes hiding App methods: {shadowed}"


def test_a_click_on_a_scrollbar_does_not_take_the_app_down():
    """The same regression from the outside: the exact call that broke.

    Both arguments matter. App._broker_event dispatches a click's meta as
    `run_action(action, default_namespace)`, and it was the second one that made
    the shadowing runner raise -- called with one argument it had happily
    started a subprocess instead, which is the quieter half of the same bug.
    """
    from pathlib import Path

    from ops.cc.app import CommandCenter
    from ops.cc.widgets.logs import LogPane

    async def boot():
        app = CommandCenter(Path("."), read_only=True)
        async with app.run_test() as pilot:
            await pilot.pause()
            scrollbar = app.query_one(LogPane).vertical_scrollbar
            # "grab" is what a scrollbar's "@mouse.down" meta resolves to.
            await app.run_action("grab", scrollbar)
            await pilot.pause()
            assert app.is_running

    asyncio.run(boot())


def test_read_only_is_off_by_default():
    assert cli.parse_args([]).read_only is False


def test_read_only_flag():
    assert cli.parse_args(["--read-only"]).read_only is True


def test_the_default_compose_dir_is_the_deployment_path():
    # as_posix, because these tests are also run on the Windows machine the
    # code is written on, where str(Path("/opt/osint")) has backslashes -- and
    # that would be a test of the platform rather than of the default.
    assert cli.parse_args([]).compose_dir.as_posix() == "/opt/osint"


def test_the_compose_dir_is_overridable_for_a_checkout():
    args = cli.parse_args(["--compose-dir", "/home/me/osint"])
    assert args.compose_dir.as_posix() == "/home/me/osint"


def test_the_theme_choices_are_the_two_that_exist():
    assert cli.parse_args([]).theme == "claude-dark"
    assert cli.parse_args(["--light"]).theme == "claude-light"


def test_the_api_and_prometheus_urls_are_the_published_ports():
    args = cli.parse_args([])
    assert args.api_url == "http://localhost:8080"
    assert args.prom_url == "http://localhost:9090"
