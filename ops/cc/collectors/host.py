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
