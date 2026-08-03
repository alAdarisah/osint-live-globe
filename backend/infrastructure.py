"""Critical infrastructure reference layer: a small, curated, static list of
publicly documented sites (refineries, pipelines, desalination plants, LNG
terminals, nuclear plants, ports, semiconductor fabs) plus major pipeline
routes. No live poller -- these coordinates don't move -- so this is served
once and cached hard, same as regions.py.

Coordinates/routes are approximate, sourced from public reference material
(EIA, company/government sites, Wikipedia) for open-source situational
awareness, not precision targeting data. `region_keys: []` means the site
isn't tied to one particular conflict zone theater (regions.py) and is
always rendered, same as everything else here -- the frontend has no region
filter on this endpoint.
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
    {
        "id": "das_island_lng",
        "name": "Das Island LNG Terminal",
        "type": "lng_terminal",
        "lat": 25.15, "lon": 52.87,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "ADNOC's offshore LNG processing and export island.",
    },
    {
        "id": "ras_laffan",
        "name": "Ras Laffan Industrial City",
        "type": "lng_terminal",
        "lat": 25.9, "lon": 51.58,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Qatar's primary LNG export hub -- world's largest LNG facility.",
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
    {
        "id": "ust_luga_terminal",
        "name": "Ust-Luga Oil/LNG Terminal",
        "type": "lng_terminal",
        "lat": 59.68, "lon": 28.35,
        "region_keys": ["russia_ukraine"],
        "note": "Major Baltic Sea export terminal for Russian crude and LNG.",
    },
    {
        "id": "odesa_port",
        "name": "Port of Odesa",
        "type": "port",
        "lat": 46.49, "lon": 30.74,
        "region_keys": ["russia_ukraine"],
        "note": "Ukraine's largest Black Sea port, key grain export chokepoint.",
    },
    {
        "id": "kursk_npp",
        "name": "Kursk Nuclear Power Plant",
        "type": "nuclear",
        "lat": 51.68, "lon": 35.6,
        "region_keys": ["russia_ukraine"],
        "note": "Russian nuclear plant near the border region, repeatedly near active fighting.",
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
    {
        "id": "aden_refinery",
        "name": "Aden Refinery",
        "type": "refinery",
        "lat": 12.79, "lon": 45.02,
        "region_keys": ["red_sea_yemen"],
        "note": "Yemen's main refinery, on the Gulf of Aden.",
    },
    {
        "id": "djibouti_port",
        "name": "Port of Djibouti",
        "type": "port",
        "lat": 11.6, "lon": 43.15,
        "region_keys": ["red_sea_yemen"],
        "note": "Primary shipping/logistics hub for the Bab-el-Mandeb approach; hosts multiple foreign naval bases.",
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
    {
        "id": "tsmc_tainan",
        "name": "TSMC Tainan (Fab 18)",
        "type": "fab",
        "lat": 22.79, "lon": 120.31,
        "region_keys": ["taiwan_strait"],
        "note": "TSMC's most advanced-node production site.",
    },
    {
        "id": "kaohsiung_port",
        "name": "Port of Kaohsiung",
        "type": "port",
        "lat": 22.61, "lon": 120.28,
        "region_keys": ["taiwan_strait"],
        "note": "Taiwan's largest port, critical for energy imports (Taiwan has almost no domestic fossil fuel production).",
    },

    # ---- Korean Peninsula ----
    {
        "id": "kori_npp",
        "name": "Kori Nuclear Power Plant",
        "type": "nuclear",
        "lat": 35.32, "lon": 129.29,
        "region_keys": ["korean_peninsula"],
        "note": "South Korea's first and one of its largest nuclear plants, near Busan.",
    },
    {
        "id": "ulsan_refinery",
        "name": "Ulsan Refinery Complex",
        "type": "refinery",
        "lat": 35.5, "lon": 129.38,
        "region_keys": ["korean_peninsula"],
        "note": "One of the world's largest single refining complexes (SK Energy).",
    },
    {
        "id": "yongbyon_nuclear",
        "name": "Yongbyon Nuclear Scientific Research Center",
        "type": "nuclear",
        "lat": 39.8, "lon": 125.75,
        "region_keys": ["korean_peninsula"],
        "note": "North Korea's primary nuclear fuel/weapons-related facility.",
    },
    {
        "id": "busan_port",
        "name": "Port of Busan",
        "type": "port",
        "lat": 35.1, "lon": 129.04,
        "region_keys": ["korean_peninsula"],
        "note": "South Korea's largest port, one of the world's busiest container hubs.",
    },

    # ---- South China Sea ----
    {
        "id": "singapore_jurong",
        "name": "Jurong Island Refining & Petrochemical Hub",
        "type": "refinery",
        "lat": 1.27, "lon": 103.7,
        "region_keys": ["south_china_sea"],
        "note": "Singapore's integrated refining/petrochemical complex, anchoring the Malacca Strait trade route.",
    },
    {
        "id": "singapore_port",
        "name": "Port of Singapore",
        "type": "port",
        "lat": 1.27, "lon": 103.85,
        "region_keys": ["south_china_sea"],
        "note": "World's second-busiest transshipment port, gateway to the Malacca Strait chokepoint.",
    },
    {
        "id": "malampaya_gas",
        "name": "Malampaya Gas-to-Power Facility",
        "type": "lng_terminal",
        "lat": 11.13, "lon": 118.83,
        "region_keys": ["south_china_sea"],
        "note": "Philippines' major offshore gas field, in contested South China Sea waters.",
    },

    # ---- Sahel ----
    {
        "id": "gao_refinery_area",
        "name": "Trans-Saharan Gas Pipeline (planned corridor, Gao segment)",
        "type": "pipeline",
        "lat": 16.27, "lon": -0.04,
        "region_keys": ["sahel"],
        "note": "Reference point on the long-planned Nigeria-Algeria gas corridor through the Sahel.",
    },
    {
        "id": "niamey_refinery",
        "name": "Zinder (SORAZ) Refinery",
        "type": "refinery",
        "lat": 13.8, "lon": 8.99,
        "region_keys": ["sahel"],
        "note": "Niger's only oil refinery.",
    },

    # ---- Sudan ----
    {
        "id": "port_sudan",
        "name": "Port Sudan",
        "type": "port",
        "lat": 19.62, "lon": 37.22,
        "region_keys": ["sudan"],
        "note": "Sudan's principal Red Sea port and de facto wartime capital.",
    },
    {
        "id": "khartoum_refinery",
        "name": "Khartoum Refinery",
        "type": "refinery",
        "lat": 15.65, "lon": 32.58,
        "region_keys": ["sudan"],
        "note": "Sudan's main refinery, repeatedly fought over since the 2023 civil war began.",
    },

    # ---- Venezuela / Caribbean ----
    {
        "id": "amuay_refinery",
        "name": "Amuay Refinery (Paraguaná Complex)",
        "type": "refinery",
        "lat": 11.75, "lon": -70.2,
        "region_keys": ["venezuela_caribbean"],
        "note": "Part of the Paraguaná Refining Complex, one of the world's largest.",
    },
    {
        "id": "jose_terminal",
        "name": "José Terminal & Petrochemical Complex",
        "type": "port",
        "lat": 10.13, "lon": -64.75,
        "region_keys": ["venezuela_caribbean"],
        "note": "Venezuela's main crude blending/export terminal on the Caribbean coast.",
    },
    {
        "id": "curacao_terminal",
        "name": "Curaçao Isla Refinery / Bullenbaai Terminal",
        "type": "port",
        "lat": 12.1, "lon": -68.87,
        "region_keys": ["venezuela_caribbean"],
        "note": "Key Caribbean refining/storage terminal historically tied to Venezuelan crude.",
    },

    # ---- Israel / Gaza / Lebanon ----
    {
        "id": "haifa_refinery",
        "name": "Haifa Bay Refinery & Port",
        "type": "refinery",
        "lat": 32.82, "lon": 35.0,
        "region_keys": ["israel_gaza_lebanon"],
        "note": "Israel's largest refinery and a major Mediterranean port.",
    },
    {
        "id": "ashkelon_terminal",
        "name": "Ashkelon Oil Terminal",
        "type": "port",
        "lat": 31.67, "lon": 34.55,
        "region_keys": ["israel_gaza_lebanon"],
        "note": "Mediterranean end of the Eilat-Ashkelon pipeline, an Indian Ocean-to-Mediterranean bypass for the Suez Canal.",
    },
    {
        "id": "tamar_gas_field",
        "name": "Tamar Gas Field Platform",
        "type": "lng_terminal",
        "lat": 32.85, "lon": 34.3,
        "region_keys": ["israel_gaza_lebanon"],
        "note": "Major offshore Mediterranean gas field supplying Israeli and regional demand.",
    },

    # ---- Global (not tied to one conflict-zone theater) ----
    {
        "id": "jamnagar_refinery",
        "name": "Jamnagar Refinery",
        "type": "refinery",
        "lat": 22.34, "lon": 69.85,
        "region_keys": [],
        "note": "Reliance's Jamnagar complex -- the world's largest single refining complex.",
    },
    {
        "id": "rotterdam_port",
        "name": "Port of Rotterdam",
        "type": "port",
        "lat": 51.95, "lon": 4.14,
        "region_keys": [],
        "note": "Europe's largest port and a major refining/petrochemical hub.",
    },
    {
        "id": "shanghai_port",
        "name": "Port of Shanghai",
        "type": "port",
        "lat": 31.05, "lon": 121.86,
        "region_keys": [],
        "note": "World's busiest container port.",
    },
    {
        "id": "los_angeles_long_beach",
        "name": "Port of Los Angeles / Long Beach",
        "type": "port",
        "lat": 33.74, "lon": -118.25,
        "region_keys": [],
        "note": "Busiest container port complex in the Western Hemisphere.",
    },
    {
        "id": "samsung_pyeongtaek",
        "name": "Samsung Pyeongtaek Fab",
        "type": "fab",
        "lat": 37.05, "lon": 126.95,
        "region_keys": [],
        "note": "Samsung's largest semiconductor manufacturing campus.",
    },
    {
        "id": "intel_arizona",
        "name": "Intel Ocotillo (Arizona) Fabs",
        "type": "fab",
        "lat": 33.32, "lon": -111.93,
        "region_keys": [],
        "note": "Major US advanced-logic fabrication campus.",
    },
    {
        "id": "fukushima_daini",
        "name": "Fukushima Daini Nuclear Power Plant",
        "type": "nuclear",
        "lat": 37.32, "lon": 141.03,
        "region_keys": [],
        "note": "Japanese nuclear plant adjacent to the decommissioned Fukushima Daiichi site.",
    },
    {
        "id": "diablo_canyon_npp",
        "name": "Diablo Canyon Power Plant",
        "type": "nuclear",
        "lat": 35.21, "lon": -120.85,
        "region_keys": [],
        "note": "California's only operating nuclear power plant.",
    },
    {
        "id": "sorek_desalination",
        "name": "Sorek Desalination Plant",
        "type": "desalination",
        "lat": 31.9, "lon": 34.71,
        "region_keys": [],
        "note": "One of the world's largest seawater reverse-osmosis desalination plants.",
    },
    {
        "id": "carlsbad_desalination",
        "name": "Carlsbad Desalination Plant",
        "type": "desalination",
        "lat": 33.11, "lon": -117.32,
        "region_keys": [],
        "note": "Largest seawater desalination plant in the Western Hemisphere.",
    },
    {
        "id": "ras_gas_qatargas",
        "name": "Sabine Pass LNG Terminal",
        "type": "lng_terminal",
        "lat": 29.74, "lon": -93.87,
        "region_keys": [],
        "note": "One of the largest LNG export terminals in the United States.",
    },
]


# Major oil/gas pipeline routes -- rendered as lines rather than points.
# `coords` are approximate waypoints along the real route, not surveyed
# geometry; `region_keys` mirrors INFRA_SITES (empty == not zone-specific).
PIPELINE_ROUTES: list[dict] = [
    {
        "id": "trans_alaska",
        "name": "Trans-Alaska Pipeline",
        "region_keys": [],
        "note": "Prudhoe Bay to Valdez, ~1,300km, one of the largest pipelines in the US.",
        "coords": [[70.25, -148.5], [66.6, -145.4], [64.84, -147.72], [61.6, -149.1], [61.13, -146.35]],
    },
    {
        "id": "keystone",
        "name": "Keystone Pipeline",
        "region_keys": [],
        "note": "Hardisty, Alberta to Gulf Coast refineries (Houston/Port Arthur), simplified route.",
        "coords": [[52.68, -111.3], [49.9, -97.13], [41.6, -93.6], [35.5, -97.5], [29.75, -95.0]],
    },
    {
        "id": "druzhba",
        "name": "Druzhba Pipeline",
        "region_keys": ["russia_ukraine"],
        "note": "One of the world's longest oil pipelines, Russia to Central/Eastern Europe.",
        "coords": [[54.9, 52.3], [53.9, 44.0], [52.4, 31.4], [51.7, 26.4], [50.68, 21.27], [48.1, 20.4]],
    },
    {
        "id": "btc_pipeline",
        "name": "Baku-Tbilisi-Ceyhan (BTC) Pipeline",
        "region_keys": [],
        "note": "Caspian crude export route bypassing Russian territory, to the Mediterranean.",
        "coords": [[40.4, 49.87], [41.72, 44.79], [37.05, 35.68]],
    },
    {
        "id": "iraq_turkey_pipeline",
        "name": "Iraq-Turkey Pipeline (Kirkuk-Ceyhan)",
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Northern Iraqi crude export route to the Mediterranean.",
        "coords": [[35.47, 44.39], [37.22, 42.48], [37.05, 35.68]],
    },
    {
        "id": "petroline_east_west",
        "name": "Saudi East-West Pipeline (Petroline)",
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Carries crude from the Eastern Province to the Red Sea, bypassing the Strait of Hormuz entirely.",
        "coords": [[26.0, 49.2], [24.9, 46.0], [23.5, 42.0], [21.0, 39.15]],
    },
    {
        "id": "habshan_fujairah_pipeline",
        "name": "Habshan-Fujairah Pipeline",
        "region_keys": ["persian_gulf_hormuz"],
        "note": "ADNOC strategic pipeline built to bypass the Strait of Hormuz, running from onshore Abu Dhabi to the Gulf of Oman.",
        "coords": [[23.75, 53.65], [24.15, 54.9], [25.11, 56.34]],
    },
    {
        "id": "power_of_siberia",
        "name": "Power of Siberia Pipeline",
        "region_keys": [],
        "note": "Major Russia-to-China gas export pipeline.",
        "coords": [[62.0, 118.0], [56.05, 122.0], [50.35, 127.5], [45.75, 127.15]],
    },
    {
        "id": "turkstream",
        "name": "TurkStream Pipeline",
        "region_keys": [],
        "note": "Russian gas export route under the Black Sea to Turkey and southeastern Europe.",
        "coords": [[44.4, 37.8], [42.0, 35.5], [41.0, 28.95], [42.7, 25.5]],
    },
    {
        "id": "transmed",
        "name": "Trans-Mediterranean Pipeline (Transmed)",
        "region_keys": [],
        "note": "Algerian gas export route to Italy via Tunisia and Sicily.",
        "coords": [[35.0, 6.85], [36.8, 10.2], [37.5, 13.0], [38.1, 15.6]],
    },
]



# Military bases -- rendered through the same "sites" list/Infra toggle as
# everything else above (type: "military", plus a `subtype` the frontend
# uses to pick an icon: air/naval/army/missile/joint/logistics/radar). Same
# curation standard as INFRA_SITES: only well-documented, unambiguous
# installations from public reference material, approximate coordinates.
MILITARY_BASES: list[dict] = [
    # ---- Persian Gulf / Strait of Hormuz ----
    {
        "id": "al_udeid_ab",
        "name": "Al Udeid Air Base",
        "type": "military", "subtype": "air",
        "lat": 25.12, "lon": 51.32,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Largest US military installation in the Middle East; forward HQ for US CENTCOM air operations.",
    },
    {
        "id": "nsa_bahrain",
        "name": "Naval Support Activity Bahrain",
        "type": "military", "subtype": "naval",
        "lat": 26.21, "lon": 50.61,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Homeport of the US Navy's 5th Fleet, responsible for the Persian Gulf/Red Sea/Arabian Sea.",
    },
    {
        "id": "camp_arifjan",
        "name": "Camp Arifjan",
        "type": "military", "subtype": "army",
        "lat": 28.86, "lon": 48.15,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Major US Army logistics and command base in Kuwait.",
    },
    {
        "id": "bandar_abbas_naval",
        "name": "Bandar Abbas Naval Base",
        "type": "military", "subtype": "naval",
        "lat": 27.14, "lon": 56.36,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Iranian Navy/IRGC Navy headquarters on the Strait of Hormuz.",
    },
    {
        "id": "chabahar_naval",
        "name": "Chabahar Naval Base",
        "type": "military", "subtype": "naval",
        "lat": 25.29, "lon": 60.62,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Iranian naval base on the Gulf of Oman, outside the Strait of Hormuz.",
    },

    # ---- Russia / Ukraine ----
    {
        "id": "sevastopol_naval",
        "name": "Sevastopol Naval Base (Black Sea Fleet HQ)",
        "type": "military", "subtype": "naval",
        "lat": 44.62, "lon": 33.53,
        "region_keys": ["russia_ukraine"],
        "note": "Headquarters of Russia's Black Sea Fleet, in occupied Crimea.",
    },
    {
        "id": "novorossiysk_naval",
        "name": "Novorossiysk Naval Base",
        "type": "military", "subtype": "naval",
        "lat": 44.71, "lon": 37.78,
        "region_keys": ["russia_ukraine"],
        "note": "Secondary Black Sea Fleet base, expanded after the fleet's Crimea losses.",
    },
    {
        "id": "hmeimim_ab",
        "name": "Hmeimim Air Base",
        "type": "military", "subtype": "air",
        "lat": 35.4, "lon": 35.95,
        "region_keys": [],
        "note": "Russia's main air base in Syria, staging point for its Mediterranean/African operations.",
    },

    # ---- Red Sea / Yemen ----
    {
        "id": "camp_lemonnier",
        "name": "Camp Lemonnier",
        "type": "military", "subtype": "joint",
        "lat": 11.54, "lon": 43.16,
        "region_keys": ["red_sea_yemen"],
        "note": "Only permanent US base in Africa; also hosts French, Japanese, and other allied forces nearby.",
    },
    {
        "id": "doraleh_naval",
        "name": "Doraleh (China PLA Support Base)",
        "type": "military", "subtype": "naval",
        "lat": 11.6, "lon": 43.05,
        "region_keys": ["red_sea_yemen"],
        "note": "China's only overseas naval base, at the Bab-el-Mandeb chokepoint.",
    },

    # ---- Korean Peninsula ----
    {
        "id": "osan_ab",
        "name": "Osan Air Base",
        "type": "military", "subtype": "air",
        "lat": 37.09, "lon": 127.03,
        "region_keys": ["korean_peninsula"],
        "note": "Headquarters of US 7th Air Force in South Korea.",
    },
    {
        "id": "camp_humphreys",
        "name": "Camp Humphreys",
        "type": "military", "subtype": "army",
        "lat": 36.97, "lon": 127.03,
        "region_keys": ["korean_peninsula"],
        "note": "Largest overseas US military installation, headquarters of US Forces Korea.",
    },
    {
        "id": "sinpo_naval",
        "name": "Sinpo Naval Shipyard",
        "type": "military", "subtype": "missile",
        "lat": 40.03, "lon": 128.19,
        "region_keys": ["korean_peninsula"],
        "note": "North Korean submarine construction/ballistic missile submarine test site.",
    },

    # ---- Taiwan Strait / South China Sea ----
    {
        "id": "kadena_ab",
        "name": "Kadena Air Base",
        "type": "military", "subtype": "air",
        "lat": 26.36, "lon": 127.77,
        "region_keys": ["taiwan_strait", "south_china_sea"],
        "note": "Largest US Air Force base in the Pacific, on Okinawa.",
    },
    {
        "id": "andersen_afb",
        "name": "Andersen Air Force Base",
        "type": "military", "subtype": "air",
        "lat": 13.58, "lon": 144.93,
        "region_keys": ["south_china_sea"],
        "note": "Key US Pacific bomber/tanker staging base on Guam.",
    },
    {
        "id": "us_naval_base_guam",
        "name": "US Naval Base Guam",
        "type": "military", "subtype": "naval",
        "lat": 13.44, "lon": 144.66,
        "region_keys": ["south_china_sea"],
        "note": "Forward submarine base supporting US Pacific Fleet operations.",
    },
    {
        "id": "yulin_naval",
        "name": "Yulin Naval Base",
        "type": "military", "subtype": "naval",
        "lat": 18.22, "lon": 109.58,
        "region_keys": ["south_china_sea"],
        "note": "Chinese nuclear submarine base on Hainan Island.",
    },
    {
        "id": "fiery_cross_reef",
        "name": "Fiery Cross Reef",
        "type": "military", "subtype": "air",
        "lat": 9.55, "lon": 112.89,
        "region_keys": ["south_china_sea"],
        "note": "Chinese artificial island with a military airstrip in the contested Spratly Islands.",
    },

    # ---- Israel / Gaza / Lebanon ----
    {
        "id": "nevatim_ab",
        "name": "Nevatim Airbase",
        "type": "military", "subtype": "air",
        "lat": 31.21, "lon": 34.99,
        "region_keys": ["israel_gaza_lebanon"],
        "note": "Main Israeli Air Force fighter base, home to Israel's F-35 squadron.",
    },
    {
        "id": "palmachim_ab",
        "name": "Palmachim Airbase",
        "type": "military", "subtype": "missile",
        "lat": 31.89, "lon": 34.69,
        "region_keys": ["israel_gaza_lebanon"],
        "note": "Israeli missile/space launch site and air defense test range.",
    },

    # ---- Global reference bases (not tied to one conflict zone) ----
    {
        "id": "ramstein_ab",
        "name": "Ramstein Air Base",
        "type": "military", "subtype": "air",
        "lat": 49.44, "lon": 7.6,
        "region_keys": [],
        "note": "Headquarters of US Air Forces in Europe and NATO Allied Air Command.",
    },
    {
        "id": "naval_station_rota",
        "name": "Naval Station Rota",
        "type": "military", "subtype": "naval",
        "lat": 36.62, "lon": -6.35,
        "region_keys": [],
        "note": "Key US/Spanish naval base controlling the Strait of Gibraltar approach.",
    },
    {
        "id": "naval_station_norfolk",
        "name": "Naval Station Norfolk",
        "type": "military", "subtype": "naval",
        "lat": 36.94, "lon": -76.33,
        "region_keys": [],
        "note": "World's largest naval base by number of assigned personnel and ships.",
    },
    {
        "id": "diego_garcia",
        "name": "Diego Garcia",
        "type": "military", "subtype": "joint",
        "lat": -7.31, "lon": 72.41,
        "region_keys": [],
        "note": "Joint US/UK air and naval base in the Indian Ocean, key long-range bomber staging point.",
    },
    {
        "id": "incirlik_ab",
        "name": "Incirlik Air Base",
        "type": "military", "subtype": "air",
        "lat": 37.0, "lon": 35.43,
        "region_keys": [],
        "note": "Major NATO air base in Turkey, hosts a US nuclear weapons storage site.",
    },
    {
        "id": "yokosuka_naval",
        "name": "Yokosuka Naval Base",
        "type": "military", "subtype": "naval",
        "lat": 35.29, "lon": 139.67,
        "region_keys": [],
        "note": "Forward-deployed homeport of the US 7th Fleet, including its aircraft carrier.",
    },
    {
        "id": "thule_ab",
        "name": "Pituffik Space Base (Thule)",
        "type": "military", "subtype": "radar",
        "lat": 76.53, "lon": -68.7,
        "region_keys": [],
        "note": "Northernmost US installation; ballistic missile early-warning radar and satellite tracking.",
    },
    {
        "id": "rms_fylingdales",
        "name": "RAF Fylingdales",
        "type": "military", "subtype": "radar",
        "lat": 54.36, "lon": -0.67,
        "region_keys": [],
        "note": "UK ballistic missile early-warning and space-tracking radar, part of the US early-warning network.",
    },
    {
        "id": "vandenberg_sfb",
        "name": "Vandenberg Space Force Base",
        "type": "military", "subtype": "missile",
        "lat": 34.74, "lon": -120.57,
        "region_keys": [],
        "note": "Primary US West Coast space launch and ballistic missile test site.",
    },
]


def serialize() -> dict:
    return {"sites": INFRA_SITES + MILITARY_BASES, "pipelines": PIPELINE_ROUTES}
