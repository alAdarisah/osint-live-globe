"""The twin fields are curated claims that two records are one place, so they get held
to the shape the frontend reads them in.

The frontend merges a curated base with the OpenStreetMap record it names
(crossSource.js's buildDeclaredTwinIndex) rather than with whatever OSM record is
nearest, because nearest is wrong about half the time on `military_area` -- the
measurements are in the note above MILITARY_BASES. `airport_twin` and `port_twin` are
the same idea against OurAirports and the NGA World Port Index, where measuring fails
differently: a plant and the airstrip built to serve it share a name and sit 200 m
apart, so distance cannot tell "recorded twice" from "two things at one place".

That makes these fields the entire mechanism, and a typo in one does not error. It
quietly leaves a site drawn twice, which is the state this whole thing was fixing.
"""

import re

from backend import infrastructure

# The pairs verified against the live sweep, by curated id. Named rather than counted
# so dropping one fails with the base that lost its merge.
DECLARED = {
    "palmachim_ab",          # the reported duplicate: English pin beside a Hebrew one
    "camp_lemonnier",
    "nsa_bahrain",
    "camp_arifjan",
    "al_dhafra_ab",
    "doraleh_naval",
    "camp_humphreys",
    "novorossiysk_naval",
    "agadez_air_base_201",
}

OSM_ID = re.compile(r"^osm:(way|node|relation)/\d+$")
# An OurAirports ident: a four-letter ICAO, or their own <country>-<n> code for a
# field with none, or a mixed FAA/local code like "1LS5".
AIRPORT_IDENT = re.compile(r"^([A-Z]{4}|[A-Z]{2}-\d{4}|[0-9A-Z]{3,6})$")
# An NGA World Port Index record GUID, braces and all -- that is how /api/ports serves
# it, and the frontend matches the string exactly.
PORT_ID = re.compile(r"^\{[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$")

# The airfields a curated entry IS rather than sits beside. Named, because the
# distinction is a judgement and the diff should show it being made.
AIRPORT_DECLARED = {
    "thule_ab", "raf_lakenheath", "osan_ab", "whiteman_afb", "raf_akrotiri",
    "raaf_tindal", "al_dhafra_ab", "fiery_cross_reef", "aviano_ab", "ramstein_ab",
    "diego_garcia", "andersen_afb", "buchel_ab", "al_udeid_ab", "ain_al_asad_ab",
    "minot_afb", "camp_humphreys", "kadena_ab", "nevatim_ab", "naval_station_rota",
    "vandenberg_sfb", "alcantara_launch_center",
}
PORT_DECLARED = {
    "haifa_refinery", "busan_port", "odesa_port", "novorossiysk_terminal",
    "kharg_island", "manila_port", "ras_laffan",
}
# Sites a distance-and-name match pairs up that are NOT the same place. Held here so
# a future "why not just measure it" cannot quietly re-add them: each of these is a
# plant beside the airstrip that serves it, or a refinery beside its town's harbour.
NOT_THE_SAME_PLACE = {
    "soyo_lng", "fujairah_terminal", "das_island_lng", "cameron_lng",
    "niamey_refinery", "jsdf_djibouti", "tuapse_refinery",
    "mina_al_ahmadi_refinery", "sevastopol_naval", "singapore_port",
    "point_lisas_desalination", "novorossiysk_naval",
}


def _all_sites() -> list[dict]:
    return infrastructure.INFRA_SITES + infrastructure.MILITARY_BASES


def _declared(field: str) -> dict[str, str]:
    return {s["id"]: s[field] for s in _all_sites() if s.get(field)}


def _twins() -> dict[str, str]:
    return {
        base["id"]: base["osm_twin"]
        for base in infrastructure.MILITARY_BASES
        if base.get("osm_twin")
    }


def test_every_declared_twin_is_a_well_formed_osm_id():
    """The frontend looks this up as an exact string key against
    /api/osm-infrastructure's own `id`, which is built as `osm:<type>/<id>`. Anything
    else matches nothing, silently."""
    for base_id, twin in _twins().items():
        assert OSM_ID.match(twin), f"{base_id}: {twin!r} is not an osm:<type>/<id>"


def test_no_openstreetmap_record_is_claimed_by_two_bases():
    """Two bases naming one record is a curation mistake with a silent symptom: the
    frontend absorbs it once (first declaration wins) so the other base keeps drawing
    a duplicate, and which one that is depends on list order."""
    seen: dict[str, str] = {}
    for base_id, twin in _twins().items():
        assert twin not in seen, f"{base_id} and {seen[twin]} both claim {twin}"
        seen[twin] = base_id


