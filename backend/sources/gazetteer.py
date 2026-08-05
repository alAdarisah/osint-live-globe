"""Offline place-name -> coordinate resolution, and how uncertain that is.

Until this module existed the backend had no geocoder at all. Every coordinate
on the map arrived pre-geocoded from upstream -- GDELT's ActionGeo_Lat/Long,
ACLED's and UCDP's own latitude/longitude -- which meant that for the ~92% of
conflict rows that come from GDELT, the pin was GDELT's machine guess about an
article, and nothing here could check it. This is the reference the check runs
against.

Two things are exported:

  resolve(name, ...)  -- every place that could plausibly be called `name`,
                         ranked, each with the evidence for the ranking. It
                         returns candidates rather than an answer: "Tripoli" is
                         genuinely two cities in two countries, and collapsing
                         that to one point is the failure mode this module
                         exists to stop.

  radius_km_for(...)  -- how large a circle actually contains the place. A
                         national centroid is not a location, it is a 400 km
                         circle drawn as a dot, and the map should say so.

Source is GeoNames' cities500 dump: every populated place over 500 people,
plus every administrative seat regardless of size (~200k rows), together with
the admin1/admin2 code tables so an oblast or a district resolves too. Village
resolution matters -- a strike on a 900-person village in Kherson oblast is
exactly the case the old pipeline drew on the oblast centroid.

Deliberately *not* using GeoNames' separate alternateNamesV2 dump: cities500's
own column 3 already carries the transliterations ("Kherson" / "Херсон" /
"Cherson"), and the standalone file is a ~200MB download for names this one
already has.

Everything is held in memory, like cities.py and capitals.py, rather than in
Postgres. Placement accuracy must not depend on the database being up -- every
storage write in this codebase is already a failure-tolerant no-op when the
pool is down (see backend/storage.py), and a geocoder that silently stopped
resolving in that state would move pins rather than merely stop recording them.
"""

import asyncio
import io
import logging
import math
import time
import unicodedata
import zipfile
from dataclasses import dataclass

import httpx

from backend import storage
from backend.cache import registry

log = logging.getLogger("osint-globe.gazetteer")

CITIES_URL = "http://download.geonames.org/export/dump/cities500.zip"
ADMIN1_URL = "http://download.geonames.org/export/dump/admin1CodesASCII.txt"
ADMIN2_URL = "http://download.geonames.org/export/dump/admin2Codes.txt"

# Same cadence as cities.py. Place names and populations do not move fast, and
# the whole point of an offline gazetteer is that it is not in the request path.
REFRESH_INTERVAL = 24 * 3600
FAILURE_RETRY_INTERVAL = 120

# Column indices in cities500.txt, the same headerless 19-column layout
# cities15000.txt uses (backend/sources/cities.py:22-28). Read by position out
# of a headerless file, so a wrong index does not raise -- it silently returns
# a neighbouring field. Pinned by test_gazetteer.py.
COL_GEONAME_ID = 0
COL_NAME = 1
COL_ASCII_NAME = 2
COL_ALTERNATE_NAMES = 3
COL_LAT = 4
COL_LON = 5
COL_FEATURE_CLASS = 6
COL_FEATURE_CODE = 7
COL_COUNTRY_CODE = 8
COL_ADMIN1 = 10
COL_ADMIN2 = 11
COL_POPULATION = 14

# How many of a row's alternate names to index. GeoNames lists up to a few
# hundred for a major capital (every language it has a name in); the first
# handful carry the transliterations and endonyms that actually appear in
# conflict reporting, and the tail is memory spent on languages no source here
# publishes in.
MAX_ALTERNATE_NAMES = 12

# Alternate names shorter than this are abbreviations and airport codes ("KBP",
# "NY") that collide catastrophically across the index.
MIN_ALTERNATE_NAME_LENGTH = 4


@dataclass(frozen=True, slots=True)
class Place:
    """One resolvable place. `slots` matters: this holds ~200k instances."""

    geonameid: int
    name: str
    country_code: str
    admin1: str
    admin2: str
    feature_class: str
    feature_code: str
    population: int
    lat: float
    lon: float


@dataclass(frozen=True, slots=True)
class Candidate:
    """A place that could be what a piece of text meant, and how sure we are.

    `score` is 0-1 and is *relative ranking evidence*, not a probability -- it
    exists so a caller can tell "one obvious answer" from "three equally good
    answers", which is the distinction that decides whether a pin may move.
    """

    place: Place
    score: float
    matched_name: str
    radius_km: float


