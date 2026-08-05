"""Does the article agree with where the pin is?

GDELT geocodes each row by picking a place named somewhere in the article. That
is a guess about a document, not an observation of an event, and it fails in
ways the row itself cannot express: it lands on the dateline city the reporter
filed from, on an organisation whose name resolves as a settlement, or on a
national centroid standing in for "somewhere in this country". The measured
baseline (backend/scripts/eval_placement.py) has 37.9% of rows placed no better
than a region, a median 87 km from the nearest human-coded event, and a tail
past 1300 km.

This module reads the article's own text back against the coordinate and says
which of five things is true:

  confirmed        the text names a locality at (or near) the pin. Believe it.
  refined          the pin was on a country or region centroid and the text
                   names one unambiguous locality inside it. Move the pin and
                   record where it came from.
  contested        the text names a locality far from the pin. Do not move the
                   pin -- we know the geocode is doubtful, not what is right --
                   but stop presenting it as though it were certain.
  dateline_suspect the only place the article names is the one it was filed
                   from. This is the classic wrong-pin case, so it is demoted
                   hardest and is never allowed to move anything.
  unverified       no readable text, or none that names a resolvable place.
                   Exactly today's behaviour: leave the coordinate alone.

Two rules run through all of it.

  A verdict may only ever move a pin *up* the precision ladder. A country
  centroid can become a locality; a locality is never overwritten by something
  coarser. Disagreement lowers confidence, it does not relocate.

  Nothing here invents a coordinate. The text yields a *name*; the gazetteer
  turns names into coordinates. That keeps every placement traceable to a
  GeoNames row rather than to a heuristic.

Overrides are returned, never applied. The dict handed in is the same object
held in gdelt.py's accumulator, so mutating it would rewrite the archive's idea
of what GDELT originally said -- the same reason officials._snap_to_capital
returns rather than mutates.
"""

import logging
import re

from backend.sources import capitals, gazetteer, proximity
from backend.sources.gdelt import IMPRECISE_PRECISIONS

log = logging.getLogger("osint-globe.geoverify")

CONFIRMED = "confirmed"
REFINED = "refined"
CONTESTED = "contested"
DATELINE_SUSPECT = "dateline_suspect"
UNVERIFIED = "unverified"

# ACLED and UCDP rows are not machine-geocoded from an article at all -- a human
# coder read the reporting and named the place. There is nothing here to
# reconcile, and calling that "unverified" would rank the best-placed rows on
# the map alongside the worst.
STRUCTURED = "structured"

# Every field a verdict can contribute. Named once so the normalizers, the
# cluster merge and the serving layer cannot drift out of agreement about what
# a placement decision consists of.
GEO_FIELDS = (
    "geo_verdict",
    "geo_confidence",
    "geo_radius_km",
    "geo_text_place",
    "geo_place_id",
    "geo_reason",
    "original_lat",
    "original_lon",
    "original_geo_precision",
)

# A text place bigger than this is not a location, it is an area -- agreeing
# with the pin about "Ukraine" confirms nothing the precision field did not
# already say. Set just above gazetteer's largest city radius so a genuine
# metropolis still counts as a locality.
LOCALITY_MAX_RADIUS_KM = 32.0

# How far the text place may sit from the pin and still count as agreement.
# Compared against the *place's own* radius as well, so a pin 20 km from the
# centre of a 25 km-radius city is inside it and agrees, while a pin 20 km from
# a village does not.
AGREEMENT_SLACK_KM = 15.0

# Past this, the text and the geocode are talking about different places rather
# than disagreeing about a boundary. Deliberately well beyond any city: at
# 100 km the two cannot both be right.
CONTEST_KM = 100.0

# How close the places an article names must be to each other for the article to
# count as being *about* one place. A dispatch on a single incident stays within
# a province; a round-up or an analysis piece ranges across a country. Only the
# first kind can contradict a coordinate -- the second has no single location to
# contradict it with.
CONSISTENCY_KM = 150.0

# Confidence, 0-100, that the coordinate is where the event happened. Separate
# from severity on purpose -- a large event we cannot place and a small one we
# can are different claims, and one number cannot carry both.
_VERDICT_CONFIDENCE = {
    CONFIRMED: 90,
    REFINED: 78,
    CONTESTED: 25,
    DATELINE_SUSPECT: 12,
}

