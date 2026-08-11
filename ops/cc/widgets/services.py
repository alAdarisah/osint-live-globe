"""The SERVICES pane: what is running, and what keeps dying."""

from rich.text import Text
from textual.widgets import DataTable

from ops.cc.collectors.compose import ServiceState
from ops.cc.motion import Flashes
from ops.cc.state import Reading
from ops.cc.theme import glyph_for, resolve, severity_style
from ops.cc.widgets.fit import fit_rows

_LABELS = (" ", "service", "status", "usage")


def service_row(service: ServiceState, now: float | None = None) -> tuple[str, str, str, str]:
    """(glyph, name, status, usage). Pure, so the interesting cases are unit
    tests rather than snapshots.

    `now` only reaches the glyph, and only for a container whose healthcheck is
    still starting -- see motion.glyph_for. Omitting it gives the still screen
    the theme defines.
    """
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

    return (glyph_for(service.severity, now), service.service, status, usage)


class ServicesPane(DataTable):
    BORDER_TITLE = "SERVICES"

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._last: tuple[Reading, float] | None = None
        # Status, not usage. A container's cpu figure changes on every single
        # tick, so flashing it would light the whole column permanently and
        # mean nothing; a container's *status* changing is the thing you
        # opened this pane to catch.
        self._flashes = Flashes()
        self._moving = False

    def on_mount(self) -> None:
        self.cursor_type = "row"
        self.show_header = False
        self.add_columns(*_LABELS)

    def on_resize(self) -> None:
        if self._last is not None:
            self.update_from(*self._last)

    def retick(self, now: float) -> None:
        """Redraw the rows already held, at a later instant -- see the twin of
        this method in sources.py."""
        if self._last is not None:
            self.update_from(self._last[0], now)

    @property
    def moving(self) -> bool:
        """Whether a retick would change anything on screen."""
        return self._moving

    @property
    def selected(self) -> str | None:
        if self.row_count == 0:
            return None
        return str(self.get_row_at(self.cursor_row)[1])

    def update_from(self, reading: Reading, now: float) -> None:
        self._last = (reading, now)
        services: list[ServiceState] = reading.value or []
        keep = self.cursor_row
        self.clear()

        # Status gives way before the service name: `r` restarts whatever is
        # selected here, and choosing that from a list of trimmed names is the
        # one thing this pane must never make you guess at. Usage never gives
        # way -- it is already the narrowest column.
        # scrollable_content_region rather than size, so a vertical scrollbar
        # (this stack is eleven services in a pane that is often shorter) does
        # not sit on top of the last cells of every row. See sources.py.
        built = [service_row(service, now) for service in services]
        # Keyed off the built status string rather than off the raw fields, so
        # a restart count ticking up reads as a change to the same thing a
        # person sees -- "×3" becoming "×4" is exactly what should light up.
        self._flashes.update(
            {service.service: row[2] for row, service in zip(built, services)}, now
        )

        rows = fit_rows(built, _LABELS, self.scrollable_content_region.width, order=(2, 1))

        flash_style = f"bold {resolve('$cc-value', self.app.theme)}"
        self._moving = any(s.severity == "starting" for s in services) or any(
            self._flashes.lit(s.service, now) for s in services
        )

        for (glyph, name, status, usage), service in zip(rows, services):
            style = severity_style(service.severity, self.app.theme)
            # A styled Text rather than a markup string: DataTable runs every
            # str cell through Rich's markup parser, which knows nothing about
            # theme tokens and raises on the result. See theme.resolve.
            self.add_row(
                Text(glyph, style=style),
                name,
                Text(status, style=flash_style)
                if self._flashes.lit(service.service, now) else status,
                usage,
            )

        if keep < self.row_count:
            self.move_cursor(row=keep)
        # Dimming a pane whose collector is failing is the app's job (see
        # app.py); the rows themselves stay exactly as they last were.
