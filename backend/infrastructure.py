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

from backend.sources.proximity import haversine_km

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

    # ==== Expanded global coverage (refineries) ====
    {
        "id": "baytown_refinery",
        "name": "Baytown Refinery",
        "type": "refinery", "lat": 29.73, "lon": -95.01,
        "region_keys": [],
        "note": "ExxonMobil's largest US refinery, part of the Houston Ship Channel refining complex.",
    },
    {
        "id": "port_arthur_refinery",
        "name": "Port Arthur Refinery",
        "type": "refinery", "lat": 29.9, "lon": -93.94,
        "region_keys": [],
        "note": "Motiva's Port Arthur plant, the largest single refinery in the United States.",
    },
    {
        "id": "baton_rouge_refinery",
        "name": "Baton Rouge Refinery",
        "type": "refinery", "lat": 30.45, "lon": -91.16,
        "region_keys": [],
        "note": "ExxonMobil's major Mississippi River refining/petrochemical complex.",
    },
    {
        "id": "whiting_refinery",
        "name": "Whiting Refinery",
        "type": "refinery", "lat": 41.68, "lon": -87.49,
        "region_keys": [],
        "note": "BP's largest US refinery, on Lake Michigan near Chicago.",
    },
    {
        "id": "antwerp_refinery",
        "name": "Antwerp Refinery",
        "type": "refinery", "lat": 51.29, "lon": 4.34,
        "region_keys": [],
        "note": "TotalEnergies refining/petrochemical complex, part of Europe's largest port-refinery cluster.",
    },
    {
        "id": "pernis_refinery",
        "name": "Pernis Refinery",
        "type": "refinery", "lat": 51.89, "lon": 4.36,
        "region_keys": [],
        "note": "Shell's largest refinery worldwide, at the Port of Rotterdam.",
    },
    {
        "id": "wilhelmshaven_refinery",
        "name": "Wilhelmshaven Refinery Area",
        "type": "refinery", "lat": 53.53, "lon": 8.11,
        "region_keys": [],
        "note": "Germany's only deepwater oil port and refining/import hub on the North Sea.",
    },
    {
        "id": "sines_refinery",
        "name": "Sines Refinery",
        "type": "refinery", "lat": 37.95, "lon": -8.87,
        "region_keys": [],
        "note": "Portugal's largest refinery, co-located with the country's main deepwater port.",
    },
    {
        "id": "sannazzaro_refinery",
        "name": "ENI Sannazzaro Refinery",
        "type": "refinery", "lat": 45.12, "lon": 8.9,
        "region_keys": [],
        "note": "Major Italian inland refinery serving northern Italy.",
    },
    {
        "id": "cartagena_refinery",
        "name": "Cartagena Refinery",
        "type": "refinery", "lat": 37.6, "lon": -0.98,
        "region_keys": [],
        "note": "Repsol's largest Spanish refinery, on the Mediterranean coast.",
    },
    {
        "id": "tuapse_refinery",
        "name": "Tuapse Refinery",
        "type": "refinery", "lat": 44.1, "lon": 39.07,
        "region_keys": ["russia_ukraine"],
        "note": "Rosneft Black Sea refinery, repeatedly struck by long-range Ukrainian drones.",
    },
    {
        "id": "omsk_refinery",
        "name": "Omsk Refinery",
        "type": "refinery", "lat": 54.97, "lon": 73.37,
        "region_keys": ["russia_ukraine"],
        "note": "One of Russia's largest refineries, deep in Siberia.",
    },
    {
        "id": "kstovo_refinery",
        "name": "Kstovo (Nizhny Novgorod) Refinery",
        "type": "refinery", "lat": 56.14, "lon": 44.15,
        "region_keys": ["russia_ukraine"],
        "note": "Lukoil refinery repeatedly hit in Ukraine's long-range drone campaign.",
    },
    {
        "id": "mina_al_ahmadi_refinery",
        "name": "Mina Al Ahmadi Refinery",
        "type": "refinery", "lat": 29.08, "lon": 48.14,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Kuwait's largest refinery and main oil export terminal.",
    },
    {
        "id": "sitra_refinery",
        "name": "Sitra Refinery",
        "type": "refinery", "lat": 26.15, "lon": 50.62,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Bahrain's Bapco refinery, supplied partly via pipeline from Saudi Arabia.",
    },
    {
        "id": "zawiya_refinery",
        "name": "Zawiya Refinery",
        "type": "refinery", "lat": 32.75, "lon": 12.73,
        "region_keys": [],
        "note": "One of Libya's largest refineries, west of Tripoli.",
    },
    {
        "id": "skikda_refinery",
        "name": "Skikda Refinery",
        "type": "refinery", "lat": 36.88, "lon": 6.9,
        "region_keys": [],
        "note": "Algeria's largest refining/LNG export complex on the Mediterranean.",
    },
    {
        "id": "durban_refinery",
        "name": "Durban Refinery (Sapref/Enref)",
        "type": "refinery", "lat": -29.87, "lon": 31.02,
        "region_keys": [],
        "note": "South Africa's largest refining hub, on the Indian Ocean coast.",
    },
    {
        "id": "cilacap_refinery",
        "name": "Cilacap Refinery",
        "type": "refinery", "lat": -7.7, "lon": 109.02,
        "region_keys": [],
        "note": "Pertamina's largest refinery, supplying much of Indonesia's fuel.",
    },
    {
        "id": "map_ta_phut_complex",
        "name": "Map Ta Phut Industrial Estate",
        "type": "refinery", "lat": 12.68, "lon": 101.15,
        "region_keys": [],
        "note": "Thailand's largest refining/petrochemical industrial estate.",
    },

    # ==== Expanded global coverage (ports) ====
    {
        "id": "antwerp_bruges_port",
        "name": "Port of Antwerp-Bruges",
        "type": "port", "lat": 51.28, "lon": 4.34,
        "region_keys": [],
        "note": "Europe's second-largest port, merged Antwerp/Zeebrugge complex.",
    },
    {
        "id": "hamburg_port",
        "name": "Port of Hamburg",
        "type": "port", "lat": 53.54, "lon": 9.97,
        "region_keys": [],
        "note": "Germany's largest port and a key North Sea/Baltic gateway.",
    },
    {
        "id": "piraeus_port",
        "name": "Port of Piraeus",
        "type": "port", "lat": 37.94, "lon": 23.64,
        "region_keys": [],
        "note": "Greece's largest port, majority-owned by China's COSCO Shipping.",
    },
    {
        "id": "valencia_port",
        "name": "Port of Valencia",
        "type": "port", "lat": 39.44, "lon": -0.32,
        "region_keys": [],
        "note": "Spain's busiest container port on the Mediterranean.",
    },
    {
        "id": "colombo_port",
        "name": "Port of Colombo",
        "type": "port", "lat": 6.95, "lon": 79.84,
        "region_keys": [],
        "note": "Sri Lanka's main port and a key Indian Ocean transshipment hub, with a China-operated terminal.",
    },
    {
        "id": "gwadar_port",
        "name": "Port of Gwadar",
        "type": "port", "lat": 25.13, "lon": 62.33,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Pakistani deepwater port on the Arabian Sea, developed and operated by China under CPEC.",
    },
    {
        "id": "chennai_port",
        "name": "Port of Chennai",
        "type": "port", "lat": 13.1, "lon": 80.3,
        "region_keys": [],
        "note": "One of India's major container and cargo ports on the Bay of Bengal.",
    },
    {
        "id": "jnpt_mumbai_port",
        "name": "Jawaharlal Nehru Port (Mumbai)",
        "type": "port", "lat": 18.95, "lon": 72.95,
        "region_keys": [],
        "note": "India's largest container port, on the Arabian Sea.",
    },
    {
        "id": "ningbo_zhoushan_port",
        "name": "Port of Ningbo-Zhoushan",
        "type": "port", "lat": 29.87, "lon": 121.85,
        "region_keys": ["south_china_sea"],
        "note": "World's busiest port by cargo tonnage.",
    },
    {
        "id": "shenzhen_port",
        "name": "Port of Shenzhen",
        "type": "port", "lat": 22.5, "lon": 113.9,
        "region_keys": ["south_china_sea"],
        "note": "One of the world's busiest container ports, in the Pearl River Delta.",
    },
    {
        "id": "hong_kong_port",
        "name": "Port of Hong Kong",
        "type": "port", "lat": 22.3, "lon": 114.17,
        "region_keys": ["south_china_sea"],
        "note": "Historic deepwater port and major transshipment hub at the mouth of the Pearl River.",
    },
    {
        "id": "tokyo_port",
        "name": "Port of Tokyo",
        "type": "port", "lat": 35.62, "lon": 139.77,
        "region_keys": [],
        "note": "Japan's largest container port by volume.",
    },
    {
        "id": "yokohama_port",
        "name": "Port of Yokohama",
        "type": "port", "lat": 35.44, "lon": 139.65,
        "region_keys": [],
        "note": "Major Japanese port adjacent to Tokyo Bay, key auto/cargo export hub.",
    },
    {
        "id": "manila_port",
        "name": "Port of Manila",
        "type": "port", "lat": 14.58, "lon": 120.95,
        "region_keys": ["south_china_sea"],
        "note": "The Philippines' main international shipping gateway.",
    },
    {
        "id": "tanjung_priok_port",
        "name": "Tanjung Priok Port (Jakarta)",
        "type": "port", "lat": -6.1, "lon": 106.88,
        "region_keys": ["south_china_sea"],
        "note": "Indonesia's busiest port, main gateway to the capital region.",
    },
    {
        "id": "sydney_port",
        "name": "Port of Sydney (Botany)",
        "type": "port", "lat": -33.95, "lon": 151.22,
        "region_keys": [],
        "note": "Australia's main east-coast container port.",
    },
    {
        "id": "vancouver_port",
        "name": "Port of Vancouver",
        "type": "port", "lat": 49.29, "lon": -123.11,
        "region_keys": [],
        "note": "Canada's largest and most diversified port.",
    },
    {
        "id": "nynj_port",
        "name": "Port of New York and New Jersey",
        "type": "port", "lat": 40.67, "lon": -74.13,
        "region_keys": [],
        "note": "Largest port complex on the US East Coast.",
    },
    {
        "id": "savannah_port",
        "name": "Port of Savannah",
        "type": "port", "lat": 32.08, "lon": -81.09,
        "region_keys": [],
        "note": "Largest single-terminal container facility in North America.",
    },
    {
        "id": "houston_port",
        "name": "Port of Houston",
        "type": "port", "lat": 29.73, "lon": -95.26,
        "region_keys": [],
        "note": "Largest US port by foreign waterborne tonnage; anchors the Gulf Coast refining complex.",
    },
    {
        "id": "santos_port",
        "name": "Port of Santos",
        "type": "port", "lat": -23.96, "lon": -46.33,
        "region_keys": [],
        "note": "Largest port in Latin America, Brazil's principal export gateway.",
    },
    {
        "id": "callao_port",
        "name": "Port of Callao",
        "type": "port", "lat": -12.05, "lon": -77.15,
        "region_keys": [],
        "note": "Peru's main port, serving Lima and the central Andes.",
    },
    {
        "id": "suez_canal_north",
        "name": "Suez Canal (Port Said Approach)",
        "type": "port", "lat": 31.26, "lon": 32.31,
        "region_keys": ["red_sea_yemen"],
        "note": "Northern entrance to the Suez Canal, the Mediterranean-Red Sea shortcut for ~12% of world trade.",
    },
    {
        "id": "panama_canal_balboa",
        "name": "Panama Canal (Balboa/Pacific Entrance)",
        "type": "port", "lat": 8.95, "lon": -79.57,
        "region_keys": [],
        "note": "Pacific entrance to the Panama Canal, a chokepoint for Asia-US East Coast trade.",
    },
    {
        "id": "mombasa_port",
        "name": "Port of Mombasa",
        "type": "port", "lat": -4.06, "lon": 39.66,
        "region_keys": [],
        "note": "East Africa's largest port, gateway to Kenya, Uganda, and the Great Lakes region.",
    },

    # ==== Expanded global coverage (LNG terminals) ====
    {
        "id": "freeport_lng",
        "name": "Freeport LNG",
        "type": "lng_terminal", "lat": 28.94, "lon": -95.31,
        "region_keys": [],
        "note": "Major US LNG export terminal on the Texas Gulf Coast.",
    },
    {
        "id": "corpus_christi_lng",
        "name": "Corpus Christi LNG",
        "type": "lng_terminal", "lat": 27.85, "lon": -97.28,
        "region_keys": [],
        "note": "Cheniere's second major US LNG export facility.",
    },
    {
        "id": "cameron_lng",
        "name": "Cameron LNG",
        "type": "lng_terminal", "lat": 29.79, "lon": -93.34,
        "region_keys": [],
        "note": "Major Louisiana LNG export terminal.",
    },
    {
        "id": "cove_point_lng",
        "name": "Cove Point LNG",
        "type": "lng_terminal", "lat": 38.39, "lon": -76.38,
        "region_keys": [],
        "note": "US East Coast LNG export/import terminal on Chesapeake Bay.",
    },
    {
        "id": "gorgon_lng",
        "name": "Gorgon LNG",
        "type": "lng_terminal", "lat": -20.68, "lon": 115.45,
        "region_keys": [],
        "note": "One of the world's largest LNG projects, on Barrow Island, Australia.",
    },
    {
        "id": "nw_shelf_lng",
        "name": "North West Shelf LNG",
        "type": "lng_terminal", "lat": -20.66, "lon": 116.14,
        "region_keys": [],
        "note": "Australia's original and long-running major LNG export venture.",
    },
    {
        "id": "bontang_lng",
        "name": "Bontang LNG",
        "type": "lng_terminal", "lat": 0.15, "lon": 117.48,
        "region_keys": ["south_china_sea"],
        "note": "Major Indonesian LNG export plant on Borneo.",
    },
    {
        "id": "yamal_lng",
        "name": "Yamal LNG",
        "type": "lng_terminal", "lat": 71.28, "lon": 72.0,
        "region_keys": [],
        "note": "Major Russian Arctic LNG export project on the Yamal Peninsula, sanctioned by Western governments.",
    },
    {
        "id": "zeebrugge_lng",
        "name": "Zeebrugge LNG Terminal",
        "type": "lng_terminal", "lat": 51.35, "lon": 3.2,
        "region_keys": [],
        "note": "Belgium's LNG import terminal, a key European gas-security asset.",
    },
    {
        "id": "grain_lng",
        "name": "Grain LNG Terminal",
        "type": "lng_terminal", "lat": 51.45, "lon": 0.71,
        "region_keys": [],
        "note": "UK's largest LNG import terminal, on the Isle of Grain.",
    },
    {
        "id": "bilbao_lng",
        "name": "Bilbao LNG Terminal",
        "type": "lng_terminal", "lat": 43.42, "lon": -3.08,
        "region_keys": [],
        "note": "Major Spanish LNG import terminal on the Bay of Biscay.",
    },
    {
        "id": "bonny_island_lng",
        "name": "Nigeria LNG Bonny Island",
        "type": "lng_terminal", "lat": 4.43, "lon": 7.17,
        "region_keys": [],
        "note": "Nigeria's sole LNG export complex, a key West African gas earner.",
    },
    {
        "id": "damietta_lng",
        "name": "Damietta LNG",
        "type": "lng_terminal", "lat": 31.42, "lon": 31.79,
        "region_keys": [],
        "note": "Major Egyptian LNG liquefaction/export terminal on the Mediterranean.",
    },
    {
        "id": "idku_lng",
        "name": "Idku LNG",
        "type": "lng_terminal", "lat": 31.32, "lon": 30.28,
        "region_keys": [],
        "note": "Egypt's other major LNG export plant, near Alexandria.",
    },
    {
        "id": "soyo_lng",
        "name": "Angola LNG (Soyo)",
        "type": "lng_terminal", "lat": -6.14, "lon": 12.37,
        "region_keys": [],
        "note": "Angola's LNG export complex at the mouth of the Congo River.",
    },

    # ==== Expanded global coverage (nuclear power plants) ====
    {
        "id": "bruce_npp",
        "name": "Bruce Nuclear Generating Station",
        "type": "nuclear", "lat": 44.33, "lon": -81.6,
        "region_keys": [],
        "note": "World's largest operating nuclear power plant by installed capacity, in Ontario, Canada.",
    },
    {
        "id": "palo_verde_npp",
        "name": "Palo Verde Nuclear Generating Station",
        "type": "nuclear", "lat": 33.39, "lon": -112.86,
        "region_keys": [],
        "note": "Largest nuclear plant in the United States, notably not sited near a large body of water.",
    },
    {
        "id": "gravelines_npp",
        "name": "Gravelines Nuclear Power Plant",
        "type": "nuclear", "lat": 51.02, "lon": 2.13,
        "region_keys": [],
        "note": "Largest nuclear power plant in Western Europe, on France's North Sea coast.",
    },
    {
        "id": "cattenom_npp",
        "name": "Cattenom Nuclear Power Plant",
        "type": "nuclear", "lat": 49.42, "lon": 6.22,
        "region_keys": [],
        "note": "Major French nuclear plant near the Luxembourg/German border.",
    },
    {
        "id": "doel_npp",
        "name": "Doel Nuclear Power Plant",
        "type": "nuclear", "lat": 51.32, "lon": 4.25,
        "region_keys": [],
        "note": "One of Belgium's two nuclear plants, on the Scheldt near Antwerp.",
    },
    {
        "id": "sizewell_npp",
        "name": "Sizewell Nuclear Power Station",
        "type": "nuclear", "lat": 52.21, "lon": 1.62,
        "region_keys": [],
        "note": "UK nuclear site on the North Sea coast, with a new reactor (Sizewell C) under construction.",
    },
    {
        "id": "hinkley_point_npp",
        "name": "Hinkley Point",
        "type": "nuclear", "lat": 51.21, "lon": -3.13,
        "region_keys": [],
        "note": "UK nuclear site in Somerset, home to the Hinkley Point C new-build reactor project.",
    },
    {
        "id": "kashiwazaki_kariwa_npp",
        "name": "Kashiwazaki-Kariwa Nuclear Power Plant",
        "type": "nuclear", "lat": 37.43, "lon": 138.6,
        "region_keys": [],
        "note": "World's largest nuclear power plant by generating capacity, in Japan.",
    },
    {
        "id": "fukushima_daiichi_npp",
        "name": "Fukushima Daiichi Nuclear Power Plant",
        "type": "nuclear", "lat": 37.42, "lon": 141.03,
        "region_keys": [],
        "note": "Site of the 2011 meltdown, still under decades-long decommissioning.",
    },
    {
        "id": "tianwan_npp",
        "name": "Tianwan Nuclear Power Plant",
        "type": "nuclear", "lat": 34.69, "lon": 119.46,
        "region_keys": [],
        "note": "One of China's largest nuclear power complexes, on the Yellow Sea coast.",
    },
    {
        "id": "qinshan_npp",
        "name": "Qinshan Nuclear Power Plant",
        "type": "nuclear", "lat": 30.43, "lon": 120.96,
        "region_keys": [],
        "note": "China's first domestically built nuclear power plant.",
    },
    {
        "id": "kudankulam_npp",
        "name": "Kudankulam Nuclear Power Plant",
        "type": "nuclear", "lat": 8.17, "lon": 77.71,
        "region_keys": [],
        "note": "India's largest nuclear power station, built with Russian assistance.",
    },
    {
        "id": "bushehr_npp",
        "name": "Bushehr Nuclear Power Plant",
        "type": "nuclear", "lat": 28.83, "lon": 50.89,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Iran's only operating nuclear power plant, on the Persian Gulf coast.",
    },
    {
        "id": "koeberg_npp",
        "name": "Koeberg Nuclear Power Station",
        "type": "nuclear", "lat": -33.68, "lon": 18.43,
        "region_keys": [],
        "note": "Africa's only operating nuclear power plant, near Cape Town.",
    },
    {
        "id": "angra_npp",
        "name": "Angra Nuclear Power Plant",
        "type": "nuclear", "lat": -23.01, "lon": -44.46,
        "region_keys": [],
        "note": "Brazil's only nuclear power plant, on the Atlantic coast.",
    },

    # ==== Expanded global coverage (desalination) ====
    {
        "id": "taweelah_desalination",
        "name": "Taweelah Desalination Plant",
        "type": "desalination", "lat": 24.47, "lon": 54.63,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "World's largest reverse-osmosis desalination plant, in Abu Dhabi.",
    },
    {
        "id": "shuweihat_desalination",
        "name": "Shuweihat Desalination Complex",
        "type": "desalination", "lat": 24.22, "lon": 52.55,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Major UAE desalination and power co-generation complex.",
    },
    {
        "id": "al_jubail_desalination",
        "name": "Al Jubail Desalination Plant",
        "type": "desalination", "lat": 27.0, "lon": 49.66,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "One of Saudi Arabia's oldest and largest desalination complexes.",
    },
    {
        "id": "barka_desalination",
        "name": "Barka Desalination Plant",
        "type": "desalination", "lat": 23.7, "lon": 57.1,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Major Omani desalination and power plant on the Gulf of Oman.",
    },
    {
        "id": "hadera_desalination",
        "name": "Hadera Desalination Plant",
        "type": "desalination", "lat": 32.43, "lon": 34.87,
        "region_keys": ["israel_gaza_lebanon"],
        "note": "One of Israel's largest seawater desalination plants.",
    },
    {
        "id": "ashkelon_desalination",
        "name": "Ashkelon Desalination Plant",
        "type": "desalination", "lat": 31.65, "lon": 34.55,
        "region_keys": ["israel_gaza_lebanon"],
        "note": "One of the first large-scale seawater reverse-osmosis plants, supplying a large share of Israel's drinking water.",
    },
    {
        "id": "perth_desalination",
        "name": "Perth Seawater Desalination Plant",
        "type": "desalination", "lat": -32.28, "lon": 115.75,
        "region_keys": [],
        "note": "Key water source for Perth, Australia, powered by dedicated wind generation.",
    },
    {
        "id": "point_lisas_desalination",
        "name": "Point Lisas Desalination Plant",
        "type": "desalination", "lat": 10.4, "lon": -61.5,
        "region_keys": ["venezuela_caribbean"],
        "note": "Major Trinidad and Tobago desalination plant serving its industrial estate.",
    },
    {
        "id": "magtaa_desalination",
        "name": "Magtaa Desalination Plant",
        "type": "desalination", "lat": 35.67, "lon": -0.35,
        "region_keys": [],
        "note": "One of Africa's largest desalination plants, near Oran, Algeria.",
    },
    {
        "id": "hamma_desalination",
        "name": "Hamma Desalination Plant",
        "type": "desalination", "lat": 36.75, "lon": 3.09,
        "region_keys": [],
        "note": "Major desalination plant supplying Algiers, Algeria.",
    },

    # ==== Expanded global coverage (semiconductor fabs) ====
    {
        "id": "tsmc_taichung",
        "name": "TSMC Central Taiwan Science Park (Fab 15)",
        "type": "fab", "lat": 24.13, "lon": 120.68,
        "region_keys": ["taiwan_strait"],
        "note": "One of TSMC's largest fabs, producing advanced-node logic chips.",
    },
    {
        "id": "samsung_hwaseong",
        "name": "Samsung Hwaseong Campus",
        "type": "fab", "lat": 37.2, "lon": 126.83,
        "region_keys": ["korean_peninsula"],
        "note": "Samsung's leading-edge logic and memory fab cluster and R&D center.",
    },
    {
        "id": "sk_hynix_icheon",
        "name": "SK Hynix Icheon Campus",
        "type": "fab", "lat": 37.27, "lon": 127.44,
        "region_keys": ["korean_peninsula"],
        "note": "SK Hynix's main memory-chip manufacturing and R&D base in South Korea.",
    },
    {
        "id": "micron_boise",
        "name": "Micron Boise Campus",
        "type": "fab", "lat": 43.6, "lon": -116.2,
        "region_keys": [],
        "note": "Micron's headquarters fab, a core US memory-chip manufacturing site.",
    },
    {
        "id": "globalfoundries_malta",
        "name": "GlobalFoundries Malta, NY Fab",
        "type": "fab", "lat": 42.9, "lon": -73.79,
        "region_keys": [],
        "note": "Major US contract chip foundry in upstate New York.",
    },
    {
        "id": "ti_richardson",
        "name": "Texas Instruments Richardson Fab",
        "type": "fab", "lat": 32.95, "lon": -96.7,
        "region_keys": [],
        "note": "Key Texas Instruments analog/logic chip manufacturing site.",
    },
    {
        "id": "tsmc_arizona",
        "name": "TSMC Arizona (Phoenix)",
        "type": "fab", "lat": 33.63, "lon": -112.03,
        "region_keys": [],
        "note": "TSMC's flagship US fab project, aimed at diversifying advanced-node production outside Taiwan.",
    },
    {
        "id": "samsung_taylor",
        "name": "Samsung Taylor, Texas Fab",
        "type": "fab", "lat": 30.57, "lon": -97.41,
        "region_keys": [],
        "note": "Samsung's major new advanced-logic fab under construction in Texas.",
    },
    {
        "id": "infineon_dresden",
        "name": "Infineon Dresden Fab",
        "type": "fab", "lat": 51.03, "lon": 13.73,
        "region_keys": [],
        "note": "Major European power-semiconductor fab, anchoring Germany's 'Silicon Saxony' cluster.",
    },
    {
        "id": "st_crolles",
        "name": "STMicroelectronics Crolles Fab",
        "type": "fab", "lat": 45.27, "lon": 5.88,
        "region_keys": [],
        "note": "Major French semiconductor fab near Grenoble.",
    },
    {
        "id": "renesas_naka",
        "name": "Renesas Naka Fab",
        "type": "fab", "lat": 36.4, "lon": 140.5,
        "region_keys": [],
        "note": "Key Japanese automotive-chip fab, previously disrupted by earthquake damage.",
    },
    {
        "id": "kioxia_yokkaichi",
        "name": "Kioxia Yokkaichi Fab",
        "type": "fab", "lat": 34.95, "lon": 136.62,
        "region_keys": [],
        "note": "One of the world's largest flash-memory manufacturing complexes.",
    },
    {
        "id": "smic_shanghai",
        "name": "SMIC Shanghai Fab",
        "type": "fab", "lat": 31.2, "lon": 121.6,
        "region_keys": [],
        "note": "China's leading domestic chip foundry's flagship manufacturing site.",
    },
    {
        "id": "smic_beijing",
        "name": "SMIC Beijing Fab",
        "type": "fab", "lat": 39.9, "lon": 116.3,
        "region_keys": [],
        "note": "Major SMIC fab supporting China's push for semiconductor self-sufficiency.",
    },
]