def test_the_verified_pairs_are_all_still_declared():
    """By name, so a re-ordering or a merge conflict that drops one is reported as the
    base that went back to two pins rather than as a count."""
    missing = DECLARED - set(_twins())
    assert not missing, (
        f"{sorted(missing)} lost their osm_twin, so each draws twice again -- once "
        "from MILITARY_BASES in English and once from the OSM sweep in the local script"
    )


def test_only_military_entries_declare_a_twin():
    """`osm_twin` is read by the military pairing alone (see rebuildOsmTwins' filter on
    `type === "military"`), so it would be inert anywhere else -- a field that looks
    like it does something and does not."""
    for site in infrastructure.INFRA_SITES:
        assert "osm_twin" not in site, site["id"]
    for base in infrastructure.MILITARY_BASES:
        if base.get("osm_twin"):
            assert base["type"] == "military", base["id"]


def test_the_field_survives_the_wire():
    """serialize() is what /api/infrastructure serves, and it is the only path the
    frontend has to this field. A future serialize() that picked fields explicitly
    would drop it and every merge with it."""
    sites = {site["id"]: site for site in infrastructure.serialize()["sites"]}
    for base_id, twin in _twins().items():
        assert sites[base_id].get("osm_twin") == twin, base_id


def test_a_declared_twin_names_the_place_it_pairs_with():
    """Each declaration carries a trailing comment with OSM's own name for the record,
    because the id alone is unreviewable -- nobody can look at `osm:way/292210998` and
    say whether it is Palmachim. This checks the comment exists rather than what it
    says; it is the only thing that makes the next curator's job possible."""
    with open(infrastructure.__file__, encoding="utf-8") as handle:
        lines = [line for line in handle if '"osm_twin"' in line]
    assert len(lines) == len(_twins()), "a declaration is not on its own line"
    for line in lines:
        assert "#" in line.split('"osm_twin"', 1)[1], (
            f"no name comment on: {line.strip()} -- an OSM id nobody can check is a "
            "claim nobody can review"
        )


def test_airport_twins_are_well_formed_and_unique():
    twins = _declared("airport_twin")
    for site_id, ident in twins.items():
        assert AIRPORT_IDENT.match(ident), f"{site_id}: {ident!r} is not an OurAirports ident"
    assert len(set(twins.values())) == len(twins), "two sites claim one airfield"


def test_port_twins_are_well_formed_and_unique():
    twins = _declared("port_twin")
    for site_id, port_id in twins.items():
        assert PORT_ID.match(port_id), f"{site_id}: {port_id!r} is not an NGA WPI GUID"
    # Uniqueness matters most here: Novorossiysk has two curated entries whose names
    # both corroborate one NGA record, and letting both claim it is the exact bug the
    # declaration exists to prevent.
    assert len(set(twins.values())) == len(twins), "two sites claim one harbour"


def test_the_verified_catalogue_pairs_are_all_still_declared():
    for field, expected in (("airport_twin", AIRPORT_DECLARED), ("port_twin", PORT_DECLARED)):
        missing = expected - set(_declared(field))
        assert not missing, (
            f"{sorted(missing)} lost their {field}, so each draws twice again -- once as a "
            "curated site and once as the catalogue record for the same place"
        )


def test_the_near_misses_stay_undeclared():
    """The other half of the judgement, and the half a measurement would get wrong.

    Angola LNG sits 230 m from Soyo Airport and shares its name; Fujairah Oil Terminal
    sits 1.2 km from Fujairah International. Those are a plant and the airstrip built
    to serve it -- two things at one place, not one thing recorded twice. Merging them
    would put an oil terminal's popup on an airport pin.
    """
    declared = set(_declared("airport_twin")) | set(_declared("port_twin"))
    wrong = declared & NOT_THE_SAME_PLACE
    assert not wrong, (
        f"{sorted(wrong)} declared a twin. Read the note above MILITARY_BASES: a twin means "
        "this entry IS that airfield or harbour, never that it is next to one"
    )


def test_the_catalogue_fields_survive_the_wire():
    sites = {site["id"]: site for site in infrastructure.serialize()["sites"]}
    for field in ("airport_twin", "port_twin"):
        for site_id, twin in _declared(field).items():
            assert sites[site_id].get(field) == twin, f"{site_id}.{field}"


def test_every_catalogue_declaration_names_the_place_it_pairs_with():
    """Same rule as the OSM ids: an ident nobody can check is a claim nobody can review.
    "OTBH" is not reviewable; "OTBH  # Al Udeid Air Base" is."""
    with open(infrastructure.__file__, encoding="utf-8") as handle:
        lines = handle.readlines()
    for field in ("airport_twin", "port_twin"):
        declarations = [line for line in lines if f'"{field}"' in line]
        assert len(declarations) == len(_declared(field)), f"a {field} is not on its own line"
        for line in declarations:
            assert "#" in line.split(f'"{field}"', 1)[1], f"no name comment on: {line.strip()}"
