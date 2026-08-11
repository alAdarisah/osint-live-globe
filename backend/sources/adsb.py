import asyncio
import logging
import re
import time

import httpx

from backend import config, storage
from backend.cache import registry
from backend.sources import airports, icao_blocks, sanctions
from backend.sources.proximity import haversine_km

log = logging.getLogger("osint-globe.adsb")

TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
STATES_URL = "https://opensky-network.org/api/states/all"

# airplanes.live: a free, keyless community mirror of ADS-B Exchange-style
# data -- unfiltered, so it carries military/government aircraft that opt out
# of OpenSky entirely. No world/bbox endpoint exists, only point+radius, so
# coverage comes from a fixed set of regional queries (same shape as the AIS
# layer's conflict-waters bboxes) plus a dedicated global military sweep.
# Hard rate limit: 1 request/second -- every call below is serialized with a
# delay, never gathered concurrently.
AIRPLANES_LIVE_BASE = "https://api.airplanes.live/v2"
_AIRPLANES_LIVE_RATE_DELAY = 1.1

# Global sweeps that are about an aircraft's *status* rather than its position,
# so unlike the point queries above they need no geographic coverage plan --
# each returns every aircraft worldwide currently in that state.
#
# The three squawk codes are the internationally reserved emergency codes, and
# they are fetched as their own queries rather than read off the point results
# because an emergency outside all seven AIRPLANES_LIVE_POINTS radii is exactly
# the one worth seeing. (The path is `squawk`; `sqk` 404s.)
#
# ladd/pia are the two programmes an operator can use to keep an aircraft out of
# public feeds: LADD (Limited Aircraft Data Displayed, an FAA programme) and PIA
# (Privacy ICAO Address, a rotating temporary hex). airplanes.live is unfiltered
# and publishes both. An aircraft asking not to be listed is a fact about the
# aircraft, and it is the only place on this map where the *absence* of data
# elsewhere is itself the data.
_SQUAWK_PATHS = {
    "7500": "unlawful interference (hijack)",
    "7600": "radio failure",
    "7700": "general emergency",
}
_DISPLAY_LIMITED_PATHS = {
    "ladd": "LADD - operator asked for limited public display (FAA programme)",
    "pia": "PIA - flying under a rotating Privacy ICAO Address",
}

# readsb's own `emergency` field, as airplanes.live passes it through. "none" is
# the overwhelmingly common value and means exactly that.
_EMERGENCY_LABEL = {
    "general": "general emergency",
    "lifeguard": "lifeguard / medical",
    "minfuel": "minimum fuel",
    "nordo": "radio failure",
    "unlawful": "unlawful interference",
    "downed": "downed aircraft",
    "reserved": "reserved emergency code",
}

# ADS-B emitter category strings (DO-260B "A0".."D7", as airplanes.live/readsb
# report them) mapped to OpenSky's flattened numeric category enum, so merged
# aircraft classify identically on the frontend regardless of source.
_READSB_CATEGORY_TO_OPENSKY = {
    "A0": 1, "A1": 2, "A2": 3, "A3": 4, "A4": 5, "A5": 6, "A6": 7, "A7": 8,
    "B1": 9, "B2": 10, "B3": 11, "B4": 12, "B5": 13, "B6": 14, "B7": 15,
    "C1": 16, "C2": 17, "C3": 18, "C4": 19, "C5": 20,
}

