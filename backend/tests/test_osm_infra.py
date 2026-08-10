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
    # The four rail classes carry the rail cap; the six MAX_PER_FEATURE classes
    # (Task 28 added power_substation and refinery beside the original four) do not.
    assert query.count(f"out center tags {osm_infra.MAX_RAIL_PER_FEATURE};") == 4
    assert query.count(f"out center tags {osm_infra.MAX_PER_FEATURE};") == 6


def test_dense_infra_point_classes_get_their_own_higher_cap():
    """man_made=storage_tank and man_made=petroleum_well are discrete whole
    features that can run to the thousands per theatre (a single oil field or
    tank farm) -- the same "do not delete the layer at the collector" argument
    the rail points above make, so they get their own cap rather than
    MAX_PER_FEATURE's 300."""
    assert osm_infra.MAX_INFRA_POINT_PER_FEATURE > osm_infra.MAX_PER_FEATURE
    query = osm_infra.build_query((0, 0, 1, 1))
    assert query.count(f"out center tags {osm_infra.MAX_INFRA_POINT_PER_FEATURE};") == 2


def test_the_four_new_point_classes_carry_no_name_filter():
    """A substation, a refinery, a storage tank and a wellhead are each a
    discrete whole feature, not a fragment of a larger area -- the same reason
    military=airfield and the rail classes above carry none."""
    query = osm_infra.build_query((0, 0, 1, 1))
    assert '"power"="substation"](' in query
    assert '"industrial"="refinery"](' in query
    assert '"man_made"="storage_tank"](' in query
    assert '"man_made"="petroleum_well"](' in query
    assert '"power"="substation"]["name"]' not in query
    assert '"man_made"="petroleum_well"]["name"]' not in query


def test_the_oil_well_selector_is_node_only():
    """A wellhead is always mapped as a point, never an area."""
    query = osm_infra.build_query((0, 0, 1, 1))
    assert 'node["man_made"="petroleum_well"](' in query


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


def test_the_four_task_28_tags_map_to_their_own_kinds():
    kinds = [
        parse(element(tags={"power": "substation"}))[0]["kind"],
        parse(element(tags={"industrial": "refinery"}))[0]["kind"],
        parse(element(tags={"man_made": "storage_tank"}))[0]["kind"],
        parse(element(osm_type="node", lat=1, lon=1, center=None,
                      tags={"man_made": "petroleum_well"}))[0]["kind"],
    ]
    assert kinds == ["power_substation", "refinery", "storage_tank", "oil_well"]


def test_an_unnamed_substation_or_well_still_gets_a_type_fallback_label():
    (substation,) = parse(element(tags={"power": "substation"}))
    assert substation["name"] == "Substation"
    assert substation["named"] is False
    (well,) = parse(element(osm_type="node", lat=1, lon=1, center=None,
                             tags={"man_made": "petroleum_well"}))
    assert well["name"] == "Oil/gas well"


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


# --- Task 28: fuel normalisation, commissioning year ------------------------


def test_fuel_normalises_to_one_of_the_eight_named_buckets():
    assert osm_infra._fuel_category("nuclear") == "nuclear"
    assert osm_infra._fuel_category("coal") == "coal"
    assert osm_infra._fuel_category("gas") == "gas"
    assert osm_infra._fuel_category("hydro") == "hydro"
    assert osm_infra._fuel_category("wind") == "wind"
    assert osm_infra._fuel_category("solar") == "solar"
    assert osm_infra._fuel_category("biomass") == "biomass"


def test_waste_is_folded_into_biomass():
    """OSM has no separate `waste` bucket of its own to place a waste-to-energy
    plant in, and public reporting (EIA/IEA) groups it with biomass already."""
    assert osm_infra._fuel_category("waste") == "biomass"


def test_a_compound_source_matches_whichever_keyword_it_contains():
    assert osm_infra._fuel_category("gas;oil") == "gas"


def test_unmapped_and_missing_fuel_values_report_other_rather_than_guessing():
    for value in (None, "", "oil", "geothermal", "diesel", "tidal"):
        assert osm_infra._fuel_category(value) == "other"


