"""Overpass query construction and response parsing.

The parsing side is mostly about ways and relations: an area has no coordinate
of its own, so everything hangs on the `center` Overpass computes -- and an
element without one has to be dropped rather than placed at the equator.
"""

from backend.sources import osm_infra


def element(
    osm_type="way",
    osm_id=12345,
    tags=None,
    lat=None,
    lon=None,
    center=(33.6461445, 35.4004389),
) -> dict:
    out = {"type": osm_type, "id": osm_id, "tags": tags if tags is not None else {"military": "airfield", "name": "Rayak Air Base"}}
    if lat is not None:
        out["lat"] = lat
    if lon is not None:
        out["lon"] = lon
    if center is not None and osm_type != "node":
        out["center"] = {"lat": center[0], "lon": center[1]}
    return out


def parse(*elements, region="israel_gaza_lebanon"):
    return osm_infra.parse_overpass({"elements": list(elements)}, region)


# --- the query -------------------------------------------------------------


def test_the_query_covers_the_region_box_and_asks_for_computed_centres():
    query = osm_infra.build_query((29.0, 34.0, 34.5, 37.0))
    assert "(29.0,34.0,34.5,37.0)" in query
    # Without `out center` every way and relation comes back with no position.
    assert "out center tags" in query


def test_every_feature_class_gets_its_own_cap_not_a_shared_one():
    """With one shared cap, Russia/Ukraine came back as 725 border-control
    nodes and 4 airfields -- the noisiest class had starved the rest."""
    query = osm_infra.build_query((0, 0, 1, 1))
    # One `out` per class, and each selector bound to its own set is what makes
    # the cap per class rather than shared.
    assert query.count("out center tags") == len(osm_infra._FEATURES)
    assert query.count("->.s") == len(osm_infra._FEATURES)


def test_rail_points_get_a_far_higher_cap_than_the_noisy_area_classes():
    """MAX_PER_FEATURE = 300 exists to suppress unnamed *fragments* of the area
    classes. A station is a discrete whole feature, so the same cap would drop
    5,227 of the 5,527 stations in the Russia/Ukraine box -- deleting the layer
    at the collector, which is the renderer's job to thin, not ours to drop."""
    assert osm_infra.MAX_RAIL_PER_FEATURE > osm_infra.MAX_PER_FEATURE
    query = osm_infra.build_query((0, 0, 1, 1))
    # The four rail classes carry the rail cap; the four area classes do not.
    assert query.count(f"out center tags {osm_infra.MAX_RAIL_PER_FEATURE};") == 4
    assert query.count(f"out center tags {osm_infra.MAX_PER_FEATURE};") == 4


def test_the_noisy_selectors_require_a_name_and_the_sparse_ones_do_not():
    """Unnamed `landuse=military` fragments were 432 of 600 results in one
    theatre, and unnamed `barrier=border_control` is every gate post on a
    frontier; an unnamed military airfield is still an airfield, and a rail
    station/halt/yard/border is a discrete feature, not a fragment."""
    query = osm_infra.build_query((0, 0, 1, 1))
    assert '"landuse"="military"]["name"]' in query
    assert '"power"="plant"]["name"]' in query
    assert '"barrier"="border_control"]["name"]' in query
    assert '"military"="airfield"](' in query
    # The rail selectors must NOT carry a `["name"]` filter -- see the border
    # case below, where the filter would discard 83% of the nodes.
    assert '"railway"="station"](' in query
    assert '"railway"="halt"](' in query
    assert '"railway"="yard"](' in query
    assert '"railway"="station"]["name"]' not in query


def test_the_rail_border_selector_is_a_node_and_carries_no_name_filter():
    """Only 17 of 101 `railway=border` nodes in Russia/Ukraine carry a name, so
    a `["name"]` filter would discard 83% of them; and a border marker is a
    point on the track, never an area, so it is a node-only selector."""
    query = osm_infra.build_query((0, 0, 1, 1))
    assert 'node["railway"="border"](' in query
    assert '"railway"="border"]["name"]' not in query


# --- parsing ---------------------------------------------------------------


def test_a_node_uses_its_own_position():
    (site,) = parse(element(osm_type="node", lat=33.1, lon=35.2, center=None,
                            tags={"barrier": "border_control", "name": "Masnaa"}))
    assert (site["lat"], site["lon"]) == (33.1, 35.2)
    assert site["kind"] == "border_control"


def test_a_way_uses_the_centre_overpass_computed():
    (site,) = parse(element())
    assert (site["lat"], site["lon"]) == (33.6461445, 35.4004389)


def test_an_element_with_no_position_at_all_is_dropped():
    assert parse(element(osm_type="way", center=None)) == []


def test_ids_are_prefixed_so_they_cannot_collide_with_a_curated_site():
    (site,) = parse(element(osm_type="relation", osm_id=99))
    assert site["id"] == "osm:relation/99"
    assert site["osm_type"] == "relation"
    assert site["osm_id"] == 99