# Major oil/gas pipeline routes -- rendered as lines rather than points.
# `coords` are approximate waypoints along the real route, not surveyed
# geometry; `region_keys` mirrors INFRA_SITES (empty == not zone-specific).
#
# Task 28: this list is untouched by that task and stays exactly what it has
# always been -- a hand-maintained schematic. What changed is what rides
# beside it: app.py's /api/infrastructure now folds in real pipeline
# *geometry* OpenStreetMap's Overpass sweep finds inside this map's eleven
# conflict theatres (backend/sources/osm_infra.py's "pipelines_osm" document,
# man_made=pipeline, with substance/operator/diameter where OSM has them),
# each entry stamped `source: "curated"` or `"osm"` so a reader can always
# tell which claim they are looking at. Outside those theatres, and for any
# route OSM has not mapped, this list is what a reader gets -- the fallback
# the merge is built to fall back to, provenance intact.
#
# Four routes have since been removed, and the rule they were removed by is worth
# stating because it decides what belongs here. A hand-drawn route whose corridor
# OSM's sweep *does* plot was drawing a second, worse line over a real one: these
# waypoint lists are schematic by construction -- four points for a 1,200km
# pipeline -- so where surveyed geometry exists the schematic is not a fallback,
# it is a competing and less accurate claim.
#
# Removed: druzhba, petroline_east_west (the Saudi East-West / Petroline),
# habshan_fujairah_pipeline, turkstream. Each has waypoints inside one of the
# eleven swept theatres, so Overpass returns man_made=pipeline geometry for them.
#
# Two consequences, stated rather than discovered later. Coverage for three of the
# four is *partial*: only Habshan-Fujairah lies wholly inside a swept box. Druzhba
# keeps its Belarus/north-Ukraine middle but loses the Samara head and the
# Hungarian tail; TurkStream keeps the Russian landfall but loses the Black Sea
# crossing and the Thrace/Bulgaria legs; Petroline keeps the Abqaiq end and loses
# the Riyadh-to-Yanbu two thirds -- the part that makes it a Hormuz bypass. Those
# segments are now drawn by nothing. And if the swept theatres are ever narrowed,
# the OSM geometry goes with them and nothing here replaces it.
#
# What stays: the six routes no swept box touches -- trans_alaska, keystone,
# btc_pipeline, iraq_turkey_pipeline, power_of_siberia, transmed. For those the
# schematic is the only line there is.
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
        "id": "power_of_siberia",
        "name": "Power of Siberia Pipeline",
        "region_keys": [],
        "note": "Major Russia-to-China gas export pipeline.",
        "coords": [[62.0, 118.0], [56.05, 122.0], [50.35, 127.5], [45.75, 127.15]],
    },
    {
        "id": "transmed",
        "name": "Trans-Mediterranean Pipeline (Transmed)",
        "region_keys": [],
        "note": "Algerian gas export route to Italy via Tunisia and Sicily.",
        "coords": [[35.0, 6.85], [36.8, 10.2], [37.5, 13.0], [38.1, 15.6]],
    },
]


