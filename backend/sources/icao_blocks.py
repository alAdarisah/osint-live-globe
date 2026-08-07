"""Which country an aircraft's Mode-S address was allocated to.

Like sanctions.py, this source draws nothing of its own. It answers one
question about markers that are already on the map: *whose address is that*.

The aircraft layer could always say what was flying and where, and could only
sometimes say where it was from. Measured against both live feeds on
2026-08-06: `origin_country` was null for **100%** of airplanes.live aircraft --
the field simply does not exist upstream -- and OpenSky, the only feed that
fills it, pauses for an hour on every 429 (see adsb.OPENSKY_RATE_LIMIT_PAUSE).
So country attribution existed only while a metered account had credits left.

ICAO allocates the 24-bit address space to states in blocks, and the block an
address sits in is a permanent property of the airframe. The same measurement
resolved 563 of 563 aircraft in a Europe point query and 393 of 393 in the
military sweep, with none falling through to the unallocated catch-all. That is
the whole point of this module: the attribution stops depending on a feed.

The table is Virtual Radar Server's `standing-data`, CC0 1.0 -- public domain,
the cleanest licence in this project -- keyless, ~29 KB, 811 rows, committed
daily around 03:50 UTC.

Two traps, both of which produce silently wrong answers rather than errors:

- **The file is UTF-8 with a BOM.** Decoded as plain UTF-8 the first header
  field arrives as "\\ufeffStart" and a DictReader keyed on "Start" raises --
  or worse, a `.get("Start")` returns None for every row and the whole table
  parses to nothing. Handled in both places: the fetch decodes utf-8-sig, and
  the parser strips a leading BOM anyway so it cannot depend on its caller.
- **The ranges deliberately overlap, and it is not first-hit.** See
  `CodeBlockTable` below for the rule and for why it is the range rule rather
  than the bitmask one the schema also documents.
"""

import asyncio
import csv
import io
import logging
import time

import httpx

from backend import storage
from backend.cache import registry

log = logging.getLogger("osint-globe.icao_blocks")

CODE_BLOCKS_URL = (
    "https://raw.githubusercontent.com/vradarserver/standing-data/main"
    "/code-blocks/schema-01/code-blocks.csv"
)
REFRESH_INTERVAL = 24 * 3600  # allocations change in months; the file commits daily
FAILURE_RETRY_INTERVAL = 300  # scaled by consecutive failures, capped at REFRESH_INTERVAL

# The whole 24-bit space, twice, in two halves. Not a country: ISO 3166-1
# reserves ZZ for user-assigned codes and the dataset uses it for the fallback
# rows that make the bitmask search below always terminate. Kept in the parsed
# document (it is part of the file) but never attributed to an aircraft --
# "ZZ" on a popup would render as a flag for a state that does not exist.
UNALLOCATED_ISO2 = "ZZ"

_MAX_ADDRESS = 0xFFFFFF


def parse_code_blocks(text: str) -> list[dict]:
    """code-blocks.csv -> one dict per allocation block.

    Read by header name rather than by position because the schema's own
    future-proofing note says new columns will be appended, and dropped rather
    than repaired when a row does not parse: a block with an unreadable range
    would otherwise claim addresses it has no business claiming.

    `Count`, `Bitmask` and `SignificantBitmask` are not kept. All three are
    derived from Start/Finish (the schema says so explicitly), and the span is
    recomputed here instead of trusting the file's arithmetic.
    """
    # Belt and braces with the utf-8-sig decode in _fetch(): a stored copy, a
    # test fixture or a future caller can hand this a string that still carries
    # the BOM, and it must not turn the first column into a different key.
    out: list[dict] = []
    for row in csv.DictReader(io.StringIO(text.lstrip("\ufeff"))):
        try:
            start = int((row["Start"] or "").strip(), 16)
            finish = int((row["Finish"] or "").strip(), 16)
        except (KeyError, TypeError, ValueError):
            continue
        if not 0 <= start <= finish <= _MAX_ADDRESS:
            continue
        country = (row.get("CountryISO2") or "").strip().upper()
        out.append(
            {
                "start": start,
                "finish": finish,
                # None covers two cases that mean the same thing to a reader:
                # the ZZ catch-all, and a row with no ISO2 at all. Neither one
                # can attribute an aircraft to a state.
                "country": None if country in ("", UNALLOCATED_ISO2) else country,
                "military": (row.get("IsMilitary") or "").strip() == "1",
            }
        )
    return out


def _address(icao24) -> int | None:
    """A Mode-S hex string -> its numeric address, or None if it is not one.

    Rejecting is as important as parsing here. readsb (and therefore
    airplanes.live) prefixes non-ICAO track identifiers with "~" -- a TIS-B or
    ADS-R target rebroadcast by ground infrastructure, whose "hex" is an
    arbitrary tracking number and not an allocation. int(..., 16) refuses it,
    which is exactly right: giving "~adfeb8" the country of block ADF800-ADFFFF
    would invent a nationality for a contact that has none.
    """
    if not icao24:
        return None
    try:
        addr = int(str(icao24).strip(), 16)
    except (TypeError, ValueError):
        return None
    return addr if 0 <= addr <= _MAX_ADDRESS else None