# How much confidence a verdict loses when the page it was read from is not one
# we vouch for. Provenance is priced in here rather than used as a veto: an
# allowlist veto made the refinement path inert (almost no conflict row has an
# allowlisted article), while a discount keeps the placement improvement and
# still ranks a Reuters reading above a content farm's.
_UNTRUSTED_PENALTY = 16

# Fallback when nothing corroborates the coordinate: how much the upstream
# precision alone is worth. These are the numbers a row scores today, made
# explicit.
_PRECISION_CONFIDENCE = {
    "locality": 65,
    "capital": 30,
    "region": 35,
    "country": 15,
    "unknown": 12,
}

# Radius to draw when no gazetteer place backs the coordinate. Mirrors
# gazetteer.radius_km_for's feature-code table one level up, in the vocabulary
# gdelt.py speaks.
_PRECISION_RADIUS_KM = {
    "locality": 15.0,
    "capital": 25.0,
    "region": 120.0,
    "country": 400.0,
    "unknown": 400.0,
}


# --- pulling place names out of prose --------------------------------------

# Names are found by tokenising and testing each token's own case, not by
# matching a character-range regex. Any explicit range is wrong somewhere:
# "Ḩalab" (U+1E28, Latin Extended Additional) and "Херсон" (Cyrillic) both fall
# outside the obvious A-Z / À-Þ classes, and both are names the gazetteer
# indexes and would then never be asked about.
#
# str.isupper() carries the whole Unicode case table, so this covers every cased
# script -- Latin with any diacritic, Cyrillic, Greek, Armenian. It cannot cover
# uncased scripts (Arabic, Hebrew, CJK): there is no capitalisation to key on,
# and treating every token as a candidate would flood the resolver with noise.
# Those articles fall through to `unverified`, which is the honest outcome and
# costs little in practice -- the outlet allowlist is almost entirely
# English-language.
_TOKEN_RE = re.compile(r"[^\W\d_]+(?:['’ʹʻʼ-][^\W\d_]+)*", re.UNICODE)

# Lower-case words that sit *inside* a proper name rather than ending it:
# "Isle of Man", "Ras al Khaimah", "Rio de Janeiro".
_NAME_CONNECTORS = frozenset({
    "of", "the", "al", "el", "az", "ad", "an", "de", "du", "da", "la", "le", "van", "von",
})

# Longest token run treated as one name.
_MAX_NAME_WORDS = 4

# Words that open sentences and resolve to real places. "Israeli forces" is not
# a report from a town called Israeli; "March" is a month far more often than it
# is a settlement. Kept small on purpose -- every entry here is a place the
# module is choosing to be blind to, so it earns its way in by being a common
# false positive rather than by being imaginable.
_STOPWORDS = frozenset({
    "the", "a", "an", "and", "but", "for", "on", "in", "at", "by", "to", "from",
    "this", "that", "these", "those", "there", "here", "it", "its", "he", "she",
    "they", "we", "you", "his", "her", "their", "our",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december",
    "president", "minister", "ministry", "government", "army", "military",
    "police", "forces", "official", "officials", "reuters", "ap", "afp",
    "north", "south", "east", "west", "central", "northern", "southern",
    "eastern", "western", "state", "states", "city", "town", "village",
    "district", "region", "province", "county", "border", "war", "attack",
})

# How many distinct candidate names to resolve per article. The opening
# paragraphs carry the event's location; deeper in, an article drifts into
# background and other datelines, and every extra name is another chance to
# match the wrong one. Windows rather than prefixes means one run yields
# several forms, so this is a budget of lookups, not of distinct places.
MAX_CANDIDATE_NAMES = 60


def _runs(text: str) -> list[list[str]]:
    """Adjacent capitalised tokens, grouped into candidate names.

    Adjacency is strict: the tokens must be separated by whitespace only. A
    comma is a boundary, so "Kherson, Khersons'ka Oblast', Ukraine" is three
    names rather than one -- which is what it is.
    """
    runs: list[list[str]] = []
    current: list[str] = []
    pending_connector: str | None = None
    previous_end = -1

    for match in _TOKEN_RE.finditer(text):
        token = match.group(0)
        gap = text[previous_end:match.start()] if previous_end >= 0 else ""
        adjacent = previous_end >= 0 and gap.strip() == ""
        previous_end = match.end()

        capitalised = token[:1].isupper()
        if capitalised and current and adjacent:
            if pending_connector:
                current.append(pending_connector)
                pending_connector = None
            current.append(token)
        elif capitalised:
            if current:
                runs.append(current)
            current = [token]
            pending_connector = None
        elif current and adjacent and token.lower() in _NAME_CONNECTORS:
            # Held rather than appended: a connector only belongs to the name if
            # another capitalised token follows it. "Isle of" is not a place.
            pending_connector = token
        else:
            if current:
                runs.append(current)
            current = []
            pending_connector = None

    if current:
        runs.append(current)
    return runs


