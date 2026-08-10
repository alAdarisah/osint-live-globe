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
