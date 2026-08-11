"""Task 20b: SHIPPING_LANES, the ten hand-drawn shipping corridors in
backend/infrastructure.py.

These are schematic waypoints -- "the corridors people actually name" -- not
a surveyed route and not derived from anything backend/refine/lane_density.py
has observed (that claim belongs to /api/lanes instead; see this module's own
docstring and Task 20's brief). The one rule this file exists to hold the
line on is the project's blanket ban on uncited numbers: a corridor is free
to carry no transit figure at all, but the moment it carries one, it must
also carry who published it, what unit it's in, and what year it's from.
"""

from backend import infrastructure

EXPECTED_NAMES = {
    "Suez approach",
    "Bab-el-Mandeb",
    "Strait of Hormuz",
    "Strait of Malacca",
    "Taiwan Strait",
    "Bosphorus",
    "Panama approach",
    "Strait of Gibraltar",
    "Danish straits",
    "Cape of Good Hope route",
}

TRANSIT_CITATION_FIELDS = ("transits_publisher", "transits_unit", "transits_year")


def _transit_citation_is_complete(lane: dict) -> bool:
    """The rule this whole file exists to enforce, factored out so it can be
    checked against synthetic fixtures as well as the shipped list -- see
    test_a_well_cited_transit_figure_is_accepted and its sibling below for
    why a synthetic case, not just the real data, has to exercise this."""
    if "transits" not in lane:
        return all(field not in lane for field in TRANSIT_CITATION_FIELDS)
    if not (isinstance(lane["transits"], (int, float)) and lane["transits"] > 0):
        return False
    for field in TRANSIT_CITATION_FIELDS:
        if lane.get(field) in (None, ""):
            return False
    return (
        isinstance(lane["transits_publisher"], str)
        and isinstance(lane["transits_unit"], str)
        and isinstance(lane["transits_year"], int)
        and 1990 <= lane["transits_year"] <= 2100
    )


def test_exactly_the_ten_named_corridors():
    assert len(infrastructure.SHIPPING_LANES) == 10
    assert {lane["name"] for lane in infrastructure.SHIPPING_LANES} == EXPECTED_NAMES


def test_ids_are_unique():
    ids = [lane["id"] for lane in infrastructure.SHIPPING_LANES]
    assert len(ids) == len(set(ids))


def test_every_corridor_has_a_name_and_a_note():
    for lane in infrastructure.SHIPPING_LANES:
        assert isinstance(lane.get("name"), str) and lane["name"].strip()
        assert isinstance(lane.get("note"), str) and lane["note"].strip()


def test_every_corridor_has_at_least_two_waypoints():
    for lane in infrastructure.SHIPPING_LANES:
        coords = lane.get("coords")
        assert isinstance(coords, list)
        assert len(coords) >= 2, lane["id"]


def test_every_waypoint_is_a_lat_lon_pair_in_range():
    for lane in infrastructure.SHIPPING_LANES:
        for point in lane["coords"]:
            assert len(point) == 2, lane["id"]
            lat, lon = point
            assert -90.0 <= lat <= 90.0, lane["id"]
            assert -180.0 <= lon <= 180.0, lane["id"]


def test_every_popup_note_says_schematic_not_surveyed():
    # Task 20's own brief: "the popup says it is schematic corridor, not a
    # surveyed route". Pinned here in words as well as in the frontend's
    # popup markup, so the two can't quietly drift apart.
    for lane in infrastructure.SHIPPING_LANES:
        assert "schematic" in lane["note"].lower(), lane["id"]
        assert "not a surveyed route" in lane["note"].lower(), lane["id"]


def test_a_transit_figure_always_carries_its_publisher_unit_and_year():
    """The global rule ("no uncited numbers") applied to this one list: a
    corridor either states no transit figure at all, or states one alongside
    who published it, what unit it's in, and what year it's from.

    Task 20 review (Critical): all three transit figures this list shipped
    with (Suez, Hormuz, Panama) turned out to be wrong when checked against
    the publisher's own page, and the controller ruling was to drop them
    rather than chase corrected numbers -- see SHIPPING_LANES' own comment in
    backend/infrastructure.py. So every corridor here currently takes the
    "no figure" branch; the two tests below exercise the "figure present"
    branch against synthetic fixtures instead, so the rule stays covered
    (both ways) whether or not the shipped list currently carries a number.
    """
    for lane in infrastructure.SHIPPING_LANES:
        assert _transit_citation_is_complete(lane), lane["id"]


def test_a_well_cited_transit_figure_is_accepted():
    # The positive case the review flagged as missing from real data: a
    # transit figure with all three citation fields, verified against the
    # rule a future corridor would actually have to meet.
    lane = {
        "id": "fixture_lane",
        "transits": 1000,
        "transits_unit": "vessel transits",
        "transits_publisher": "Example Canal Authority",
        "transits_year": 2024,
    }
    assert _transit_citation_is_complete(lane)


def test_a_transit_figure_missing_any_one_citation_field_is_rejected():
    base = {
        "id": "fixture_lane",
        "transits": 1000,
        "transits_unit": "vessel transits",
        "transits_publisher": "Example Canal Authority",
        "transits_year": 2024,
    }
    for field in TRANSIT_CITATION_FIELDS:
        incomplete = {k: v for k, v in base.items() if k != field}
        assert not _transit_citation_is_complete(incomplete), field


def test_serialize_includes_lanes_alongside_sites_and_pipelines():
    payload = infrastructure.serialize()
    assert payload["lanes"] == infrastructure.SHIPPING_LANES
    assert payload["sites"] == infrastructure.INFRA_SITES + infrastructure.MILITARY_BASES
    assert payload["pipelines"] == infrastructure.PIPELINE_ROUTES
