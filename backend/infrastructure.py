"""Critical infrastructure reference layer: a small, curated, static list of
publicly documented sites (refineries, pipelines, desalination plants, LNG
terminals, nuclear plants, ports, semiconductor fabs) relevant to the
conflict zones in regions.py. No live poller -- these coordinates don't
move -- so this is served once and cached hard, same as regions.py.

Coordinates are approximate, sourced from public reference material (EIA,
company/government sites, Wikipedia) for open-source situational awareness,
not precision targeting data. This is a starter set focused on the theaters
already defined in regions.py; extend INFRA_SITES as more zones are added.
"""

INFRA_SITES: list[dict] = [
    # ---- Persian Gulf / Strait of Hormuz ----
    {
        "id": "ras_tanura",
        "name": "Ras Tanura Refinery & Oil Terminal",
        "type": "refinery",
        "lat": 26.7, "lon": 50.15,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "One of the world's largest oil export terminals (Saudi Aramco).",
    },
    {
        "id": "abqaiq",
        "name": "Abqaiq Oil Processing Facility",
        "type": "refinery",
        "lat": 25.93, "lon": 49.67,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "World's largest crude oil stabilization plant (Saudi Aramco).",
    },
    {
        "id": "kharg_island",
        "name": "Kharg Island Oil Terminal",
        "type": "refinery",
        "lat": 29.23, "lon": 50.32,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Iran's primary crude oil export terminal.",
    },
    {
        "id": "bandar_abbas_refinery",
        "name": "Bandar Abbas Refinery",
        "type": "refinery",
        "lat": 27.15, "lon": 56.25,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Major Iranian refinery on the Strait of Hormuz.",
    },
    {
        "id": "south_pars_assaluyeh",
        "name": "South Pars / Assaluyeh Gas Complex",
        "type": "lng_terminal",
        "lat": 27.48, "lon": 52.6,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Processing hub for the world's largest natural gas field.",
    },
    {
        "id": "ruwais_refinery",
        "name": "Ruwais Refinery",
        "type": "refinery",
        "lat": 24.11, "lon": 52.73,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "ADNOC's major UAE refining/petrochemical complex.",
    },
    {
        "id": "fujairah_terminal",
        "name": "Fujairah Oil Terminal",
        "type": "port",
        "lat": 25.11, "lon": 56.34,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Major storage/export point on the Gulf of Oman -- reachable without transiting Hormuz.",
    },
    {
        "id": "habshan_fujairah_pipeline",
        "name": "Habshan–Fujairah Pipeline",
        "type": "pipeline",
        "lat": 24.3, "lon": 55.5,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "ADNOC strategic pipeline built to bypass the Strait of Hormuz.",
    },
    {
        "id": "ras_al_khair_desalination",
        "name": "Ras Al Khair Desalination Plant",
        "type": "desalination",
        "lat": 27.63, "lon": 49.3,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "One of the world's largest desalination plants, on the Persian Gulf coast.",
    },
    {
        "id": "jebel_ali_desalination",
        "name": "Jebel Ali Desalination Complex",
        "type": "desalination",
        "lat": 25.0, "lon": 55.13,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Major Dubai desalination complex supplying the emirate's fresh water.",
    },
    # ---- Russia / Ukraine ----
    {
        "id": "zaporizhzhia_npp",
        "name": "Zaporizhzhia Nuclear Power Plant",
        "type": "nuclear",
        "lat": 47.51, "lon": 34.59,
        "region_keys": ["russia_ukraine"],
        "note": "Europe's largest nuclear plant, under occupation and frequently near the front line.",
    },
    {
        "id": "novorossiysk_terminal",
        "name": "Novorossiysk Oil Terminal",
        "type": "port",
        "lat": 44.72, "lon": 37.77,
        "region_keys": ["russia_ukraine"],
        "note": "Major Russian Black Sea crude oil export terminal.",
    },
    # ---- Red Sea / Yemen ----
    {
        "id": "ras_isa_terminal",
        "name": "Ras Isa Oil Terminal",
        "type": "port",
        "lat": 15.13, "lon": 42.6,
        "region_keys": ["red_sea_yemen"],
        "note": "Red Sea oil terminal near the Bab-el-Mandeb shipping chokepoint.",
    },
    # ---- Taiwan Strait ----
    {
        "id": "tsmc_hsinchu",
        "name": "TSMC Hsinchu Fabs",
        "type": "fab",
        "lat": 24.78, "lon": 121.0,
        "region_keys": ["taiwan_strait"],
        "note": "Core of global advanced semiconductor manufacturing.",
    },
]


def serialize() -> list[dict]:
    return INFRA_SITES