def test_commissioning_year_reads_a_confident_four_digit_prefix():
    assert osm_infra._commissioning_year("1986") == 1986
    assert osm_infra._commissioning_year("1986-05") == 1986
    assert osm_infra._commissioning_year("1986-05-01") == 1986


def test_commissioning_year_is_left_out_rather_than_guessed_at():
    for value in (None, "", "circa 1970", "under construction", "99"):
        assert osm_infra._commissioning_year(value) is None


def test_commissioning_year_rejects_an_implausible_number():
    """A guard against a stray non-year numeral (a voltage, an id) that
    happens to start with four digits, not a claim about plant history."""
    assert osm_infra._commissioning_year("1200 MW") is None  # not None by luck: 1200 is out of range
    assert osm_infra._commissioning_year("30000") is None


def test_power_plant_records_carry_fuel_and_commissioning_year():
    (plant,) = parse(element(tags={
        "power": "plant", "name": "x", "generator:source": "wind", "start_date": "2011",
    }))
    assert plant["fuel"] == "wind"
    assert plant["commissioning_year"] == 2011


def test_a_non_power_plant_record_still_carries_the_two_new_fields():
    """Computed unconditionally rather than branched on kind (see
    parse_overpass' own note) -- an airfield with neither tag simply reports
    the two total-function defaults."""
    (airfield,) = parse(element(tags={"military": "airfield"}))
    assert airfield["fuel"] == "other"
    assert airfield["commissioning_year"] is None


# --- Task 28: combined power-line/pipeline geometry pass --------------------


def line_way(way_id=1, geometry=None, tags=None):
    return {
        "type": "way",
        "id": way_id,
        "geometry": geometry if geometry is not None else [
            {"lat": 50.45, "lon": 30.52}, {"lat": 50.5, "lon": 30.6},
        ],
        "tags": tags if tags is not None else {},
    }


def test_the_grid_lines_query_asks_for_geometry_and_carries_both_classes():
    query = osm_infra.build_grid_lines_query((29.0, 34.0, 34.5, 37.0))
    assert "(29.0,34.0,34.5,37.0)" in query
    assert query.count("out geom tags") == 2
    assert 'way["power"~"^(line|cable)$"]' in query
    assert 'way["man_made"="pipeline"]' in query


def test_power_lines_and_pipelines_are_split_by_tag_not_by_named_set():
    payload = {"elements": [
        line_way(1, tags={"power": "line", "voltage": "400000"}),
        line_way(2, tags={"man_made": "pipeline", "substance": "gas"}),
        line_way(3, tags={"power": "cable"}),
    ]}
    power_lines, pipelines = osm_infra.parse_grid_lines(payload, "russia_ukraine")
    assert {p["id"] for p in power_lines} == {"osm:way/1", "osm:way/3"}
    assert {p["id"] for p in pipelines} == {"osm:way/2"}


def test_every_captured_power_line_tag_lands_on_the_record():
    tags = {"power": "line", "name": "Line A", "operator": "Ukrenergo", "voltage": "330000", "cables": "3", "frequency": "50"}
    power_lines, _pipelines = osm_infra.parse_grid_lines({"elements": [line_way(tags=tags)]}, "sudan")
    (line,) = power_lines
    assert line["name"] == "Line A"
    assert line["operator"] == "Ukrenergo"
    assert line["voltage"] == "330000"
    assert line["cables"] == "3"
    assert line["frequency"] == "50"
    assert line["source"] == "osm"
    assert line["region_key"] == "sudan"


def test_every_captured_pipeline_tag_lands_on_the_record():
    tags = {"name": "Line B", "operator": "Naftogaz", "substance": "gas", "diameter": "1200", "man_made": "pipeline"}
    _power_lines, pipelines = osm_infra.parse_grid_lines({"elements": [line_way(tags=tags)]}, "sahel")
    (pipeline,) = pipelines
    assert pipeline["name"] == "Line B"
    assert pipeline["operator"] == "Naftogaz"
    assert pipeline["substance"] == "gas"
    assert pipeline["diameter"] == "1200"
    assert pipeline["source"] == "osm"
    assert pipeline["region_key"] == "sahel"


