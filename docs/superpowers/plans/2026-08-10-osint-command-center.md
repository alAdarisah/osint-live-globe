# OSINT Command Center (`cc`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Textual terminal dashboard, `cc`, that runs on the Arch Linux server hosting this stack and shows container state, source production, database health and live logs on one screen, with keys to start, stop, restart and rebuild the stack.

**Architecture:** Collectors are pure-ish async functions that shell out to `docker` or call HTTP and return frozen dataclasses; they import nothing from Textual, which is what makes them testable without a terminal. Each runs as its own supervised asyncio task writing into one shared `State`, and widgets render from that state. Mutating actions shell out to the existing `deploy.sh` and `docker compose` rather than reimplementing them.

**Tech Stack:** Python 3.12, Textual, psutil, httpx, pytest. Docker Compose v2 CLI on the host.

**Spec:** `docs/superpowers/specs/2026-08-10-osint-command-center-design.md`

## Global Constraints

- Python 3.12, matching `backend/Dockerfile` (`python:3.12-slim`).
- New dependencies live in `ops/cc/requirements.txt` only. Do **not** add anything to the repository root `requirements.txt` — that file builds the backend, ingest, refine and cache-worker images, none of which have any reason to carry a TUI.
- `textual>=0.86` is a hard floor: `textual.theme.Theme` and the `App.theme` string API do not exist before it. Pin the exact resolved versions into `ops/cc/requirements.txt` (this repo pins exactly, e.g. `fastapi==0.115.0`).
- No collector may import from `textual`. No widget may contain a hex colour or a subprocess call.
- The tool never writes to Postgres and never calls a credentialed upstream. It reads Docker, `localhost:8080/api/health` and `localhost:9090`.
- Timeouts: every subprocess and HTTP call gets 5 s. A failed collector keeps its last-good value; a pane must never blank or show a zero it did not measure.
- Source health verdicts come from `/api/health`'s `last_error`, computed by `backend/mirror.py`. Never invent a staleness threshold in `ops/cc`.
- Comment style follows the repository: explain *why* a thing is the way it is, not what the line does. Look at `backend/cache.py` and `backend/tests/test_ingest_jobs.py` for the register.
- Commit after every task.

## File Structure

```
ops/
  __init__.py
  cc/
    __init__.py
    __main__.py             CLI entry: arguments, theme selection, App launch
    app.py                  Textual App: layout, bindings, collector supervision
    state.py                Reading + State: what every collector writes into
    theme.py                The two themes, semantic tokens, status glyphs
    spark.py                Unicode sparkline rendering
    run.py                  Async subprocess runner + CommandResult + Runner type
    actions.py              The mutating commands and their confirmation rules
    collectors/
      __init__.py
      compose.py            docker compose ps + docker inspect -> ServiceState
      stats.py              docker stats -> ContainerStats, merged into ServiceState
      health.py             /api/health -> SourceState, Alert, SourcesSnapshot
      prom.py               PromQL -> MetricSnapshot
      host.py               psutil -> HostSnapshot
      logs.py               docker compose logs -f -> LogLine stream
    widgets/
      __init__.py
      services.py           SERVICES pane
      sources.py            SOURCES pane
      host.py               HOST pane
      logs.py               LOGS pane
    tests/
      __init__.py
      test_state.py
      test_theme.py
      test_compose.py
      test_stats.py
      test_health.py
      test_prom.py
      test_host.py
      test_logs.py
      test_actions.py
      test_spark.py
      test_app.py
    requirements.txt
    requirements-dev.txt
    README.md
```

Tests live beside the code they test rather than in `backend/tests/`, because
`ops/cc` is a separate program with a separate virtualenv; putting them under
`backend/tests/` would mean the backend's test run imports Textual.

---

### Task 1: Package skeleton, process runner, and `Reading`

**Files:**
- Create: `ops/__init__.py`, `ops/cc/__init__.py`, `ops/cc/collectors/__init__.py`, `ops/cc/widgets/__init__.py`, `ops/cc/tests/__init__.py`
- Create: `ops/cc/requirements.txt`, `ops/cc/requirements-dev.txt`
- Create: `ops/cc/run.py`, `ops/cc/state.py`
- Test: `ops/cc/tests/test_state.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `run.CommandResult(argv: tuple[str, ...], returncode: int, stdout: str, stderr: str, timed_out: bool)`
  - `run.Runner = Callable[[Sequence[str]], Awaitable[CommandResult]]`
  - `run.CollectorError(Exception)` — every collector's "I could not answer"
  - `async run.run(argv, *, cwd: Path, timeout: float = 5.0) -> CommandResult`
  - `run.runner_for(cwd: Path, timeout: float = 5.0) -> Runner`
  - `state.Reading(value=None, updated_at=0.0, error=None)` with `.ok`, `.age(now)`, `.succeeded(value, now)`, `.failed(message, now)`
  - `state.State()` with attributes `services`, `sources`, `metrics`, `host`, each a `Reading`

- [ ] **Step 1: Create the package files**

Create the five `__init__.py` files, all empty except `ops/cc/__init__.py`:

```python
"""The command center: a terminal dashboard for the running stack.

Separate from `backend/` and from its requirements.txt on purpose -- this is a
program you run on the server, not part of any image the stack builds.
"""
```

`ops/cc/requirements.txt`:

```
# Pinned exactly, as the root requirements.txt is. Install into a venv on the
# server; nothing here belongs in a backend image.
#
# textual: >=0.86 is a hard floor -- textual.theme.Theme and the App.theme
# string API arrived in 0.86, and ops/cc/theme.py is built on both.
textual==REPLACE_WITH_RESOLVED_VERSION
psutil==REPLACE_WITH_RESOLVED_VERSION
httpx==REPLACE_WITH_RESOLVED_VERSION
```

`ops/cc/requirements-dev.txt`:

```
-r requirements.txt
pytest==8.3.3
# Renders a widget to a terminal snapshot and diffs it. Dev-only: the server
# never needs it, and it pulls in a browser-based diff viewer.
pytest-textual-snapshot==REPLACE_WITH_RESOLVED_VERSION
```

- [ ] **Step 2: Resolve and pin the versions**

Run:

```bash
python -m venv /tmp/cc-resolve && /tmp/cc-resolve/bin/pip install textual psutil httpx pytest-textual-snapshot
```

Then `/tmp/cc-resolve/bin/pip freeze | grep -Ei '^(textual|psutil|httpx|pytest-textual-snapshot)='` and replace each `REPLACE_WITH_RESOLVED_VERSION` with the exact version printed. If the resolved `textual` is below 0.86, stop and report it — the theme task depends on that API.

- [ ] **Step 3: Write the failing test for `Reading`**

`ops/cc/tests/test_state.py`:

```python
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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `python -m pytest ops/cc/tests/test_state.py -v`
Expected: FAIL, `ModuleNotFoundError: No module named 'ops.cc.state'`

- [ ] **Step 5: Write `ops/cc/state.py`**

```python
"""The one object every collector writes into and every widget reads.

`Reading` exists because the dashboard is looked at when things are broken. A
collector that fails must leave the previous answer on screen, aged and dimmed,
rather than blanking its pane -- an empty pane and a healthy-but-idle pane look
identical, and the difference is the whole reason someone opened this.
"""

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Reading:
    """One collector's most recent successful value, plus what happened since."""

    value: Any = None
    # time.monotonic() of the last success. 0.0 means "never collected", which
    # is deliberately not the same as "collected and got nothing".
    updated_at: float = 0.0
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None and self.updated_at > 0.0

    def age(self, now: float) -> float:
        """Seconds since the data was true -- not since the last attempt."""
        return now - self.updated_at

    def succeeded(self, value: Any, now: float) -> "Reading":
        return Reading(value=value, updated_at=now, error=None)

    def failed(self, message: str, now: float) -> "Reading":
        # value and updated_at survive: see the module docstring.
        return Reading(value=self.value, updated_at=self.updated_at, error=message)


@dataclass
class State:
    """Mutable holder of the four readings. One instance per running app."""

    services: Reading = field(default_factory=Reading)
    sources: Reading = field(default_factory=Reading)
    metrics: Reading = field(default_factory=Reading)
    host: Reading = field(default_factory=Reading)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `python -m pytest ops/cc/tests/test_state.py -v`
Expected: PASS (6 passed)

- [ ] **Step 7: Write `ops/cc/run.py`**

No test of its own — it is a thin wrapper over `asyncio.create_subprocess_exec`, and every collector test injects a fake `Runner` instead. Testing it would test asyncio.

```python
"""Running one external command, with a timeout, without blocking the UI.

Collectors take a `Runner` rather than calling this directly, so their tests can
hand them recorded output instead of needing Docker.
"""

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from pathlib import Path


class CollectorError(Exception):
    """A collector could not answer. The supervisor dims that pane and shows this.

    Lives here rather than in any one collector because all five raise it and
    none of them should have to import another to do so.
    """


@dataclass(frozen=True)
class CommandResult:
    argv: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str
    timed_out: bool = False


Runner = Callable[[Sequence[str]], Awaitable[CommandResult]]


async def run(argv: Sequence[str], *, cwd: Path, timeout: float = 5.0) -> CommandResult:
    """Run `argv`, capture both streams, and never raise.

    A timeout returns a result rather than raising, because every caller's
    response to "docker did not answer in 5 seconds" is the same as its response
    to "docker answered with an error": keep the last good value and say so.
    """
    try:
        process = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as exc:  # docker not installed, cwd gone
        return CommandResult(tuple(argv), 127, "", str(exc))

    try:
        out, err = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        return CommandResult(tuple(argv), 124, "", f"timed out after {timeout}s", timed_out=True)

    return CommandResult(
        tuple(argv),
        process.returncode or 0,
        out.decode("utf-8", "replace"),
        err.decode("utf-8", "replace"),
    )


def runner_for(cwd: Path, timeout: float = 5.0) -> Runner:
    async def _run(argv: Sequence[str]) -> CommandResult:
        return await run(argv, cwd=cwd, timeout=timeout)

    return _run
```

- [ ] **Step 8: Commit**

```bash
git add ops/
git commit -m "Start the command center with the part that has to survive an outage"
```

---

### Task 2: Theme and status glyphs

**Files:**
- Create: `ops/cc/theme.py`
- Test: `ops/cc/tests/test_theme.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `theme.TOKENS: tuple[str, ...]` — the semantic variable names every widget may use
  - `theme.CLAUDE_DARK: textual.theme.Theme`, `theme.CLAUDE_LIGHT: textual.theme.Theme`
  - `theme.THEMES: dict[str, Theme]` keyed `"claude-dark"` / `"claude-light"`
  - `theme.GLYPH: dict[str, str]` keyed `"ok" | "starting" | "warn" | "down"`
  - `theme.severity_style(severity: str) -> str` returning a Rich style string

- [ ] **Step 1: Write the failing test**

`ops/cc/tests/test_theme.py`:

```python
"""The theme, checked for the two ways it can break someone else's terminal.

A token defined in one theme and not the other renders as an unstyled -- often
invisible -- pane for whoever picked the other theme, and nothing in a snapshot
test of the dark theme would catch it.
"""

import pytest

from ops.cc.theme import CLAUDE_DARK, CLAUDE_LIGHT, GLYPH, THEMES, TOKENS, severity_style


def test_both_themes_define_exactly_the_documented_tokens():
    for theme in (CLAUDE_DARK, CLAUDE_LIGHT):
        assert set(theme.variables) == set(TOKENS), theme.name


def test_the_two_themes_disagree_only_about_the_base_pair():
    """The accents are the brand; only ground and muted change with the terminal."""
    differing = {k for k in TOKENS if CLAUDE_DARK.variables[k] != CLAUDE_LIGHT.variables[k]}
    assert differing == {"cc-muted", "cc-border"}


def test_the_accents_are_the_brand_palette():
    assert CLAUDE_DARK.variables["cc-warn"] == "#d97757"
    assert CLAUDE_DARK.variables["cc-value"] == "#6a9bcc"
    assert CLAUDE_DARK.variables["cc-ok"] == "#788c5d"


def test_dark_is_dark_and_light_is_light():
    assert CLAUDE_DARK.dark is True and CLAUDE_DARK.background == "#141413"
    assert CLAUDE_LIGHT.dark is False and CLAUDE_LIGHT.background == "#faf9f5"


def test_themes_are_registered_under_the_names_the_cli_accepts():
    assert THEMES == {"claude-dark": CLAUDE_DARK, "claude-light": CLAUDE_LIGHT}


def test_every_severity_has_a_glyph_and_a_style():
    """Colour alone must not carry state -- monochrome terminals exist, so do
    red-green colour-blind readers, and this screen is read under stress."""
    for severity in ("ok", "starting", "warn", "down"):
        assert GLYPH[severity]
        assert severity_style(severity)


def test_down_inverts_the_accent_rather_than_inventing_a_red():
    """The palette has no red. Failure is a block, not another coloured word."""
    assert severity_style("down") == "bold $cc-down-fg on $cc-down"
    assert CLAUDE_DARK.variables["cc-down"] == "#d97757"


def test_an_unknown_severity_is_not_silently_styled_as_healthy():
    with pytest.raises(KeyError):
        severity_style("probably-fine")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest ops/cc/tests/test_theme.py -v`
Expected: FAIL, `ModuleNotFoundError: No module named 'ops.cc.theme'`

- [ ] **Step 3: Write `ops/cc/theme.py`**

```python
"""Anthropic's palette, mapped to what this dashboard has to say.

Colour and glyphs only: a terminal's font belongs to whoever opened it, so the
brand's typography is not something this program gets to set.

Widgets refer to the tokens below and never to a hex value, which is what makes
retheming a one-file change -- and what makes the parity test at the top of
tests/test_theme.py able to prove both themes are complete.

There is no red here, because the palette has none. Rather than invent a hue for
the most important state on the screen, `down` inverts the accent: dark text on
an orange block, so a stopped container reads as a solid bar rather than one
more coloured word among coloured words.
"""

from textual.theme import Theme

# Straight from the brand palette.
_DARK = "#141413"
_LIGHT = "#faf9f5"
_MID_GRAY = "#b0aea5"
_LIGHT_GRAY = "#e8e6dc"
_ORANGE = "#d97757"
_BLUE = "#6a9bcc"
_GREEN = "#788c5d"

# Derived, and the only two values not in the palette: a four-pane layout needs
# a second surface level and a rule weight that the palette does not name.
_SURFACE_DARK = "#1f1e1d"
_SURFACE_LIGHT = "#efede4"
_MUTED_ON_LIGHT = "#6b6a63"  # #b0aea5 fails contrast on a light ground

TOKENS = (
    "cc-ok",       # healthy container, producing source, exit code 0
    "cc-warn",     # degraded, stale, WARN lines, the focused pane title
    "cc-down",     # background of the inverted failure block
    "cc-down-fg",  # text on that block
    "cc-idle",     # not running, not a problem: created, stopped by request
    "cc-value",    # numbers and sparklines
    "cc-muted",    # labels, units, timestamps, inactive key hints
    "cc-border",   # pane rules
)

_ACCENTS = {
    "cc-ok": _GREEN,
    "cc-warn": _ORANGE,
    "cc-down": _ORANGE,
    "cc-down-fg": _DARK,
    "cc-idle": _MID_GRAY,
    "cc-value": _BLUE,
}

CLAUDE_DARK = Theme(
    name="claude-dark",
    dark=True,
    background=_DARK,
    surface=_SURFACE_DARK,
    panel=_SURFACE_DARK,
    foreground=_LIGHT,
    primary=_ORANGE,
    secondary=_BLUE,
    accent=_ORANGE,
    success=_GREEN,
    warning=_ORANGE,
    error=_ORANGE,
    variables={**_ACCENTS, "cc-muted": _MID_GRAY, "cc-border": _MID_GRAY},
)

CLAUDE_LIGHT = Theme(
    name="claude-light",
    dark=False,
    background=_LIGHT,
    surface=_SURFACE_LIGHT,
    panel=_SURFACE_LIGHT,
    foreground=_DARK,
    primary=_ORANGE,
    secondary=_BLUE,
    accent=_ORANGE,
    success=_GREEN,
    warning=_ORANGE,
    error=_ORANGE,
    variables={**_ACCENTS, "cc-muted": _MUTED_ON_LIGHT, "cc-border": _LIGHT_GRAY},
)

THEMES = {theme.name: theme for theme in (CLAUDE_DARK, CLAUDE_LIGHT)}

# Shape as well as colour, so the screen still parses in monochrome.
GLYPH = {"ok": "●", "starting": "◐", "warn": "▲", "down": "■"}

_STYLES = {
    "ok": "$cc-ok",
    "starting": "$cc-muted",
    "warn": "bold $cc-warn",
    "down": "bold $cc-down-fg on $cc-down",
}


def severity_style(severity: str) -> str:
    """Rich style for a severity. Raises on an unknown one, rather than
    defaulting -- a typo that renders as healthy is the worst possible bug in
    a status display."""
    return _STYLES[severity]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest ops/cc/tests/test_theme.py -v`
Expected: PASS (8 passed)

- [ ] **Step 5: Commit**

```bash
git add ops/cc/theme.py ops/cc/tests/test_theme.py
git commit -m "Give failure a shape, not just a colour"
```

---

### Task 3: `collectors/compose.py` — container state

**Files:**
- Create: `ops/cc/collectors/compose.py`
- Test: `ops/cc/tests/test_compose.py`

**Interfaces:**
- Consumes: `run.CommandResult`, `run.Runner` (Task 1).
- Produces:
  - `compose.ServiceState(service, container, state, health, exit_code, restarts, cpu_percent=None, mem_bytes=None, mem_percent=None)` — frozen, with `.severity -> str`
  - `compose.parse_ps(stdout: str) -> list[ServiceState]`
  - `compose.parse_restarts(stdout: str) -> dict[str, int]`
  - `async compose.collect(run: Runner) -> list[ServiceState]`
  - `compose.replace_stats(service: ServiceState, cpu_percent, mem_bytes, mem_percent) -> ServiceState`

- [ ] **Step 1: Write the failing test**

`ops/cc/tests/test_compose.py`:

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest ops/cc/tests/test_compose.py -v`
Expected: FAIL, `ImportError: cannot import name 'compose'`

- [ ] **Step 3: Write `ops/cc/collectors/compose.py`**

```python
"""Which containers exist, and what state they are in.

Read through the Docker CLI rather than the socket API because `docker compose
ps` already resolves the project name, the health state and the service-to-
container mapping, and it keeps working when the compose file gains a service.

The restart count is the one fact `ps` does not carry, so it comes from a
second `docker inspect` call -- and its failure is tolerated, because a missing
restart count is cosmetic where a missing container list is the pane.
"""

import json
from collections.abc import Sequence
from dataclasses import dataclass, replace

from ops.cc.run import CollectorError, Runner


@dataclass(frozen=True)
class ServiceState:
    service: str
    container: str
    state: str
    health: str
    exit_code: int
    restarts: int = 0
    cpu_percent: float | None = None
    mem_bytes: int | None = None
    mem_percent: float | None = None

    @property
    def severity(self) -> str:
        """One of theme.GLYPH's keys.

        `running` + `unhealthy` is deliberately `warn` rather than `down`: the
        process is alive and may recover, and flattening the two loses the
        distinction between "restart it" and "look at why the healthcheck
        fails".
        """
        if self.state == "running":
            if self.health == "unhealthy":
                return "warn"
            if self.health == "starting":
                return "starting"
            # Empty health means no healthcheck defined (refine, cache-worker),
            # not an unknown state.
            return "ok"
        if self.state in ("restarting", "created", "paused"):
            return "warn"
        return "down"


def _rows(stdout: str) -> list[dict]:
    """Compose emits either one object per line or a single array, depending on
    version. Both shapes are still in service; neither is worth branching on
    anywhere but here."""
    text = stdout.strip()
    if not text:
        return []
    if text.startswith("["):
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return []
        return [row for row in parsed if isinstance(row, dict)]

    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            # One malformed line loses one container, not the pane.
            continue
        if isinstance(parsed, dict):
            rows.append(parsed)
    return rows


def parse_ps(stdout: str) -> list[ServiceState]:
    return [
        ServiceState(
            service=row.get("Service") or row.get("Name", "?"),
            container=row.get("Name", ""),
            state=(row.get("State") or "").lower(),
            health=(row.get("Health") or "").lower(),
            exit_code=int(row.get("ExitCode") or 0),
        )
        for row in _rows(stdout)
    ]


def parse_restarts(stdout: str) -> dict[str, int]:
    """`docker inspect` output, one `/name<TAB>count` per line."""
    counts: dict[str, int] = {}
    for line in stdout.splitlines():
        name, _, count = line.strip().partition("\t")
        if not name or not count.strip().isdigit():
            continue
        counts[name.lstrip("/")] = int(count.strip())
    return counts


def replace_stats(
    service: ServiceState,
    cpu_percent: float | None,
    mem_bytes: int | None,
    mem_percent: float | None,
) -> ServiceState:
    return replace(
        service, cpu_percent=cpu_percent, mem_bytes=mem_bytes, mem_percent=mem_percent
    )


async def collect(run: Runner) -> list[ServiceState]:
    ps = await run(["docker", "compose", "ps", "--format", "json", "--all"])
    if ps.returncode != 0:
        raise CollectorError((ps.stderr or ps.stdout).strip() or "docker compose ps failed")

    services = parse_ps(ps.stdout)
    if not services:
        return []

    inspect = await run(
        ["docker", "inspect", "--format", "{{.Name}}\t{{.RestartCount}}",
         *[s.container for s in services if s.container]]
    )
    counts = parse_restarts(inspect.stdout) if inspect.returncode == 0 else {}
    return [replace(s, restarts=counts.get(s.container, 0)) for s in services]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest ops/cc/tests/test_compose.py -v`
Expected: PASS (14 passed)

- [ ] **Step 5: Commit**

```bash
git add ops/cc/collectors/compose.py ops/cc/tests/test_compose.py
git commit -m "Read container state without pretending a broken docker is an empty stack"
```

---

### Task 4: `collectors/stats.py` — CPU and memory per container

**Files:**
- Create: `ops/cc/collectors/stats.py`
- Test: `ops/cc/tests/test_stats.py`

**Interfaces:**
- Consumes: `compose.ServiceState`, `compose.replace_stats`, `run.Runner`.
- Produces:
  - `stats.ContainerStats(container, cpu_percent, mem_bytes, mem_percent)`
  - `stats.parse_size(text: str) -> int | None`
  - `stats.parse_stats(stdout: str) -> dict[str, ContainerStats]`
  - `async stats.collect(run: Runner) -> dict[str, ContainerStats]`
  - `stats.merge(services: list[ServiceState], stats: dict[str, ContainerStats]) -> list[ServiceState]`

- [ ] **Step 1: Write the failing test**

`ops/cc/tests/test_stats.py`:

```python
"""Parsing `docker stats`, which reports strings meant for humans.

Sizes arrive as "1.234GiB" and percentages as "12.34%", in binary units, and
the units differ per row -- so the parsing is the whole risk here.
"""

import asyncio
import json

from ops.cc.collectors import compose, stats
from ops.cc.run import CommandResult

STATS = "\n".join(json.dumps(row) for row in [
    {"Name": "osint-backend-1", "CPUPerc": "12.34%", "MemUsage": "256.5MiB / 15.6GiB",
     "MemPerc": "1.61%"},
    {"Name": "osint-postgres-1", "CPUPerc": "0.00%", "MemUsage": "1.234GiB / 15.6GiB",
     "MemPerc": "7.90%"},
]) + "\n"


