"""The LOGS pane: the reason for watching rather than polling."""

from rich.text import Text
from textual.widgets import RichLog

from ops.cc.collectors.logs import LogLine
from ops.cc.theme import severity_style

_LEVEL_STYLE = {"error": severity_style("down"), "warn": severity_style("warn"), "info": ""}


class LogPane(RichLog):
    BORDER_TITLE = "LOGS"

    def __init__(self, **kwargs) -> None:
        super().__init__(wrap=False, markup=False, max_lines=2000, **kwargs)
        self._filter = ""
        self._frozen = False

    def set_filter(self, text: str) -> None:
        self._filter = text.lower()

    def set_frozen(self, frozen: bool) -> None:
        # Freezing stops the auto-scroll, not the collection: lines still
        # arrive, so releasing it catches up instead of showing a gap.
        self._frozen = frozen
        self.auto_scroll = not frozen

    def matches(self, line: LogLine) -> bool:
        return self._filter in line.text.lower() or self._filter in line.service.lower()

    def append(self, line: LogLine) -> None:
        if not self.matches(line):
            return
        text = Text(f"{line.service:<12} {line.text}")
        style = _LEVEL_STYLE[line.level]
        if style:
            text.stylize(style)
        self.write(text)