# airplanes.live's own "desc" field is already a human-readable string (e.g.
# "Boeing KC-135R Stratotanker") for aircraft it has reference data for --
# keyword-matching that text is far safer than hand-maintaining a table of
# exact ICAO type-designator codes from memory, and only fires when a real
# desc string came through (no fabrication when it didn't).
#
# Nicknames alone were not nearly enough. Measured against a live feed: 216 of
# 311 military aircraft (69%) matched nothing and fell back to one generic
# plane glyph, including 73 T-6 Texans, 14 T-38 Talons and 14 C-12 Hurons --
# a list of famous names cannot cover a fleet.
_ROLE_KEYWORDS = [
    ("tanker", ["tanker", "stratotanker", "pegasus", "voyager"]),
    ("bomber", ["bomber", "stratofortress", "spirit", "lancer"]),
    # "falcon" and "viper" were both here and both are traps: a Dassault Falcon
    # 900 is a business jet, and the AH-1Z Viper is a helicopter -- each was
    # being drawn as a fast jet. Names in this list have to be unambiguous,
    # because a name match runs before the designator parser and overrides it.
    # F-16 and F-35 lose nothing by the tightening: their designators say
    # "fighter" without any help from a nickname.
    ("fighter", ["fighter", "eagle", "fighting falcon", "raptor", "lightning ii",
                 "hornet", "typhoon", "tiger ii", "gripen", "rafale", "harrier",
                 "thunderbolt", "warthog"]),
    ("awacs", ["sentry", "awacs", "wedgetail", "early warning"]),
    ("recon", ["reconnaissance", "rivet joint", "recon", "dragon lady", "cobra ball",
               "joint stars", "compass call"]),
    ("patrol", ["poseidon", "orion", "atlantique", "maritime patrol", "sea guardian"]),
    ("drone", ["reaper", "predator", "global hawk", "unmanned", "bayraktar", "heron"]),
    ("trainer", ["texan", "talon", "goshawk", "tucano", "kaydet", "hawk t", "trainer",
                 "pc-21", "pc-9", "grob"]),
    ("transport", ["globemaster", "hercules", "galaxy", "transport", "extender",
                   "huron", "clipper", "husky", "twin otter", "casa", "spartan",
                   "a-400", "a400", "atlas", "king air"]),
    # Rotorcraft families that carry no MDS designator, so the parser below
    # cannot reach them: AgustaWestland, Airbus/Eurocopter and MD are the ones
    # that actually appear in the live military feed.
    ("helicopter", ["helicopter", "black hawk", "seahawk", "chinook", "apache",
                    "agusta", "eurocopter", "sikorsky", "super lynx", "lynx",
                    "koala", "dolphin", "explorer", "md-900", "wildcat", "merlin",
                    "puma", "cougar", "caracal", "venom"]),
]

# US/NATO Mission Design Series -- the designator itself says what the aircraft
# is for, and it is sitting in the middle of every one of these desc strings.
#
# Read right-to-left, because that is how the scheme is built:
#
#   MH-60R   M = modified mission (multi-mission), H = vehicle type (helicopter)
#   KC-46A   K = modified mission (tanker),        C = basic mission (cargo)
#   RC-135S  R = modified mission (recon),         C = basic mission (cargo)
#   T-6A     no modifier,                          T = basic mission (trainer)
#
# So: the last letter is the vehicle type or basic mission, and a leading
# letter (when there are two) is the modified mission, which is what a reader
# most wants to see -- a KC-46 is a tanker first and a cargo airframe second.
_MDS_RE = re.compile(r"\b([A-Z]{1,2})-?(\d{1,3})[A-Z]?\b")

# Vehicle-type letters, which win outright: they describe the airframe rather
# than the job.
_MDS_VEHICLE = {"H": "helicopter", "Q": "drone"}

# Basic-mission letters. Deliberately partial: D, G, L, M, N, S, W, X, Y and Z
# are omitted so that non-MDS designators which merely look like one ("AW-119",
# "BD-700", "CL-415", "MD-900") fail to parse instead of being misread. That
# rejection is the point -- an AW-119 Koala matched as an attack aircraft would
# be worse than no glyph at all.
_MDS_BASIC = {
    "B": "bomber",
    "C": "transport",
    "E": "awacs",       # special electronic mission: E-3 Sentry, E-2 Hawkeye
    "F": "fighter",
    "K": "tanker",
    "P": "patrol",
    "R": "recon",
    "T": "trainer",
    "U": "transport",   # utility
    "V": "transport",   # VIP / staff transport
}

# "A" (attack) is deliberately in neither table, and this is the one exclusion
# worth spelling out: Airbus model numbers look exactly like MDS designators,
# so "AIRBUS A-320" parsed as an attack aircraft and drew an airliner as a
# fighter. The A-prefix fleet is small and the names carry it anyway --
# Warthog, Thunderbolt and Super Tucano are all matched by keyword above --
# so dropping the letter costs almost nothing and removes a whole class of
# confident, wrong answers.

