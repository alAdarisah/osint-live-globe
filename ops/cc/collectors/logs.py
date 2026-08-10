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