def test_parses_binary_sizes():
    assert stats.parse_size("256.5MiB") == int(256.5 * 1024 * 1024)
    assert stats.parse_size("1.234GiB") == int(1.234 * 1024 * 1024 * 1024)
    assert stats.parse_size("512B") == 512
    assert stats.parse_size("4kB") == 4000, "docker uses kB for decimal kilobytes"


def test_an_unparseable_size_is_none_not_zero():
    """Zero memory is a measurement; unknown is not, and the pane renders them
    differently."""
    assert stats.parse_size("--") is None
    assert stats.parse_size("") is None


def test_parses_the_stats_lines():
    parsed = stats.parse_stats(STATS)
    assert parsed["osint-backend-1"].cpu_percent == 12.34
    assert parsed["osint-backend-1"].mem_percent == 1.61
    assert parsed["osint-postgres-1"].mem_bytes == int(1.234 * 1024**3)


def test_merge_attaches_stats_to_the_matching_container():
    services = [compose.ServiceState("backend", "osint-backend-1", "running", "healthy", 0)]
    merged = stats.merge(services, stats.parse_stats(STATS))
    assert merged[0].cpu_percent == 12.34
    assert merged[0].mem_bytes == int(256.5 * 1024**2)


def test_merge_leaves_a_container_docker_stats_did_not_report():
    """A container that exited between the two calls has state but no stats."""
    services = [compose.ServiceState("refine", "osint-refine-1", "exited", "", 0)]
    merged = stats.merge(services, stats.parse_stats(STATS))
    assert merged[0].cpu_percent is None
    assert merged[0].severity == "down"


def test_collect_asks_for_a_single_sample():
    """Without --no-stream this streams forever and the collector never returns."""
    seen = []

    async def fake_run(argv):
        seen.append(list(argv))
        return CommandResult(tuple(argv), 0, STATS, "")

    asyncio.run(stats.collect(fake_run))
    assert "--no-stream" in seen[0]


def test_collect_returns_empty_when_docker_stats_fails():
    """Unlike the container list, stats failing is not worth dimming a pane
    over -- the numbers simply go blank while the states stay live."""
    async def fake_run(argv):
        return CommandResult(tuple(argv), 1, "", "boom")

    assert asyncio.run(stats.collect(fake_run)) == {}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest ops/cc/tests/test_stats.py -v`
Expected: FAIL, `ImportError: cannot import name 'stats'`

- [ ] **Step 3: Write `ops/cc/collectors/stats.py`**

```python
"""CPU and memory per container.

Separate from compose.py, and on a slower interval, because `docker stats`
samples every container and costs an order of magnitude more than `ps`. State
changes are what you want promptly; a CPU percentage is not, and running both on
one interval would make the monitor a visible load on the box it monitors.
"""

import json
import re
from dataclasses import dataclass

from ops.cc.collectors.compose import ServiceState, replace_stats
from ops.cc.run import Runner

# docker mixes binary (MiB) and decimal (kB) units in the same field.
_UNITS = {
    "b": 1, "kb": 1000, "mb": 1000**2, "gb": 1000**3, "tb": 1000**4,
    "kib": 1024, "mib": 1024**2, "gib": 1024**3, "tib": 1024**4,
}
_SIZE = re.compile(r"^\s*([0-9.]+)\s*([a-zA-Z]+)\s*$")


@dataclass(frozen=True)
class ContainerStats:
    container: str
    cpu_percent: float | None
    mem_bytes: int | None
    mem_percent: float | None


def parse_size(text: str) -> int | None:
    """"256.5MiB" -> bytes. None when docker printed something else, which it
    does for a container that is starting or has just exited."""
    match = _SIZE.match(text or "")
    if not match:
        return None
    value, unit = match.groups()
    factor = _UNITS.get(unit.lower())
    if factor is None:
        return None
    return int(float(value) * factor)


def _percent(text: str) -> float | None:
    try:
        return float((text or "").strip().rstrip("%"))
    except ValueError:
        return None


def parse_stats(stdout: str) -> dict[str, ContainerStats]:
    parsed: dict[str, ContainerStats] = {}
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        name = row.get("Name", "")
        if not name:
            continue
        used, _, _limit = (row.get("MemUsage") or "").partition("/")
        parsed[name] = ContainerStats(
            container=name,
            cpu_percent=_percent(row.get("CPUPerc", "")),
            mem_bytes=parse_size(used.strip()),
            mem_percent=_percent(row.get("MemPerc", "")),
        )
    return parsed


def merge(
    services: list[ServiceState], samples: dict[str, ContainerStats]
) -> list[ServiceState]:
    merged = []
    for service in services:
        sample = samples.get(service.container)
        merged.append(
            service if sample is None
            else replace_stats(service, sample.cpu_percent, sample.mem_bytes, sample.mem_percent)
        )
    return merged


async def collect(run: Runner) -> dict[str, ContainerStats]:
    """Empty dict on failure rather than an exception: losing the numbers is
    worth far less than dimming the pane that carries the container states."""
    result = await run(["docker", "stats", "--no-stream", "--format", "json"])
    if result.returncode != 0:
        return {}
    return parse_stats(result.stdout)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest ops/cc/tests/test_stats.py -v`
Expected: PASS (7 passed)

- [ ] **Step 5: Commit**

```bash
git add ops/cc/collectors/stats.py ops/cc/tests/test_stats.py
git commit -m "Sample container CPU on its own slower clock"
```

---

### Task 5: `collectors/health.py` — sources and alerts

**Files:**
- Create: `ops/cc/collectors/health.py`
- Test: `ops/cc/tests/test_health.py`

**Interfaces:**
- Consumes: `run.CollectorError`.
- Produces:
  - `health.SourceState(name, item_count, seconds_since_success, last_error, key_configured)` with `.severity`
  - `health.Alert(subject, condition, severity, detail, occurrences, last_seen)`
  - `health.SourcesSnapshot(sources: tuple[SourceState, ...], alerts: tuple[Alert, ...])` with `.worst_alert_severity`
  - `health.parse_health(payload: dict) -> SourcesSnapshot`
  - `async health.collect(client: httpx.AsyncClient, base_url: str) -> SourcesSnapshot`

- [ ] **Step 1: Write the failing test**

`ops/cc/tests/test_health.py`:

```python
"""Reading /api/health, whose shape has one trap and one rule worth pinning.

The trap: sources and the `alerts` list share one dict, so a naive walk turns
the alert list into a source named "alerts".

The rule: staleness is decided by backend/mirror.py from each job's
expected_every, and arrives here as last_error. Recomputing it locally would
disagree with the map the first time a six-hourly source polled on schedule.
"""

import asyncio

import httpx

from ops.cc.collectors import health

PAYLOAD = {
    "acled": {"name": "acled", "key_configured": True, "item_count": 4201, "version": 12,
              "last_success": 1000.0, "seconds_since_success": 720, "last_error": None},
    "ais": {"name": "ais", "key_configured": True, "item_count": 0, "version": 3,
            "last_success": 900.0, "seconds_since_success": 2820,
            "last_error": "ingest: aisstream closed the socket"},
    "firms": {"name": "firms", "key_configured": True, "item_count": 9133, "version": 40,
              "last_success": 1700.0, "seconds_since_success": 120, "last_error": None},
    "gfw_gaps": {"name": "gfw_gaps", "key_configured": False, "item_count": 12, "version": 2,
                 "last_success": 800.0, "seconds_since_success": 9000,
                 "last_error": "ingest: no token configured"},
    "cables": {"name": "cables", "key_configured": True, "item_count": 0, "version": 0,
               "last_success": None, "seconds_since_success": None, "last_error": None},
    "alerts": [
        {"subject": "redis", "condition": "evicting", "severity": "critical",
         "detail": "maxmemory reached", "first_seen": 1.0, "last_seen": 2.0, "occurrences": 9},
        {"subject": "refine", "condition": "not producing", "severity": "warning",
         "detail": "no rows in 2h", "first_seen": 1.0, "last_seen": 2.0, "occurrences": 1},
    ],
}


def _by_name(snapshot):
    return {s.name: s for s in snapshot.sources}


def test_alerts_are_not_parsed_as_a_source():
    assert "alerts" not in _by_name(health.parse_health(PAYLOAD))


def test_every_real_source_is_kept():
    assert set(_by_name(health.parse_health(PAYLOAD))) == {
        "acled", "ais", "firms", "gfw_gaps", "cables"
    }


def test_a_source_with_no_error_is_healthy_however_old_it_is():
    """acled polls every six hours; 720 seconds of silence is not a problem,
    and only the backend knows that."""
    assert _by_name(health.parse_health(PAYLOAD))["acled"].severity == "ok"


def test_an_erroring_source_still_serving_rows_is_degraded_not_down():
    assert _by_name(health.parse_health(PAYLOAD))["gfw_gaps"].severity == "warn"


def test_an_erroring_source_serving_nothing_is_down():
    assert _by_name(health.parse_health(PAYLOAD))["ais"].severity == "down"


def test_a_source_that_has_never_polled_is_starting_not_broken():
    """On a cold start every source looks like this for a minute."""
    assert _by_name(health.parse_health(PAYLOAD))["cables"].severity == "starting"


def test_alerts_are_parsed_worst_first():
    snapshot = health.parse_health(PAYLOAD)
    assert [a.severity for a in snapshot.alerts] == ["critical", "warning"]
    assert snapshot.worst_alert_severity == "critical"


def test_no_alerts_means_no_worst():
    assert health.parse_health({"acled": PAYLOAD["acled"]}).worst_alert_severity is None


def test_a_payload_without_an_alerts_key_still_parses():
    """/api/health serves alerts as [] when the table is unreachable, but an
    older backend may not send the key at all."""
    snapshot = health.parse_health({"acled": PAYLOAD["acled"]})
    assert snapshot.alerts == ()
    assert len(snapshot.sources) == 1


def test_collect_reads_the_api():
    def handler(request):
        assert request.url.path == "/api/health"
        return httpx.Response(200, json=PAYLOAD)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    snapshot = asyncio.run(health.collect(client, "http://localhost:8080"))
    assert len(snapshot.sources) == 5


def test_collect_raises_on_a_non_200():
    """A 502 from nginx means the backend is not up. The pane must dim and say
    so, not show an empty source list."""
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(502, text="bad gateway"))
    )
    try:
        asyncio.run(health.collect(client, "http://localhost:8080"))
    except health.CollectorError as exc:
        assert "502" in str(exc)
    else:
        raise AssertionError("a 502 must not read as zero sources")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest ops/cc/tests/test_health.py -v`
Expected: FAIL, `ImportError: cannot import name 'health'`

- [ ] **Step 3: Write `ops/cc/collectors/health.py`**

```python
"""What each source is producing, and what the cache worker is complaining about.

Both come from one call to /api/health (see backend/app.py), which merges the
source registry with the open rows of the alerts table into a single object --
hence the explicit exclusion of the "alerts" key below.

Staleness is not decided here. backend/mirror.py already decides it per source,
from that job's expected_every and INGEST_STALE_MULTIPLIER, and publishes the
verdict as last_error -- the same fact osint_source_up is built from. A second
threshold in this file would disagree with the map and the alerts table the
first time a six-hourly source polled exactly on schedule.
"""

from dataclasses import dataclass

import httpx

from ops.cc.run import CollectorError

_SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2}


@dataclass(frozen=True)
class SourceState:
    name: str
    item_count: int
    seconds_since_success: int | None
    last_error: str | None
    key_configured: bool

    @property
    def severity(self) -> str:
        if self.last_error:
            # Still serving rows means degraded, not dead: the map still shows
            # this layer, it is simply no longer being refreshed.
            return "warn" if self.item_count > 0 else "down"
        if self.seconds_since_success is None:
            # Registered but never polled. Normal for the first minute after a
            # cold start, which is exactly when this dashboard is being watched.
            return "starting"
        return "ok"


