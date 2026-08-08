"""Natural Earth's admin-1 layer -> one stored collection per country.

The features below are trimmed copies of real ne_10m_admin_1_states_provinces
entries, keeping the properties the split actually reads. Three things about
that file drive the assertions and none of them are visible from the field
names:

  - Every subdivision on earth -- 4,596 of them across 251 countries -- is in
    one flat FeatureCollection, so the split by `adm0_a3` is the whole of "serve
    one country's states".
  - `iso_3166_2` is present for almost everything and empty for a handful of
    Chinese and Indonesian entries. Those still have to be kept: a state missing
    from the layer is drawn exactly like sea.
  - Coordinates arrive at full float precision and are rounded on the way in.
    Rounding merges points, so the de-duplication has to happen with it or the
    ring keeps its original length and nothing is saved.
"""

from backend.sources import admin1_boundaries


def _square(x: float, y: float, size: float = 1.0) -> dict:
    return {
        "type": "Polygon",
        "coordinates": [[
            [x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y],
        ]],
    }


def _feature(props: dict, geometry: dict | None = None) -> dict:
    return {"type": "Feature", "properties": props, "geometry": geometry or _square(0, 0)}


ALASKA = {
    "adm0_a3": "USA", "admin": "United States of America", "name": "Alaska",
    "name_en": "Alaska", "iso_3166_2": "US-AK", "postal": "AK", "type_en": "State",
}
TEXAS = {
    "adm0_a3": "USA", "admin": "United States of America", "name": "Texas",
    "name_en": "Texas", "iso_3166_2": "US-TX", "postal": "TX", "type_en": "State",
}
ONTARIO = {
    "adm0_a3": "CAN", "admin": "Canada", "name": "Ontario", "name_en": "Ontario",
    "iso_3166_2": "CA-ON", "postal": "ON", "type_en": "Province",
}


def test_splits_by_country():
    out = admin1_boundaries.build_collections([
        _feature(ALASKA), _feature(TEXAS), _feature(ONTARIO),
    ])
    assert sorted(out) == ["CAN", "USA"]
    assert [f["properties"]["name"] for f in out["USA"]["features"]] == ["Alaska", "Texas"]
    assert out["CAN"]["type"] == "FeatureCollection"


def test_keeps_the_fields_the_map_reads_and_drops_the_rest():
    noisy = dict(TEXAS, scalerank=2, label_x=-99.3, gns_id=4736286, name_alt="TX|Tex.")
    props = admin1_boundaries.build_collections([_feature(noisy)])["USA"]["features"][0]["properties"]
    assert props == {
        "key": "US-TX",
        "code": "US-TX",
        "name": "Texas",
        "postal": "TX",
        "kind": "State",
        "country_code": "USA",
        "country": "United States of America",
    }


def test_keeps_a_subdivision_with_no_iso_code():
    # Real shape of the gap: a few CHN/IDN entries publish an empty
    # `iso_3166_2`. Dropping them would leave a hole inside a country that is
    # otherwise fully covered, and a hole is indistinguishable from sea.
    codeless = {
        "adm0_a3": "CHN", "admin": "China", "name": "Paracel Islands",
        "iso_3166_2": "", "postal": "", "type_en": "Disputed",
    }
    features = admin1_boundaries.build_collections([_feature(codeless)])["CHN"]["features"]
    assert len(features) == 1
    assert features[0]["properties"]["code"] == ""
    assert features[0]["properties"]["name"] == "Paracel Islands"


def test_drops_a_feature_with_no_country_or_no_geometry():
    out = admin1_boundaries.build_collections([
        _feature({"name": "Nowhere", "iso_3166_2": "XX-1"}),          # no adm0_a3
        _feature(dict(TEXAS, name="", name_en="", gn_name=""), None),  # no name
        {"type": "Feature", "properties": ALASKA, "geometry": None},   # no geometry
    ])
    assert out == {}


def test_two_subdivisions_sharing_an_iso_code_get_different_keys():
    # Natural Earth cuts a capital out of the region around it and gives both the
    # region's code: Lima the province and Lima the city are both PE-LIM. The map
    # selects on the key, so without this both highlighted at once -- and the
    # name does not separate them either, which is why the suffix is on the key
    # rather than a fallback to the name.
    lima = {"adm0_a3": "PER", "admin": "Peru", "name": "Lima", "iso_3166_2": "PE-LIM"}
    features = admin1_boundaries.build_collections([
        _feature(lima, _square(0, 0)), _feature(lima, _square(5, 5)),
    ])["PER"]["features"]
    assert [f["properties"]["key"] for f in features] == ["PE-LIM", "PE-LIM#2"]
    # The published code is untouched: it is what a subnational feed joins on.
    assert {f["properties"]["code"] for f in features} == {"PE-LIM"}


def test_a_codeless_subdivision_is_keyed_on_country_and_name():
    codeless = {"adm0_a3": "CHN", "admin": "China", "name": "Paracel Islands", "iso_3166_2": ""}
    features = admin1_boundaries.build_collections([_feature(codeless)])["CHN"]["features"]
    assert features[0]["properties"]["key"] == "CHN:Paracel Islands"


def test_rounds_and_deduplicates_coordinates():
    # Two points that differ only in the fifth decimal collapse into one, which
    # is the whole point of rounding: keeping both would round the file's size
    # and none of its length.
    ring = [[1.000001, 2.000002], [1.000004, 2.000003], [3.5, 2.0], [3.5, 4.0], [1.000001, 2.000002]]
    feature = _feature(TEXAS, {"type": "Polygon", "coordinates": [ring]})
    geometry = admin1_boundaries.build_collections([feature])["USA"]["features"][0]["geometry"]
    assert geometry["coordinates"] == [[[1.0, 2.0], [3.5, 2.0], [3.5, 4.0], [1.0, 2.0]]]


def test_drops_a_ring_that_rounding_collapses():
    # A subdivision smaller than the grid it is being rounded onto is not a
    # shape any more, and an empty polygon handed to Leaflet is a fill over
    # nothing rather than an error anyone would see.
    speck = _feature(TEXAS, _square(10.0, 10.0, size=0.0001))
    assert admin1_boundaries.build_collections([speck]) == {}
