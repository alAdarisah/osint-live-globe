"""Turning `docker compose logs -f` output into lines the pane can colour.

Compose prefixes every line with the container name and a pipe; the level has
to come out of the message body, which is written by five different processes
with four different formatters.
"""

from ops.cc.collectors import logs


def test_splits_the_compose_prefix_from_the_message():
    line = logs.parse_line("backend-1  | INFO:     127.0.0.1:52310 - GET /api/ships 200")
    assert line.service == "backend-1"
    assert line.text.startswith("INFO:")


def test_a_line_without_a_prefix_is_kept_whole():
    """Compose emits bare status lines of its own during up and down."""
    line = logs.parse_line(" Container osint-backend-1  Started")
    assert line.service == ""
    assert "Started" in line.text


def test_error_lines_are_found_however_they_are_spelled():
    for raw in ("backend-1  | ERROR: pool exhausted",
                "ingest-1   | [error] aisstream refused",
                "refine-1   | CRITICAL cannot reach postgres",
                "backend-1  | Traceback (most recent call last):"):
        assert logs.parse_line(raw).level == "error", raw


def test_warnings_are_their_own_level():
    for raw in ("ingest-1  | WARNING: backing off 30s",
                "ingest-1  | WARN aisstream backoff"):
        assert logs.parse_line(raw).level == "warn", raw


def test_a_word_containing_error_does_not_promote_a_line():
    """"0 errors" and "error_rate" are the two that used to light the pane up."""
    assert logs.parse_line("backend-1  | refreshed error_rate gauge, 0 errors").level == "info"


def test_everything_else_is_info():
    assert logs.parse_line("backend-1  | served /api/ships 214 rows").level == "info"


def test_argv_follows_and_limits_the_backlog():
    assert logs.argv(None) == [
        "docker", "compose", "logs", "--follow", "--no-color", "--tail", "200"
    ]


def test_argv_scopes_to_one_service():
    assert logs.argv("backend")[-1] == "backend"


def test_backoff_grows_and_then_stops_growing():
    """The stream exits every time the stack is stopped, and stays exited until
    it is started again -- so this must not become a spin, or a five-minute
    wait after `s`."""
    assert logs.backoff(0) == 1.0
    assert logs.backoff(1) == 2.0
    assert logs.backoff(5) <= 30.0
    assert logs.backoff(50) == 30.0