def test_a_grid_line_with_fewer_than_two_vertices_is_dropped():
    payload = {"elements": [line_way(tags={"power": "line"}, geometry=[{"lat": 1, "lon": 1}])]}
    power_lines, pipelines = osm_infra.parse_grid_lines(payload, "sudan")
    assert power_lines == []
    assert pipelines == []


def test_an_empty_grid_lines_response_is_not_an_error():
    power_lines, pipelines = osm_infra.parse_grid_lines({}, "sudan")
    assert power_lines == []
    assert pipelines == []
    power_lines, pipelines = osm_infra.parse_grid_lines({"elements": []}, "sudan")
    assert power_lines == []
    assert pipelines == []


def test_flattening_grid_lines_dedups_across_overlapping_theatres():
    shared = {"id": "osm:way/1", "path": [[1, 1], [2, 2]], "region_key": "south_china_sea"}
    flat = osm_infra.flatten_power_lines({
        "south_china_sea": [shared],
        "taiwan_strait": [{**shared, "region_key": "taiwan_strait"}],
    })
    assert len(flat) == 1
    assert flat[0]["region_key"] == "south_china_sea"


def test_serialize_power_lines_and_pipelines_state_their_own_provenance():
    power_doc = osm_infra.serialize_power_lines([{"id": "osm:way/1", "path": [[1, 1], [2, 2]]}])
    assert "power=line|cable" in power_doc["provenance"]
    assert "not worldwide" in power_doc["provenance"]
    pipeline_doc = osm_infra.serialize_pipelines([], truncated_regions=["sahel"])
    assert "man_made=pipeline" in pipeline_doc["provenance"]
    assert pipeline_doc["truncated_regions"] == ["sahel"]


# --- Task 28: caps reuse the same truncation-detection mechanism Task 27 added --


def test_the_grid_lines_cap_check_is_per_class_not_per_response(monkeypatch):
    """A dense pipeline network hitting its own cap in one region says nothing
    about whether the power grid in the same box did too -- each class must be
    checked against its own cap independently."""
    monkeypatch.setattr(osm_infra, "MAX_POWER_LINE_WAYS", 1)
    monkeypatch.setattr(osm_infra, "MAX_PIPELINE_WAYS", 5)
    payload = {"elements": [
        line_way(1, tags={"power": "line"}),
        line_way(2, tags={"man_made": "pipeline"}),
    ]}
    assert osm_infra._grid_lines_truncated(payload) == {"power"}


def test_an_empty_grid_lines_response_is_never_flagged_truncated():
    assert osm_infra._grid_lines_truncated({}) == set()
    assert osm_infra._grid_lines_truncated({"elements": []}) == set()


def test_rail_lines_truncation_still_delegates_to_the_shared_helper():
    """Task 28 generalised _rail_lines_truncated into _ways_truncated -- this
    pins that the public name and its behaviour are unchanged."""
    assert osm_infra._ways_truncated({"elements": [{}] * 3}, 3) is True
    assert osm_infra._ways_truncated({"elements": [{}] * 2}, 3) is False


# --- Task 28 review (Important 2): the point sweep gets the same log-and-flag
# treatment as the line caps, generalised across every _FEATURES class ------


def test_capped_point_kinds_flags_a_class_at_its_own_cap():
    # _FEATURES bakes its cap in at module import time from the *value* of
    # MAX_INFRA_POINT_PER_FEATURE at that moment, not a live reference -- so,
    # unlike _ways_truncated (which reads its cap as a plain function
    # argument), this cannot be exercised by monkeypatching the constant.
    # Real-sized payloads instead, the same way
    # test_capped_point_kinds_covers_the_four_original_classes_too below does.
    payload = {"elements": [element(tags={"man_made": "storage_tank"})] * osm_infra.MAX_INFRA_POINT_PER_FEATURE}
    assert osm_infra._capped_point_kinds(payload) == {"storage_tank"}


