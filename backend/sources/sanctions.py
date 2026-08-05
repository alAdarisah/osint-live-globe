"""OFAC's Specially Designated Nationals list, reduced to things that move.

This source draws nothing on the map of its own. It answers one question about
markers that are already there: *is this particular ship or aircraft on the
list*. That is the difference between a tanker and a designated tanker sitting
dark off Fujairah, and it is the single highest-value annotation available for
free anywhere in this project.

The file is a headerless 12-column CSV of ~19,000 rows, of which ~1,500 are
vessels and ~340 aircraft. Its identifiers live in two places:

- **Structured**: the `Call_Sign` column for vessels, and `SDN_Name` for
  aircraft rows -- OFAC lists an aircraft *by* its tail number.
- **Free text**: IMO and MMSI numbers are written into the `Remarks` prose, as
  "Vessel Registration Identification IMO 7406784; f.k.a. 'ANA I'.". 1,517 of
  1,524 vessel rows carry an IMO there and 791 an MMSI.

Every match records **which identifier fired**, and the popup prints it. This
is not decoration. An IMO is permanent and hull-specific; an MMSI is reassigned
when a ship changes flag; an AIS call sign is free text typed by a crew. They
are three very different strengths of claim about the same hull, and a reader
told only "sanctioned" cannot tell which one they are looking at.

Nothing here matches on name. A vessel name is the easiest field in AIS to
change and the most commonly duplicated -- there are dozens of ships called
"VICTORY" -- so a name match would produce confident, wrong designations.
"""

import asyncio
import csv
import io
import logging
import re
import time

import httpx

from backend import storage
from backend.cache import registry

log = logging.getLogger("osint-globe.sanctions")

# OFAC's own publication endpoint. treasury.gov/ofac/downloads/sdn.csv still
# works but 302s here, so this is the destination rather than the redirect.
SDN_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV"
REFRESH_INTERVAL = 24 * 3600  # OFAC publishes changes on business days
FAILURE_RETRY_INTERVAL = 300  # scaled by consecutive failures, capped at REFRESH_INTERVAL

# Column positions in the headerless SDN.CSV. Pinned by name here because a
# headerless file does not raise on a wrong index -- it silently returns the
# neighbouring field, the same trap cities.py and gdelt.py document.
COL_ENT_NUM = 0
COL_NAME = 1
COL_SDN_TYPE = 2
COL_PROGRAM = 3
COL_TITLE = 4
COL_CALL_SIGN = 5
COL_VESSEL_TYPE = 6
COL_TONNAGE = 7
COL_GRT = 8
COL_VESSEL_FLAG = 9
COL_VESSEL_OWNER = 10
COL_REMARKS = 11
_COLUMNS = 12

# OFAC's null. Written with a trailing space in most rows and without it in
# some, so it is compared stripped.
_NULL = "-0-"

_IMO_RE = re.compile(r"\bIMO\s+(\d{7})\b")
_MMSI_RE = re.compile(r"\bMMSI\s+(\d{9})\b")
_TAIL_RE = re.compile(r"\bAircraft Tail Number\s+([A-Z0-9][A-Z0-9-]{2,9})\b", re.I)
# "f.k.a. 'ANA I'" / "a.k.a. 'SAND SWAN'" -- previous names, worth showing in
# the popup because a designated hull renaming itself is the whole game.
_ALIAS_RE = re.compile(r"\b[afn]\.k\.a\.\s+'([^']+)'", re.I)


def _clean(value: str | None) -> str | None:
    value = (value or "").strip()
    return None if not value or value == _NULL else value


def _normalize_id(value: str | None) -> str | None:
    """Registrations and call signs, reduced to a comparable key.

    Tail numbers are written "EP-GOL" by OFAC and may arrive from ADS-B as
    "EP-GOL" or "EPGOL"; call signs pick up stray spaces in AIS. Case and
    punctuation are noise in both, so they are stripped for the key while the
    original is kept for display.
    """
    if not value:
        return None
    key = re.sub(r"[^A-Z0-9]", "", value.upper())
    # Two characters is not an identifier, it is a coincidence waiting to match.
    return key if len(key) >= 3 else None


class SanctionsIndex:
    """The list, keyed by every identifier it can be matched on.

    Built whole per refresh and swapped in by a single rebind (same discipline
    as gazetteer.py), so a lookup racing a refresh sees one complete index or
    the other.
    """

    __slots__ = ("by_imo", "by_mmsi", "by_callsign", "by_tail", "entries")

    def __init__(self, entries: list[dict] | None = None):
        self.entries: list[dict] = entries or []
        self.by_imo: dict[str, dict] = {}
        self.by_mmsi: dict[str, dict] = {}
        self.by_callsign: dict[str, dict] = {}
        self.by_tail: dict[str, dict] = {}
        for entry in self.entries:
            if entry.get("imo"):
                self.by_imo.setdefault(entry["imo"], entry)
            if entry.get("mmsi"):
                self.by_mmsi.setdefault(entry["mmsi"], entry)
            for key in entry.get("callsign_keys") or ():
                self.by_callsign.setdefault(key, entry)
            for key in entry.get("tail_keys") or ():
                self.by_tail.setdefault(key, entry)

    def __len__(self) -> int:
        return len(self.entries)

    def _hit(self, entry: dict, matched_on: str) -> dict:
        """What travels on a ship's or aircraft's record.

        Deliberately small: the map needs the programme, the listed name, and
        -- above all -- which identifier matched. Everything else stays here.
        """
        return {
            "listed_as": entry["name"],
            "program": entry["program"],
            "sdn_type": entry["sdn_type"],
            "matched_on": matched_on,
            "aliases": entry.get("aliases") or [],
            "flag": entry.get("vessel_flag"),
            "owner": entry.get("vessel_owner"),
            "ent_num": entry.get("ent_num"),
        }

    def for_vessel(self, imo=None, mmsi=None, callsign=None) -> dict | None:
        """Strongest identifier first, and it stops at the first hit.

        The ordering is the point. An IMO number is assigned to a hull for life
        and survives renaming, reflagging and resale. An MMSI is tied to the
        radio licence and is reissued when a ship changes flag -- which
        sanctioned ships do constantly, so a stale MMSI can point at an
        innocent hull. A call sign is whatever the crew typed into the
        transponder.
        """
        for value, key, label in (
            (imo, self.by_imo, "imo"),
            (mmsi, self.by_mmsi, "mmsi"),
            (_normalize_id(callsign), self.by_callsign, "callsign"),
        ):
            if not value:
                continue
            entry = key.get(str(value).strip())
            if entry:
                return self._hit(entry, label)
        return None

    def for_aircraft(self, registration=None) -> dict | None:
        entry = self.by_tail.get(_normalize_id(registration) or "")
        return self._hit(entry, "registration") if entry else None


