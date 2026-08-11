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