def test_capped_point_kinds_is_per_class_not_per_response():
    """A dense storage-tank farm hitting its own cap says nothing about
    whether a completely different class in the same box did too."""
    payload = {
        "elements": (
            [element(tags={"man_made": "storage_tank"})] * osm_infra.MAX_INFRA_POINT_PER_FEATURE
            + [element(tags={"power": "substation"})]
        ),
    }
    assert osm_infra._capped_point_kinds(payload) == {"storage_tank"}


def test_capped_point_kinds_covers_the_four_original_classes_too():
    """Not just the two new dense ones -- every _FEATURES class is checked,
    including the four that predate this task and never had this check
    before (military_airfield/military_area/power_plant/border_control)."""
    payload = {"elements": [element(tags={"military": "airfield"})] * osm_infra.MAX_PER_FEATURE}
    assert osm_infra._capped_point_kinds(payload) == {"military_airfield"}


def test_capped_point_kinds_is_empty_under_every_cap():
    payload = {"elements": [element(tags={"military": "airfield"})]}
    assert osm_infra._capped_point_kinds(payload) == set()


def test_capped_point_kinds_is_never_flagged_on_an_empty_response():
    assert osm_infra._capped_point_kinds({}) == set()
    assert osm_infra._capped_point_kinds({"elements": []}) == set()


def test_capped_point_kinds_ignores_an_element_matching_no_known_kind():
    payload = {"elements": [element(tags={"amenity": "cafe"})]}
    assert osm_infra._capped_point_kinds(payload) == set()


# --- Task 27: mainline rail geometry ----------------------------------------


def rail_way(way_id=1, geometry=None, tags=None):
    return {
        "type": "way",
        "id": way_id,
        "geometry": geometry if geometry is not None else [
            {"lat": 50.45, "lon": 30.52}, {"lat": 50.5, "lon": 30.6},
        ],
        "tags": tags if tags is not None else {},
    }


def test_the_rail_line_query_asks_for_geometry_not_a_computed_centre():
    """`out geom` is the whole point of a second query: a point sweep's `out
    center` throws the vertices away, and a polyline needs every one of them."""
    query = osm_infra.build_rail_line_query((29.0, 34.0, 34.5, 37.0))
    assert "(29.0,34.0,34.5,37.0)" in query
    assert "out geom tags" in query
    assert "out center" not in query


def test_the_rail_line_selector_is_the_running_lines_only():
    """Sidings, yards, platforms and disused/proposed track carry the same
    railway=* tag family and are exactly what made the *full* linework ~300 MB
    per theatre (see railways.py's docstring) -- this selector excludes them."""
    query = osm_infra.build_rail_line_query((0, 0, 1, 1))
    assert 'way["railway"~"^(rail|light_rail|narrow_gauge)$"]' in query
    assert "siding" not in query
    assert "platform" not in query


def test_a_way_with_fewer_than_two_vertices_is_not_a_line():
    payload = {"elements": [rail_way(geometry=[{"lat": 1, "lon": 1}])]}
    assert osm_infra.parse_rail_lines(payload, "sudan") == []


def test_a_node_or_relation_in_the_response_is_ignored():
    """The selector is way-only, but a defensive parse should not choke on
    anything else Overpass might still hand back."""
    payload = {"elements": [{"type": "node", "id": 1, "lat": 1, "lon": 1}]}
    assert osm_infra.parse_rail_lines(payload, "sudan") == []


def test_every_captured_tag_lands_on_the_record():
    tags = {
        "name": "Kyiv-Odesa Line", "operator": "Ukrzaliznytsia", "gauge": "1520",
        "electrified": "contact_line", "usage": "main", "service": "main",
        "railway": "rail",
    }
    (line,) = osm_infra.parse_rail_lines({"elements": [rail_way(tags=tags)]}, "ukraine")
    assert line["name"] == "Kyiv-Odesa Line"
    assert line["operator"] == "Ukrzaliznytsia"
    assert line["gauge"] == "1520"
    assert line["electrified"] == "contact_line"
    assert line["usage"] == "main"
    assert line["service"] == "main"
    assert line["railway"] == "rail"


