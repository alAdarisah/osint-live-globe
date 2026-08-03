import asyncio
import logging
import time

import httpx

from backend import config, storage
from backend.cache import registry

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
_ROLE_KEYWORDS = [
    ("tanker", ["tanker", "stratotanker"]),
    ("bomber", ["bomber", "stratofortress", "spirit", "lancer"]),
    ("fighter", ["fighter", "eagle", "falcon", "raptor", "lightning ii", "hornet", "typhoon", "viper"]),
    ("awacs", ["sentry", "awacs"]),
    ("recon", ["reconnaissance", "rivet joint", "recon"]),
    ("patrol", ["poseidon", "orion"]),
    ("drone", ["reaper", "predator", "global hawk", "unmanned"]),
    ("transport", ["globemaster", "hercules", "galaxy", "transport", "extender"]),
    ("helicopter", ["helicopter", "black hawk", "chinook", "apache"]),
]


def _infer_military_role(desc: str | None) -> str | None:
    if not desc:
        return None
    lowered = desc.lower()
    for role, keywords in _ROLE_KEYWORDS:
        if any(kw in lowered for kw in keywords):
            return role
    return None


_token: dict = {"access_token": None, "expires_at": 0}


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
    async with httpx.AsyncClient(timeout=20) as client:
        token = await _get_token(client)
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        resp = await client.get(STATES_URL, headers=headers)
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


async def _fetch_airplanes_live() -> dict[str, dict]:
    items: dict[str, dict] = {}
    paths = ["mil"] + [f"point/{lat}/{lon}/{radius}" for lat, lon, radius in config.AIRPLANES_LIVE_POINTS]
    async with httpx.AsyncClient(timeout=15) as client:
        for i, path in enumerate(paths):
            if i:
                await asyncio.sleep(_AIRPLANES_LIVE_RATE_DELAY)  # stay under 1 req/sec
            for ac in await _fetch_airplanes_live_endpoint(client, path):
                hex_id = (ac.get("hex") or "").lower()
                lat, lon = ac.get("lat"), ac.get("lon")
                if not hex_id or lat is None or lon is None:
                    continue
                alt_baro = ac.get("alt_baro")
                on_ground = alt_baro == "ground"
                db_flags = ac.get("dbFlags") or 0
                type_desc = ac.get("desc")
                items[hex_id] = {
                    "icao24": hex_id,
                    "callsign": (ac.get("flight") or "").strip() or None,
                    "origin_country": None,
                    "lat": lat,
                    "lon": lon,
                    "altitude": ac.get("alt_geom") if on_ground else alt_baro,
                    "velocity": ac.get("gs"),
                    "heading": ac.get("track"),
                    "on_ground": on_ground,
                    "category": _READSB_CATEGORY_TO_OPENSKY.get(ac.get("category"), 0),
                    "military": bool(db_flags & 1),
                    "type_code": ac.get("t"),
                    "type_desc": type_desc,
                    "registration": ac.get("r"),
                    "operator": ac.get("ownOp"),
                    "military_role": _infer_military_role(type_desc),
                }
    return items


async def _fetch() -> list[dict]:
    opensky_items, airplanes_live_items = await asyncio.gather(
        _fetch_opensky(), _fetch_airplanes_live()
    )
    # airplanes.live wins on conflict: unfiltered coverage and a real military
    # flag beat OpenSky's fields for the same aircraft. Fall back to OpenSky
    # fields (e.g. origin_country, which airplanes.live doesn't provide) via
    # the base dict it's merged into.
    merged = dict(opensky_items)
    for icao24, item in airplanes_live_items.items():
        base = merged.get(icao24, {})
        merged[icao24] = {**base, **item, "origin_country": item.get("origin_country") or base.get("origin_country")}
    return list(merged.values())


async def start():
    authenticated = bool(config.OPENSKY_CLIENT_ID and config.OPENSKY_CLIENT_SECRET)
    state = registry.register("adsb", key_configured=authenticated)
    interval = config.ADSB_POLL_INTERVAL_AUTH if authenticated else config.ADSB_POLL_INTERVAL_ANON
    while True:
        try:
            state.data = await _fetch()
            state.last_success = time.time()
            state.last_error = None
            await storage.record_snapshot("adsb", state.data, "icao24")
            military_count = sum(1 for a in state.data if a.get("military"))
            log.info(
                "ADS-B: %d aircraft (%s, %d flagged military)",
                len(state.data),
                "OpenSky authenticated" if authenticated else "OpenSky anonymous, rate-limited to 100 calls/day",
                military_count,
            )
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("ADS-B fetch failed: %s", exc)
        await asyncio.sleep(interval)