# --- how big is a place, really -------------------------------------------
#
# These are the numbers the map's uncertainty ring is drawn from, so they are
# claims about the world and belong in one table rather than scattered at the
# call sites. They are first approximations, deliberately: the whole point of
# backend/scripts/eval_placement.py is that they get tuned against measured
# placement error rather than argued about.

# An administrative division is represented by a single point but occupies a
# region; these are median-ish radii, not maxima.
_ADMIN_RADIUS_KM = {
    "ADM1": 120.0,   # an oblast, a state, a governorate
    "ADM1H": 120.0,
    "ADM2": 40.0,    # a raion, a county, a district
    "ADM2H": 40.0,
    "ADM3": 15.0,
    "ADM4": 8.0,
    "ADMD": 40.0,
}

# A country centroid. Egypt and Monaco are both "a country", so this is a
# blunt instrument -- country_radius_km() below refines it from Natural Earth's
# actual geometry whenever the countries source has loaded.
_COUNTRY_RADIUS_KM = 400.0
_COUNTRY_FEATURE_CODES = frozenset({"PCLI", "PCL", "PCLD", "PCLF", "PCLIX", "PCLS"})

# Anything unrecognised. Deliberately coarser than a district: an unknown
# feature code means we do not know what kind of thing this is, and the one
# direction an uncertainty ring must never err in is "smaller than the truth".
# Kept below ADM1 so it does not out-claim a division we *did* identify.
_DEFAULT_RADIUS_KM = 50.0

# A populated place's radius scales with population, but sublinearly -- a city
# of 10M is not 1000x the area of one of 10k. Calibrated so 10k -> ~1.5 km,
# 1M -> ~9.5 km, 10M -> ~24 km, which is roughly built-up area.
_POP_RADIUS_MIN_KM = 1.0
_POP_RADIUS_MAX_KM = 30.0


def radius_km_for(feature_code: str, population: int = 0) -> float:
    """The radius of the circle that actually contains this place.

    This is what backend/sources/geoverify.py compares distances against and
    what the frontend draws as the uncertainty ring -- so "how far from the
    stated point could the truth be" is the question it answers, not "how big
    is the settlement".
    """
    code = (feature_code or "").strip().upper()
    if code in _COUNTRY_FEATURE_CODES:
        return _COUNTRY_RADIUS_KM
    if code in _ADMIN_RADIUS_KM:
        return _ADMIN_RADIUS_KM[code]
    if code.startswith("PPL"):
        if population <= 0:
            # A populated place GeoNames has no population for is a small one;
            # it is in cities500 at all because it is an administrative seat.
            return 3.0
        scaled = 1.5 * (population / 10_000.0) ** 0.4
        return max(_POP_RADIUS_MIN_KM, min(_POP_RADIUS_MAX_KM, scaled))
    return _DEFAULT_RADIUS_KM


def country_radius_km(country_code: str) -> float:
    """A country's own radius, from Natural Earth geometry when available.

    Falls back to the blunt constant before the countries source's first poll,
    or for a code Natural Earth does not carry. Reads the same
    FeatureCollection the countries layer serves and reuses regions.py's bbox
    walker rather than a second geometry implementation.
    """
    code = (country_code or "").strip().upper()
    if not code or not registry.has("countries"):
        return _COUNTRY_RADIUS_KM
    try:
        from backend import regions

        fc = registry.get("countries").data
        if not isinstance(fc, dict):
            return _COUNTRY_RADIUS_KM
        for feature in fc.get("features") or ():
            props = feature.get("properties") or {}
            if code not in {
                str(props.get(key, "")).upper()
                for key in ("ISO_A2", "iso_a2", "ISO_A2_EH", "WB_A2")
            }:
                continue
            south, west, north, east = regions._feature_bbox(feature)
            # Half the diagonal of the bounding box, in km. An overestimate for
            # a country shaped like Chile and an underestimate for one shaped
            # like a disc -- but the honest direction for an uncertainty ring
            # is "at least this big".
            lat_km = (north - south) * 110.574
            mid_lat = math.radians((north + south) / 2.0)
            lon_km = (east - west) * 111.32 * max(math.cos(mid_lat), 0.05)
            return max(50.0, math.hypot(lat_km, lon_km) / 2.0)
    except Exception:  # noqa: BLE001 - a geometry surprise must not break placement
        log.debug("Country radius lookup failed for %s", code, exc_info=True)
    return _COUNTRY_RADIUS_KM


# --- name normalization ----------------------------------------------------

