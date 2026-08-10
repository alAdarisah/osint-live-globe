"""The SOURCES pane: what is being collected, and what has stopped."""

from textual.widgets import DataTable

from ops.cc.collectors.health import SourcesSnapshot, SourceState
from ops.cc.state import Reading
from ops.cc.theme import GLYPH, severity_style


def _ago(seconds: int | None) -> str:
    if seconds is None:
        return "never"
    if seconds < 90:
        return f"{seconds}s ago"
    if seconds < 5400:
        return f"{seconds // 60}m ago"
    return f"{seconds // 3600}h ago"


def source_row(source: SourceState) -> tuple[str, str, str, str]:
    """(glyph, name, items, detail)."""
    items = f"{source.item_count:,}" if source.item_count else "—"
    # An error displaces the age: how long ago a dead source last worked is the
    # least useful thing about it, and the reason it died is the most.
    detail = source.last_error if source.last_error else _ago(source.seconds_since_success)
    return (GLYPH[source.severity], source.name, items, detail)


class SourcesPane(DataTable):
    BORDER_TITLE = "SOURCES"

    def on_mount(self) -> None:
        self.cursor_type = "row"
        self.show_header = False
        self.add_columns(" ", "source", "items", "detail")

    @property
    def selected(self) -> str | None:
        if self.row_count == 0:
            return None
        return str(self.get_row_at(self.cursor_row)[1])

    def update_from(self, reading: Reading, now: float) -> None:
        snapshot: SourcesSnapshot = reading.value or SourcesSnapshot()
        keep = self.cursor_row
        self.clear()
        for source in sorted(snapshot.sources, key=lambda s: s.name):
            glyph, name, items, detail = source_row(source)
            self.add_row(f"[{severity_style(source.severity)}]{glyph}[/]", name, items, detail)
        for alert in snapshot.alerts:
            # Alerts sit in the same list rather than a pane of their own: they
            # are almost always about a source, and a separate pane for two rows
            # would cost a quarter of the screen to say nothing most days.
            style = severity_style("down" if alert.severity == "critical" else "warn")
            self.add_row(
                f"[{style}]{GLYPH['warn']}[/]", alert.subject, "",
                f"{alert.condition}: {alert.detail}",
            )
        if keep < self.row_count:
            self.move_cursor(row=keep)