# Modified-mission letters, which take precedence over the basic mission.
#
# H (search and rescue) is absent on purpose: an HC-130J is a C-130 doing rescue
# work, and "transport" describes what a reader sees better than a rescue glyph
# we do not have. E is absent for a sharper reason -- as a *modifier* it means
# electronic warfare, not early warning, so EC-130J Commando Solo was being
# labelled "AWACS / airborne early warning", which is a different aircraft doing
# a different job. Falling through to its basic mission calls it a transport,
# which is at least true.
_MDS_MODIFIER = {
    "K": "tanker",
    "P": "patrol",
    "R": "recon",
    "T": "trainer",
    "V": "transport",
}


def _role_from_designator(desc: str) -> str | None:
    """Read the role out of an MDS designator inside a type description."""
    for letters, _number in _MDS_RE.findall(desc.upper()):
        vehicle = _MDS_VEHICLE.get(letters[-1])
        if vehicle:
            return vehicle
        basic = _MDS_BASIC.get(letters[-1])
        if basic is None:
            continue  # not a designator we can read; keep looking
        if len(letters) == 2:
            return _MDS_MODIFIER.get(letters[0], basic)
        return basic
    return None


# Callsign prefixes that mean an aircraft is flying a military mission, whether
# or not any database says the airframe is military.
#
# This heuristic lived in the frontend until the aircraft feed grew a class
# filter. It had to move, and the reason is worth stating: /api/aircraft can now
# be asked for only the aircraft a zoomed-out reader can draw, and the server
# decides who those are. If the server's idea of "military" were narrower than
# the client's by even one prefix, the client would keep classifying an aircraft
# as military that the server had already dropped -- and the aircraft would
# simply not be on the map, with no error anywhere. Two copies of this list
# would be exactly that bug waiting to happen, so there is one copy, here, and
# the record carries the answer rather than the rule (see `callsign_military`).
#
# Deliberately generous. A false positive puts a civil aircraft in the military
# bucket, which a reader can see and dismiss; a false negative removes a
# military aircraft from a map whose whole purpose is showing them.
_MILITARY_CALLSIGN_PREFIXES = (
    "RCH", "CNV", "NATO", "HKY", "ASCOT", "IAM", "GAF", "DUKE", "TARTAN",
    "FORTE", "VIVI", "REACH", "KNIFE", "VADER", "POLAR", "FALCON", "VULCAN",
    "SLAM", "SPAR", "COBRA", "TITAN", "USAF", "NAVY", "MARINE", "ARMY",
)


def _callsign_military(callsign: str | None) -> bool:
    """Whether a callsign is one of the military prefixes above."""
    cs = (callsign or "").strip().upper()
    return bool(cs) and cs.startswith(_MILITARY_CALLSIGN_PREFIXES)


def _infer_military_role(desc: str | None, category: int | None = None) -> str | None:
    """Best-effort role for a military aircraft, or None.

    Three passes, most specific first: a known name, then the MDS designator,
    then the ADS-B emitter category. Never a guess dressed as a fact -- the
    frontend prints "best-effort" alongside anything derived this way.
    """
    if desc:
        lowered = desc.lower()
        for role, keywords in _ROLE_KEYWORDS:
            if any(kw in lowered for kw in keywords):
                return role
        role = _role_from_designator(desc)
        if role:
            return role
    # ADS-B emitter category 8 is "rotorcraft", broadcast by the aircraft
    # itself. Last rather than first because it is coarse -- it separates
    # helicopters from everything else and says nothing more.
    if category == 8:
        return "helicopter"
    return None


_token: dict = {"access_token": None, "expires_at": 0}

# OpenSky bills per request out of a daily credit budget, and a global
# states/all is its most expensive call (4 credits). Running out is not an
# error to retry through: every further request is refused *and* charged
# against the same exhausted budget, so hammering it each poll is what keeps
# it exhausted. Skipping OpenSky for a while costs nothing here -- see
# _fetch(), where airplanes.live carries the layer meanwhile.
OPENSKY_RATE_LIMIT_PAUSE = 3600
_opensky_pause_until = 0.0