def candidate_names(text: str) -> list[str]:
    """Place-name candidates from `text`, in reading order, longest first.

    Every contiguous window of a run is emitted, not just its prefixes. A
    capitalised word in front of the place name is the normal case, not the
    exception -- a title-cased headline ("Strike On Kherson Market Kills
    Three") and a Ukrainian sentence ("Обстріл Херсон") both put the place in the
    middle of a run, and a prefix-only scan would never ask about it.

    Longest window first, because the longest is what the text actually said;
    shorter windows exist only in case the gazetteer does not carry it.
    _resolve_text_places relies on that order to discard the fragments of a
    name that already resolved.
    """
    if not text:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for run in _runs(text):
        for length in range(min(len(run), _MAX_NAME_WORDS), 0, -1):
            for start in range(len(run) - length + 1):
                words = run[start:start + length]
                # A connector belongs inside a name, never at either end:
                # "Isle of Man" is a place, "Isle of" and "of Man" are the
                # fragments a window scan would otherwise manufacture.
                if words[0].lower() in _NAME_CONNECTORS or words[-1].lower() in _NAME_CONNECTORS:
                    continue
                # A window made entirely of stopwords is prose. One that merely
                # starts with a stopword ("New York") is not, so every word is
                # tested.
                if all(w.lower().strip(".") in _STOPWORDS for w in words):
                    continue
                name = " ".join(words)
                if len(name) < 3:
                    continue
                key = name.lower()
                if key in seen:
                    continue
                seen.add(key)
                out.append(name)
                if len(out) >= MAX_CANDIDATE_NAMES:
                    return out
    return out


def _resolve_text_places(
    names: list[str], iso2: str | None, index: gazetteer.Gazetteer
) -> list[tuple[str, gazetteer.Candidate]]:
    """(surface name, best gazetteer candidate) for every name that resolves.

    Ambiguous names are dropped rather than guessed at: this list decides
    whether a pin moves, and "Tripoli, we picked one" is precisely the mistake
    the gazetteer returns candidates to prevent.
    """
    resolved: list[tuple[str, gazetteer.Candidate]] = []
    accepted_keys: list[str] = []
    for name in names:
        key = name.lower()
        # A shorter form of a name that already resolved is the same mention.
        # Without this, "New York Mills" resolving would still leave "New York"
        # to resolve separately and compete with it.
        if any(f" {key} " in f" {taken} " for taken in accepted_keys):
            continue
        candidates = index.resolve(name, country_code=iso2)
        if not candidates or index.is_ambiguous(candidates):
            continue
        resolved.append((name, candidates[0]))
        accepted_keys.append(key)
    return resolved


def _localities(
    resolved: list[tuple[str, gazetteer.Candidate]], iso2: str | None
) -> list[tuple[str, gazetteer.Candidate]]:
    """The place-sized entries, in reading order, preferring the stated country.

    Order is the text's own. An article names where it happened early and drifts
    into background later, so first-mentioned is the best single guess -- and it
    is a far better one than "most specific", which was the first thing tried
    here and was wrong: a passing mention of a small village outranked the city
    the piece was actually about, purely because the village is smaller.
    """
    localities = [
        (name, cand) for name, cand in resolved if cand.radius_km <= LOCALITY_MAX_RADIUS_KM
    ]
    if iso2:
        in_country = [(n, c) for n, c in localities if c.place.country_code == iso2]
        if in_country:
            return in_country
    return localities


def _agrees_with_pin(
    localities: list[tuple[str, gazetteer.Candidate]], lat: float, lon: float
) -> tuple[str, gazetteer.Candidate, float] | None:
    """The closest named place that is near enough to the pin to confirm it.

    Asked of the whole set rather than of one chosen place. "Does this article
    name somewhere at the pin?" is a question about the article, and answering
    it by picking one name first meant a piece that named both the pin's city
    and somewhere else could be judged to contradict itself.
    """
    best = None
    for name, cand in localities:
        distance = proximity.haversine_km(lat, lon, cand.place.lat, cand.place.lon)
        if distance <= max(cand.radius_km, AGREEMENT_SLACK_KM):
            if best is None or distance < best[2]:
                best = (name, cand, distance)
    return best


