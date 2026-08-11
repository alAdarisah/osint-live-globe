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

import re

from textual.theme import Theme

from ops.cc.motion import spinner

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


def glyph_for(severity: str, now: float | None = None) -> str:
    """The mark a row of this severity shows at `now`.

    `now` of None means a still screen, and the row builders default to it, so a
    caller with no clock -- and every test written before there was one -- gets
    exactly the glyph GLYPH defines.

    Only `starting` has a moving form, because it is the only severity that
    means "not yet" rather than "this is how it is". A container pulling an
    image and a source registered but never polled are both doing something,
    and a still mark claims otherwise. Its frames are rotations of GLYPH's own
    ◐, so nothing changes width when it begins or stops.

    Raises on an unknown severity for the same reason severity_style does: a
    typo that renders as healthy is the worst bug a status display can have.
    """
    static = GLYPH[severity]
    if severity != "starting" or now is None:
        return static
    return spinner(now)

_STYLES = {
    "ok": "$cc-ok",
    "starting": "$cc-muted",
    "warn": "bold $cc-warn",
    "down": "bold $cc-down-fg on $cc-down",
}

_TOKEN = re.compile(r"\$([a-z0-9-]+)")


def resolve(style: str, theme_name: str) -> str:
    """Substitute the $tokens in a style for `theme_name`'s hex values.

    Textual's CSS understands `$cc-ok`; Rich does not, and every pane's rows go
    through Rich. Worse than ignored: Rich's markup parser requires a tag to
    open with a letter, `#`, `/` or `@`, so `[$cc-ok]●[/]` is read as literal
    text followed by an unmatched closing tag and raises MarkupError -- which
    surfaces as the whole app dying on the first frame that has a row in it,
    not as one mis-coloured glyph.

    Raises KeyError on a token neither theme defines, for the same reason
    severity_style does: silence here is a wrong colour on a status screen.
    """
    variables = THEMES[theme_name].variables
    return _TOKEN.sub(lambda match: variables[match.group(1)], style)


def severity_style(severity: str, theme_name: str) -> str:
    """Rich style for a severity, resolved against a theme. Raises on an
    unknown severity, rather than defaulting -- a typo that renders as healthy
    is the worst possible bug in a status display.

    The theme is an argument rather than a default because `cc-muted` is one of
    the two tokens the themes disagree about, so a caller that forgot it would
    render light-theme rows in the dark theme's grey and never be told.
    """
    return resolve(_STYLES[severity], theme_name)