def parse_sdn(text: str) -> list[dict]:
    """SDN.CSV -> one entry per listed vessel or aircraft.

    Individuals and entities (the other ~17,000 rows) are dropped: nothing on
    this map is a person, and keeping them would mean carrying a 5 MB index to
    answer questions no layer asks.
    """
    entries: list[dict] = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < _COLUMNS:
            continue
        sdn_type = (_clean(row[COL_SDN_TYPE]) or "").lower()
        if sdn_type not in ("vessel", "aircraft"):
            continue
        name = _clean(row[COL_NAME])
        if not name:
            continue
        remarks = _clean(row[COL_REMARKS]) or ""

        imo_match = _IMO_RE.search(remarks)
        mmsi_match = _MMSI_RE.search(remarks)

        callsign = _clean(row[COL_CALL_SIGN])
        callsign_keys = [k for k in (_normalize_id(callsign),) if k]

        # OFAC lists an aircraft *by* its tail number -- SDN_Name is the
        # registration itself ("EP-GOL"), which is why this is the primary
        # source and the Remarks pattern only the secondary one: 342 aircraft
        # rows carry a name, 164 also spell the tail out in prose.
        tail_keys: list[str] = []
        if sdn_type == "aircraft":
            tail_keys = [k for k in (_normalize_id(name),) if k]
            for extra in _TAIL_RE.findall(remarks):
                key = _normalize_id(extra)
                if key and key not in tail_keys:
                    tail_keys.append(key)

        entries.append(
            {
                "ent_num": _clean(row[COL_ENT_NUM]),
                "name": name,
                "sdn_type": sdn_type,
                "program": _clean(row[COL_PROGRAM]),
                "imo": imo_match.group(1) if imo_match else None,
                "mmsi": mmsi_match.group(1) if mmsi_match else None,
                "callsign": callsign,
                "callsign_keys": callsign_keys,
                "tail_keys": tail_keys,
                "vessel_type": _clean(row[COL_VESSEL_TYPE]),
                "vessel_flag": _clean(row[COL_VESSEL_FLAG]),
                "vessel_owner": _clean(row[COL_VESSEL_OWNER]),
                "aliases": _ALIAS_RE.findall(remarks),
            }
        )
    return entries


# --- the live index --------------------------------------------------------

_index = SanctionsIndex()


def install(entries: list[dict]) -> None:
    global _index
    _index = SanctionsIndex(entries)


def current() -> SanctionsIndex:
    return _index


def for_vessel(imo=None, mmsi=None, callsign=None) -> dict | None:
    """Never raises and never blocks: an empty index (the file has not
    downloaded yet, or OFAC is unreachable) simply has no opinion, which is the
    correct answer to give about a sanctions listing you cannot see."""
    return _index.for_vessel(imo=imo, mmsi=mmsi, callsign=callsign)


def for_aircraft(registration=None) -> dict | None:
    return _index.for_aircraft(registration=registration)


async def _fetch() -> list[dict]:
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        resp = await client.get(SDN_URL)
        resp.raise_for_status()
        # The file is Latin-1 in practice and httpx will guess UTF-8 from the
        # absent charset; decoding explicitly avoids losing the accented owner
        # names rather than replacing them.
        text = resp.content.decode("cp1252", "replace")
    return parse_sdn(text)


async def start():
    state = registry.register("sanctions", key_configured=True)  # no key required
    consecutive_failures = 0
    while True:
        ok = False
        try:
            entries = await _fetch()
            install(entries)
            # Not point data -- there is nothing to place on a map -- so
            # state.data is the list itself purely so /api/health can report a
            # meaningful item_count and a stalled refresh is visible.
            state.data = entries
            state.last_success = time.time()
            state.last_error = None
            ok = True
            index = current()
            log.info(
                "OFAC SDN: %d listed vessels/aircraft (%d by IMO, %d by MMSI, %d by call sign, %d by tail)",
                len(entries),
                len(index.by_imo),
                len(index.by_mmsi),
                len(index.by_callsign),
                len(index.by_tail),
            )
            await storage.record_source_health("sanctions", len(entries), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("OFAC SDN fetch failed: %s", exc)
            await storage.record_source_health("sanctions", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
