"""Motion, on a screen made of characters.

The rule here is the same one the colours follow: a thing that moves is saying
something, and if it has nothing to say it holds still. A terminal dashboard
that animates for decoration is worse than a static one -- movement in the
corner of the eye is a claim on attention, and spending that on nothing teaches
the person watching to stop looking.

So there are exactly three kinds of motion in this program:

  spinner   a state that is *transitional* -- pulling an image, starting a
            container, a source registered but not yet polled. The frame says
            "still working" for a state whose whole meaning is "not yet".
  heartbeat a collector is alive and running to schedule. Its pane's marker
            breathes on that collector's own period, so a stalled collector
            stops moving and the stillness is the alarm.
  flash     a number that just changed, held bright for one tick. The question
            this dashboard exists to answer is "what moved", and a number that
            answers it without being diffed by eye is the cheapest win here.

Everything below is a pure function of a timestamp and the previous values, so
the interesting cases are unit tests rather than a person watching a terminal
for a minute to see whether the phase wrapped correctly.

On budget: the app drives all of this from one timer (see app.py). Nothing here
schedules work of its own, and every function is cheap enough to call for every
row on every frame. That matters because this program is normally watched over
SSH on a box that is having a bad day.

Nothing here imports anything of this program's, and that is deliberate: the
theme module pulls in Textual, and a plain `pytest` run from the backend's
environment has to be able to import these tests (see tests/conftest.py). Pure
timing arithmetic with no dependencies is the one shape that satisfies both --
which is why the glyph a severity animates to lives in theme.py, not here.
"""

import time
from collections.abc import Hashable

# A rotating half-circle. Deliberately the same weight and width as GLYPH's
# static "starting" mark, which is one of these frames -- so a row that starts
# spinning does not change size, and a terminal without the glyph coverage to
# draw them degrades to boxes in one column rather than reflowing the pane.
SPINNER = "◐◓◑◒"

# Half a second per frame. Slow enough to read as "working" rather than
# "panicking", and slow enough that a 2-frame-per-second repaint is all the
# bandwidth this costs on a laggy link.
SPINNER_PERIOD = 2.0

# How long a changed number stays lit. Just over the fastest collector interval
# (services, 2s), so a value that changes on consecutive ticks stays lit
# continuously rather than strobing between lit and unlit.
FLASH_SECONDS = 2.5

# A collector that has missed this many of its own intervals has stopped, and
# its heartbeat holds still. Two, not one: a single late tick is a slow docker
# command, not a dead collector, and crying wolf on every hiccup is how a
# status light gets ignored.
STALE_INTERVALS = 2.0


def spinner(now: float, period: float = SPINNER_PERIOD) -> str:
    """The frame a transitional state shows at `now`.

    Phase comes from the clock rather than from a counter, so every spinner on
    screen is on the same beat. Independent counters drift apart and the pane
    ends up looking like it is buffering rather than working.
    """
    if period <= 0:
        return SPINNER[0]
    step = int(now / (period / len(SPINNER))) % len(SPINNER)
    return SPINNER[step]


def breath(now: float, period: float) -> bool:
    """Whether a heartbeat marker is on its bright half at `now`.

    A square wave rather than a fade: a terminal has two levels to work with
    (dim and not), so pretending to have more of them just produces a marker
    that spends most of its time at an indeterminate brightness.
    """
    if period <= 0:
        return True
    return (now % period) < (period / 2)


def heartbeat(updated_at: float, interval: float, now: float) -> bool | None:
    """The state of a pane's liveness marker.

    True/False are the two halves of a live collector's breath. None means the
    collector is not running to schedule -- never started, or overdue -- and the
    marker holds still.

    Stillness is the alarm here, which is the opposite of the usual arrangement
    and is deliberate: a dashboard watched during an incident is watched
    peripherally, and "that corner stopped moving" is a thing peripheral vision
    is genuinely good at noticing.
    """
    if updated_at <= 0.0:
        return None
    if now - updated_at > interval * STALE_INTERVALS:
        return None
    return breath(now, interval)


class Flashes:
    """Which values changed recently, for one pane.

    Keyed by whatever identifies a cell -- (row name, column) is what the panes
    use. Holds only the keys it has been shown, so a source that disappears
    stops being tracked on the next tick rather than accumulating forever.
    """

    def __init__(self, hold: float = FLASH_SECONDS) -> None:
        self._hold = hold
        self._values: dict[Hashable, object] = {}
        self._changed_at: dict[Hashable, float] = {}

    def update(self, values: dict[Hashable, object], now: float | None = None) -> None:
        """Record this tick's values and note which of them moved.

        A key's first appearance is never a change. Every value on the first
        tick after launch would otherwise light up at once, which says "all of
        this just happened" about a screen that has simply been drawn -- the
        same reason the map's arrival flash does not fire on its first load.
        """
        now = time.monotonic() if now is None else now
        for key, value in values.items():
            if key in self._values and self._values[key] != value:
                self._changed_at[key] = now
        self._values = dict(values)
        # Drop keys that are no longer on screen, so a pane that churns its rows
        # does not grow a timestamp for every row it has ever shown.
        self._changed_at = {
            key: at for key, at in self._changed_at.items() if key in self._values
        }

    def lit(self, key: Hashable, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        at = self._changed_at.get(key)
        return at is not None and (now - at) < self._hold