# Characters that appear inside place names as punctuation rather than as part
# of the name: Khersons'ka, Ra's al-Khaymah, Saint-Denis, N'Djamena.
_PUNCT_TO_SPACE = str.maketrans({c: " " for c in "-–—_/\\.,()[]{}"})

# Every apostrophe-shaped character GeoNames actually uses, not just the ASCII
# one. Slavic and Arabic transliterations are full of modifier letters --
# "Lʹviv" (U+02B9), "Ḩalab ʻAdrā" (U+02BB), "Ra'ʼs" (U+02BC) -- and these are
# *letters* to Unicode, so neither NFKD nor a combining-mark filter removes
# them. Missing one means "Lʹviv" and "Lviv" fold to different keys and the
# same city fails to resolve depending on which source spelled it.
_PUNCT_TO_NOTHING = str.maketrans(
    {c: "" for c in "'’‘‛`´ʹʺʻʼʽˈ′″\"«»"}
)


def normalize(name: str) -> str:
    """Fold a place name to the key both sides of a comparison are stored under.

    Diacritics go (Lviv/Lʹviv, Al-Ḥudaydah/Al Hudaydah), apostrophes go, other
    punctuation becomes a space, case goes, runs of whitespace collapse.
    Non-Latin scripts pass through unchanged apart from case -- there is nothing
    to fold in Херсон, and its Latin transliteration is indexed separately as an
    alternate name rather than synthesized here.
    """
    if not name:
        return ""
    text = unicodedata.normalize("NFKD", name)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.translate(_PUNCT_TO_NOTHING).translate(_PUNCT_TO_SPACE)
    return " ".join(text.lower().split())


# --- the index -------------------------------------------------------------


class Gazetteer:
    """A resolvable name index over a set of Places.

    Built once per refresh and swapped in whole, so a lookup never sees a
    half-built index. Held as one object rather than module globals so a test
    can build a three-row gazetteer without touching the network.
    """

    __slots__ = ("_places", "_by_name", "_by_id")

    def __init__(self, places: list[Place], alternates: dict[int, list[str]] | None = None):
        self._places: list[Place] = places
        self._by_id: dict[int, Place] = {p.geonameid: p for p in places}
        # normalized name -> [(geonameid, surface form, is_primary)]
        self._by_name: dict[str, list[tuple[int, str, bool]]] = {}
        for place in places:
            self._add_name(place.geonameid, place.name, primary=True)
        for geonameid, names in (alternates or {}).items():
            for alt in names:
                self._add_name(geonameid, alt, primary=False)

    def _add_name(self, geonameid: int, surface: str, primary: bool) -> None:
        key = normalize(surface)
        if not key:
            return
        bucket = self._by_name.setdefault(key, [])
        # A row often lists the same string as both name and asciiname; index it
        # once, preferring the primary flag so scoring is not decided by file order.
        for i, (existing_id, _, existing_primary) in enumerate(bucket):
            if existing_id == geonameid:
                if primary and not existing_primary:
                    bucket[i] = (geonameid, surface, True)
                return
        bucket.append((geonameid, surface, primary))

    def __len__(self) -> int:
        return len(self._places)

    @property
    def places(self) -> list[Place]:
        return self._places

    def get(self, geonameid: int) -> Place | None:
        return self._by_id.get(geonameid)

    def resolve(
        self,
        name: str,
        country_code: str | None = None,
        admin1: str | None = None,
        limit: int = 8,
    ) -> list[Candidate]:
        """Every place plausibly called `name`, best first.

        `country_code` and `admin1` are *hints*, not filters. A candidate in the
        wrong country is scored down but still returned, because the hint itself
        can be wrong -- GDELT's own country code is the thing being checked in
        half the calls to this function, and filtering by it would make the
        check unable to disagree.
        """
        key = normalize(name)
        if not key:
            return []
        bucket = self._by_name.get(key)
        if not bucket:
            return []

        want_cc = (country_code or "").strip().upper() or None
        want_admin1 = (admin1 or "").strip() or None

        candidates: list[Candidate] = []
        for geonameid, surface, primary in bucket:
            place = self._by_id.get(geonameid)
            if place is None:
                continue
            score = 1.0 if primary else 0.92
            if want_cc:
                score *= 1.0 if place.country_code == want_cc else 0.35
            if want_admin1:
                score *= 1.0 if place.admin1 == want_admin1 else 0.9
            # Population as a tiebreak only -- enough to put Paris, France ahead
            # of Paris, Texas, small enough that it never outranks a country
            # match. log10 keeps a 10M city from swamping the country signal.
            score += min(math.log10(max(place.population, 1)) / 100.0, 0.08)
            candidates.append(
                Candidate(
                    place=place,
                    score=round(min(score, 1.0), 4),
                    matched_name=surface,
                    radius_km=radius_km_for(place.feature_code, place.population),
                )
            )

        candidates.sort(key=lambda c: (-c.score, -c.place.population, c.place.geonameid))
        return candidates[:limit]

    def is_ambiguous(self, candidates: list[Candidate], margin: float = 0.15) -> bool:
        """True when the top two candidates are too close to choose between.

        The margin is what decides whether the deterministic pass is allowed to
        move a pin on its own or has to hand off (to the LLM pass, or to leaving
        the coordinate alone). Two same-country cities with the same name is the
        case this catches.
        """
        if len(candidates) < 2:
            return False
        return (candidates[0].score - candidates[1].score) < margin


