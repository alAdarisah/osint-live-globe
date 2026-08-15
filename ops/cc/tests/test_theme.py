"""The theme, checked for the two ways it can break someone else's terminal.

A token defined in one theme and not the other renders as an unstyled -- often
invisible -- pane for whoever picked the other theme, and nothing in a snapshot
test of the dark theme would catch it.
"""

import pytest

from rich.style import Style

from ops.cc.theme import (CLAUDE_DARK, CLAUDE_LIGHT, GLYPH, THEMES, TOKENS, resolve,
                          severity_style)


def test_both_themes_define_exactly_the_documented_tokens():
    for theme in (CLAUDE_DARK, CLAUDE_LIGHT):
        assert set(theme.variables) == set(TOKENS), theme.name


def test_the_two_themes_disagree_only_about_the_base_pair():
    """The accents are the brand; only ground and muted change with the terminal."""
    differing = {k for k in TOKENS if CLAUDE_DARK.variables[k] != CLAUDE_LIGHT.variables[k]}
    assert differing == {"cc-muted", "cc-border"}


def test_the_accents_are_the_brand_palette():
    assert CLAUDE_DARK.variables["cc-warn"] == "#d97757"
    assert CLAUDE_DARK.variables["cc-value"] == "#6a9bcc"
    assert CLAUDE_DARK.variables["cc-ok"] == "#788c5d"


def test_dark_is_dark_and_light_is_light():
    assert CLAUDE_DARK.dark is True and CLAUDE_DARK.background == "#141413"
    assert CLAUDE_LIGHT.dark is False and CLAUDE_LIGHT.background == "#faf9f5"


def test_themes_are_registered_under_the_names_the_cli_accepts():
    assert THEMES == {"claude-dark": CLAUDE_DARK, "claude-light": CLAUDE_LIGHT}


def test_every_severity_has_a_glyph_and_a_style():
    """Colour alone must not carry state -- monochrome terminals exist, so do
    red-green colour-blind readers, and this screen is read under stress."""
    for severity in ("ok", "starting", "warn", "down"):
        assert GLYPH[severity]
        assert severity_style(severity, "claude-dark")


def test_down_inverts_the_accent_rather_than_inventing_a_red():
    """The palette has no red. Failure is a block, not another coloured word."""
    assert severity_style("down", "claude-dark") == "bold #141413 on #d97757"
    assert CLAUDE_DARK.variables["cc-down"] == "#d97757"


def test_an_unknown_severity_is_not_silently_styled_as_healthy():
    with pytest.raises(KeyError):
        severity_style("probably-fine", "claude-dark")


def test_no_severity_style_reaches_rich_with_a_token_left_in_it():
    """The regression: Rich reads `$cc-ok` as literal text rather than as an
    opening tag, so `[$cc-ok]●[/]` raised MarkupError and killed the app on the
    first frame that had a row in it. Every style Rich sees must be hex by then.
    """
    for theme_name in THEMES:
        for severity in ("ok", "starting", "warn", "down"):
            style = severity_style(severity, theme_name)
            assert "$" not in style, (severity, theme_name)
            # Parses, and to something visible -- "" would also contain no "$".
            assert Style.parse(style)


def test_the_muted_severity_follows_the_theme_it_was_asked_for():
    """cc-muted is one of the two tokens the themes disagree about, which is
    why the theme is an argument and not a default."""
    assert severity_style("starting", "claude-dark") == CLAUDE_DARK.variables["cc-muted"]
    assert severity_style("starting", "claude-light") == CLAUDE_LIGHT.variables["cc-muted"]


def test_an_undefined_token_is_not_silently_dropped():
    with pytest.raises(KeyError):
        resolve("$cc-invented", "claude-dark")
