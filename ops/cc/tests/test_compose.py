"""Reading container state out of the Docker CLI.

Two output shapes, because Compose changed its mind: v2 emitted one JSON object
per line, v2.21 and later emit a single JSON array. Both are still in the wild
and the difference is invisible until the pane is empty on somebody's box.
"""

import asyncio
import json

from ops.cc.collectors import compose
from ops.cc.run import CommandResult

PS_ROWS = [
    {"ID": "aaa", "Name": "osint-postgres-1", "Service": "postgres", "State": "running",
     "Health": "healthy", "ExitCode": 0},
    {"ID": "bbb", "Name": "osint-ingest-1", "Service": "ingest", "State": "restarting",
     "Health": "", "ExitCode": 1},
    {"ID": "ccc", "Name": "osint-frontend-1", "Service": "frontend", "State": "exited",
     "Health": "", "ExitCode": 137},
    {"ID": "ddd", "Name": "osint-backend-1", "Service": "backend", "State": "running",
     "Health": "unhealthy", "ExitCode": 0},
]

NDJSON = "\n".join(json.dumps(row) for row in PS_ROWS) + "\n"
ARRAY = json.dumps(PS_ROWS)

INSPECT = "/osint-postgres-1\t0\n/osint-ingest-1\t3\n/osint-frontend-1\t0\n/osint-backend-1\t0\n"


def _by_service(services):
    return {s.service: s for s in services}


def test_parses_the_line_per_object_shape():
    assert [s.service for s in compose.parse_ps(NDJSON)] == [
        "postgres", "ingest", "frontend", "backend"
    ]


def test_parses_the_json_array_shape():
    assert [s.service for s in compose.parse_ps(ARRAY)] == [
        "postgres", "ingest", "frontend", "backend"
    ]


def test_empty_output_is_a_stopped_stack_not_an_error():
    """Before `s` is pressed there are no containers at all, and that is a
    normal state the pane has to render."""
    assert compose.parse_ps("") == []
    assert compose.parse_ps("[]") == []


def test_a_truncated_line_does_not_lose_the_whole_pane():
    broken = json.dumps(PS_ROWS[0]) + "\n{not json\n" + json.dumps(PS_ROWS[1]) + "\n"
    assert [s.service for s in compose.parse_ps(broken)] == ["postgres", "ingest"]


def test_severity_running_and_healthy_is_ok():
    assert _by_service(compose.parse_ps(NDJSON))["postgres"].severity == "ok"


def test_severity_running_but_unhealthy_is_warn():
    """The container is up, so this is not `down`; the healthcheck disagreeing
    with `running` is exactly the state worth colouring differently."""
    assert _by_service(compose.parse_ps(NDJSON))["backend"].severity == "warn"


def test_severity_restarting_is_warn():
    assert _by_service(compose.parse_ps(NDJSON))["ingest"].severity == "warn"


def test_severity_exited_is_down():
    assert _by_service(compose.parse_ps(NDJSON))["frontend"].severity == "down"


def test_a_running_container_with_no_healthcheck_is_ok_not_unknown():
    """refine and cache-worker have no healthcheck; they must not read as broken."""
    row = json.dumps({"ID": "e", "Name": "osint-refine-1", "Service": "refine",
                      "State": "running", "Health": "", "ExitCode": 0})
    assert compose.parse_ps(row)[0].severity == "ok"


def test_starting_health_is_its_own_severity():
    row = json.dumps({"ID": "f", "Name": "osint-backend-1", "Service": "backend",
                      "State": "running", "Health": "starting", "ExitCode": 0})
    assert compose.parse_ps(row)[0].severity == "starting"


def test_restart_counts_are_read_by_container_name():
    assert compose.parse_restarts(INSPECT) == {
        "osint-postgres-1": 0, "osint-ingest-1": 3, "osint-frontend-1": 0, "osint-backend-1": 0,
    }


def test_collect_merges_restart_counts_onto_services():
    calls = []

    async def fake_run(argv):
        calls.append(list(argv))
        stdout = NDJSON if "ps" in argv else INSPECT
        return CommandResult(tuple(argv), 0, stdout, "")

    services = _by_service(asyncio.run(compose.collect(fake_run)))
    assert services["ingest"].restarts == 3
    assert calls[0][:4] == ["docker", "compose", "ps", "--format"]
    assert calls[1][:2] == ["docker", "inspect"]


def test_collect_survives_inspect_failing():
    """A restart count is a nice-to-have; container state is not. Losing the
    former must not cost the latter."""
    async def fake_run(argv):
        if "inspect" in argv:
            return CommandResult(tuple(argv), 1, "", "no such object")
        return CommandResult(tuple(argv), 0, NDJSON, "")

    services = _by_service(asyncio.run(compose.collect(fake_run)))
    assert services["ingest"].restarts == 0
    assert services["postgres"].severity == "ok"


def test_collect_raises_when_ps_itself_fails():
    """The supervisor turns this into a dimmed pane with an error. Returning an
    empty list instead would render as "the stack is stopped", which is a
    different and much calmer thing than "docker is not answering"."""
    async def fake_run(argv):
        return CommandResult(tuple(argv), 1, "", "permission denied on /var/run/docker.sock")

    try:
        asyncio.run(compose.collect(fake_run))
    except compose.CollectorError as exc:
        assert "permission denied" in str(exc)
    else:
        raise AssertionError("a failing docker call must not read as an empty stack")