def _retry_after_seconds(resp: httpx.Response) -> int | None:
    raw = resp.headers.get("Retry-After", "").strip()
    if not raw.isdigit():
        return None
    # An hour either way is fine; a header claiming days is not worth honouring
    # when the budget resets daily anyway.
    return min(int(raw), 6 * 3600)


async def _get_token(client: httpx.AsyncClient) -> str | None:
    if not (config.OPENSKY_CLIENT_ID and config.OPENSKY_CLIENT_SECRET):
        return None
    if _token["access_token"] and time.time() < _token["expires_at"] - 30:
        return _token["access_token"]
    resp = await client.post(
        TOKEN_URL,
        data={
            "grant_type": "client_credentials",
            "client_id": config.OPENSKY_CLIENT_ID,
            "client_secret": config.OPENSKY_CLIENT_SECRET,
        },
    )
    resp.raise_for_status()
    payload = resp.json()
    _token["access_token"] = payload["access_token"]
    _token["expires_at"] = time.time() + int(payload.get("expires_in", 1800))
    return _token["access_token"]


async def _fetch_opensky() -> dict[str, dict]:
    global _opensky_pause_until
    if time.time() < _opensky_pause_until:
        return {}
    async with httpx.AsyncClient(timeout=20) as client:
        token = await _get_token(client)
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        resp = await client.get(STATES_URL, headers=headers)
        if resp.status_code == 429:
            pause = _retry_after_seconds(resp) or OPENSKY_RATE_LIMIT_PAUSE
            _opensky_pause_until = time.time() + pause
            log.warning(
                "OpenSky is out of credits (429) -- pausing it for %dmin. "
                "Aircraft keep coming from airplanes.live meanwhile.",
                pause // 60,
            )
            return {}
        resp.raise_for_status()
        payload = resp.json()

    items = {}
    for s in payload.get("states") or []:
        lat, lon = s[6], s[5]
        if lat is None or lon is None:
            continue
        icao24 = s[0]
        items[icao24] = {
            "icao24": icao24,
            "callsign": (s[1] or "").strip() or None,
            "origin_country": s[2],
            "lat": lat,
            "lon": lon,
            "altitude": s[7] if s[7] is not None else s[13],
            "velocity": s[9],
            "heading": s[10],
            "on_ground": s[8],
            "category": s[17] if len(s) > 17 else 0,
            "military": False,  # OpenSky has no such field -- refined below if airplanes.live agrees
            # Kept separate from `military` for the same reason `hex_military`
            # is: that is a database's judgement about an airframe, this is what
            # the aircraft is calling itself on this flight, and conflating them
            # would throw away which one fired.
            "callsign_military": _callsign_military(s[1]),
            # s[3] time_position, s[4] last_contact: when this position was last
            # updated, and when *any* message was last received. Position time is
            # the honest answer to "when was this aircraft last heard where the
            # icon is", and it is null for aircraft heard only on non-positional
            # messages -- hence the fallback rather than one or the other.
            "updated": s[3] or s[4],
        }
    return items


async def _fetch_airplanes_live_endpoint(client: httpx.AsyncClient, path: str) -> list[dict]:
    try:
        resp = await client.get(f"{AIRPLANES_LIVE_BASE}/{path}")
        resp.raise_for_status()
        return resp.json().get("ac") or []
    except Exception as exc:  # noqa: BLE001 - one bad query shouldn't sink the whole poll
        log.debug("airplanes.live fetch failed (%s): %s", path, exc)
        return []