@dataclass(frozen=True)
class Alert:
    subject: str
    condition: str
    severity: str
    detail: str
    occurrences: int
    last_seen: float


@dataclass(frozen=True)
class SourcesSnapshot:
    sources: tuple[SourceState, ...] = ()
    alerts: tuple[Alert, ...] = ()

    @property
    def worst_alert_severity(self) -> str | None:
        if not self.alerts:
            return None
        return min(self.alerts, key=lambda a: _SEVERITY_ORDER.get(a.severity, 9)).severity


def parse_health(payload: dict) -> SourcesSnapshot:
    sources = tuple(
        SourceState(
            name=name,
            item_count=int(body.get("item_count") or 0),
            seconds_since_success=body.get("seconds_since_success"),
            last_error=body.get("last_error") or None,
            key_configured=bool(body.get("key_configured")),
        )
        for name, body in payload.items()
        if name != "alerts" and isinstance(body, dict)
    )
    alerts = tuple(
        Alert(
            subject=row.get("subject", "?"),
            condition=row.get("condition", "?"),
            severity=row.get("severity", "info"),
            detail=row.get("detail") or "",
            occurrences=int(row.get("occurrences") or 0),
            last_seen=float(row.get("last_seen") or 0.0),
        )
        for row in payload.get("alerts", [])
        if isinstance(row, dict)
    )
    # The API already orders alerts worst-first; sorting again keeps that true
    # if it ever stops being.
    alerts = tuple(sorted(alerts, key=lambda a: _SEVERITY_ORDER.get(a.severity, 9)))
    return SourcesSnapshot(sources=sources, alerts=alerts)


async def collect(client: httpx.AsyncClient, base_url: str) -> SourcesSnapshot:
    try:
        response = await client.get(f"{base_url}/api/health", timeout=5.0)
    except httpx.HTTPError as exc:
        raise CollectorError(f"{type(exc).__name__}: {exc}") from exc
    if response.status_code != 200:
        raise CollectorError(f"HTTP {response.status_code} from /api/health")
    return parse_health(response.json())
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest ops/cc/tests/test_health.py -v`
Expected: PASS (11 passed)

- [ ] **Step 5: Commit**

```bash
git add ops/cc/collectors/health.py ops/cc/tests/test_health.py
git commit -m "Take the source verdict from the process that knows the schedule"
```

---

### Task 6: `collectors/prom.py` — database and request metrics

**Files:**
- Create: `ops/cc/collectors/prom.py`
- Test: `ops/cc/tests/test_prom.py`

**Interfaces:**
- Consumes: `run.CollectorError`.
- Produces:
  - `prom.INSTANT: dict[str, str]` and `prom.RANGE: dict[str, str]` — metric key to PromQL
  - `prom.MetricSnapshot(values: dict[str, float | None], series: dict[str, tuple[float, ...]])`
  - `prom.parse_instant(payload: dict) -> float | None`
  - `prom.parse_range(payload: dict) -> tuple[float, ...]`
  - `async prom.collect(client: httpx.AsyncClient, base_url: str) -> MetricSnapshot`

- [ ] **Step 1: Write the failing test**

`ops/cc/tests/test_prom.py`:

```python
"""The half-dozen numbers worth glancing at, and the ways Prometheus says no.

Every metric name queried here already appears in monitoring/grafana/dashboards
or monitoring/postgres-exporter/queries.yaml -- the test at the bottom is what
keeps that true, because a renamed metric is invisible until the pane is blank.
"""

import asyncio
import json
import pathlib

import httpx

from ops.cc.collectors import prom

ROOT = pathlib.Path(__file__).resolve().parents[3]

INSTANT_OK = {"status": "success",
              "data": {"resultType": "vector",
                       "result": [{"metric": {}, "value": [1754800000, "8123456789"]}]}}
INSTANT_EMPTY = {"status": "success", "data": {"resultType": "vector", "result": []}}
INSTANT_ERROR = {"status": "error", "errorType": "bad_data", "error": "parse error"}
RANGE_OK = {"status": "success",
            "data": {"resultType": "matrix",
                     "result": [{"metric": {},
                                 "values": [[1, "0.5"], [2, "1.5"], [3, "2.0"]]}]}}


def test_reads_the_scalar_out_of_a_vector():
    assert prom.parse_instant(INSTANT_OK) == 8123456789.0


def test_an_empty_result_is_none_not_zero():
    """postgres-exporter briefly has no samples after a restart. Zero
    connections and "not measured yet" must not render identically."""
    assert prom.parse_instant(INSTANT_EMPTY) is None


def test_a_query_error_is_none():
    assert prom.parse_instant(INSTANT_ERROR) is None


def test_a_nan_sample_is_none():
    payload = {"status": "success", "data": {"resultType": "vector",
               "result": [{"metric": {}, "value": [1, "NaN"]}]}}
    assert prom.parse_instant(payload) is None


def test_range_returns_the_samples_in_order():
    assert prom.parse_range(RANGE_OK) == (0.5, 1.5, 2.0)


def test_an_empty_range_is_an_empty_tuple():
    assert prom.parse_range({"status": "success",
                             "data": {"resultType": "matrix", "result": []}}) == ()


def test_collect_queries_every_documented_metric():
    asked = []

    def handler(request):
        asked.append(request.url.params.get("query"))
        if request.url.path.endswith("query_range"):
            return httpx.Response(200, json=RANGE_OK)
        return httpx.Response(200, json=INSTANT_OK)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    snapshot = asyncio.run(prom.collect(client, "http://localhost:9090"))

    assert set(snapshot.values) == set(prom.INSTANT)
    assert set(snapshot.series) == set(prom.RANGE)
    assert set(asked) == set(prom.INSTANT.values()) | set(prom.RANGE.values())


def test_collect_raises_when_prometheus_is_unreachable():
    """Prometheus being down is an expected state -- it is the normal one before
    `s` is pressed -- but it is the supervisor that turns it into `unreachable`,
    not a snapshot full of Nones that reads like a measured stack at rest."""
    def handler(request):
        raise httpx.ConnectError("connection refused")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        asyncio.run(prom.collect(client, "http://localhost:9090"))
    except prom.CollectorError:
        pass
    else:
        raise AssertionError("an unreachable Prometheus must not read as measured zeros")


def test_one_failing_query_does_not_lose_the_others():
    def handler(request):
        if "pg_database_size_bytes" in (request.url.params.get("query") or ""):
            return httpx.Response(422, json=INSTANT_ERROR)
        if request.url.path.endswith("query_range"):
            return httpx.Response(200, json=RANGE_OK)
        return httpx.Response(200, json=INSTANT_OK)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    snapshot = asyncio.run(prom.collect(client, "http://localhost:9090"))
    assert snapshot.values["db_size"] is None
    assert snapshot.values["connections"] == 8123456789.0


def test_every_queried_metric_name_exists_in_the_monitoring_config():
    """A metric this pane invents is one that silently never renders."""
    corpus = "\n".join(
        path.read_text(encoding="utf-8")
        for path in [
            *(ROOT / "monitoring" / "grafana" / "dashboards").glob("*.json"),
            ROOT / "monitoring" / "postgres-exporter" / "queries.yaml",
        ]
    )
    for name in prom.METRIC_NAMES:
        assert name in corpus, f"{name} is not produced by anything in monitoring/"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest ops/cc/tests/test_prom.py -v`
Expected: FAIL, `ImportError: cannot import name 'prom'`

- [ ] **Step 3: Write `ops/cc/collectors/prom.py`**

```python
"""The six numbers the host pane shows, read from Prometheus.

The set is fixed here rather than configurable: a dashboard whose contents come
from a config file is a worse Grafana, and Grafana is one keypress away.

Application metrics come through Prometheus rather than from the backend
directly because backend:8000/metrics is deliberately not published to the host
(see backend/app.py) -- Prometheus reaches it over the compose network, and this
tool reads what Prometheus already scraped.
"""

import asyncio
import math
import time
from dataclasses import dataclass, field

import httpx

from ops.cc.run import CollectorError

INSTANT = {
    "db_size": 'pg_database_size_bytes{datname="osint"}',
    "connections": "pg_connection_budget_used",
    "connection_limit": "pg_connection_budget_limit_ordinary",
    "oldest_transaction": "pg_long_running_max_transaction_seconds",
    "scrapes_up": "sum(up)",
    "scrapes_total": "count(up)",
    "alerts_active": "sum(osint_alerts_active)",
}

RANGE = {
    "request_rate": "sum(rate(osint_http_requests_total[5m]))",
}

# Bare metric names, for the test that proves nothing here was invented.
METRIC_NAMES = (
    "pg_database_size_bytes",
    "pg_connection_budget_used",
    "pg_connection_budget_limit_ordinary",
    "pg_long_running_max_transaction_seconds",
    "osint_alerts_active",
    "osint_http_requests_total",
)

# 15 minutes at 30s steps: 30 samples, which is more than the ~8 cells a
# sparkline occupies, so spark() downsamples rather than interpolating.
_RANGE_SECONDS = 900
_RANGE_STEP = 30


@dataclass(frozen=True)
class MetricSnapshot:
    values: dict[str, float | None] = field(default_factory=dict)
    series: dict[str, tuple[float, ...]] = field(default_factory=dict)


def _sample(raw: str) -> float | None:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    # Prometheus renders absent-but-defined as NaN; a NaN drawn as 0 in a
    # sparkline is a dip that never happened.
    return None if math.isnan(value) else value


def parse_instant(payload: dict) -> float | None:
    if payload.get("status") != "success":
        return None
    result = payload.get("data", {}).get("result") or []
    if not result:
        return None
    return _sample(result[0].get("value", [None, None])[1])


def parse_range(payload: dict) -> tuple[float, ...]:
    if payload.get("status") != "success":
        return ()
    result = payload.get("data", {}).get("result") or []
    if not result:
        return ()
    samples = (_sample(point[1]) for point in result[0].get("values", []))
    return tuple(value for value in samples if value is not None)


async def _get(client: httpx.AsyncClient, url: str, params: dict) -> dict | None:
    """None on anything that is not a well-formed 200. One failing query must
    not cost the other six."""
    try:
        response = await client.get(url, params=params, timeout=5.0)
    except httpx.HTTPError as exc:
        raise CollectorError(f"{type(exc).__name__}: {exc}") from exc
    if response.status_code != 200:
        return None
    try:
        return response.json()
    except ValueError:
        return None


async def collect(client: httpx.AsyncClient, base_url: str) -> MetricSnapshot:
    end = time.time()
    instant_results = await asyncio.gather(*[
        _get(client, f"{base_url}/api/v1/query", {"query": query})
        for query in INSTANT.values()
    ])
    range_results = await asyncio.gather(*[
        _get(client, f"{base_url}/api/v1/query_range",
             {"query": query, "start": end - _RANGE_SECONDS, "end": end, "step": _RANGE_STEP})
        for query in RANGE.values()
    ])

    return MetricSnapshot(
        values={
            key: (parse_instant(payload) if payload else None)
            for key, payload in zip(INSTANT, instant_results)
        },
        series={
            key: (parse_range(payload) if payload else ())
            for key, payload in zip(RANGE, range_results)
        },
    )
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest ops/cc/tests/test_prom.py -v`
Expected: PASS (10 passed)

- [ ] **Step 5: Commit**

```bash
git add ops/cc/collectors/prom.py ops/cc/tests/test_prom.py
git commit -m "Ask Prometheus the six questions worth a glance"
```

---

### Task 7: `collectors/host.py` — machine load

**Files:**
- Create: `ops/cc/collectors/host.py`
- Test: `ops/cc/tests/test_host.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `host.HostSnapshot(cpu_percent, mem_percent, disk_percent, load1, hostname)`
  - `async host.collect(psutil_module=psutil, disk_path="/") -> HostSnapshot`