# The ten shipping corridors people actually name -- Task 20b. Hand-drawn
# schematic waypoints, not a surveyed route and not derived from anything this
# map has observed (that claim belongs to lane_density.py's grid instead, see
# /api/lanes). Every entry carries `name` and `note`; where a transit figure is
# included it also carries `transits`, `transits_unit`, `transits_publisher`
# and `transits_year` -- the global rule against uncited numbers applies to
# this list as much as anywhere else, so a corridor with no figure this
# project can actually stand behind simply omits the four transit fields
# rather than guessing. test_shipping_corridors.py checks that pattern holds.
#
# Task 20 review (Critical): this list shipped with three `transits` figures
# (Suez, Hormuz, Panama) that were all wrong when checked against the
# publisher's own page -- Suez off by 547, Panama off by ~1,000 (a 7% gap the
# "approximate" label didn't cover), Hormuz a 2022-vs-2023 year mix-up. None
# were re-derived and re-added: a hand-maintained statistic in a Python
# literal has no refresh path, no owner and no way to signal staleness, which
# is exactly what this project's rule against presenting a number it did not
# receive is for. The bar for a transit figure to earn its way back in:
# verified against the publisher's own page (not an aggregator), with the
# source URL and access date stored beside the number so the next reader can
# check it and see how old the check is. All ten corridors below carry none
# until that bar is met.
#
# Task 20 review (Minor 1): the shipped `transits` field also conflated two
# different quantities under one name -- Hormuz's figure was an oil-flow rate
# (million barrels/day), everything else a vessel count. If a transit figure
# returns for a chokepoint, keep a genuine vessel count under `transits` and
# give a non-vessel quantity (barrels/day, tonnage, whatever the publisher
# actually reports) its own differently-named field instead of sharing this
# one -- `transits_unit` disambiguates it for a popup reader, but the schema
# itself should not need a unit string to say what kind of number it holds.
SHIPPING_LANES: list[dict] = [
    {
        "id": "suez_approach",
        "name": "Suez approach",
        "region_keys": ["red_sea_yemen"],
        "note": "Mediterranean-Red Sea shortcut via the Suez Canal -- schematic corridor, not a surveyed route.",
        "coords": [[31.26, 32.31], [30.6, 32.35], [29.95, 32.55], [29.5, 32.6]],
    },
    {
        "id": "bab_el_mandeb",
        "name": "Bab-el-Mandeb",
        "region_keys": ["red_sea_yemen"],
        "note": "Chokepoint linking the Red Sea/Suez route to the Gulf of Aden and Indian Ocean -- schematic corridor, not a surveyed route.",
        "coords": [[14.0, 42.6], [12.6, 43.4], [11.6, 43.8], [11.0, 44.5]],
    },
    {
        "id": "hormuz",
        "name": "Strait of Hormuz",
        "region_keys": ["persian_gulf_hormuz"],
        "note": "The sole sea passage between the Persian Gulf and the Gulf of Oman -- schematic corridor, not a surveyed route.",
        "coords": [[26.9, 51.5], [26.5, 55.0], [26.0, 56.3], [25.3, 57.0], [24.5, 58.5]],
    },
    {
        "id": "malacca",
        "name": "Strait of Malacca",
        "region_keys": ["south_china_sea"],
        "note": "Shortest sea route between the Indian Ocean and the Pacific -- schematic corridor, not a surveyed route.",
        "coords": [[5.8, 95.3], [4.0, 98.0], [2.5, 101.0], [1.3, 103.5], [1.15, 104.0]],
    },
    {
        "id": "taiwan_strait_lane",
        "name": "Taiwan Strait",
        "region_keys": ["taiwan_strait"],
        "note": "Separates mainland China from Taiwan; also the route of frequent freedom-of-navigation transits -- schematic corridor, not a surveyed route.",
        "coords": [[25.3, 121.7], [24.5, 119.6], [23.5, 119.2], [22.0, 118.9]],
    },
    {
        "id": "bosphorus",
        "name": "Bosphorus",
        # Tagged to the Russia/Ukraine theatre rather than left unscoped
        # (Task 20 review, Minor 2): the strait is the Montreux-governed
        # chokepoint Russia's Black Sea Fleet and its grain/oil-export traffic
        # both have to pass, and Turkey has restricted transit of belligerent
        # warships through it since the 2022 invasion -- a live fact about
        # that conflict, not the Turkey/Bosphorus theatre in general.
        "region_keys": ["russia_ukraine"],
        "note": "Connects the Black Sea to the Sea of Marmara and the Mediterranean, regulated by the 1936 Montreux Convention -- schematic corridor, not a surveyed route.",
        "coords": [[41.25, 29.1], [41.05, 29.0], [40.97, 28.98], [40.75, 28.9]],
    },
    {
        "id": "panama_approach",
        "name": "Panama approach",
        "region_keys": [],
        "note": "Connects the Atlantic and Pacific via the Panama Canal -- schematic corridor, not a surveyed route.",
        "coords": [[9.6, -79.9], [9.35, -79.92], [9.08, -79.68], [8.9, -79.57], [8.4, -79.9]],
    },
    {
        "id": "gibraltar",
        "name": "Strait of Gibraltar",
        "region_keys": [],
        "note": "Connects the Atlantic Ocean to the Mediterranean Sea; narrowest point about 13km wide -- schematic corridor, not a surveyed route.",
        "coords": [[36.1, -5.9], [35.95, -5.6], [35.9, -5.35], [35.85, -5.1]],
    },
    {
        "id": "danish_straits",
        "name": "Danish straits",
        "region_keys": [],
        "note": "The only sea connection between the Baltic Sea and the North Sea/Atlantic, via the Kattegat, the Great Belt and the Oresund -- schematic corridor, not a surveyed route.",
        "coords": [[57.7, 10.6], [56.5, 12.2], [55.6, 12.6], [54.9, 12.9], [54.5, 13.0]],
    },
    {
        "id": "cape_of_good_hope",
        "name": "Cape of Good Hope route",
        "region_keys": [],
        "note": "The traditional detour around southern Africa, used more heavily whenever the Suez/Red Sea corridor is unsafe -- schematic corridor, not a surveyed route.",
        "coords": [[-30.0, 15.0], [-34.0, 18.4], [-35.0, 20.5], [-33.0, 27.0], [-29.0, 32.0]],
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
        "osm_twin": "osm:way/28654027",  # القاعدة البحرية الأمريكية البحرين
        "note": "Homeport of the US Navy's 5th Fleet, responsible for the Persian Gulf/Red Sea/Arabian Sea.",
    },
    {
        "id": "camp_arifjan",
        "name": "Camp Arifjan",
        "type": "military", "subtype": "army",
        "lat": 28.86, "lon": 48.15,
        "region_keys": ["persian_gulf_hormuz"],
        "osm_twin": "osm:way/1159755811",  # معسكر عريفجان
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
        "osm_twin": "osm:way/233225970",  # Новороссийская военно-морская база
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
        "osm_twin": "osm:way/193044654",  # Camp Lemonnier معسكر ليمونيه
        "note": "Only permanent US base in Africa; also hosts French, Japanese, and other allied forces nearby.",
    },
    {
        "id": "doraleh_naval",
        "name": "Doraleh (China PLA Support Base)",
        "type": "military", "subtype": "naval",
        "lat": 11.6, "lon": 43.05,
        "region_keys": ["red_sea_yemen"],
        "osm_twin": "osm:way/512417624",  # 中国人民解放军驻吉布提保障基地
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
        "osm_twin": "osm:way/245548245",  # 캠프 험프리스
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
        "osm_twin": "osm:way/292210998",  # בסיס חיל האוויר פלמחים
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

    # ---- Persian Gulf / Strait of Hormuz (additional) ----
    {
        "id": "ain_al_asad_ab",
        "name": "Ain al-Asad Airbase",
        "type": "military", "subtype": "air",
        "lat": 33.78, "lon": 42.44,
        "region_keys": ["persian_gulf_hormuz"],
        "note": "Major US-Iraqi airbase in Anbar province, repeatedly targeted by Iran-aligned militias.",
    },
    {
        "id": "al_dhafra_ab",
        "name": "Al Dhafra Air Base",
        "type": "military", "subtype": "air",
        "lat": 24.25, "lon": 54.55,
        "region_keys": ["persian_gulf_hormuz"],
        "osm_twin": "osm:way/218153981",  # قاعدة الظفرة الجوية
        "note": "Key US/French/UAE airbase south of Abu Dhabi, hosts US fighter and reconnaissance squadrons.",
    },

    # ---- Russia / Ukraine (additional) ----
    {
        "id": "baltiysk_naval",
        "name": "Baltiysk Naval Base",
        "type": "military", "subtype": "naval",
        "lat": 54.65, "lon": 19.9,
        "region_keys": ["russia_ukraine"],
        "note": "Headquarters of Russia's Baltic Fleet, in the Kaliningrad exclave between Poland and Lithuania.",
    },

    # ---- Red Sea / Yemen (additional) ----
    {
        "id": "jsdf_djibouti",
        "name": "JSDF Base Djibouti",
        "type": "military", "subtype": "joint",
        "lat": 11.55, "lon": 43.15,
        "region_keys": ["red_sea_yemen"],
        "note": "Japan's only permanent overseas military base, alongside the US, French, and Chinese facilities nearby.",
    },

    # ---- Sahel (additional) ----
    {
        "id": "agadez_air_base_201",
        "name": "Air Base 201 (Agadez)",
        "type": "military", "subtype": "air",
        "lat": 16.96, "lon": 7.99,
        "region_keys": ["sahel"],
        "osm_twin": "osm:way/532904980",  # Base Aérienne 201
        "note": "US drone base in Niger built for Sahel counterterrorism ISR, vacated in 2024.",
    },

    # ---- Mediterranean / Europe ----
    {
        "id": "tartus_naval",
        "name": "Tartus Naval Base",
        "type": "military", "subtype": "naval",
        "lat": 34.9, "lon": 35.87,
        "region_keys": [],
        "note": "Russia's only Mediterranean naval base and sole remaining foothold in Syria.",
    },
    {
        "id": "raf_akrotiri",
        "name": "RAF Akrotiri",
        "type": "military", "subtype": "air",
        "lat": 34.59, "lon": 32.99,
        "region_keys": [],
        "note": "UK Sovereign Base Area on Cyprus, primary staging point for British Middle East air operations.",
    },
    {
        "id": "souda_bay_naval",
        "name": "Souda Bay Naval Base",
        "type": "military", "subtype": "naval",
        "lat": 35.49, "lon": 24.15,
        "region_keys": [],
        "note": "Greek/NATO naval and air base on Crete, key logistics hub for the Eastern Mediterranean.",
    },
    {
        "id": "aviano_ab",
        "name": "Aviano Air Base",
        "type": "military", "subtype": "air",
        "lat": 46.03, "lon": 12.6,
        "region_keys": [],
        "note": "Forward-deployed US Air Force fighter wing in northeastern Italy.",
    },
    {
        "id": "raf_lakenheath",
        "name": "RAF Lakenheath",
        "type": "military", "subtype": "air",
        "lat": 52.41, "lon": 0.56,
        "region_keys": [],
        "note": "US Air Force base in the UK, hosting F-35s reportedly certified for nuclear weapons storage.",
    },
    {
        "id": "buchel_ab",
        "name": "Büchel Air Base",
        "type": "military", "subtype": "air",
        "lat": 50.17, "lon": 7.06,
        "region_keys": [],
        "note": "German air base storing US nuclear weapons under NATO nuclear-sharing arrangements.",
    },

    # ---- Russian Arctic / Far North ----
    {
        "id": "severomorsk_naval",
        "name": "Severomorsk Naval Base",
        "type": "military", "subtype": "naval",
        "lat": 69.07, "lon": 33.42,
        "region_keys": [],
        "note": "Headquarters of Russia's Northern Fleet, above the Arctic Circle on the Kola Peninsula.",
    },
    {
        "id": "plesetsk_cosmodrome",
        "name": "Plesetsk Cosmodrome",
        "type": "military", "subtype": "missile",
        "lat": 62.96, "lon": 40.68,
        "region_keys": [],
        "note": "Russian military space launch and ICBM test site, one of the world's busiest spaceports.",
    },

    # ---- Sub-Saharan Africa ----
    {
        "id": "camp_simba",
        "name": "Camp Simba (Manda Bay)",
        "type": "military", "subtype": "joint",
        "lat": -2.1, "lon": 40.91,
        "region_keys": [],
        "note": "US/Kenyan base on the Indian Ocean coast supporting East Africa counterterrorism operations.",
    },

    # ---- Americas ----
    {
        "id": "guantanamo_bay_naval",
        "name": "Naval Station Guantanamo Bay",
        "type": "military", "subtype": "naval",
        "lat": 19.9, "lon": -75.15,
        "region_keys": [],
        "note": "Oldest US overseas naval base, on Cuba's southeastern coast.",
    },
    {
        "id": "pearl_harbor_hickam",
        "name": "Joint Base Pearl Harbor-Hickam",
        "type": "military", "subtype": "joint",
        "lat": 21.35, "lon": -157.95,
        "region_keys": [],
        "note": "Headquarters of US Indo-Pacific Command, homeport of the US Pacific Fleet.",
    },
    {
        "id": "whiteman_afb",
        "name": "Whiteman Air Force Base",
        "type": "military", "subtype": "air",
        "lat": 38.73, "lon": -93.55,
        "region_keys": [],
        "note": "Sole home of the B-2 stealth bomber fleet.",
    },
    {
        "id": "minot_afb",
        "name": "Minot Air Force Base",
        "type": "military", "subtype": "missile",
        "lat": 48.42, "lon": -101.35,
        "region_keys": [],
        "note": "One of two US bases operating both nuclear ICBMs and bombers.",
    },
    {
        "id": "fort_liberty",
        "name": "Fort Liberty",
        "type": "military", "subtype": "army",
        "lat": 35.14, "lon": -79.0,
        "region_keys": [],
        "note": "One of the largest US Army installations by population, home of Army Special Operations Command.",
    },
    {
        "id": "alcantara_launch_center",
        "name": "Alcântara Launch Center",
        "type": "military", "subtype": "missile",
        "lat": -2.37, "lon": -44.4,
        "region_keys": [],
        "note": "Brazilian military space launch site near the equator, prized for its low-latitude launch efficiency.",
    },

    # ---- South Asia ----
    {
        "id": "ins_kadamba",
        "name": "INS Kadamba",
        "type": "military", "subtype": "naval",
        "lat": 15.45, "lon": 73.8,
        "region_keys": [],
        "note": "India's largest naval base, on the west coast at Karwar.",
    },
    {
        "id": "pns_ormara",
        "name": "PNS Ormara (Jinnah Naval Base)",
        "type": "military", "subtype": "naval",
        "lat": 25.2, "lon": 64.64,
        "region_keys": [],
        "note": "Pakistan Navy base on the Arabian Sea coast, developed to disperse fleet assets from Karachi.",
    },
    {
        "id": "ngari_gunsa_ab",
        "name": "Ngari Gunsa Airbase",
        "type": "military", "subtype": "air",
        "lat": 32.5, "lon": 80.09,
        "region_keys": [],
        "note": "High-altitude Chinese military airfield in Tibet near the disputed India border.",
    },

    # ---- China (additional) ----
    {
        "id": "jiuquan_satellite_center",
        "name": "Jiuquan Satellite Launch Center",
        "type": "military", "subtype": "missile",
        "lat": 40.96, "lon": 100.29,
        "region_keys": [],
        "note": "China's oldest space launch center, also used for military space and missile programs.",
    },
    {
        "id": "xichang_satellite_center",
        "name": "Xichang Satellite Launch Center",
        "type": "military", "subtype": "missile",
        "lat": 28.25, "lon": 102.02,
        "region_keys": [],
        "note": "Key Chinese satellite and space launch site in Sichuan province.",
    },

    # ---- Oceania ----
    {
        "id": "raaf_tindal",
        "name": "RAAF Base Tindal",
        "type": "military", "subtype": "air",
        "lat": -14.52, "lon": 132.38,
        "region_keys": [],
        "note": "Australian air base in the Northern Territory, hosting rotational US bomber deployments.",
    },
    {
        "id": "pine_gap",
        "name": "Pine Gap",
        "type": "military", "subtype": "radar",
        "lat": -23.8, "lon": 133.74,
        "region_keys": [],
        "note": "Joint US-Australian satellite surveillance and signals intelligence facility.",
    },
    {
        "id": "hmas_stirling",
        "name": "HMAS Stirling",
        "type": "military", "subtype": "naval",
        "lat": -32.15, "lon": 115.68,
        "region_keys": [],
        "note": "Australia's largest naval base, future homeport for AUKUS nuclear-powered submarines.",
    },
    {
        "id": "woomera_test_range",
        "name": "Woomera Test Range",
        "type": "military", "subtype": "missile",
        "lat": -30.95, "lon": 136.53,
        "region_keys": [],
        "note": "One of the world's largest land weapons/rocket test ranges, in outback South Australia.",
    },
]


def serialize() -> dict:
    return {
        "sites": INFRA_SITES + MILITARY_BASES,
        "pipelines": PIPELINE_ROUTES,
        "lanes": SHIPPING_LANES,
    }


# Task 29: which of osm_infra.py's kinds are a comparable claim to a
# MILITARY_BASES entry -- an installation, not the broader (often
# fragment-heavy) `landuse=military` area class, which stays out of this list
# and continues to ride the plain OSM infrastructure layer unchanged. See
# osm_infra.py's own _FEATURES comment for why each of these six carries (or
# does not carry) a `["name"]` filter.
MILITARY_OSM_KINDS = frozenset({
    "military_airfield", "military_base", "military_naval_base",
    "military_training_area", "military_barracks", "military_danger_area",
})

# The three air-defence/radar classes (Task 29 item 4) are a different layer
# with a different completeness promise -- see decorateOsmInfra's own
# "airDefense" branch on the frontend for the caveat this set exists to keep
# separate from the bases merge below (the frontend's own split happens in
# createMapController.js's isAirDefenseItem, a plain JS literal rather than an
# import of this constant -- there is no cross-language import to have).
# Exported and named here anyway, alongside MILITARY_OSM_KINDS, as the one
# place in the backend that documents and tests the boundary between the two:
# see test_military_merge.py's own check that these three can never inflate
# an installation count.
AIR_DEFENSE_OSM_KINDS = frozenset({"radar_station", "military_bunker", "military_checkpoint"})

# A curated pin is hand-placed at the installation's own coordinates; an OSM
# way's `out center` is a computed centroid of whatever polygon a mapper
# traced for the same footprint, which for a sprawling base (an airfield's
# runways plus its whole cantonment area, say) can land a couple of
# kilometres from the curated point without being a different installation.
# 5km is wide enough to bridge that gap.
#
# Task 29 review (Important 1): it is NOT, on its own, narrow enough to tell
# two genuinely separate nearby facilities apart. Camp Lemonnier (US) and
# JSDF Base Djibouti (Japan) are 1.56km apart -- both inside this radius of a
# point near either one, not outside it as an earlier version of this
# comment claimed, citing that exact pair, before anyone had actually
# computed the distance. With curated points that close together, an OSM
# centroid's documented drift is easily enough to make the *wrong* one the
# nearest -- and a false `matched_curated_id` is the worst kind of error this
# layer can make: it tells a reader OpenStreetMap corroborates one country's
# base when the feature was mapped for a different country's.
#
# The radius alone cannot fix that -- shrinking it only moves the same
# problem to a smaller cluster of close-together bases somewhere else, and a
# global map of foreign military installations has more crowded corners than
# Djibouti's. So the radius stays generous, and _closest_curated_match below
# refuses to guess instead: an OSM site is matched only when exactly one
# curated site is within this radius of it. Two or more, and the drift that
# is normal at this radius is not precise enough to say which one the
# feature belongs to, so no match is claimed at all.
BASE_MATCH_RADIUS_KM = 5.0


def _closest_curated_match(site: dict, curated: list[dict]) -> tuple[dict | None, bool]:
    """The one curated site an OSM record should be matched to, or (None,
    ambiguous) when the match was refused -- see BASE_MATCH_RADIUS_KM's own
    note on why "more than one" refuses rather than picks the nearest.
    `curated` is the small (~100-entry) MILITARY_BASES list, so a plain
    per-call scan is simpler than building a spatial index for it and no
    source of the bug a coarse grid cell could introduce at a cluster
    boundary.

    Task 32 review (empty-state sweep): a refusal used to come back as a bare
    None, indistinguishable from "zero curated sites nearby" -- both read as
    "no curated site nearby" to a caller that only checks `matched_curated_id`,
    which is exactly the "found nothing" vs "did not look" conflation this
    module's own docstring warns the merge step must not make. `ambiguous`
    tells the two apart: True means this OSM site sits within range of more
    than one curated site and the match was refused on purpose, not that
    nothing curated is nearby at all.
    """
    within = [
        c for c in curated
        if haversine_km(site["lat"], site["lon"], c["lat"], c["lon"]) <= BASE_MATCH_RADIUS_KM
    ]
    if len(within) == 1:
        return within[0], False
    return None, len(within) > 1


def merge_military_bases(curated: list[dict], osm_sites: list[dict]) -> list[dict]:
    """Curated MILITARY_BASES beside OpenStreetMap's military=* sweep, each
    site keeping its own `source` rather than being blended into one record --
    see osm_infra.py's own module docstring for why that promise matters here
    specifically (this list is the one place in the app where the two claims
    a reader could most easily mistake for confirming each other actually
    meet).

    Every curated site passes through unchanged, `source: "curated"`. An OSM
    site is included only when its `kind` is one of MILITARY_OSM_KINDS (the
    plain `landuse=military` area class, or any other kind osm_sites happens
    to carry, is left out -- this is a list of installations, not everything
    the sweep found); it is stamped `source: "osm"`, and, when exactly one
    curated site sits within BASE_MATCH_RADIUS_KM (see
    _closest_curated_match), `matched_curated_id` names it. That flag is what
    count_distinct_bases below reads to avoid reporting two installations
    where a human curator and OpenStreetMap's mappers both independently
    found the same one.

    An OSM site refused a match because more than one curated site sits
    within range is stamped `ambiguous_match: True` instead -- the refusal
    itself is information (the frontend's own popup says so, see popups.js's
    militaryBaseRows), not the same silence as an OSM site with no curated
    neighbour at all.
    """
    out = [{**site, "source": "curated"} for site in curated]
    for site in osm_sites:
        if site.get("kind") not in MILITARY_OSM_KINDS:
            continue
        record = {**site, "source": "osm"}
        match, ambiguous = _closest_curated_match(site, curated)
        if match is not None:
            record["matched_curated_id"] = match["id"]
        elif ambiguous:
            record["ambiguous_match"] = True
        out.append(record)
    return out


def count_distinct_bases(merged: list[dict]) -> int:
    """How many distinct physical installations `merge_military_bases`
    reports, treating a matched OSM/curated pair as one site rather than two.

    Summing every record in the merged list would double-count: an OSM entry
    with `matched_curated_id` set is corroborating evidence for a site already
    counted once as its curated entry, not a second installation.

    Task 29 review (Minor 2): this dedups an OSM record against a *curated*
    one only. Two separate OSM records for one joint-use installation (a
    base two different mappers each traced a polygon for) are not deduped
    against each other and both count -- outside the brief's ask, which was
    pairing curated against OSM, not OSM against itself. Noted rather than
    fixed here; an OSM-vs-OSM dedup would need its own distance/ambiguity
    rule, the same shape as _closest_curated_match's, and its own review.
    """
    return sum(
        1 for site in merged
        if site.get("source") == "curated" or not site.get("matched_curated_id")
    )