def _text_is_consistent(
    localities: list[tuple[str, gazetteer.Candidate]], anchor: gazetteer.Candidate
) -> bool:
    """Do the places the article names agree with each other?

    A dispatch about one incident names one area. A round-up, an analysis piece,
    or a story with a lot of background names places scattered across a country,
    and *that* text cannot contradict a coordinate -- it has no single location
    to contradict it with. Requiring agreement is what keeps "the article
    mentions somewhere else" from being reported as "the pin is wrong".
    """
    if len(localities) == 1:
        return True
    near = sum(
        1 for _, cand in localities
        if proximity.haversine_km(
            anchor.place.lat, anchor.place.lon, cand.place.lat, cand.place.lon
        ) <= CONSISTENCY_KM
    )
    return near * 2 > len(localities)


# --- the verdict -----------------------------------------------------------


def reconcile(row: dict, index: gazetteer.Gazetteer | None = None) -> dict:
    """Overrides describing how much to trust `row`'s coordinate, and why.

    Always returns a dict, never None: every row gets a verdict, a radius and a
    confidence, because "we did not check" and "we checked and found nothing"
    have to be distinguishable downstream and a missing key cannot do that.

    The caller applies the result with `row = {**row, **reconcile(row)}` or
    equivalent. Nothing here mutates `row`.
    """
    index = index or gazetteer.current()
    precision = (row.get("geo_precision") or "unknown").strip() or "unknown"
    lat, lon = row.get("lat"), row.get("lon")

    unchecked = _unverified(precision, reason="no-coordinate")
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return unchecked

    # "Was this article ever looked at?" -- the key's presence, not its value.
    # A fetch that returned no body and a row nobody fetched are different
    # states, and only the first licenses any conclusion about what the text
    # does or does not say.
    scraped = "article_excerpt" in row
    text = " ".join(
        part for part in (row.get("real_title"), row.get("article_excerpt")) if part
    ).strip()
    if not scraped or not text:
        return _unverified(precision, reason="no-text")

    iso2 = capitals.to_iso2(row.get("geo_country_code"))
    resolved = _resolve_text_places(candidate_names(text), iso2, index)
    if not resolved:
        return _unverified(precision, reason="no-place-in-text")

    dateline = (row.get("dateline_place") or "").strip() or None
    dateline_key = gazetteer.normalize(dateline) if dateline else None

    non_dateline = [
        (name, cand) for name, cand in resolved
        if not dateline_key or gazetteer.normalize(name) != dateline_key
    ]

    # Every place the article names is the one it was filed from. GDELT will
    # have geocoded to that place and it is the reporter's desk, not the event.
    if dateline_key and not non_dateline:
        return {
            "geo_verdict": DATELINE_SUSPECT,
            "geo_confidence": _VERDICT_CONFIDENCE[DATELINE_SUSPECT],
            "geo_radius_km": _radius_for_precision(precision),
            "geo_text_place": dateline,
            "geo_reason": "the only place named is the dateline",
        }

    localities = _localities(non_dateline, iso2)
    if not localities:
        # The text names places, but only areas -- "Sudan", "the Sahel". That is
        # agreement about a region, which the precision field already says.
        return _unverified(precision, reason="text-names-no-locality")

    # Does the article name anywhere at the pin? Asked of every place it names,
    # before choosing between them -- a piece that names both the pin's city and
    # somewhere else is corroborating the pin, not contradicting it.
    agreement = _agrees_with_pin(localities, lat, lon)
    if agreement is not None:
        name, candidate, distance_km = agreement
        return {
            "geo_verdict": CONFIRMED,
            "geo_confidence": _VERDICT_CONFIDENCE[CONFIRMED],
            "geo_radius_km": candidate.radius_km,
            "geo_text_place": name,
            "geo_place_id": candidate.place.geonameid,
            "geo_reason": f"the report names {name}, {distance_km:.0f} km from the pin",
        }

    # Nothing named is at the pin. The first place named is the article's own
    # claim about where this happened.
    name, candidate = localities[0]
    place = candidate.place
    distance_km = proximity.haversine_km(lat, lon, place.lat, place.lon)

    # ...but only if the article is talking about one place at all. A round-up
    # or an analysis piece names somewhere in six different provinces, and text
    # like that cannot contradict a coordinate because it has no single location
    # to contradict it with. Measured before this check, two thirds of all rows
    # came back "contested" -- which was not GDELT being wrong two thirds of the
    # time, it was this layer reading scattered background mentions as a claim.
    if not _text_is_consistent(localities, candidate):
        return _unverified(precision, reason="the report names places far apart")

    # The pin is on something coarser than a place and the text names exactly
    # one consistent place inside it. This is the upgrade the whole layer exists
    # for, and it is *only* offered on pins whose placement we already admit we
    # do not know: a country-centroid row carries ~400 km of error before this
    # runs, so moving it to a named town in the same country cannot be much
    # worse and is usually far better. Refining a locality pin could genuinely
    # do harm, which is why the precision gate above forbids it.
    #
    # Deliberately *not* gated on the outlet allowlist. That was tried, and it
    # made the layer inert: measured over a live window, close to zero rows
    # passing the violence gate have an allowlisted article, so refinement fired
    # on 0.4% of rows and the 30% of pins sitting on national centroids stayed
    # there. The allowlist answers "do we vouch for this newsroom's claims",
    # which is a different question from "did this page name a town correctly" --
    # and the constraints that actually make the move safe (unambiguous in the
    # gazetteer, inside the country GDELT already named, consistent with the
    # rest of the article, not the dateline) do not depend on the masthead.
    # Provenance is priced into the confidence instead.
    if precision in IMPRECISE_PRECISIONS and (not iso2 or place.country_code == iso2):
        return {
            "lat": place.lat,
            "lon": place.lon,
            "geo_precision": "locality",
            "geo_verdict": REFINED,
            "geo_confidence": (
                _VERDICT_CONFIDENCE[REFINED] if row.get("article_trusted")
                else _VERDICT_CONFIDENCE[REFINED] - _UNTRUSTED_PENALTY
            ),
            "geo_radius_km": candidate.radius_km,
            "geo_text_place": name,
            "geo_place_id": place.geonameid,
            # Kept so the move is auditable and reversible, the same three
            # fields officials._snap_to_capital records when it moves a pin.
            "original_lat": lat,
            "original_lon": lon,
            "original_geo_precision": precision,
            "geo_reason": (
                f"placed only to {precision}; the report names {name}"
            ),
        }

    if distance_km > CONTEST_KM:
        return {
            "geo_verdict": CONTESTED,
            "geo_confidence": _VERDICT_CONFIDENCE[CONTESTED],
            # The disagreement itself is the uncertainty: the truth is
            # somewhere between the two claims, so the ring has to cover both.
            "geo_radius_km": max(distance_km, candidate.radius_km),
            "geo_text_place": name,
            "geo_place_id": place.geonameid,
            "geo_reason": (
                f"the report names {name}, {distance_km:.0f} km from the pin"
            ),
        }

    # Between the agreement tolerance and the contest threshold on an already
    # locality-precision pin: two nearby places, no basis for preferring ours
    # over GDELT's. Say so rather than pretending either.
    return {
        "geo_verdict": CONFIRMED,
        "geo_confidence": _VERDICT_CONFIDENCE[CONFIRMED] - 20,
        "geo_radius_km": max(distance_km, candidate.radius_km),
        "geo_text_place": name,
        "geo_place_id": place.geonameid,
        "geo_reason": f"the report names {name}, {distance_km:.0f} km from the pin",
    }


def for_structured() -> dict:
    """The placement verdict for a human-coded ACLED/UCDP row.

    Confidence is high but not maximal, and the radius is a few kilometres
    rather than zero: a coder names a settlement, not a street corner, so the
    honest ring is the settlement.
    """
    return {
        "geo_verdict": STRUCTURED,
        "geo_confidence": 92,
        "geo_radius_km": 5.0,
        "geo_text_place": None,
        "geo_reason": "coded to a named place by a human reviewer",
    }


def _unverified(precision: str, reason: str) -> dict:
    return {
        "geo_verdict": UNVERIFIED,
        "geo_confidence": _PRECISION_CONFIDENCE.get(precision, 12),
        "geo_radius_km": _radius_for_precision(precision),
        "geo_text_place": None,
        "geo_reason": reason,
    }


def _radius_for_precision(precision: str) -> float:
    return _PRECISION_RADIUS_KM.get(precision, _PRECISION_RADIUS_KM["unknown"])