- [ ] **Step 1: Write the failing test**

`ops/cc/tests/test_host.py`:

```python
"""The machine's own numbers. Thin, but the non-blocking bit matters.

psutil.cpu_percent(interval=...) sleeps; called from the event loop it freezes
every other pane for the duration. This collector must use the non-blocking
form, which is what the fake below proves.
"""

import asyncio
import types

from ops.cc.collectors import host


def _fake_psutil(**overrides):
    calls = {}

    def cpu_percent(interval=None):
        calls["cpu_interval"] = interval
        return overrides.get("cpu", 34.2)

    fake = types.SimpleNamespace(
        cpu_percent=cpu_percent,
        virtual_memory=lambda: types.SimpleNamespace(percent=overrides.get("mem", 61.0)),
        disk_usage=lambda path: types.SimpleNamespace(percent=overrides.get("disk", 44.0)),
        getloadavg=lambda: (overrides.get("load", 1.25), 1.0, 0.9),
    )
    return fake, calls


def test_reads_the_four_numbers():
    fake, _ = _fake_psutil()
    snapshot = asyncio.run(host.collect(fake))
    assert (snapshot.cpu_percent, snapshot.mem_percent, snapshot.disk_percent, snapshot.load1) == (
        34.2, 61.0, 44.0, 1.25
    )


def test_cpu_is_sampled_without_blocking_the_event_loop():
    fake, calls = _fake_psutil()
    asyncio.run(host.collect(fake))
    assert calls["cpu_interval"] is None, "interval= sleeps, and freezes every other pane"


def test_a_missing_loadavg_is_none_rather_than_a_crash():
    """getloadavg exists on Linux; the tool should still start elsewhere."""
    fake, _ = _fake_psutil()
    fake.getloadavg = lambda: (_ for _ in ()).throw(OSError("not supported"))
    assert asyncio.run(host.collect(fake)).load1 is None


def test_the_hostname_is_reported_for_the_header():
    assert asyncio.run(host.collect(_fake_psutil()[0])).hostname
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest ops/cc/tests/test_host.py -v`
Expected: FAIL, `ImportError: cannot import name 'host'`

- [ ] **Step 3: Write `ops/cc/collectors/host.py`**

```python
"""CPU, memory, disk and load for the box itself.

Database size is not here: it comes from Prometheus (see collectors/prom.py),
because reading the pgdata volume off the filesystem means reading under
/var/lib/docker/volumes, which needs root -- and cc runs as an ordinary user in
the docker group.
"""

import socket
from dataclasses import dataclass

import psutil


@dataclass(frozen=True)
class HostSnapshot:
    cpu_percent: float
    mem_percent: float
    disk_percent: float
    load1: float | None
    hostname: str


async def collect(psutil_module=psutil, disk_path: str = "/") -> HostSnapshot:
    # interval=None returns the usage since the previous call rather than
    # sleeping to measure a fresh window. The first call is meaningless and the
    # rest are exactly the 5s window this collector runs on.
    cpu = psutil_module.cpu_percent(interval=None)
    try:
        load1 = psutil_module.getloadavg()[0]
    except (OSError, AttributeError):
        load1 = None
    return HostSnapshot(
        cpu_percent=cpu,
        mem_percent=psutil_module.virtual_memory().percent,
        disk_percent=psutil_module.disk_usage(disk_path).percent,
        load1=load1,
        hostname=socket.gethostname(),
    )
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest ops/cc/tests/test_host.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add ops/cc/collectors/host.py ops/cc/tests/test_host.py
git commit -m "Read the box without sleeping in the event loop"
```

---

### Task 8: `collectors/logs.py` — the log stream

**Files:**
- Create: `ops/cc/collectors/logs.py`
- Test: `ops/cc/tests/test_logs.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `logs.LogLine(service, text, level)`
  - `logs.parse_line(raw: str) -> LogLine`
  - `logs.argv(service: str | None, tail: int = 200) -> list[str]`
  - `logs.backoff(attempt: int) -> float`
  - `async logs.stream(cwd, on_line, *, service=None, sleep=asyncio.sleep) -> None`

- [ ] **Step 1: Write the failing test**

`ops/cc/tests/test_logs.py`:

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest ops/cc/tests/test_logs.py -v`
Expected: FAIL, `ImportError: cannot import name 'logs'`

- [ ] **Step 3: Write `ops/cc/collectors/logs.py`**

```python
"""The live log, from `docker compose logs -f`.

The only streaming collector: it holds a subprocess open rather than being
polled, and restarts with backoff when that subprocess exits -- which happens
every time the stack is stopped, and is a normal state rather than a fault.
"""

import asyncio
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

_PREFIX = re.compile(r"^(?P<service>[A-Za-z0-9][A-Za-z0-9_.-]*)\s+\|\s?(?P<text>.*)$")

# Word boundaries on both sides: "0 errors" and "error_rate" are log lines from
# a healthy backend, and colouring them red trains you to ignore the colour.
_ERROR = re.compile(r"\b(error|critical|fatal|exception|traceback)\b", re.IGNORECASE)
_WARN = re.compile(r"\b(warn|warning)\b", re.IGNORECASE)

_MAX_BACKOFF = 30.0


@dataclass(frozen=True)
class LogLine:
    service: str
    text: str
    level: str  # "error" | "warn" | "info"


def parse_line(raw: str) -> LogLine:
    line = raw.rstrip("\n")
    match = _PREFIX.match(line)
    service, text = (match.group("service"), match.group("text")) if match else ("", line.strip())

    if _ERROR.search(text):
        level = "error"
    elif _WARN.search(text):
        level = "warn"
    else:
        level = "info"
    return LogLine(service=service, text=text, level=level)


def argv(service: str | None, tail: int = 200) -> list[str]:
    """--no-color because compose's own ANSI codes would fight the theme's."""
    command = ["docker", "compose", "logs", "--follow", "--no-color", "--tail", str(tail)]
    if service:
        command.append(service)
    return command


def backoff(attempt: int) -> float:
    """1, 2, 4 ... capped. Uncapped, a stack left down overnight would take
    hours to notice it came back."""
    return min(2.0**attempt, _MAX_BACKOFF)


async def stream(
    cwd: Path,
    on_line: Callable[[LogLine], None],
    *,
    service: str | None = None,
    sleep=asyncio.sleep,
) -> None:
    """Follow the log forever, restarting the subprocess when it exits.

    Never returns. Cancel the task to stop it -- which is what the app does when
    the log pane is rescoped to a different service.
    """
    attempt = 0
    while True:
        process = await asyncio.create_subprocess_exec(
            *argv(service),
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        assert process.stdout is not None
        saw_output = False
        async for raw in process.stdout:
            saw_output = True
            on_line(parse_line(raw.decode("utf-8", "replace")))
        await process.wait()

        # A stream that produced something before dying is a stack that went
        # down, not a broken command: start the backoff over so the first
        # reconnect after `s` is immediate.
        attempt = 0 if saw_output else attempt + 1
        await sleep(backoff(attempt))
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest ops/cc/tests/test_logs.py -v`
Expected: PASS (9 passed)

- [ ] **Step 5: Commit**

```bash
git add ops/cc/collectors/logs.py ops/cc/tests/test_logs.py
git commit -m "Follow the log, and treat a stopped stack as a pause not a fault"
```

---

### Task 9: `actions.py` — the mutating keys

**Files:**
- Create: `ops/cc/actions.py`
- Test: `ops/cc/tests/test_actions.py`

**Interfaces:**
- Consumes: `run.Runner`.
- Produces:
  - `actions.Action(key, label, needs_selection: bool, confirm: str | None, confirm_word: str | None)`
  - `actions.ACTIONS: dict[str, Action]`
  - `actions.argv_for(key: str, selected: str | None) -> list[str]`
  - `actions.is_allowed(key: str, *, read_only: bool) -> bool`
  - `actions.confirm_for(key: str, selected: str | None) -> tuple[str | None, str | None]` — `(prompt, required_word)`
  - `async actions.execute(key, *, selected, read_only, run: Runner) -> int`

- [ ] **Step 1: Write the failing test**

`ops/cc/tests/test_actions.py`:

```python
"""The five keys that change something, and the guards on the two that cost.

`D` re-polls every metered source (ACLED, FIRMS, ADS-B, AIS, Overpass, GFW), so
it is the one key in the program that spends money. Everything here exists to
make that key hard to press by accident and every other key easy.
"""

import asyncio

import pytest

from ops.cc import actions
from ops.cc.run import CommandResult


def _recorder():
    seen = []

    async def fake_run(argv):
        seen.append(list(argv))
        return CommandResult(tuple(argv), 0, "", "")

    return fake_run, seen


def test_the_argv_for_every_key():
    assert actions.argv_for("s", None) == ["docker", "compose", "up", "-d"]
    assert actions.argv_for("x", None) == ["docker", "compose", "stop"]
    assert actions.argv_for("r", "backend") == ["docker", "compose", "restart", "backend"]
    assert actions.argv_for("d", None) == ["./deploy.sh"]
    assert actions.argv_for("D", None) == ["./deploy.sh", "--ingest"]


def test_rebuilds_shell_out_rather_than_reimplementing_staleness():
    """deploy.sh decides which images are behind their source. A second
    implementation here would be a second answer to that question."""
    assert actions.argv_for("d", None)[0].endswith("deploy.sh")


def test_restart_without_a_selection_is_refused():
    with pytest.raises(ValueError):
        actions.argv_for("r", None)


def test_stopping_asks_first():
    prompt, word = actions.confirm_for("x", None)
    assert prompt and word is None


def test_restarting_ingest_asks_where_restarting_refine_does_not():
    assert actions.confirm_for("r", "refine") == (None, None)
    prompt, word = actions.confirm_for("r", "ingest")
    assert prompt and "ingest" in prompt


def test_rebuilding_ingest_demands_a_typed_word():
    prompt, word = actions.confirm_for("D", None)
    assert word == "INGEST"
    assert "metered" in prompt.lower() or "quota" in prompt.lower()


def test_a_plain_rebuild_does_not_ask():
    assert actions.confirm_for("d", None) == (None, None)


def test_read_only_refuses_every_mutating_key():
    for key in ("s", "x", "r", "d", "D"):
        assert actions.is_allowed(key, read_only=True) is False
        assert actions.is_allowed(key, read_only=False) is True


def test_execute_runs_nothing_at_all_in_read_only():
    fake_run, seen = _recorder()
    with pytest.raises(PermissionError):
        asyncio.run(actions.execute("D", selected=None, read_only=True, run=fake_run))
    assert seen == [], "read-only must refuse before the subprocess, not after"


def test_execute_returns_the_exit_code():
    async def failing(argv):
        return CommandResult(tuple(argv), 2, "", "compose said no")

    assert asyncio.run(
        actions.execute("s", selected=None, read_only=False, run=failing)
    ) == 2


def test_every_action_has_a_footer_label():
    assert set(actions.ACTIONS) == {"s", "x", "r", "d", "D"}
    for action in actions.ACTIONS.values():
        assert action.label
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest ops/cc/tests/test_actions.py -v`
Expected: FAIL, `ImportError: cannot import name 'actions'`

- [ ] **Step 3: Write `ops/cc/actions.py`**