class CodeBlockTable:
    """The allocation table, ordered so that the matching rule is the ordering.

    The blocks are **not** independent ranges. A state's whole allocation is one
    row, and the military sub-block, and often a single specifically-assigned
    address, are further rows sitting inside it -- three rows can contain the
    same address, all with different `IsMilitary` values. The schema README
    states the rule: *look for the smallest range that contains the code*.

    So the list is sorted by span once, at construction, and a lookup returns
    the first containing range. Getting this wrong does not raise; it quietly
    returns the enclosing country-wide block, which for 010070 means calling an
    Egyptian military address civil.

    Why the range rule and not the bitmask one. The same README describes a
    second method -- iterate in descending `SignificantBitmask`, match on
    `addr & mask == bitmask` -- and calls it what other code does. The two are
    equivalent only for power-of-two-aligned ranges. Two rows are not:
    500000-5004FF (SM) and 682000-6824FF (MN) both derive a non-contiguous mask
    of FFFB00, and the bitmask test rejects 768 of the 1280 addresses their
    range covers, sending them to the ZZ catch-all instead of to San Marino and
    Mongolia. The range rule is the documented one and it is also the one that
    loses no aircraft, so it is what is implemented.

    Built whole per refresh and swapped in by a single rebind (the discipline
    gazetteer.py and sanctions.py use), so a lookup racing a refresh sees one
    complete table or the other, never a half-sorted one.
    """

    __slots__ = ("blocks", "_smallest_first")

    def __init__(self, blocks: list[dict] | None = None):
        self.blocks: list[dict] = blocks or []
        # THE RULE, expressed once. Country-less rows (the ZZ catch-all, and any
        # future row with a blank ISO2) are dropped from the search rather than
        # filtered per-lookup: a block that names no state cannot attribute one,
        # so the honest answer is to keep looking at the wider blocks. `start`
        # is a tiebreak only, to keep the order deterministic across refreshes.
        self._smallest_first = sorted(
            (b for b in self.blocks if b.get("country")),
            key=lambda b: (b["finish"] - b["start"], b["start"]),
        )

    def __len__(self) -> int:
        return len(self.blocks)

    @property
    def allocated(self) -> int:
        """Blocks that name a country -- i.e. that a lookup can actually return."""
        return len(self._smallest_first)

    def lookup(self, icao24) -> dict | None:
        """The smallest allocated block containing this address, or None.

        Linear over ~800 rows: measured at 24us per call, so 14ms for a full
        563-aircraft poll that runs every two minutes. A prefix index would be
        faster and would bury the rule inside a data structure; at this cost it
        is not worth trading the one for the other.
        """
        addr = _address(icao24)
        if addr is None:
            return None
        for block in self._smallest_first:
            if block["start"] <= addr <= block["finish"]:
                return {
                    "country": block["country"],
                    "military": block["military"],
                    # Which row answered, so a reader can see how specific the
                    # claim is: a single-address block is a named airframe, a
                    # /8 is a whole state's allocation.
                    "block": f"{block['start']:06X}-{block['finish']:06X}",
                }
        return None


# --- the live table --------------------------------------------------------

_table = CodeBlockTable()


def install(blocks: list[dict]) -> None:
    global _table
    _table = CodeBlockTable(blocks)


def current() -> CodeBlockTable:
    return _table


def lookup(icao24) -> dict | None:
    """Never raises and never blocks: an empty table (the file has not
    downloaded yet, or GitHub is unreachable) simply has no opinion, which is
    the correct thing to say about an allocation you cannot see."""
    return _table.lookup(icao24)


async def _fetch() -> list[dict]:
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        resp = await client.get(CODE_BLOCKS_URL)
        resp.raise_for_status()
        # utf-8-sig, not utf-8: raw.githubusercontent serves this as
        # text/plain with no charset, httpx guesses, and the BOM survives into
        # the first header name. See the module docstring.
        text = resp.content.decode("utf-8-sig")
    return parse_code_blocks(text)


async def _rehydrate(state) -> None:
    """Serve the last stored table until the live one downloads.

    lookup() answers "no opinion" against an empty table, which is safe but
    also wrong when we already have the allocation -- and with a 24-hour
    refresh that backs off to 24 hours on failure, one bad boot fetch would
    mean a whole day of aircraft with no country on them. Same reasoning, and
    same shape, as sanctions._rehydrate.
    """
    if await storage.warm_reference(state, "icao_blocks", "ICAO code blocks"):
        install(state.data)


async def start():
    state = registry.register("icao_blocks", key_configured=True)  # no key required
    await _rehydrate(state)
    consecutive_failures = 0
    while True:
        ok = False
        try:
            blocks = await _fetch()
            install(blocks)
            # Not point data -- an allocation has no position -- so state.data
            # holds the list purely so /api/health reports a meaningful
            # item_count and a stalled refresh is visible.
            state.data = blocks
            state.last_success = time.time()
            state.last_error = None
            ok = True
            table = current()
            log.info(
                "ICAO code blocks: %d rows, %d allocated to a country (%d military)",
                len(blocks),
                table.allocated,
                sum(1 for b in blocks if b["military"] and b["country"]),
            )
            # No lat/lon anywhere in an allocation, so it goes to the
            # whole-document store rather than the point store.
            await storage.record_reference("icao_blocks", blocks)
            await storage.record_source_health("icao_blocks", len(blocks), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("ICAO code blocks fetch failed: %s", exc)
            await storage.record_source_health("icao_blocks", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
