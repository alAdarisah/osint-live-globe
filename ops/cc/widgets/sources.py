"""The SOURCES pane: what is being collected, and what has stopped."""

from rich.text import Text
from textual.widgets import DataTable

from ops.cc.collectors.health import SourcesSnapshot, SourceState
from ops.cc.motion import Flashes
from ops.cc.state import Reading
from ops.cc.theme import GLYPH, glyph_for, resolve, severity_style
from ops.cc.widgets.fit import fit_rows

_LABELS = (" ", "source", "items", "detail")


def _ago(seconds: int | None) -> str:
    if seconds is None:
        return "never"
    if seconds < 90:
        return f"{seconds}s ago"
    if seconds < 5400:
        return f"{seconds // 60}m ago"
    return f"{seconds // 3600}h ago"


def source_row(source: SourceState, now: float | None = None) -> tuple[str, str, str, str]:
    """(glyph, name, items, detail).

    `now` only reaches the glyph, and only for a source that has registered but
    never polled -- see motion.glyph_for. Without it the row is exactly what it
    always was, which is what keeps this function testable against a literal.
    """
    items = f"{source.item_count:,}" if source.item_count else "—"
    # An error displaces the age: how long ago a dead source last worked is the
    # least useful thing about it, and the reason it died is the most.
    detail = source.last_error if source.last_error else _ago(source.seconds_since_success)
    return (glyph_for(source.severity, now), source.name, items, detail)


class SourcesPane(DataTable):
    BORDER_TITLE = "SOURCES"

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        # The last thing drawn, so a resize can redraw at the new width instead
        # of waiting out the collector's 10s interval in the wrong shape.
        self._last: tuple[Reading, float] | None = None
        # Item counts only. A source's *name* changing is not news, and its
        # detail column is either an age that changes every tick by definition
        # or an error string that is already coloured -- lighting either up
        # would be motion that says nothing.
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
        """Redraw the rows already held, at a later instant.

        This is what advances a spinner and expires a flash between the
        collector's own ticks -- ten seconds is far too coarse for either. It
        re-runs the flash bookkeeping with unchanged values, which by
        construction lights nothing new.
        """
        if self._last is not None:
            self.update_from(self._last[0], now)

    @property
    def moving(self) -> bool:
        """Whether a retick would change anything on screen.

        Asked every frame by the app so that a pane with nothing transitional
        and nothing recently changed costs no redraw at all -- this program is
        normally watched over SSH.
        """
        return self._moving

    @property
    def selected(self) -> str | None:
        if self.row_count == 0:
            return None
        return str(self.get_row_at(self.cursor_row)[1])

    def update_from(self, reading: Reading, now: float) -> None:
        self._last = (reading, now)
        snapshot: SourcesSnapshot = reading.value or SourcesSnapshot()
        keep = self.cursor_row
        self.clear()

        ordered = sorted(snapshot.sources, key=lambda s: s.name)
        # Before the rows are built, so a count that moves this tick is lit on
        # this tick rather than one behind.
        self._flashes.update({s.name: s.item_count for s in ordered}, now)

        rows = [source_row(source, now) for source in ordered]
        severities = [source.severity for source in ordered]
        # Parallel to `rows`, and padded for the alert rows appended below --
        # an alert has no item count, so nothing there can flash.
        lit = [self._flashes.lit(source.name, now) for source in ordered]
        self._moving = any(lit) or any(s.severity == "starting" for s in ordered)
        for alert in snapshot.alerts:
            # Alerts sit in the same list rather than a pane of their own: they
            # are almost always about a source, and a separate pane for two rows
            # would cost a quarter of the screen to say nothing most days.
            rows.append((GLYPH["warn"], alert.subject, "",
                         f"{alert.condition}: {alert.detail}"))
            severities.append("down" if alert.severity == "critical" else "warn")
            lit.append(False)

        # Detail gives way first: it is the only unbounded column, and a
        # source's name is what makes its row findable. The name goes second,
        # and only when detail has already been squeezed to nothing.
        #
        # scrollable_content_region, not size: this pane always has more rows
        # than height, and its vertical scrollbar sits over the last two cells
        # of every row. Sized to `size` the table fit exactly -- and the
        # scrollbar covered the ellipsis that says the message was trimmed,
        # which is the one character in the row that must not be hidden.
        rows = fit_rows(rows, _LABELS, self.scrollable_content_region.width, order=(3, 1))

        # A count that just moved is drawn bold in the value colour for one
        # flash, then falls back to the pane's ordinary text. This is the
        # question the pane is actually asked -- "is anything still coming in"
        # -- answered without diffing five-digit numbers by eye.
        flash_style = f"bold {resolve('$cc-value', self.app.theme)}"

        for (glyph, name, items, detail), severity, is_lit in zip(rows, severities, lit):
            style = severity_style(severity, self.app.theme)
            # Text rather than markup, for two reasons that both end in a dead
            # app: DataTable parses every str cell as Rich markup, which cannot
            # read a theme token (see theme.resolve), and `detail` is an
            # upstream error string -- one that happens to contain a bracket
            # would take the pane down at exactly the moment it is needed.
            self.add_row(
                Text(glyph, style=style),
                Text(name),
                Text(items, style=flash_style) if is_lit else items,
                Text(detail),
            )

        if keep < self.row_count:
            self.move_cursor(row=keep)