```python
"""Everything the dashboard can change, and what it asks before changing it.

One table rather than five key handlers, so the guards cannot drift from the
commands they guard -- and so the read-only check happens in one place that is
impossible to route around.

Rebuilds shell out to deploy.sh. It decides which images are behind their source
by comparing image build times against file mtimes; a second implementation here
would be a second answer to the same question, and the two would disagree the
first time one of them was edited.
"""

from collections.abc import Sequence
from dataclasses import dataclass

from ops.cc.run import Runner

# Restarting ingest re-polls every metered source, so both keys that touch it
# ask first -- one plainly, one by making you type the word.
_INGEST_COST = (
    "Rebuilding ingest re-polls every metered source (ACLED, FIRMS, ADS-B, AIS, "
    "Overpass, GFW) and spends real quota."
)


@dataclass(frozen=True)
class Action:
    key: str
    label: str
    argv: tuple[str, ...]
    needs_selection: bool = False
    confirm: str | None = None
    confirm_word: str | None = None


ACTIONS = {
    "s": Action("s", "up", ("docker", "compose", "up", "-d")),
    "x": Action("x", "stop", ("docker", "compose", "stop"),
                confirm="Stop the whole stack? Collection pauses until it is started again."),
    "r": Action("r", "restart", ("docker", "compose", "restart"), needs_selection=True),
    "d": Action("d", "deploy", ("./deploy.sh",)),
    "D": Action("D", "deploy+ingest", ("./deploy.sh", "--ingest"),
                confirm=_INGEST_COST, confirm_word="INGEST"),
}


def argv_for(key: str, selected: str | None) -> list[str]:
    action = ACTIONS[key]
    if action.needs_selection:
        if not selected:
            raise ValueError(f"{action.label} needs a selected service")
        return [*action.argv, selected]
    return list(action.argv)


def confirm_for(key: str, selected: str | None) -> tuple[str | None, str | None]:
    """(prompt, required word). Both None when the key just runs."""
    action = ACTIONS[key]
    if key == "r" and selected == "ingest":
        # Not in the table, because it depends on what is selected: restarting
        # refine costs nothing, restarting ingest costs the quota.
        return (f"Restart ingest? {_INGEST_COST}", None)
    return (action.confirm, action.confirm_word)


def is_allowed(key: str, *, read_only: bool) -> bool:
    return key in ACTIONS and not read_only


async def execute(key: str, *, selected: str | None, read_only: bool, run: Runner) -> int:
    """Run the action and return its exit code.

    Raises PermissionError under --read-only before touching the runner: a
    read-only mode that refuses after spawning the process is not one.
    """
    if not is_allowed(key, read_only=read_only):
        raise PermissionError(f"{key} is disabled in read-only mode")
    result = await run(argv_for(key, selected))
    return result.returncode


def footer(read_only: bool) -> Sequence[tuple[str, str, bool]]:
    """(key, label, enabled) for the footer, in the documented order."""
    return [(a.key, a.label, not read_only) for a in ACTIONS.values()]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest ops/cc/tests/test_actions.py -v`
Expected: PASS (11 passed)

- [ ] **Step 5: Commit**

```bash
git add ops/cc/actions.py ops/cc/tests/test_actions.py
git commit -m "Make the one key that spends money hard to press by accident"
```

---

### Task 10: `spark.py` — sparkline rendering

**Files:**
- Create: `ops/cc/spark.py`
- Test: `ops/cc/tests/test_spark.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `spark.spark(values: Sequence[float], width: int = 8) -> str`

- [ ] **Step 1: Write the failing test**

`ops/cc/tests/test_spark.py`:

```python
"""Eight cells of history. Small, and wrong in interesting ways if unguarded."""

from ops.cc.spark import BLOCKS, spark


def test_renders_one_cell_per_requested_column():
    assert len(spark([1, 2, 3, 4, 5, 6, 7, 8], width=8)) == 8


def test_downsamples_a_longer_series_to_the_width():
    assert len(spark(list(range(30)), width=8)) == 8


def test_a_shorter_series_is_left_padded_with_blanks():
    """Right-aligned, because the newest sample must always be the last cell --
    a series that grows leftward makes "now" move around the pane."""
    rendered = spark([1, 2, 3], width=8)
    assert rendered.startswith(" " * 5)
    assert rendered[-1] == BLOCKS[-1]


def test_no_samples_renders_as_blanks_not_a_flat_line():
    """A flat line at the bottom says "measured, and it was zero"."""
    assert spark([], width=8) == " " * 8


def test_a_flat_series_renders_at_the_bottom_not_at_the_top():
    """max == min: dividing by the range would be a crash, and rendering full
    blocks would make an idle backend look saturated."""
    assert spark([4.0] * 8, width=8) == BLOCKS[0] * 8


def test_the_largest_sample_is_the_tallest_block():
    assert spark([0, 10], width=2) == BLOCKS[0] + BLOCKS[-1]


def test_negative_values_do_not_escape_the_block_range():
    rendered = spark([-5, 0, 5], width=3)
    assert all(char in BLOCKS for char in rendered)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest ops/cc/tests/test_spark.py -v`
Expected: FAIL, `ModuleNotFoundError: No module named 'ops.cc.spark'`

- [ ] **Step 3: Write `ops/cc/spark.py`**

```python
"""A sparkline in eight characters.

Scaled to the series' own range rather than to an absolute one: these are trend
cells, not gauges, and the number beside them carries the magnitude.
"""

from collections.abc import Sequence

BLOCKS = "▁▂▃▄▅▆▇█"


def spark(values: Sequence[float], width: int = 8) -> str:
    if not values:
        # Blanks, not a flat line: an empty series means "not measured", and a
        # row of ▁ says "measured, and it was zero".
        return " " * width

    samples = list(values)
    if len(samples) > width:
        # Take the last `width` buckets' means, so the newest sample is always
        # in the last cell.
        size = len(samples) / width
        samples = [
            sum(samples[int(i * size):int((i + 1) * size)] or [0])
            / max(1, len(samples[int(i * size):int((i + 1) * size)]))
            for i in range(width)
        ]

    low, high = min(samples), max(samples)
    span = high - low
    if span == 0:
        cells = BLOCKS[0] * len(samples)
    else:
        cells = "".join(
            BLOCKS[min(len(BLOCKS) - 1, int((value - low) / span * len(BLOCKS)))]
            for value in samples
        )
    return cells.rjust(width)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest ops/cc/tests/test_spark.py -v`
Expected: PASS (7 passed)

- [ ] **Step 5: Commit**

```bash
git add ops/cc/spark.py ops/cc/tests/test_spark.py
git commit -m "Draw eight cells of history without claiming a zero"
```

---

### Task 11: The four panes

**Files:**
- Create: `ops/cc/widgets/services.py`, `ops/cc/widgets/sources.py`, `ops/cc/widgets/host.py`, `ops/cc/widgets/logs.py`
- Test: `ops/cc/tests/test_app.py` (rendering rows; the app itself is Task 12)

**Interfaces:**
- Consumes: `state.Reading`, `theme.GLYPH`, `theme.severity_style`, `compose.ServiceState`, `health.SourcesSnapshot`, `prom.MetricSnapshot`, `host.HostSnapshot`, `spark.spark`, `logs.LogLine`.
- Produces:
  - `widgets.services.ServicesPane(Static)` with `.update_from(reading: Reading, now: float)` and `.selected -> str | None`
  - `widgets.services.service_row(service) -> tuple[str, str, str, str]` — pure, `(glyph, name, status, usage)`
  - `widgets.sources.SourcesPane(Static)` with `.update_from(reading, now)`; `widgets.sources.source_row(source) -> tuple[str, str, str, str]`
  - `widgets.host.HostPane(Static)` with `.update_from(host_reading, metrics_reading, now)`; `widgets.host.format_bytes(n) -> str`; `widgets.host.host_lines(host_snapshot, metric_snapshot) -> list[str]`
  - `widgets.logs.LogPane(RichLog)` with `.append(line: LogLine)`, `.set_filter(text: str)`, `.set_frozen(bool)`, `.matches(line) -> bool`

- [ ] **Step 1: Write the failing tests for the pure row builders**

Append to `ops/cc/tests/test_app.py` (create the file):

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest ops/cc/tests/test_app.py -v`
Expected: FAIL, `ModuleNotFoundError: No module named 'ops.cc.widgets.services'`

- [ ] **Step 3: Write `ops/cc/widgets/services.py`**

```python
"""The SERVICES pane: what is running, and what keeps dying."""

from textual.widgets import DataTable

from ops.cc.collectors.compose import ServiceState
from ops.cc.state import Reading
from ops.cc.theme import GLYPH, severity_style


def service_row(service: ServiceState) -> tuple[str, str, str, str]:
    """(glyph, name, status, usage). Pure, so the interesting cases are unit
    tests rather than snapshots."""
    status = service.health or service.state
    if service.state == "exited":
        status = f"exited ({service.exit_code})"
    if service.restarts:
        status = f"{status} ×{service.restarts}"

    usage = ""
    if service.cpu_percent is not None:
        # Blank rather than 0.0% when docker stats has not reported this
        # container: an unmeasured value must not look like a measured idle one.
        megabytes = f" {service.mem_bytes // (1024 * 1024)}M" if service.mem_bytes else ""
        usage = f"{service.cpu_percent:.1f}%{megabytes}"

    return (GLYPH[service.severity], service.service, status, usage)


class ServicesPane(DataTable):
    BORDER_TITLE = "SERVICES"

    def on_mount(self) -> None:
        self.cursor_type = "row"
        self.show_header = False
        self.add_columns(" ", "service", "status", "usage")

    @property
    def selected(self) -> str | None:
        if self.row_count == 0:
            return None
        row = self.get_row_at(self.cursor_row)
        return str(row[1])

    def update_from(self, reading: Reading, now: float) -> None:
        services: list[ServiceState] = reading.value or []
        keep = self.cursor_row
        self.clear()
        for service in services:
            glyph, name, status, usage = service_row(service)
            style = severity_style(service.severity)
            self.add_row(f"[{style}]{glyph}[/]", name, status, usage)
        if keep < self.row_count:
            self.move_cursor(row=keep)
        # Dimming a pane whose collector is failing is the app's job (see
        # app.py); the rows themselves stay exactly as they last were.
```

- [ ] **Step 4: Write `ops/cc/widgets/sources.py`**

```python
"""The SOURCES pane: what is being collected, and what has stopped."""

from textual.widgets import DataTable

from ops.cc.collectors.health import SourcesSnapshot, SourceState
from ops.cc.state import Reading
from ops.cc.theme import GLYPH, severity_style


def _ago(seconds: int | None) -> str:
    if seconds is None:
        return "never"
    if seconds < 90:
        return f"{seconds}s ago"
    if seconds < 5400:
        return f"{seconds // 60}m ago"
    return f"{seconds // 3600}h ago"


def source_row(source: SourceState) -> tuple[str, str, str, str]:
    """(glyph, name, items, detail)."""
    items = f"{source.item_count:,}" if source.item_count else "—"
    # An error displaces the age: how long ago a dead source last worked is the
    # least useful thing about it, and the reason it died is the most.
    detail = source.last_error if source.last_error else _ago(source.seconds_since_success)
    return (GLYPH[source.severity], source.name, items, detail)


class SourcesPane(DataTable):
    BORDER_TITLE = "SOURCES"

    def on_mount(self) -> None:
        self.cursor_type = "row"
        self.show_header = False
        self.add_columns(" ", "source", "items", "detail")

    @property
    def selected(self) -> str | None:
        if self.row_count == 0:
            return None
        return str(self.get_row_at(self.cursor_row)[1])

    def update_from(self, reading: Reading, now: float) -> None:
        snapshot: SourcesSnapshot = reading.value or SourcesSnapshot()
        keep = self.cursor_row
        self.clear()
        for source in sorted(snapshot.sources, key=lambda s: s.name):
            glyph, name, items, detail = source_row(source)
            self.add_row(f"[{severity_style(source.severity)}]{glyph}[/]", name, items, detail)
        for alert in snapshot.alerts:
            # Alerts sit in the same list rather than a pane of their own: they
            # are almost always about a source, and a separate pane for two rows
            # would cost a quarter of the screen to say nothing most days.
            style = severity_style("down" if alert.severity == "critical" else "warn")
            self.add_row(
                f"[{style}]{GLYPH['warn']}[/]", alert.subject, "", f"{alert.condition}: {alert.detail}"
            )
        if keep < self.row_count:
            self.move_cursor(row=keep)
```

