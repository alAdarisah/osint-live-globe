"""The LOGS pane: the reason for watching rather than polling."""

from rich.text import Text
from textual.widgets import RichLog

from ops.cc.collectors.logs import LogLine
from ops.cc.theme import severity_style

_LEVEL_SEVERITY = {"error": "down", "warn": "warn"}


class LogPane(RichLog):
    BORDER_TITLE = "LOGS"

    def __init__(self, **kwargs) -> None:
        super().__init__(wrap=False, markup=False, max_lines=2000, **kwargs)
        self._filter = ""
        self._frozen = False
        # Resolved on mount rather than at import: the styles are theme
        # dependent, and there is no app -- and so no theme -- at import time.
        self._level_style: dict[str, str] = {}

    def on_mount(self) -> None:
        self._level_style = {
            level: severity_style(severity, self.app.theme)
            for level, severity in _LEVEL_SEVERITY.items()
        }

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
        style = self._level_style.get(line.level)
        if style:
            text.stylize(style)
        self.write(text)