def test_each_supported_tag_maps_to_its_own_kind():
    kinds = [
        parse(element(tags={"military": "airfield"}))[0]["kind"],
        parse(element(tags={"landuse": "military", "name": "x"}))[0]["kind"],
        parse(element(tags={"power": "plant", "name": "x"}))[0]["kind"],
        parse(element(tags={"barrier": "border_control"}))[0]["kind"],
    ]
    assert kinds == ["military_airfield", "military_area", "power_plant", "border_control"]


def test_rail_tags_map_to_their_own_per_record_kinds():
    """These ride the existing osm_infra storage kind, mirror and endpoint --
    the distinction is only the per-record `kind`, exactly as the other classes
    already carry one."""
    kinds = [
        parse(element(osm_type="node", lat=1, lon=1, center=None,
                      tags={"railway": "station", "name": "Kyiv-Pas"}))[0]["kind"],
        parse(element(tags={"railway": "halt", "name": "x"}))[0]["kind"],
        parse(element(tags={"railway": "yard", "name": "x"}))[0]["kind"],
        parse(element(osm_type="node", lat=1, lon=1, center=None,
                      tags={"railway": "border"}))[0]["kind"],
    ]
    assert kinds == ["railway_station", "railway_halt", "railway_yard", "railway_border"]


def test_an_unnamed_rail_border_falls_back_to_its_uic_ref_not_a_generic_label():
    """83% of `railway=border` nodes carry no name but do carry a UIC ref, so
    the fallback reads that rather than labelling them all the same."""
    (site,) = parse(element(osm_type="node", lat=1, lon=1, center=None,
                            tags={"railway": "border", "uic_ref": "2200001"}))
    assert site["name"] == "UIC 2200001"
    assert site["named"] is False


def test_an_unnamed_rail_border_uses_an_operator_ref_when_there_is_no_uic():
    """The probe found these carrying operator-namespaced refs like ref:RO:CFR."""
    (site,) = parse(element(osm_type="node", lat=1, lon=1, center=None,
                            tags={"railway": "border", "ref:RO:CFR": "800"}))
    assert site["name"] == "800"
    assert site["named"] is False


def test_a_truly_bare_rail_border_still_gets_the_generic_label():
    (site,) = parse(element(osm_type="node", lat=1, lon=1, center=None,
                            tags={"railway": "border"}))
    assert site["name"] == "Railway border crossing"
    assert site["named"] is False


def test_an_element_matching_none_of_the_tags_is_ignored():
    assert parse(element(tags={"amenity": "cafe", "name": "Not infrastructure"})) == []


def test_an_unnamed_feature_gets_a_type_label_and_is_marked_unnamed():
    (site,) = parse(element(tags={"military": "airfield"}))
    assert site["name"] == "Military airfield"
    assert site["named"] is False

    (named,) = parse(element(tags={"military": "airfield", "name": "Rayak"}))
    assert named["named"] is True


def test_an_english_name_is_used_when_there_is_no_default_one():
    (site,) = parse(element(tags={"power": "plant", "name:en": "Zouk Power Station"}))
    assert site["name"] == "Zouk Power Station"
    assert site["named"] is True


def test_the_region_the_sweep_found_it_in_travels_with_the_record():
    (site,) = parse(element(), region="sudan")
    assert site["region_key"] == "sudan"


def test_an_empty_response_is_not_an_error():
    assert osm_infra.parse_overpass({}, "sudan") == []
    assert osm_infra.parse_overpass({"elements": []}, "sudan") == []


# --- flattening the per-theatre sweep --------------------------------------


def test_a_feature_in_two_overlapping_theatres_is_only_listed_once():
    """Taiwan Strait sits inside the South China Sea box, so a feature in the
    overlap comes back from both sweeps. Counting it twice would report more
    sites than the map draws, which reads as a renderer bug."""
    shared = {"id": "osm:node/1", "name": "Shared", "region_key": "south_china_sea"}
    flat = osm_infra.flatten({
        "south_china_sea": [shared, {"id": "osm:node/2", "name": "Only SCS"}],
        "taiwan_strait": [{**shared, "region_key": "taiwan_strait"}],
    })
    assert len(flat) == 2
    # First sweep wins, so a feature does not flip theatre from poll to poll.
    assert next(s for s in flat if s["id"] == "osm:node/1")["region_key"] == "south_china_sea"


def test_flattening_an_empty_sweep_is_not_an_error():
    assert osm_infra.flatten({}) == []
    assert osm_infra.flatten({"sudan": []}) == []


# --- the freehand power output field ---------------------------------------


def test_power_output_is_normalised_to_megawatts():
    assert osm_infra._megawatts("1200 MW") == 1200
    assert osm_infra._megawatts("1.2 GW") == 1200
    assert osm_infra._megawatts("500 kW") == 0.5
    assert osm_infra._megawatts("800000000 W") == 800


def test_an_unreadable_power_output_is_left_out_rather_than_guessed_at():
    """OSM writes this field freehand and most of the time it is unparseable."""
    for value in (None, "", "lots", "2x600 MW", "yes"):
        assert osm_infra._megawatts(value) is None
