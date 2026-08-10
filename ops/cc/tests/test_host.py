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