# The live index. Empty until the first successful refresh; every caller must
# cope with that, exactly as capitals.py's cold-start path does -- a cold
# gazetteer means "no opinion", never "no such place".
_index = Gazetteer([])


def current() -> Gazetteer:
    return _index


def install(index: Gazetteer) -> None:
    """Swap in a new index atomically.

    The whole index is replaced by a single rebind rather than mutated, so a
    lookup racing a refresh sees either the old index or the new one and never a
    half-built one. Public because the offline calibration harness
    (backend/scripts/eval_placement.py) has to load a gazetteer without running
    the poller.
    """
    global _index
    _index = index


def resolve(
    name: str,
    country_code: str | None = None,
    admin1: str | None = None,
    limit: int = 8,
) -> list[Candidate]:
    """Module-level convenience over the live index."""
    return _index.resolve(name, country_code=country_code, admin1=admin1, limit=limit)


# --- parsing ---------------------------------------------------------------


def parse_cities(text: str) -> tuple[list[Place], dict[int, list[str]]]:
    """cities500.txt -> (places, alternate names by id).

    Same by-position discipline as cities._parse_cities and gdelt._parse_events:
    the file is headerless, so a wrong column index reads a neighbouring field
    instead of raising.
    """
    places: list[Place] = []
    alternates: dict[int, list[str]] = {}
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) <= COL_POPULATION:
            continue
        try:
            geonameid = int(parts[COL_GEONAME_ID])
            lat = float(parts[COL_LAT])
            lon = float(parts[COL_LON])
        except ValueError:
            continue
        try:
            population = int(parts[COL_POPULATION])
        except ValueError:
            population = 0
        name = parts[COL_NAME].strip()
        if not name:
            continue
        places.append(
            Place(
                geonameid=geonameid,
                name=name,
                country_code=parts[COL_COUNTRY_CODE].strip().upper(),
                admin1=parts[COL_ADMIN1].strip(),
                admin2=parts[COL_ADMIN2].strip(),
                feature_class=parts[COL_FEATURE_CLASS].strip(),
                feature_code=parts[COL_FEATURE_CODE].strip(),
                population=population,
                lat=lat,
                lon=lon,
            )
        )
        names = _alternate_names(parts, primary=name)
        if names:
            alternates[geonameid] = names
    return places, alternates


def _alternate_names(parts: list[str], primary: str) -> list[str]:
    """The transliterations worth indexing from a row's alternatenames column.

    Short forms are dropped outright: GeoNames lists airport and station codes
    here, and a three-letter key collides across hundreds of unrelated places.
    """
    raw = parts[COL_ALTERNATE_NAMES] if len(parts) > COL_ALTERNATE_NAMES else ""
    ascii_name = parts[COL_ASCII_NAME].strip() if len(parts) > COL_ASCII_NAME else ""
    primary_key = normalize(primary)

    out: list[str] = []
    seen = {primary_key}
    for value in ([ascii_name] if ascii_name else []) + (raw.split(",") if raw else []):
        candidate = value.strip()
        if len(candidate) < MIN_ALTERNATE_NAME_LENGTH:
            continue
        key = normalize(candidate)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(candidate)
        if len(out) >= MAX_ALTERNATE_NAMES:
            break
    return out