def test_the_geometry_comes_out_as_leaflet_lat_lon_pairs():
    (line,) = osm_infra.parse_rail_lines(
        {"elements": [rail_way(geometry=[{"lat": 50.45, "lon": 30.52}, {"lat": 50.5, "lon": 30.6}])]},
        "ukraine",
    )
    assert line["path"] == [[50.45, 30.52], [50.5, 30.6]]


def test_every_line_is_tagged_source_osm_at_the_point_of_collection():
    """railways.py merges this with Natural Earth and relies on that tag being
    set here, not guessed back out of the shape of the data."""
    (line,) = osm_infra.parse_rail_lines({"elements": [rail_way()]}, "ukraine")
    assert line["source"] == "osm"


def test_the_id_is_prefixed_so_it_cannot_collide_with_a_point_feature():
    (line,) = osm_infra.parse_rail_lines({"elements": [rail_way(way_id=42)]}, "ukraine")
    assert line["id"] == "osm:way/42"


def test_the_region_the_sweep_found_the_way_in_travels_with_the_record():
    (line,) = osm_infra.parse_rail_lines({"elements": [rail_way()]}, "sahel")
    assert line["region_key"] == "sahel"


def test_an_empty_rail_line_response_is_not_an_error():
    assert osm_infra.parse_rail_lines({}, "sudan") == []
    assert osm_infra.parse_rail_lines({"elements": []}, "sudan") == []


def test_a_way_in_two_overlapping_theatres_is_only_listed_once():
    shared = {"id": "osm:way/1", "path": [[1, 1], [2, 2]], "region_key": "south_china_sea"}
    flat = osm_infra.flatten_rail_lines({
        "south_china_sea": [shared, {"id": "osm:way/2", "path": [[3, 3], [4, 4]]}],
        "taiwan_strait": [{**shared, "region_key": "taiwan_strait"}],
    })
    assert len(flat) == 2
    assert next(l for l in flat if l["id"] == "osm:way/1")["region_key"] == "south_china_sea"


def test_flattening_an_empty_rail_line_sweep_is_not_an_error():
    assert osm_infra.flatten_rail_lines({}) == []
    assert osm_infra.flatten_rail_lines({"sudan": []}) == []


def test_the_rail_line_document_states_its_own_provenance():
    doc = osm_infra.serialize_rail_lines([{"id": "osm:way/1", "source": "osm", "path": [[1, 1], [2, 2]]}])
    assert doc["attribution"] == "OpenStreetMap contributors"
    assert "railway=rail|light_rail|narrow_gauge" in doc["provenance"]
    assert doc["lines"] == [{"id": "osm:way/1", "source": "osm", "path": [[1, 1], [2, 2]]}]
    assert doc["truncated_regions"] == []


# --- Task 27 fix (post-review): detecting a capped response -----------------


def test_a_response_at_the_cap_is_flagged_truncated(monkeypatch):
    monkeypatch.setattr(osm_infra, "MAX_RAIL_LINE_WAYS", 2)
    payload = {"elements": [rail_way(1), rail_way(2)]}
    assert osm_infra._rail_lines_truncated(payload) is True


def test_a_response_under_the_cap_is_not_flagged(monkeypatch):
    monkeypatch.setattr(osm_infra, "MAX_RAIL_LINE_WAYS", 5)
    payload = {"elements": [rail_way(1), rail_way(2)]}
    assert osm_infra._rail_lines_truncated(payload) is False


def test_an_empty_response_is_never_flagged_truncated():
    assert osm_infra._rail_lines_truncated({}) is False
    assert osm_infra._rail_lines_truncated({"elements": []}) is False


def test_truncated_regions_are_carried_in_the_stored_document():
    doc = osm_infra.serialize_rail_lines([], truncated_regions=["russia_ukraine", "sahel"])
    # Sorted, so two sweeps that found the same capped set in a different
    # order never look like a change to a reader comparing two snapshots.
    assert doc["truncated_regions"] == ["russia_ukraine", "sahel"]
