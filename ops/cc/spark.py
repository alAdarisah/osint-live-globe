"""A sparkline in eight characters.

Scaled to the series' own range rather than to an absolute one: these are trend
cells, not gauges, and the number beside them carries the magnitude.
"""

from collections.abc import Sequence

BLOCKS = "▁▂▃▄▅▆▇█"


def spark(values: Sequence[float], width: int = 8) -> str:
    if not values:
        # Blanks, not a flat line: an empty series means "not measured", and a
        # row of ▁ says "measured, and it was zero".
        return " " * width

    samples = list(values)
    if len(samples) > width:
        # Take the last `width` buckets' means, so the newest sample is always
        # in the last cell.
        size = len(samples) / width
        samples = [
            sum(samples[int(i * size):int((i + 1) * size)] or [0])
            / max(1, len(samples[int(i * size):int((i + 1) * size)]))
            for i in range(width)
        ]

    low, high = min(samples), max(samples)
    span = high - low
    if span == 0:
        cells = BLOCKS[0] * len(samples)
    else:
        cells = "".join(
            BLOCKS[min(len(BLOCKS) - 1, int((value - low) / span * len(BLOCKS)))]
            for value in samples
        )
    return cells.rjust(width)