- [ ] **Step 5: Write `ops/cc/widgets/host.py`**

```python
"""The HOST pane: the box, and the six database numbers worth a glance."""

from textual.widgets import Static

from ops.cc.collectors.host import HostSnapshot
from ops.cc.collectors.prom import MetricSnapshot
from ops.cc.spark import spark
from ops.cc.state import Reading

_SUFFIXES = ("B", "K", "M", "G", "T")


def format_bytes(count: int | float | None) -> str:
    """Short enough for a status line. `—` for unmeasured, never `0B`."""
    if count is None:
        return "—"
    value = float(count)
    for suffix in _SUFFIXES:
        if value < 1024 or suffix == _SUFFIXES[-1]:
            if suffix == "B" or value >= 100:
                return f"{value:.0f}{suffix}"
            return f"{value:.1f}{suffix}"
        value /= 1024
    return f"{value:.0f}T"


def _number(value: float | None, fmt: str = "{:.0f}") -> str:
    return "—" if value is None else fmt.format(value)


def host_lines(host: HostSnapshot | None, metrics: MetricSnapshot | None) -> list[str]:
    """Two lines: the machine, then the database. Either half renders when the
    other's collector is failing."""
    metrics = metrics or MetricSnapshot()
    values = metrics.values

    if host is None:
        machine = "cpu — mem — disk —"
    else:
        machine = (
            f"cpu {spark(metrics.series.get('request_rate', ()))} {host.cpu_percent:.0f}%   "
            f"mem {host.mem_percent:.0f}%   disk {host.disk_percent:.0f}%   "
            f"load {_number(host.load1, '{:.2f}')}"
        )

    database = (
        f"db {format_bytes(values.get('db_size'))}   "
        f"conn {_number(values.get('connections'))}/{_number(values.get('connection_limit'))}   "
        f"oldest xact {_number(values.get('oldest_transaction'), '{:.0f}')}s   "
        f"scrape {_number(values.get('scrapes_up'))}/{_number(values.get('scrapes_total'))} up"
    )
    return [machine, database]


class HostPane(Static):
    BORDER_TITLE = "HOST"

    def update_from(self, host: Reading, metrics: Reading, now: float) -> None:
        lines = host_lines(host.value, metrics.value)
        if not metrics.ok and metrics.updated_at == 0.0:
            # Before the stack is up, Prometheus is simply not there yet. Saying
            # so beats a line of dashes that looks like a measurement failure.
            lines.append("[$cc-muted]prometheus unreachable — press s to start the stack[/]")
        self.update("\n".join(lines))
```

- [ ] **Step 6: Write `ops/cc/widgets/logs.py`**

```python
"""The LOGS pane: the reason for watching rather than polling."""

from rich.text import Text
from textual.widgets import RichLog

from ops.cc.collectors.logs import LogLine
from ops.cc.theme import severity_style

_LEVEL_STYLE = {"error": severity_style("down"), "warn": severity_style("warn"), "info": ""}


class LogPane(RichLog):
    BORDER_TITLE = "LOGS"

    def __init__(self, **kwargs) -> None:
        super().__init__(wrap=False, markup=False, max_lines=2000, **kwargs)
        self._filter = ""
        self._frozen = False

    def set_filter(self, text: str) -> None:
        self._filter = text.lower()

    def set_frozen(self, frozen: bool) -> None:
        # Freezing stops the auto-scroll, not the collection: lines still
        # arrive, so releasing it catches up instead of showing a gap.
        self._frozen = frozen
        self.auto_scroll = not frozen

    def matches(self, line: LogLine) -> bool:
        return self._filter in line.text.lower() or self._filter in line.service.lower()

    def append(self, line: LogLine) -> None:
        if not self.matches(line):
            return
        text = Text(f"{line.service:<12} {line.text}")
        style = _LEVEL_STYLE[line.level]
        if style:
            text.stylize(style)
        self.write(text)
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `python -m pytest ops/cc/tests/test_app.py -v`
Expected: PASS (11 passed)

- [ ] **Step 8: Commit**

```bash
git add ops/cc/widgets ops/cc/tests/test_app.py
git commit -m "Give every pane a row builder that refuses to invent a zero"
```

---

### Task 12: `app.py` and `__main__.py` — the running program

**Files:**
- Create: `ops/cc/app.py`, `ops/cc/__main__.py`
- Modify: `ops/cc/tests/test_app.py` (append the supervision and CLI tests)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `app.CommandCenter(Textual App)` with `__init__(compose_dir: Path, *, read_only=False, theme_name="claude-dark", api_url=..., prom_url=...)`
  - `app.supervise(collect, apply, interval, *, now, sleep) -> None` — the one collector-supervision loop
  - `__main__.parse_args(argv: list[str]) -> argparse.Namespace`

- [ ] **Step 1: Write the failing tests**

Append to `ops/cc/tests/test_app.py`:

```python
import asyncio

import pytest

from ops.cc import __main__ as cli
from ops.cc.app import supervise
from ops.cc.run import CollectorError
from ops.cc.state import Reading


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


def test_read_only_is_off_by_default():
    assert cli.parse_args([]).read_only is False


def test_read_only_flag():
    assert cli.parse_args(["--read-only"]).read_only is True


def test_the_default_compose_dir_is_the_deployment_path():
    assert str(cli.parse_args([]).compose_dir) == "/opt/osint"


def test_the_compose_dir_is_overridable_for_a_checkout():
    assert str(cli.parse_args(["--compose-dir", "/home/me/osint"]).compose_dir) == "/home/me/osint"


def test_the_theme_choices_are_the_two_that_exist():
    assert cli.parse_args([]).theme == "claude-dark"
    assert cli.parse_args(["--light"]).theme == "claude-light"


def test_the_api_and_prometheus_urls_are_the_published_ports():
    args = cli.parse_args([])
    assert args.api_url == "http://localhost:8080"
    assert args.prom_url == "http://localhost:9090"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest ops/cc/tests/test_app.py -v`
Expected: FAIL, `ModuleNotFoundError: No module named 'ops.cc.app'`

- [ ] **Step 3: Write `ops/cc/app.py`**

```python
"""The four panes, the keys, and the supervision that keeps them all updating.

`supervise` is the whole error policy in one function: a collector that raises
leaves its pane holding the previous value, dimmed, and is called again on the
next tick. Nothing here is allowed to end a pane's updates for the session.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx
from textual import work
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import Footer, Header, Input

from ops.cc import actions
from ops.cc.collectors import compose as compose_collector
from ops.cc.collectors import health as health_collector
from ops.cc.collectors import host as host_collector
from ops.cc.collectors import logs as logs_collector
from ops.cc.collectors import prom as prom_collector
from ops.cc.collectors import stats as stats_collector
from ops.cc.run import runner_for
from ops.cc.state import State
from ops.cc.theme import THEMES
from ops.cc.widgets.host import HostPane
from ops.cc.widgets.logs import LogPane
from ops.cc.widgets.services import ServicesPane
from ops.cc.widgets.sources import SourcesPane


async def supervise(
    collect: Callable[[], Awaitable],
    apply: Callable[[object], None],
    interval: float,
    *,
    sleep=asyncio.sleep,
    on_error: Callable[[str], None] | None = None,
) -> None:
    """Call `collect` forever, handing each result to `apply`.

    Cancellation propagates -- that is how the app stops. Everything else is
    caught: a collector that raises must cost one tick, not the pane.
    """
    while True:
        try:
            apply(await collect())
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - see the docstring
            if on_error is not None:
                on_error(str(exc))
        await sleep(interval)


class CommandCenter(App):
    CSS = """
    Screen { layout: vertical; }
    #top { height: 1fr; }
    ServicesPane, SourcesPane { width: 1fr; border: round $cc-border; }
    HostPane { height: 4; border: round $cc-border; padding: 0 1; }
    LogPane { height: 2fr; border: round $cc-border; }
    .stale { opacity: 0.55; }
    #filter { display: none; }
    #filter.visible { display: block; }
    """

    BINDINGS = [
        ("s", "act('s')", "up"),
        ("x", "act('x')", "stop"),
        ("r", "act('r')", "restart"),
        ("d", "act('d')", "deploy"),
        ("D", "act('D')", "deploy+ingest"),
        ("l", "scope_logs", "logs"),
        ("slash", "filter", "filter"),
        ("f", "freeze", "freeze"),
        ("g", "tunnel('grafana')", "grafana"),
        ("p", "tunnel('prometheus')", "prometheus"),
        ("q", "quit", "quit"),
    ]

    def __init__(
        self,
        compose_dir: Path,
        *,
        read_only: bool = False,
        theme_name: str = "claude-dark",
        api_url: str = "http://localhost:8080",
        prom_url: str = "http://localhost:9090",
    ) -> None:
        super().__init__()
        self.compose_dir = compose_dir
        self.read_only = read_only
        self.theme_name = theme_name
        self.api_url = api_url
        self.prom_url = prom_url
        self.state = State()
        self.run_command = runner_for(compose_dir)
        # Actions get their own runner: deploy.sh takes minutes, and sharing the
        # 5s collector timeout would kill it a twentieth of the way through.
        self.run_action = runner_for(compose_dir, timeout=1800.0)
        self._client = httpx.AsyncClient()
        self._log_task: asyncio.Task | None = None
        self._log_service: str | None = None

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Vertical():
            with Horizontal(id="top"):
                yield ServicesPane(id="services")
                yield SourcesPane(id="sources")
            yield HostPane(id="host")
            yield Input(placeholder="filter logs", id="filter")
            yield LogPane(id="logs")
        yield Footer()

    def on_mount(self) -> None:
        for theme in THEMES.values():
            self.register_theme(theme)
        self.theme = self.theme_name
        self.title = "✳ osint command center"
        self.sub_title = f"{self.compose_dir.name} — read-only" if self.read_only else str(self.compose_dir)

        self._start_collectors()
        self._restart_log_stream(None)

    def _start_collectors(self) -> None:
        services = self.query_one(ServicesPane)
        sources = self.query_one(SourcesPane)
        host_pane = self.query_one(HostPane)

        def apply_services(value):
            self.state.services = self.state.services.succeeded(value, time.monotonic())
            services.update_from(self.state.services, time.monotonic())
            services.set_class(False, "stale")

        def fail_services(message):
            self.state.services = self.state.services.failed(message, time.monotonic())
            services.set_class(True, "stale")

        async def collect_services():
            found = await compose_collector.collect(self.run_command)
            return stats_collector.merge(found, await stats_collector.collect(self.run_command))

        async def collect_sources():
            return await health_collector.collect(self._client, self.api_url)

        def apply_sources(value):
            self.state.sources = self.state.sources.succeeded(value, time.monotonic())
            sources.update_from(self.state.sources, time.monotonic())
            sources.set_class(False, "stale")

        def fail_sources(message):
            self.state.sources = self.state.sources.failed(message, time.monotonic())
            sources.set_class(True, "stale")

        def refresh_host(_value=None):
            host_pane.update_from(self.state.host, self.state.metrics, time.monotonic())

        def apply_host(value):
            self.state.host = self.state.host.succeeded(value, time.monotonic())
            refresh_host()

        def apply_metrics(value):
            self.state.metrics = self.state.metrics.succeeded(value, time.monotonic())
            refresh_host()

        def fail_metrics(message):
            self.state.metrics = self.state.metrics.failed(message, time.monotonic())
            refresh_host()

        self.run_worker(supervise(collect_services, apply_services, 2.0, on_error=fail_services))
        self.run_worker(supervise(collect_sources, apply_sources, 10.0, on_error=fail_sources))
        self.run_worker(supervise(
            lambda: prom_collector.collect(self._client, self.prom_url),
            apply_metrics, 15.0, on_error=fail_metrics,
        ))
        self.run_worker(supervise(host_collector.collect, apply_host, 5.0))

    def _restart_log_stream(self, service: str | None) -> None:
        if self._log_task is not None:
            self._log_task.cancel()
        pane = self.query_one(LogPane)
        pane.clear()
        self._log_service = service
        pane.border_title = f"LOGS [{service or 'all'}]"
        self._log_task = asyncio.create_task(
            logs_collector.stream(self.compose_dir, pane.append, service=service)
        )

    # --- keys ---------------------------------------------------------------

    # @work is required, not decorative: push_screen_wait below raises unless it
    # is awaited from a worker, and running the action off the message loop is
    # also what keeps the panes updating while deploy.sh takes its minutes.
    @work(exclusive=True)
    async def action_act(self, key: str) -> None:
        if not actions.is_allowed(key, read_only=self.read_only):
            self.notify("read-only mode: that key is disabled", severity="warning")
            return

        selected = self.query_one(ServicesPane).selected
        if key == "r" and selected is None:
            self.notify("select a service first", severity="warning")
            return

        prompt, word = actions.confirm_for(key, selected)
        if prompt is not None and not await self._confirmed(prompt, word):
            return

        pane = self.query_one(LogPane)
        pane.write(f"$ {' '.join(actions.argv_for(key, selected))}")
        code = await actions.execute(
            key, selected=selected, read_only=self.read_only, run=self.run_action
        )
        pane.write(f"— exit {code}")
        if code != 0:
            self.notify(f"{actions.ACTIONS[key].label} exited {code}", severity="error")

    async def _confirmed(self, prompt: str, word: str | None) -> bool:
        from ops.cc.widgets.confirm import ConfirmScreen

        return bool(await self.push_screen_wait(ConfirmScreen(prompt, word)))

    def action_scope_logs(self) -> None:
        selected = self.query_one(ServicesPane).selected
        self._restart_log_stream(None if selected == self._log_service else selected)

    def action_filter(self) -> None:
        field = self.query_one("#filter", Input)
        field.add_class("visible")
        field.focus()

    def on_input_changed(self, event: Input.Changed) -> None:
        # Filters what arrives from here on, not what is already on screen:
        # re-rendering the backlog would mean holding every line twice, and the
        # question being asked ("is it still doing X?") is about new lines.
        self.query_one(LogPane).set_filter(event.value)

    def action_freeze(self) -> None:
        pane = self.query_one(LogPane)
        frozen = pane.auto_scroll
        pane.set_frozen(frozen)
        self.notify("log scroll frozen" if frozen else "log scroll live")

    def action_tunnel(self, which: str) -> None:
        port = {"grafana": 3000, "prometheus": 9090}[which]
        command = f"ssh -L {port}:localhost:{port} {self.state.host.value.hostname if self.state.host.value else '<host>'}"
        # The server is headless, so the useful output is the command to run on
        # the machine that has a browser -- not an attempt to open one here.
        self.copy_to_clipboard(command)
        self.query_one(LogPane).write(command)
        self.notify(f"{which}: {command}")

    async def on_unmount(self) -> None:
        if self._log_task is not None:
            self._log_task.cancel()
        await self._client.aclose()
```

- [ ] **Step 4: Write `ops/cc/widgets/confirm.py`**

```python
"""The dialog in front of the keys that cost something.