def normalize_airplanes_live(ac: dict) -> dict | None:
    """One airplanes.live aircraft object -> our record shape, or None.

    Split out of the fetch loop because the same aircraft now arrives from
    several endpoints (a point query, the military sweep, an emergency squawk
    sweep) and every one of them has to normalise identically -- otherwise
    which query happened to run last would decide what the map shows.
    """
    hex_id = (ac.get("hex") or "").lower()
    lat, lon = ac.get("lat"), ac.get("lon")
    if not hex_id or lat is None or lon is None:
        return None
    alt_baro = ac.get("alt_baro")
    on_ground = alt_baro == "ground"
    db_flags = ac.get("dbFlags") or 0
    type_desc = ac.get("desc")
    category = _READSB_CATEGORY_TO_OPENSKY.get(ac.get("category"), 0)
    squawk = (ac.get("squawk") or "").strip() or None
    emergency = (ac.get("emergency") or "").strip().lower()
    # readsb reports age, not time: seen_pos is seconds since the last position
    # message, seen is seconds since any message at all. Turned into an absolute
    # timestamp here so an aircraft record carries the same "when was this last
    # true" field a ship does, whichever feed it came from. Measured against our
    # own clock rather than the response's `now` because this normalises one
    # aircraft, not the envelope it arrived in -- the difference is the
    # request's own latency, well under the second this is rounded to.
    seen = ac.get("seen_pos")
    if not isinstance(seen, (int, float)):
        seen = ac.get("seen")
    return {
        "icao24": hex_id,
        "callsign": (ac.get("flight") or "").strip() or None,
        "origin_country": None,
        "lat": lat,
        "lon": lon,
        "altitude": ac.get("alt_geom") if on_ground else alt_baro,
        "velocity": ac.get("gs"),
        "heading": ac.get("track"),
        "on_ground": on_ground,
        "category": category,
        "military": bool(db_flags & 1),
        # See the note on the OpenSky record: a mission callsign and a database
        # flag are two different claims and are carried as two fields.
        "callsign_military": _callsign_military(ac.get("flight")),
        "type_code": ac.get("t"),
        "type_desc": type_desc,
        "registration": ac.get("r"),
        "operator": ac.get("ownOp"),
        "military_role": _infer_military_role(type_desc, category),
        "squawk": squawk,
        # Two independent signals for the same thing, kept separate: the
        # transponder code the aircraft is squawking right now, and readsb's
        # decoded emergency status. Either can be present without the other --
        # `emergency` is only broadcast by newer transponders -- so the pin
        # lights up on either and the popup says which one fired.
        "emergency": _EMERGENCY_LABEL.get(emergency) if emergency and emergency != "none" else None,
        "emergency_squawk": _SQUAWK_PATHS.get(squawk),
        "updated": round(time.time() - seen, 1) if isinstance(seen, (int, float)) else None,
    }


async def _fetch_airplanes_live() -> dict[str, dict]:
    items: dict[str, dict] = {}
    # Order matters only for the rate-limit budget, not for correctness: every
    # response merges into whatever is already held for that aircraft rather
    # than replacing it (see below), so no query can erase another's tag.
    paths = (
        ["mil"]
        + [f"point/{lat}/{lon}/{radius}" for lat, lon, radius in config.AIRPLANES_LIVE_POINTS]
        + [f"squawk/{code}" for code in _SQUAWK_PATHS]
        + list(_DISPLAY_LIMITED_PATHS)
    )
    async with httpx.AsyncClient(timeout=15) as client:
        for i, path in enumerate(paths):
            if i:
                await asyncio.sleep(_AIRPLANES_LIVE_RATE_DELAY)  # stay under 1 req/sec
            # Which programme (if any) this whole response is evidence of.
            display_limited = _DISPLAY_LIMITED_PATHS.get(path)
            for ac in await _fetch_airplanes_live_endpoint(client, path):
                record = normalize_airplanes_live(ac)
                if record is None:
                    continue
                if display_limited:
                    record["display_limited"] = path
                    record["display_limited_note"] = display_limited
                existing = items.get(record["icao24"])
                # Merge rather than overwrite, and let a *set* value win over an
                # unset one: an aircraft returned by both /pia and a point query
                # must keep its PIA tag whichever order they arrived in.
                items[record["icao24"]] = (
                    record if existing is None else {**existing, **{k: v for k, v in record.items() if v is not None}}
                )
    return items


# Above this, "the nearest airfield" stops being information and starts being
# trivia: an airliner at FL350 is within 40 km of a dozen fields and at none of
# them. Below it -- and on the ground -- the nearest field is the single most
# useful thing that can be said about a contact.
NEAREST_AIRFIELD_MAX_ALT_FT = 10_000


