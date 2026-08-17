"""`osm_twin` is a curated claim that two records are one place, so it gets held to
the shape the frontend reads it in.

The frontend merges a curated base with the OpenStreetMap record it names
(crossSource.js's buildDeclaredTwinIndex) rather than with whatever OSM record is
nearest, because nearest is wrong about half the time on `military_area` -- the
measurements are in the note above MILITARY_BASES. That makes this field the entire
mechanism: a typo does not error, it just quietly leaves a base drawn twice, which is
the state this whole thing was fixing.
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