A typed word rather than a y/n for the one key that spends metered quota: y is
one keystroke away from every other key on the board, and this is the only
action in the program that cannot be undone by pressing something else.
"""

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label


class ConfirmScreen(ModalScreen[bool]):
    CSS = """
    ConfirmScreen { align: center middle; }
    Vertical { width: 60; padding: 1 2; border: round $cc-warn; background: $surface; }
    """

    def __init__(self, prompt: str, required_word: str | None = None) -> None:
        super().__init__()
        self.prompt = prompt
        self.required_word = required_word

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Label(self.prompt)
            if self.required_word:
                yield Label(f"Type {self.required_word} to continue.")
                yield Input(id="word")
            yield Button("Confirm", variant="warning", id="confirm")
            yield Button("Cancel", id="cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "cancel":
            self.dismiss(False)
            return
        if self.required_word is None:
            self.dismiss(True)
            return
        typed = self.query_one("#word", Input).value.strip()
        self.dismiss(typed == self.required_word)
```

- [ ] **Step 5: Write `ops/cc/__main__.py`**

```python
"""`cc` -- the command center entry point.

Defaults are the deployment's: /opt/osint, the two published localhost ports.
--compose-dir is what makes the same program runnable against a checkout on
another machine.
"""

import argparse
from pathlib import Path

from ops.cc.app import CommandCenter


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="cc", description=__doc__)
    parser.add_argument("--compose-dir", type=Path, default=Path("/opt/osint"),
                        help="directory holding docker-compose.yml (default: /opt/osint)")
    parser.add_argument("--read-only", action="store_true",
                        help="disable every key that changes something")
    parser.add_argument("--light", dest="theme", action="store_const",
                        const="claude-light", default="claude-dark",
                        help="use the light theme, for a light terminal profile")
    parser.add_argument("--api-url", default="http://localhost:8080",
                        help="where the frontend serves /api (default: http://localhost:8080)")
    parser.add_argument("--prom-url", default="http://localhost:9090",
                        help="Prometheus base URL (default: http://localhost:9090)")
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    CommandCenter(
        args.compose_dir,
        read_only=args.read_only,
        theme_name=args.theme,
        api_url=args.api_url,
        prom_url=args.prom_url,
    ).run()


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: Run the whole suite**

Run: `python -m pytest ops/cc/tests -v`
Expected: PASS (all tests from Tasks 1-12)

- [ ] **Step 7: Run it against a live stack and confirm the panes fill**

Run, from the repository root with the stack up:

```bash
python -m ops.cc --compose-dir .
```

Expected: four panes, container states within 2 s, sources within 10 s, host numbers within 15 s, log lines streaming. Press `q` to quit. If Prometheus is not running, the host pane must show `prometheus unreachable` and everything else must keep updating — check that before moving on, because it is the state the tool starts in.

- [ ] **Step 8: Commit**

```bash
git add ops/cc/app.py ops/cc/__main__.py ops/cc/widgets/confirm.py ops/cc/tests/test_app.py
git commit -m "Put the four panes on one screen and keep them updating through failures"
```

---

### Task 13: Install on the Arch box, and document it

**Files:**
- Create: `ops/cc/README.md`
- Create: `ops/cc/install.sh`
- Modify: `README.md` (add a section; find the operations/deployment area and put it there)

**Interfaces:**
- Consumes: everything above.
- Produces: `/usr/local/bin/cc` on the server.

- [ ] **Step 1: Write `ops/cc/install.sh`**

```bash
#!/usr/bin/env bash
# Install the command center on the server. Idempotent: run it again after a
# deploy to pick up new dependencies.
#
#   ./ops/cc/install.sh          venv + /usr/local/bin/cc
#
# Deliberately not a systemd unit. This is a program you run when you want to
# look at something, not a service -- a dashboard nobody is watching is just a
# process holding a subprocess open.
set -euo pipefail

REPO=${1:-/opt/osint}
VENV="$REPO/ops/cc/.venv"

python -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$REPO/ops/cc/requirements.txt"

sudo tee /usr/local/bin/cc >/dev/null <<EOF
#!/usr/bin/env bash
# The command center. Runs from the repo so 'docker compose' finds the project.
cd "$REPO"
exec "$VENV/bin/python" -m ops.cc "\$@"
EOF
sudo chmod +x /usr/local/bin/cc

echo "Installed. Run: cc"
echo
if ! groups | grep -qw docker; then
  echo "Note: $USER is not in the docker group, so every collector will fail with"
  echo "      'permission denied on /var/run/docker.sock'. Fix with:"
  echo "        sudo usermod -aG docker $USER   # then log out and back in"
fi
```

- [ ] **Step 2: Write `ops/cc/README.md`**

````markdown
# cc — the command center

A terminal dashboard for the stack this repository defines. Runs on the server,
shows container state, source production, database health and the live log on
one screen, and can start, stop, restart and rebuild from the same keys.

## Install (Arch Linux server)

```bash
sudo pacman -S --needed python docker docker-compose
./ops/cc/install.sh /opt/osint
cc
```

The user running `cc` must be in the `docker` group. No root, and no systemd
unit: this is a program you run, not a service.

## Keys

| Key | Does |
| --- | --- |
| `s` | `docker compose up -d` |
| `x` | `docker compose stop` (asks first) |
| `r` | restart the selected service (asks first for `ingest`) |
| `d` | `deploy.sh` — rebuild whatever is behind its source |
| `D` | `deploy.sh --ingest` — also rebuild ingest. Type `INGEST` to confirm; this re-polls every metered source |
| `l` | scope the log pane to the selected service |
| `/` | filter log lines |
| `f` | freeze log scrolling |
| `g`, `p` | print and copy the SSH tunnel command for Grafana or Prometheus |
| `q` | quit |

`--read-only` disables `s x r d D`. `--light` switches to the light theme.
`--compose-dir` points it at a checkout somewhere other than `/opt/osint`.

## Development

```bash
python -m venv .venv && .venv/bin/pip install -r ops/cc/requirements-dev.txt
.venv/bin/python -m pytest ops/cc/tests
.venv/bin/python -m ops.cc --compose-dir .
```

Collectors import nothing from Textual, which is why the tests need no
terminal. Keep it that way: anything that needs a widget to be tested is
usually a row builder that wants extracting.

Design: `docs/superpowers/specs/2026-08-10-osint-command-center-design.md`
````

- [ ] **Step 3: Add a section to the root `README.md`**

Read the existing README's operations area first and match its voice — it
explains why, at length, and this section should too. Insert:

```markdown
### Watching it run: `cc`

`ops/cc` is a terminal dashboard for the running stack: container state, what
each source is producing, the database numbers worth a glance, and the live log,
on one screen. It exists because the alternative was four SSH sessions, and the
failures worth catching are the ones where two of them disagree — a container
that is up while the source it feeds has stopped producing.

    ./ops/cc/install.sh /opt/osint
    cc

It reads `docker compose ps`, `/api/health` and Prometheus, and shells out to
`deploy.sh` for rebuilds rather than repeating its staleness rules. `--read-only`
disables every key that changes something. See `ops/cc/README.md`.
```

- [ ] **Step 4: Verify the install path on the server**

Run on the Arch box:

```bash
cd /opt/osint && ./ops/cc/install.sh /opt/osint && cc --read-only
```

Expected: the dashboard opens with the mutating keys struck through in the
footer, all four panes populate, and `q` exits cleanly.

- [ ] **Step 5: Commit**

```bash
git add ops/cc/README.md ops/cc/install.sh README.md
git commit -m "Make the command center one command to install and one to run"
```

---

## Self-Review Notes

Checked against the spec:

- Four panes, always visible — Tasks 11, 12.
- Collectors with the documented intervals — Tasks 3-8, wired in Task 12.
- Last-good-on-failure, never blank, never a zero it did not measure — Task 1 (`Reading`), enforced per-pane in Tasks 11 and 12, and tested in `test_state.py`, `test_prom.py`, `test_app.py`.
- Prometheus unreachable is an expected state — Task 6, and the host pane's message in Task 11.
- The exact PromQL set, with a test that every metric name exists in `monitoring/` — Task 6.
- Source verdicts from `last_error` rather than a local threshold — Task 5.
- Every control, with `D` behind a typed word and `--read-only` refusing before the subprocess — Task 9.
- The theme, both variants, token parity, no red, glyph per state — Task 2.
- Installation, `docker` group requirement, no systemd — Task 13.

Out of scope per the spec, and absent here on purpose: SSH/remote operation, Admin Mode editing, alerting, any write to Postgres, replacing the Grafana dashboards.