def _attach_nearest_airfield(item: dict) -> None:
    """Name the airfield an aircraft is approaching, leaving or sitting on.

    An inference, and labelled as one on the way out: proximity is not a
    destination, and the popup shows the distance so a reader can see how much
    to make of it.
    """
    altitude = item.get("altitude")
    airborne_high = isinstance(altitude, (int, float)) and altitude > NEAREST_AIRFIELD_MAX_ALT_FT
    if airborne_high and not item.get("on_ground"):
        return
    field = airports.nearest(item["lat"], item["lon"])
    if not field:
        return
    item["nearest_airfield"] = {
        "name": field["name"],
        "code": field.get("icao") or field.get("iata") or field.get("id"),
        "km": round(haversine_km(item["lat"], item["lon"], field["lat"], field["lon"]), 1),
        "military_name": field.get("military_name", False),
    }


def _attach_hex_allocation(item: dict) -> None:
    """Whose Mode-S block this aircraft's address was allocated out of.

    Deliberately *alongside* `origin_country` rather than into it. The two are
    different claims about the same aircraft and are allowed to disagree in
    public:

      - `origin_country` is OpenSky's own assertion, and a country *name*
        ("United Kingdom"). It is null for every airplanes.live aircraft --
        the feed has no such field -- and OpenSky stops answering for an hour
        on each 429, so on 2026-08-06 it was absent for 100% of the aircraft
        the community feed contributed.
      - `hex_country` is an ISO2 code derived from the ICAO allocation table
        (backend/sources/icao_blocks.py), which is a permanent property of the
        airframe and needs no credits. It resolved 563 of 563 aircraft in a
        Europe point query and 393 of 393 in the military sweep.

    Different names and different shapes, so nothing downstream can mistake one
    for the other, and overwriting the feed's assertion with a derived one would
    destroy the only evidence that they ever differed.
    """
    block = icao_blocks.lookup(item.get("icao24"))
    if not block:
        return
    item["hex_country"] = block["country"]
    # The second military signal, and the reason it is not folded into
    # `military`. `military` is airplanes.live's dbFlags bit 1: a community
    # database's judgement about this specific airframe. `hex_military` is the
    # allocation table saying the *address* sits in a range a state reserved
    # for military use. Of 393 aircraft dbFlags flagged on 2026-08-06, 378 also
    # sat in a military block -- the 15 that did not are the informative cases,
    # and reconciling them here would delete the disagreement rather than show
    # it. It matters most in the point queries, where the response did not come
    # from /mil and dbFlags may be absent from the aircraft object entirely.
    item["hex_military"] = block["military"]
    item["hex_block"] = block["block"]


_last_counts = {"OpenSky": 0, "airplanes.live": 0}


def _contribution_summary() -> str:
    parts = []
    for name, count in _last_counts.items():
        if name == "OpenSky" and time.time() < _opensky_pause_until:
            parts.append(f"{name} paused until credits reset")
        else:
            parts.append(f"{name} {count}")
    return ", ".join(parts)