def parse_admin_codes(text: str, feature_code: str) -> list[Place]:
    """admin1CodesASCII.txt / admin2Codes.txt -> Places for the divisions.

    Four tab-separated columns: "UA.30", "Kyiv City", "Kyiv City", 703447. The
    code column is what a cities500 row's admin1/admin2 field points at, so
    parsing it here is what makes "Khersons'ka Oblast'" resolvable at all --
    without it an oblast-level report has no target but the country.

    These files carry no coordinates. The division's own centroid is recovered
    in build_index() from the places that belong to it, which is both cheap and
    more honest than a nominal seat: the centroid of everywhere in the oblast is
    a better guess for "somewhere in the oblast" than the oblast capital is.
    """
    out: list[Place] = []
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        code = parts[0].strip()
        name = parts[1].strip()
        if not code or not name:
            continue
        segments = code.split(".")
        if len(segments) < 2:
            continue
        try:
            geonameid = int(parts[3])
        except ValueError:
            continue
        out.append(
            Place(
                geonameid=geonameid,
                name=name,
                country_code=segments[0].strip().upper(),
                admin1=segments[1].strip(),
                admin2=segments[2].strip() if len(segments) > 2 else "",
                feature_class="A",
                feature_code=feature_code,
                population=0,
                # Filled in by build_index from member places; a division with
                # no members keeps (0, 0) and is dropped rather than shown at
                # Null Island.
                lat=0.0,
                lon=0.0,
            )
        )
    return out


def build_index(
    cities: list[Place],
    alternates: dict[int, list[str]],
    admin1: list[Place],
    admin2: list[Place],
) -> Gazetteer:
    """Assemble the searchable index, giving each admin division a centroid."""
    by_admin1: dict[tuple[str, str], list[Place]] = {}
    by_admin2: dict[tuple[str, str, str], list[Place]] = {}
    for place in cities:
        if place.admin1:
            by_admin1.setdefault((place.country_code, place.admin1), []).append(place)
            if place.admin2:
                by_admin2.setdefault(
                    (place.country_code, place.admin1, place.admin2), []
                ).append(place)

    placed: list[Place] = list(cities)
    placed.extend(_locate_divisions(admin1, lambda d: by_admin1.get((d.country_code, d.admin1))))
    placed.extend(
        _locate_divisions(
            admin2, lambda d: by_admin2.get((d.country_code, d.admin1, d.admin2))
        )
    )
    return Gazetteer(placed, alternates)


def _locate_divisions(divisions: list[Place], members_of) -> list[Place]:
    """Give each division the population-weighted centroid of its members.

    Weighted rather than plain: an oblast's population is concentrated in its
    towns, and "somewhere in Kherson oblast" is far more likely to mean a
    populated part of it than an empty one.
    """
    out: list[Place] = []
    for division in divisions:
        members = members_of(division)
        if not members:
            continue
        weights = [max(m.population, 1) for m in members]
        total = float(sum(weights))
        lat = sum(m.lat * w for m, w in zip(members, weights)) / total
        lon = sum(m.lon * w for m, w in zip(members, weights)) / total
        out.append(
            Place(
                geonameid=division.geonameid,
                name=division.name,
                country_code=division.country_code,
                admin1=division.admin1,
                admin2=division.admin2,
                feature_class=division.feature_class,
                feature_code=division.feature_code,
                population=sum(m.population for m in members),
                lat=lat,
                lon=lon,
            )
        )
    return out


# --- polling ---------------------------------------------------------------


async def _fetch() -> Gazetteer:
    async with httpx.AsyncClient(timeout=180, follow_redirects=True) as client:
        cities_resp, admin1_resp, admin2_resp = await asyncio.gather(
            client.get(CITIES_URL), client.get(ADMIN1_URL), client.get(ADMIN2_URL)
        )
        for resp in (cities_resp, admin1_resp, admin2_resp):
            resp.raise_for_status()

    with zipfile.ZipFile(io.BytesIO(cities_resp.content)) as zf:
        with zf.open("cities500.txt") as f:
            cities, alternates = parse_cities(f.read().decode("utf-8", errors="replace"))

    admin1 = parse_admin_codes(admin1_resp.text, "ADM1")
    admin2 = parse_admin_codes(admin2_resp.text, "ADM2")
    return build_index(cities, alternates, admin1, admin2)


async def start():
    state = registry.register("gazetteer", key_configured=True)  # no key required
    consecutive_failures = 0
    while True:
        ok = False
        try:
            index = await _fetch()
            install(index)
            # The registry payload is a summary, not the index: these are
            # ~200k rows and /api/health reports item_count by len(). Publishing
            # the Place list itself would put a 50MB structure behind an
            # endpoint that only ever wanted a number.
            state.data = [{"places": len(index)}]
            state.last_success = time.time()
            state.last_error = None
            ok = True
            log.info("Gazetteer: %d resolvable places indexed", len(index))
            await storage.record_source_health("gazetteer", len(index), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Gazetteer fetch failed: %s", exc)
            await storage.record_source_health("gazetteer", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL
            if ok
            else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
