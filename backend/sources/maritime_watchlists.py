"""OpenSanctions' maritime collection: what somebody has said about a hull.

Like sanctions.py this draws nothing of its own. It answers a question about
ships that are already on the map -- but a different question from OFAC's, and
the difference is why it is a second source rather than more rows in the first.

OFAC answers "has the United States designated this hull". This file answers
"has *anyone* said anything about this hull, who were they, and what kind of
thing did they say". Verified live 2026-08-06: 4,984,859 bytes, 23,050 rows, of
which 20,328 are vessels covering 9,150 distinct IMO numbers -- against OFAC's
~1,500 -- and most of that reach is evidence OFAC does not carry at all.

    https://data.opensanctions.org/datasets/latest/maritime/maritime.csv

Keyless, ~5 MB, republished daily, and served with `ETag` + `Last-Modified` +
`Cache-Control: max-age=86400`, so the poll below is a conditional GET and an
unchanged day costs one 304 instead of five megabytes.

**Licence: CC BY-NC 4.0.** Non-commercial use has been confirmed for this
project, so it is cleared -- but attribution is a condition of the licence, not
a courtesy. It therefore travels on every match (`source`, `source_url`,
`licence`) rather than living in a comment here, because a comment is not what
a reader sees.

Three kinds of claim, kept as three kinds of claim
--------------------------------------------------

The `risk` column is a semicolon-joined token list, and the tokens are not
degrees of one thing. Distinct vessel IMOs behind each, and how many of those
OFAC does not list at all:

    token           IMOs   beyond OFAC  who says so                    class
    sanction       1,971          452   EU map, Canada, Switzerland,   designation
                                        UK FCDO, UN 1718, France
    mare.detained  6,681        6,488   Tokyo / Black Sea / Abuja      state_action
                                        MoU port-state control
    reg.warn         745          733   Paris MoU bans, MoU warning    state_action
                                        lists
    mare.shadow      849          468   ua_war_sanctions only          allegation
    poi            1,400          716   ua_war_sanctions only          allegation

A legal designation, a documented act by a port state, and an accusation are
three different strengths of claim about a ship, and the great majority of the
6,488 detentions are lifeboat and crew-wage deficiencies. Rendering all of it
as one "flagged" dot is exactly the failure dark_vessels.py's docstring exists
to prevent, so every match carries an explicit `evidence` class, the raw `risk`
tokens it was derived from, and a plain sentence saying what the class means.

**`mare.shadow` and `poi` come from one dataset, `ua_war_sanctions`, whose
publisher is the War&Sanctions portal of ГУР МО України -- the Main Directorate
of Intelligence of Ukraine's Ministry of Defence.** 849 hulls called "shadow
fleet" by a belligerent state's military intelligence service is an allegation
with a named and interested author. It may well be correct; it is not a
listing, and the reader is entitled to know which one they are looking at.

The `datasets` column carries that authorship *per row*, which is why listings
are kept per row here rather than flattened per hull: a tanker detained by the
Tokyo MoU and separately accused by ГУР carries two claims from two authors,
and merging them into one bag of tokens would lose which of them said what.

VESSEL rows only, and that is required rather than tidy
-------------------------------------------------------

2,722 of the 23,050 rows are ORGANIZATION. OpenSanctions' own manifest warns
that the `imo` column holds a *company* IMO on those -- a different registry
sharing the same number space -- so keeping them would turn a shipping
company's registration into a hull annotation on whatever ship happens to carry
the same seven digits.

What this list cannot tell you
------------------------------

**It carries no dates.** A Paris MoU ban from 2013 and a designation made this
week are indistinguishable rows in this file. The per-dataset
`entities.ftm.json` documents do carry `startDate` and an authority, but
reaching them is 8+ further downloads and a two-pass join, so it is not done
here. Every match instead carries `undated: True`, and the popup should say the
list does not date its entries rather than implying currency by staying quiet.

**Matching is IMO-only in practice.** There is not one call sign in the whole
file, and only 7,051 MMSIs against 19,535 IMOs, so sanctions.py's IMO -> MMSI
-> call-sign ladder degrades to a single rung. MMSI is still indexed for the
hulls that have one, and still reported as the weaker match it is (an MMSI is
reissued when a ship changes flag, which is a thing the ships on this list do).

The consequence is worth stating plainly: ais.py learns a hull's IMO only from
ShipStaticData, which arrives minutes apart at best and for some vessels never.
So an annotation lags first sighting, and misses outright any hull that never
broadcasts static data at all -- a population correlated with the one this list
is about. That is a limitation to state, not a bug to fix from this end.
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

log = logging.getLogger("osint-globe.maritime_watchlists")

MARITIME_URL = "https://data.opensanctions.org/datasets/latest/maritime/maritime.csv"

# The publisher's own cadence: the manifest at .../maritime/index.json declares
# daily coverage and the file is served with max-age=86400. Matching it exactly
# means the conditional GET below is asking at the moment there might be an
# answer, rather than collecting 304s.
REFRESH_INTERVAL = 24 * 3600
FAILURE_RETRY_INTERVAL = 300  # scaled by consecutive failures, capped at REFRESH_INTERVAL

# Attribution is a condition of CC BY-NC 4.0 and these strings are what carry
# it to the reader. They are attached to every match rather than logged once at
# startup, because the licence is about what gets shown, not what got fetched.
SOURCE_NAME = "OpenSanctions maritime collection"
SOURCE_URL = "https://www.opensanctions.org/datasets/maritime/"
LICENCE = "CC BY-NC 4.0"

# --- the evidence taxonomy -------------------------------------------------
#
# The whole reason this source was chosen. See the header: these three are
# different kinds of claim, not a severity scale, and the map is not allowed to
# collapse them.

DESIGNATION = "designation"
STATE_ACTION = "state_action"
ALLEGATION = "allegation"
# A token OpenSanctions has added since this file last looked, or a row with no
# risk token at all. Kept rather than dropped -- the hull is still in a maritime
# watchlist collection, and silently discarding it would hide a listing instead
# of qualifying it -- but it is never presented as one of the three above.
UNCLASSIFIED = "unclassified"

_RISK_EVIDENCE = {
    "sanction": DESIGNATION,
    "mare.detained": STATE_ACTION,
    "reg.warn": STATE_ACTION,
    "mare.shadow": ALLEGATION,
    "poi": ALLEGATION,
}

# Strongest claim first. Used only to pick which class heads a hull that has
# several; every class present is kept alongside it.
_EVIDENCE_ORDER = (DESIGNATION, STATE_ACTION, ALLEGATION, UNCLASSIFIED)

# What each class means, in the words the popup should use. Shipped on the match
# so that no renderer can put an evidence badge on screen without the sentence
# that says what the badge is claiming.
EVIDENCE_MEANING = {
    DESIGNATION: (
        "A government has formally designated this hull under a sanctions "
        "programme."
    ),
    STATE_ACTION: (
        "A port state has recorded an action against this hull -- a detention "
        "or a ban. Most port-state detentions are safety and crew-welfare "
        "deficiencies, not sanctions matters."
    ),
    ALLEGATION: (
        "A named party alleges this hull is involved in something. No listing "
        "authority has acted on it. Read who is making the claim before "
        "weighing it."
    ),
    UNCLASSIFIED: (
        "Listed in a maritime watchlist dataset under a risk tag this map does "
        "not recognise. See the dataset named below for what it means."
    ),
}

# Datasets whose authorship changes how the claim should be read, spelled out by
# hand. Deliberately short: the raw dataset id travels on every match anyway, and
# a confidently wrong friendly name is worse than an id a reader can look up.
_DATASET_PUBLISHERS = {
    "ua_war_sanctions": (
        "War&Sanctions -- Main Directorate of Intelligence of the Ministry of "
        "Defence of Ukraine (ГУР МО України)"
    ),
    "abuja_mou_detention": "Abuja MoU on Port State Control",
}

# Port-state control MoUs name themselves in their own dataset ids
# ("abuja_mou_detention", "black_sea_mou_..."), so the friendly name is derived
# from the id rather than guessed at from a table this file would have to keep
# in step with OpenSanctions.
_MOU_RE = re.compile(r"^(?P<region>[a-z_]+?)_mou(?:_|$)")

# How many separate listings to keep per hull. The file averages 2.2 vessel rows
# per IMO, so this only bites on a hull with a long detention history -- and
# `listing_count` records the true total, so the popup can say "12 of 30 shown"
# rather than quietly presenting a truncated list as complete.
MAX_LISTINGS_PER_HULL = 12
MAX_ALIASES_PER_HULL = 8

# OpenSanctions writes vessel IMOs as "IMO9427366". An IMO number is exactly
# seven digits; anything else in that column is a different number.
_IMO_DIGITS_RE = re.compile(r"(\d{7})")
_MMSI_DIGITS_RE = re.compile(r"^(\d{9})$")


def normalize_imo(value: str | None) -> str | None:
    """"IMO9427366" -> "9427366", and anything that is not an IMO -> None.

    Applied to both sides of a lookup: this file writes the prefix, AIS does
    not, and a key that matches only when both happen to agree on formatting is
    a key that silently never fires.
    """
    if not value:
        return None
    text = str(value).strip().upper()
    if text.startswith("IMO"):
        text = text[3:]
    digits = re.sub(r"\D", "", text)
    # Length checked before the regex search so that an eight-digit number is
    # rejected outright rather than having its first seven digits taken.
    if len(digits) != 7:
        return None
    match = _IMO_DIGITS_RE.fullmatch(digits)
    return match.group(1) if match else None


def _normalize_mmsi(value: str | None) -> str | None:
    if not value:
        return None
    digits = re.sub(r"\D", "", str(value))
    match = _MMSI_DIGITS_RE.match(digits)
    return match.group(1) if match else None


def _tokens(value: str | None) -> list[str]:
    """A semicolon-joined column -> its parts, in file order, deduplicated."""
    out: list[str] = []
    for part in (value or "").split(";"):
        part = part.strip()
        if part and part not in out:
            out.append(part)
    return out


def publisher_for(dataset: str) -> str:
    """A dataset id -> who stands behind it, for the popup.

    Thin on purpose. Only the datasets whose authorship changes how a claim
    should be weighed are named by hand; port-state MoUs are derived from their
    own ids; everything else falls back to the id with its underscores opened
    up. The raw id is on the record either way, so a reader is never left with
    only this function's opinion of who published something.
    """
    known = _DATASET_PUBLISHERS.get(dataset)
    if known:
        return known
    match = _MOU_RE.match(dataset)
    if match:
        region = match.group("region").replace("_", " ").title()
        return f"{region} MoU on Port State Control"
    return dataset.replace("_", " ")


def _classes_for(risk: list[str]) -> list[str]:
    """Risk tokens -> the evidence classes present, strongest first."""
    present = {_RISK_EVIDENCE.get(token, UNCLASSIFIED) for token in risk}
    ordered = [cls for cls in _EVIDENCE_ORDER if cls in present]
    # A row with no risk token at all is still a row in this collection.
    return ordered or [UNCLASSIFIED]


def _headline(classes: list[str]) -> str:
    for cls in _EVIDENCE_ORDER:
        if cls in classes:
            return cls
    return UNCLASSIFIED


def _extend_unique(target: list, values, cap: int | None = None) -> None:
    for value in values:
        if value and value not in target:
            if cap is not None and len(target) >= cap:
                return
            target.append(value)


def parse_maritime(text: str) -> list[dict]:
    """maritime.csv -> one merged entry per hull.

    Read by header name rather than by position: unlike OFAC's headerless
    SDN.CSV this file names its columns, and OpenSanctions adds columns between
    releases. DictReader turns a new column into a key nobody asks for, where
    positional reading would turn it into the wrong value in every field after
    it.

    Rows are merged per hull because 20,328 vessel rows describe 9,150 hulls --
    the same tanker detained by three different MoUs is three rows -- but each
    row survives as its own listing inside the entry, keeping its own risk
    tokens with its own publisher. That pairing is the point: it is what lets a
    popup say "detained by the Tokyo MoU, and separately alleged by Ukrainian
    military intelligence" instead of "flagged".
    """
    merged: dict[str, dict] = {}
    for row in csv.DictReader(io.StringIO(text)):
        # ORGANIZATION rows carry a *company* IMO in the same column. Taking
        # them would annotate hulls with shipping companies' registrations.
        if (row.get("type") or "").strip().upper() != "VESSEL":
            continue

        imo = normalize_imo(row.get("imo"))
        mmsi = _normalize_mmsi(row.get("mmsi"))
        if not imo and not mmsi:
            # No call signs exist anywhere in this file, so a row with neither
            # number cannot be matched to an AIS track by any means. Keeping it
            # would inflate the count with entries no lookup can ever reach.
            continue

        # Hulls with an IMO key on it; the ~800 vessel rows without one are kept
        # under their MMSI so they are at least reachable. They will not merge
        # with an IMO-keyed row for the same ship, which is the honest outcome:
        # nothing in the file says the two are the same hull.
        key = imo or f"mmsi:{mmsi}"

        risk = _tokens(row.get("risk"))
        datasets = _tokens(row.get("datasets"))
        classes = _classes_for(risk)
        caption = (row.get("caption") or "").strip() or None

        entry = merged.get(key)
        if entry is None:
            entry = merged[key] = {
                "key": key,
                "imo": imo,
                "mmsi": mmsi,
                "name": caption,
                "flag": (row.get("flag") or "").strip() or None,
                "countries": [],
                "aliases": [],
                "risk": [],
                "datasets": [],
                "evidence_classes": [],
                "listings": [],
                "listing_count": 0,
            }
        elif mmsi and not entry["mmsi"]:
            entry["mmsi"] = mmsi

        _extend_unique(entry["countries"], _tokens(row.get("countries")))
        _extend_unique(entry["aliases"], _tokens(row.get("aliases")), MAX_ALIASES_PER_HULL)
        # A second row naming the same hull differently is a rename, and a
        # rename is the whole game (see sanctions.py) -- so the caption that did
        # not win the name slot is kept as an alias rather than discarded.
        if caption and caption != entry["name"]:
            _extend_unique(entry["aliases"], [caption], MAX_ALIASES_PER_HULL)
        _extend_unique(entry["risk"], risk)
        _extend_unique(entry["datasets"], datasets)
        _extend_unique(entry["evidence_classes"], classes)

        entry["listing_count"] += 1
        if len(entry["listings"]) < MAX_LISTINGS_PER_HULL:
            entry["listings"].append({
                "evidence": _headline(classes),
                "evidence_classes": classes,
                "risk": risk,
                "datasets": datasets,
                "publishers": [publisher_for(dataset) for dataset in datasets],
                "url": (row.get("url") or "").strip() or None,
            })

    for entry in merged.values():
        entry["evidence_classes"] = [
            cls for cls in _EVIDENCE_ORDER if cls in entry["evidence_classes"]
        ]
        entry["evidence"] = _headline(entry["evidence_classes"])
    return list(merged.values())


class WatchlistIndex:
    """The collection, keyed by the two identifiers it can be matched on.

    Built whole per refresh and swapped in by a single rebind (same discipline
    as sanctions.py and gazetteer.py), so a lookup racing a refresh sees one
    complete index or the other, never a half-built one.
    """

    __slots__ = ("entries", "by_imo", "by_mmsi")

    def __init__(self, entries: list[dict] | None = None):
        self.entries: list[dict] = entries or []
        self.by_imo: dict[str, dict] = {}
        self.by_mmsi: dict[str, dict] = {}
        for entry in self.entries:
            if entry.get("imo"):
                self.by_imo.setdefault(entry["imo"], entry)
            if entry.get("mmsi"):
                # setdefault, not assignment: an MMSI is reissued when a ship
                # changes flag, so two hulls in this file can legitimately claim
                # the same one. First listing wins and the ambiguity is why the
                # match reports `matched_on`.
                self.by_mmsi.setdefault(entry["mmsi"], entry)

    def __len__(self) -> int:
        return len(self.entries)

    def _hit(self, entry: dict, matched_on: str) -> dict:
        """What travels on a ship's record.

        Everything here is either the claim, who made it, or a caveat on it.
        There is no score and no single "flagged" boolean, deliberately: any
        renderer reaching for one would have to pick which of a designation, a
        detention and an accusation it meant.
        """
        return {
            "listed_as": entry.get("name"),
            "evidence": entry.get("evidence", UNCLASSIFIED),
            "evidence_classes": entry.get("evidence_classes") or [UNCLASSIFIED],
            "evidence_note": EVIDENCE_MEANING[entry.get("evidence", UNCLASSIFIED)],
            "risk": entry.get("risk") or [],
            "datasets": entry.get("datasets") or [],
            "listings": entry.get("listings") or [],
            "listing_count": entry.get("listing_count", 0),
            "aliases": entry.get("aliases") or [],
            "flag": entry.get("flag"),
            "countries": entry.get("countries") or [],
            "matched_on": matched_on,
            # The file dates nothing. Said out loud on every match so the popup
            # can print the caveat rather than letting recency be assumed.
            "undated": True,
            "source": SOURCE_NAME,
            "source_url": SOURCE_URL,
            "licence": LICENCE,
        }

    def for_vessel(self, imo=None, mmsi=None) -> dict | None:
        """IMO first, MMSI second, and it stops at the first hit.

        The ordering is sanctions.py's, minus the call-sign rung this file
        cannot offer: an IMO is assigned to a hull for life and survives
        renaming, reflagging and resale, while an MMSI is tied to the radio
        licence and reissued on a change of flag -- which the ships on this list
        change constantly, so a stale MMSI can point at an innocent hull.
        """
        normalized_imo = normalize_imo(imo)
        if normalized_imo:
            entry = self.by_imo.get(normalized_imo)
            if entry:
                return self._hit(entry, "imo")
        normalized_mmsi = _normalize_mmsi(mmsi)
        if normalized_mmsi:
            entry = self.by_mmsi.get(normalized_mmsi)
            if entry:
                return self._hit(entry, "mmsi")
        return None


# --- the live index --------------------------------------------------------

_index = WatchlistIndex()

# The conditional-GET validators from the last download that actually parsed.
# Set only after a successful parse (see _fetch): storing them alongside a
# response that turned out to be unreadable would earn a 304 on the next poll
# and make the failure permanent until a restart.
_last_etag: str | None = None
_last_modified: str | None = None


def install(entries: list[dict]) -> None:
    global _index
    _index = WatchlistIndex(entries)


def current() -> WatchlistIndex:
    return _index


def for_vessel(imo=None, mmsi=None) -> dict | None:
    """Never raises and never blocks: an empty index (the file has not
    downloaded yet, or OpenSanctions is unreachable) simply has no opinion,
    which is the correct thing to say about a list you cannot see."""
    return _index.for_vessel(imo=imo, mmsi=mmsi)


class Unchanged(Exception):
    """OpenSanctions answered 304 -- what we hold is still current."""


async def _fetch() -> list[dict]:
    """The maritime CSV, conditionally.

    Raises Unchanged on a 304, which is a *success* with nothing to do, not a
    failure -- see start(), where it records a healthy poll against the index
    already in hand.
    """
    global _last_etag, _last_modified
    headers = {}
    if _last_etag:
        headers["If-None-Match"] = _last_etag
    if _last_modified:
        headers["If-Modified-Since"] = _last_modified
    # 180s rather than the usual 30: this is a 5 MB body, and the whole point of
    # the conditional GET above is that it is paid for at most once a day.
    async with httpx.AsyncClient(timeout=180, follow_redirects=True) as client:
        resp = await client.get(MARITIME_URL, headers=headers)
        if resp.status_code == 304:
            raise Unchanged()
        resp.raise_for_status()
        text = resp.content.decode("utf-8", "replace")

    entries = parse_maritime(text)
    if not entries:
        # A 200 that parses to nothing is what a renamed column looks like from
        # here, and it is indistinguishable from "no ships are listed today" if
        # it is allowed through. Raising keeps the index we already have and
        # leaves the validators stale so the next poll refetches rather than
        # collecting a 304 against a file it could not read.
        raise RuntimeError(
            f"{MARITIME_URL} returned {len(text)} bytes but no VESSEL rows "
            f"parsed out of it -- the column names have probably changed"
        )
    _last_etag = resp.headers.get("ETag")
    _last_modified = resp.headers.get("Last-Modified")
    return entries


async def _rehydrate(state) -> None:
    """Serve the last stored collection until the live one downloads.

    for_vessel answers "no opinion" against an empty index, which is the safe
    answer but the wrong one when the listing is already known -- and with a
    24-hour refresh that backs off to 24 hours, a bad boot fetch would otherwise
    cost a whole day of unannotated hulls.
    """
    if await storage.warm_reference(state, "maritime_watchlists", "OpenSanctions maritime"):
        install(state.data)


def _summary(entries: list[dict]) -> str:
    counts = {cls: 0 for cls in _EVIDENCE_ORDER}
    for entry in entries:
        counts[entry.get("evidence", UNCLASSIFIED)] += 1
    return ", ".join(f"{counts[cls]} {cls}" for cls in _EVIDENCE_ORDER)


async def start():
    state = registry.register("maritime_watchlists", key_configured=True)  # no key required
    await _rehydrate(state)
    consecutive_failures = 0
    while True:
        ok = False
        try:
            try:
                entries = await _fetch()
            except Unchanged:
                log.info(
                    "OpenSanctions maritime: unchanged (304), holding %d hulls",
                    len(current()),
                )
            else:
                install(entries)
                # Not point data -- a listing has no position -- so state.data is
                # the list itself purely so /api/health reports a meaningful
                # item_count and a stalled refresh is visible.
                state.data = entries
                log.info(
                    "OpenSanctions maritime: %d hulls (%s); %d by IMO, %d by MMSI",
                    len(entries), _summary(entries),
                    len(current().by_imo), len(current().by_mmsi),
                )
                # No lat/lon anywhere in a listing, so it goes to the
                # whole-document store rather than the point store.
                await storage.record_reference("maritime_watchlists", entries)
            state.last_success = time.time()
            state.last_error = None
            ok = True
            await storage.record_source_health("maritime_watchlists", len(current()), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("OpenSanctions maritime fetch failed: %s", exc)
            await storage.record_source_health("maritime_watchlists", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