async def _fetch() -> list[dict]:
    # Independently fallible on purpose. These are two unrelated networks with
    # unrelated failure modes -- one keyed and metered, one keyless and
    # community-run -- and a plain gather() propagated the first exception,
    # so an OpenSky 429 threw away a complete airplanes.live result that had
    # already arrived. The aircraft layer went empty for hours at a time while
    # a working source sat there unused. Only a poll where *both* failed is a
    # failed poll.
    results = await asyncio.gather(
        _fetch_opensky(), _fetch_airplanes_live(), return_exceptions=True
    )
    opensky_items, airplanes_live_items = results
    failures = [(name, r) for name, r in zip(("OpenSky", "airplanes.live"), results) if isinstance(r, Exception)]
    if len(failures) == len(results):
        raise failures[0][1]
    for name, exc in failures:
        log.warning("%s unavailable this poll, continuing without it: %s", name, exc)
    if isinstance(opensky_items, Exception):
        opensky_items = {}
    if isinstance(airplanes_live_items, Exception):
        airplanes_live_items = {}
    _last_counts["OpenSky"] = len(opensky_items)
    _last_counts["airplanes.live"] = len(airplanes_live_items)
    # airplanes.live wins on conflict: unfiltered coverage and a real military
    # flag beat OpenSky's fields for the same aircraft. Fall back to OpenSky
    # fields (e.g. origin_country, which airplanes.live doesn't provide) via
    # the base dict it's merged into.
    merged = dict(opensky_items)
    for icao24, item in airplanes_live_items.items():
        base = merged.get(icao24, {})
        merged[icao24] = {
            **base,
            **item,
            "origin_country": item.get("origin_country") or base.get("origin_country"),
            # Same treatment, same reason: airplanes.live only carries an age
            # for aircraft it has actually heard from recently, and letting its
            # None overwrite OpenSky's timestamp would make the popup say the
            # last ping is unknown for an aircraft we have a time for.
            "updated": item.get("updated") or base.get("updated"),
        }
    for item in merged.values():
        # Which upstream(s) actually contributed to this specific record. The
        # merge above is silent about this by construction -- a card reading
        # only the merged fields has no way to say whose numbers they are
        # looking at, and "ADS-B" is not an answer to that when two
        # independent feeds with different coverage and different failure
        # modes stand behind the word. Looked up against the two source dicts
        # rather than inferred from which fields happen to be set, because
        # inferring it would be wrong exactly when it matters most: an
        # airplanes.live aircraft with no reference data on file (no
        # registration, no type) sets none of the fields a guess would key on.
        item["data_sources"] = [
            name for name, feed in (("OpenSky", opensky_items), ("airplanes.live", airplanes_live_items))
            if item["icao24"] in feed
        ]
        # All three no-op until their own source's first download lands, which
        # is the point of them being lookups rather than dependencies: ADS-B
        # never waits on any of them, and re-runs them from scratch on every
        # poll so a list that arrives late still reaches aircraft already on
        # the map.
        _attach_nearest_airfield(item)
        _attach_hex_allocation(item)
        listing = sanctions.for_aircraft(item.get("registration"))
        if listing:
            item["sanctions"] = listing
    return list(merged.values())


async def ingest_once():
    """One poll. Runs in the ingest process, on the schedule in backend/ingest.

    Nothing is warmed from storage here, and not for the reason the other
    sources have: this process serves no one, so there is nothing to fill. The
    backend does read these positions back (see backend/mirror.py), which is a
    real change -- aircraft used to be the one layer deliberately left blank
    after a restart, on the grounds that drawing an aircraft where it was ten
    minutes ago is a confident lie. That is no longer avoidable once the
    backend's aircraft layer *is* the stored one, so it is bounded instead:
    config.ENTITY_STALE_AFTER["adsb"] evicts after 30 minutes, every record
    carries its own `updated` timestamp for the age the popup shows, and
    /api/health reports how long ago this job actually last succeeded.
    """
    authenticated = bool(config.OPENSKY_CLIENT_ID and config.OPENSKY_CLIENT_SECRET)
    state = registry.ensure("adsb", key_configured=authenticated)
    try:
        state.data = await _fetch()
        state.last_success = time.time()
        state.last_error = None
        await storage.record_snapshot("adsb", state.data, "icao24")
        await storage.record_source_health("adsb", len(state.data), True)
        military_count = sum(1 for a in state.data if a.get("military"))
        emergencies = sum(1 for a in state.data if a.get("emergency") or a.get("emergency_squawk"))
        hidden = sum(1 for a in state.data if a.get("display_limited"))
        # Names what each upstream actually contributed rather than how
        # this process is configured to talk to them: with either one able
        # to drop out on its own now, "OpenSky authenticated" on a poll
        # OpenSky sat out of would be the most misleading line in the log.
        log.info(
            "ADS-B: %d aircraft (%s, %d flagged military, %d emergency, %d display-limited)",
            len(state.data),
            _contribution_summary(),
            military_count,
            emergencies,
            hidden,
        )
    except Exception as exc:  # noqa: BLE001 - one failed poll is not a dead source
        state.last_error = str(exc)
        log.warning("ADS-B fetch failed: %s", exc)
        await storage.record_source_health("adsb", None, False, str(exc))
