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
