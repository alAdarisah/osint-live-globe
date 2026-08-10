"""Anthropic's palette, mapped to what this dashboard has to say.

Colour and glyphs only: a terminal's font belongs to whoever opened it, so the
brand's typography is not something this program gets to set.

Widgets refer to the tokens below and never to a hex value, which is what makes
retheming a one-file change -- and what makes the parity test at the top of
tests/test_theme.py able to prove both themes are complete.

There is no red here, because the palette has none. Rather than invent a hue for
the most important state on the screen, `down` inverts the accent: dark text on
an orange block, so a stopped container reads as a solid bar rather than one
more coloured word among coloured words.
"""

from textual.theme import Theme

# Straight from the brand palette.
_DARK = "#141413"
_LIGHT = "#faf9f5"
_MID_GRAY = "#b0aea5"
_LIGHT_GRAY = "#e8e6dc"
_ORANGE = "#d97757"
_BLUE = "#6a9bcc"
_GREEN = "#788c5d"

# Derived, and the only two values not in the palette: a four-pane layout needs
# a second surface level and a rule weight that the palette does not name.
_SURFACE_DARK = "#1f1e1d"
_SURFACE_LIGHT = "#efede4"
_MUTED_ON_LIGHT = "#6b6a63"  # #b0aea5 fails contrast on a light ground

TOKENS = (
    "cc-ok",       # healthy container, producing source, exit code 0
    "cc-warn",     # degraded, stale, WARN lines, the focused pane title
    "cc-down",     # background of the inverted failure block
    "cc-down-fg",  # text on that block
    "cc-idle",     # not running, not a problem: created, stopped by request
    "cc-value",    # numbers and sparklines
    "cc-muted",    # labels, units, timestamps, inactive key hints
    "cc-border",   # pane rules
)

_ACCENTS = {
    "cc-ok": _GREEN,
    "cc-warn": _ORANGE,
    "cc-down": _ORANGE,
    "cc-down-fg": _DARK,
    "cc-idle": _MID_GRAY,
    "cc-value": _BLUE,
}

CLAUDE_DARK = Theme(
    name="claude-dark",
    dark=True,
    background=_DARK,
    surface=_SURFACE_DARK,
    panel=_SURFACE_DARK,
    foreground=_LIGHT,
    primary=_ORANGE,
    secondary=_BLUE,
    accent=_ORANGE,
    success=_GREEN,
    warning=_ORANGE,
    error=_ORANGE,
    variables={**_ACCENTS, "cc-muted": _MID_GRAY, "cc-border": _MID_GRAY},
)

CLAUDE_LIGHT = Theme(
    name="claude-light",
    dark=False,
    background=_LIGHT,
    surface=_SURFACE_LIGHT,
    panel=_SURFACE_LIGHT,
    foreground=_DARK,
    primary=_ORANGE,
    secondary=_BLUE,
    accent=_ORANGE,
    success=_GREEN,
    warning=_ORANGE,
    error=_ORANGE,
    variables={**_ACCENTS, "cc-muted": _MUTED_ON_LIGHT, "cc-border": _LIGHT_GRAY},
)

THEMES = {theme.name: theme for theme in (CLAUDE_DARK, CLAUDE_LIGHT)}

# Shape as well as colour, so the screen still parses in monochrome.
GLYPH = {"ok": "●", "starting": "◐", "warn": "▲", "down": "■"}

_STYLES = {
    "ok": "$cc-ok",
    "starting": "$cc-muted",
    "warn": "bold $cc-warn",
    "down": "bold $cc-down-fg on $cc-down",
}


def severity_style(severity: str) -> str:
    """Rich style for a severity. Raises on an unknown one, rather than
    defaulting -- a typo that renders as healthy is the worst possible bug in
    a status display."""
    return _STYLES[severity]
