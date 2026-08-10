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
        return str(self.get_row_at(self.cursor_row)[1])

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
