"""Eight cells of history. Small, and wrong in interesting ways if unguarded."""

from ops.cc.spark import BLOCKS, spark


def test_renders_one_cell_per_requested_column():
    assert len(spark([1, 2, 3, 4, 5, 6, 7, 8], width=8)) == 8


def test_downsamples_a_longer_series_to_the_width():
    assert len(spark(list(range(30)), width=8)) == 8


def test_a_shorter_series_is_left_padded_with_blanks():
    """Right-aligned, because the newest sample must always be the last cell --
    a series that grows leftward makes "now" move around the pane."""
    rendered = spark([1, 2, 3], width=8)
    assert rendered.startswith(" " * 5)
    assert rendered[-1] == BLOCKS[-1]


def test_no_samples_renders_as_blanks_not_a_flat_line():
    """A flat line at the bottom says "measured, and it was zero"."""
    assert spark([], width=8) == " " * 8


def test_a_flat_series_renders_at_the_bottom_not_at_the_top():
    """max == min: dividing by the range would be a crash, and rendering full
    blocks would make an idle backend look saturated."""
    assert spark([4.0] * 8, width=8) == BLOCKS[0] * 8


def test_the_largest_sample_is_the_tallest_block():
    assert spark([0, 10], width=2) == BLOCKS[0] + BLOCKS[-1]


def test_negative_values_do_not_escape_the_block_range():
    rendered = spark([-5, 0, 5], width=3)
    assert all(char in BLOCKS for char in rendered)
