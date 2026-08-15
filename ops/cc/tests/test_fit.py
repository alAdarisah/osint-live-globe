"""Row trimming, checked as arithmetic rather than against a terminal.

The bug these pin: a source's `last_error` is unbounded upstream text, and one
304-character message sized the SOURCES table to 230 cells inside a 100-cell
pane. DataTable's answer is a horizontal scrollbar, which on a status screen
means every row's glyph and name are off to the left where nothing suggests
they exist.
"""

from ops.cc.widgets.fit import ELLIPSIS, ellipsize, fit_rows

LABELS = (" ", "source", "items", "detail")


def test_text_that_already_fits_is_untouched():
    assert ellipsize("firms", 10) == "firms"
    assert ellipsize("firms", 5) == "firms"


def test_trimmed_text_says_it_was_trimmed():
    assert ellipsize("aisstream closed the socket", 10) == "aisstream" + ELLIPSIS
    assert len(ellipsize("aisstream closed the socket", 10)) == 10


def test_the_narrowest_widths_do_not_produce_a_wider_string():
    """A pane one cell wide is absurd, but it is reachable by dragging, and it
    must not be the thing that raises."""
    assert ellipsize("anything", 1) == ELLIPSIS
    assert ellipsize("anything", 0) == ""
    assert ellipsize("anything", -3) == ""


def rendered_width(rows):
    """What DataTable will make of these rows: the widest cell per column, plus
    a cell of padding on each side of each column."""
    widths = [max([len(LABELS[i])] + [len(row[i]) for row in rows])
              for i in range(len(LABELS))]
    return sum(widths) + 2 * len(LABELS)


def test_rows_that_fit_are_returned_unchanged():
    rows = [("●", "firms", "9,133", "2m ago")]
    assert fit_rows(rows, LABELS, 100, order=(3, 1)) == rows


def test_the_widest_row_decides_the_trim_and_every_row_takes_it():
    """One trim width for the column, so the rows stay aligned."""
    rows = [
        ("●", "firms", "9,133", "2m ago"),
        ("■", "ais", "—", "ingest: aisstream closed the socket, retrying in 30s"),
    ]
    fitted = fit_rows(rows, LABELS, 60, order=(3, 1))
    assert fitted[1][3].endswith(ELLIPSIS)
    assert rendered_width(fitted) <= 60


def test_the_fitted_rows_are_no_wider_than_the_pane():
    rows = [("■", "ais", "—", "x" * 304)]
    for width in (40, 60, 100, 200):
        assert rendered_width(fit_rows(rows, LABELS, width, order=(3, 1))) <= width, width


def test_a_long_name_gives_way_only_after_the_column_before_it():
    """Both orders of business: detail is spent first, and when that is not
    enough the name gives way too rather than the row overflowing."""
    rows = [("■", "a-source-with-a-long-name", "1,000", "x" * 200)]

    roomy = fit_rows(rows, LABELS, 60, order=(3, 1))
    assert roomy[0][1] == "a-source-with-a-long-name", "detail alone was enough here"
    assert roomy[0][2] == "1,000"

    cramped = fit_rows(rows, LABELS, 38, order=(3, 1))
    assert cramped[0][1].endswith(ELLIPSIS)
    assert rendered_width(cramped) <= 38


def test_a_pane_too_narrow_for_the_minimums_still_shows_something():
    """Below the minimum the table scrolls again -- but every column must still
    render some text. An empty detail cell reads as "no error"."""
    rows = [("■", "a-source-with-a-long-name", "1,000", "connection refused")]
    fitted = fit_rows(rows, LABELS, 10, order=(3, 1))
    assert fitted[0][1] and fitted[0][3]
    assert fitted[0][3].endswith(ELLIPSIS)


def test_no_rows_is_not_an_error():
    assert fit_rows([], LABELS, 80, order=(3, 1)) == []
