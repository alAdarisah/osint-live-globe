"""Trimming rows to the width a pane actually has.

DataTable sizes each column to its widest cell and scrolls horizontally when the
total exceeds the widget. On a status screen that is the wrong trade twice over:
one 304-character error string from a source pushed the SOURCES table to 230
cells inside a 100-cell pane, so the glyph and name of every row below it were
off-screen sideways -- and nothing about a table suggests there is more of it to
the right. Better a trimmed message than a hidden one.

Pure functions, so the arithmetic is unit-tested rather than eyeballed against a
terminal.
"""

ELLIPSIS = "…"


def ellipsize(text: str, width: int) -> str:
    """`text` in at most `width` cells, marking the loss when there is one."""
    if width <= 0:
        return ""
    if len(text) <= width:
        return text
    if width == 1:
        return ELLIPSIS
    return text[: width - 1] + ELLIPSIS


def fit_rows(
    rows: list[tuple[str, ...]],
    labels: tuple[str, ...],
    total: int,
    order: tuple[int, ...],
    *,
    cell_padding: int = 1,
    minimum: int = 6,
) -> list[tuple[str, ...]]:
    """Trim columns until the widest row fits `total` cells.

    `total` is the pane's content width (DataTable.size.width -- Textual's size
    already excludes the border). Column labels count even with show_header off:
    DataTable seeds each column's content_width from its label and never goes
    below it.

    `order` is the columns that may give way, most expendable first. One column
    is rarely enough: a 25-character service name overflows a 38-cell pane on
    its own, whatever is done to the status beside it. Each is squeezed down to
    `minimum` in turn until the row fits, and every row is trimmed to the same
    per-column width, so the columns stay aligned -- a table whose rows each
    truncate somewhere different is harder to read than one that scrolls.

    A pane narrower than the minimums still overflows, and should: below that
    there is nothing to render but ellipses.
    """
    if not rows:
        return rows

    widths = [
        max([len(labels[column])] + [len(row[column]) for row in rows])
        for column in range(len(labels))
    ]
    overhead = 2 * cell_padding * len(labels)

    for column in order:
        excess = sum(widths) + overhead - total
        if excess <= 0:
            break
        widths[column] = max(minimum, widths[column] - excess)

    return [
        tuple(ellipsize(cell, widths[column]) for column, cell in enumerate(row))
        for row in rows
    ]
