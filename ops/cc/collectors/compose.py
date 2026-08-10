"""Which containers exist, and what state they are in.

Read through the Docker CLI rather than the socket API because `docker compose
ps` already resolves the project name, the health state and the service-to-
container mapping, and it keeps working when the compose file gains a service.

The restart count is the one fact `ps` does not carry, so it comes from a
second `docker inspect` call -- and its failure is tolerated, because a missing
restart count is cosmetic where a missing container list is the pane.
"""

import json
from dataclasses import dataclass, replace

from ops.cc.run import CollectorError, Runner

__all__ = ["CollectorError", "ServiceState", "collect", "parse_ps", "parse_restarts",
           "replace_stats"]


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
