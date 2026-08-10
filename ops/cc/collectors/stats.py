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
