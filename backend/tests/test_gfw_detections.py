"""What a satellite detection is allowed to claim, and where it is allowed to sit.

Three things here are load-bearing and none of them fails loudly in production:

  - The position comes out of the feature id, not the tile geometry, and the id
    does not label which of its two numbers is latitude. Read the wrong way
    round, every detection in the Strait of Hormuz lands in inland Latvia --
    outside every watched box, so the clip drops it and the layer is empty under
    a green health light.
  - A 204 means the publisher has nothing in the window. Recorded as a failure,
    a dataset that is merely dry reads as a dataset that is broken -- which is
    the live state of the SAR product as this was written.
  - `detected` and `matched` are two different claims by two different parties.

The MVT decoder is hand-rolled (see the module docstring for why), so it is
tested against tiles built here byte by byte rather than against a fixture
nobody can read.
"""

import struct
import time

import pytest

from backend import config, storage
from backend.sources import gfw_detections as gfw

# A real feature, verbatim from a Sentinel-1 position tile over the Strait of
# Hormuz. Its id and its geometry are 3.3e-5 degrees apart -- the same point at
# two precisions -- which is what makes it usable as a fixture for both the
# precision claim and the axis-order claim.
REAL_ID = (
    "S1A_IW_GRDH_1SDV_20260628T021441_20260628T021506_065163_0836E0_F6B7"
    ";56.74939600;27.0279540"
)
REAL_GEOM_LONLAT = (56.749363, 27.027974)
REAL_STIME = 1782612894  # 2026-06-28T02:14:54Z, the scene acquisition


def feature(**overrides) -> dict:
    props = {"id": REAL_ID, "stime": REAL_STIME, "value": 1.0, "vessel_id": ""}
    props.update(overrides.pop("props", {}))
    out = {"props": props, "geom_lonlat": REAL_GEOM_LONLAT}
    out.update(overrides)
    return out


OPTICAL = gfw.DATASETS[0]
# Comfortably after the fixture's acquisition, so age_days is a fixed number
# rather than one that changes as this test ages.
NOW = REAL_STIME + 5 * 86400


# --- the feature id --------------------------------------------------------


def test_position_comes_from_the_id_and_beats_the_quantised_geometry():
    lat, lon = gfw.position_from(REAL_ID, REAL_GEOM_LONLAT)
    # The id's own digits, exactly -- not the tile grid's rounding of them.
    assert (lat, lon) == (27.0279540, 56.74939600)
    geom_lon, geom_lat = REAL_GEOM_LONLAT
    assert (lat, lon) != (geom_lat, geom_lon)
    assert 0 < abs(lon - geom_lon) < 1e-4, "the geometry is the same point, coarser"
    assert 0 < abs(lat - geom_lat) < 1e-4


def test_the_id_is_lon_then_lat_which_is_the_reading_the_geometry_agrees_with():
    """Read the other way round this detection is 3,000 km inland in Latvia.

    The geometry is the only witness to which field is which, so it is the one
    consulted -- the ordering is not asserted anywhere in the module.
    """
    lat, lon = gfw.position_from(REAL_ID, REAL_GEOM_LONLAT)
    assert (round(lat), round(lon)) == (27, 57)
    assert gfw.in_watched_waters(lat, lon), "Hormuz is one of the eight watched boxes"


def test_an_id_the_geometry_contradicts_is_dropped_rather_than_placed():
    """Neither reading matching the tile means the id is not this feature's."""
    elsewhere = "GRANULE;10.0000000;10.0000000"
    assert gfw.position_from(elsewhere, REAL_GEOM_LONLAT) is None


def test_the_axis_order_follows_the_tile_rather_than_the_module():
    """If GFW ever swaps the fields, the geometry says so and this follows."""
    swapped = "GRANULE;27.0279540;56.74939600"
    assert gfw.position_from(swapped, REAL_GEOM_LONLAT) == (27.0279540, 56.74939600)


@pytest.mark.parametrize(
    "raw",
    [
        None,
        "",
        "no-semicolons-at-all",
        "GRANULE;56.749396",                 # one coordinate, not two
        "GRANULE;not-a-number;27.027954",
        ";56.749396;27.027954",              # no granule
        "GRANULE;56.749396;999.0",           # off the planet
        "GRANULE;nan;27.027954",
    ],
)
def test_a_malformed_id_is_dropped_not_placed(raw):
    assert gfw.position_from(raw, None) is None
    assert gfw.build_record(feature(props={"id": raw}), OPTICAL, 1.0, NOW) is None


def test_a_granule_containing_a_semicolon_still_parses():
    """rsplit, not split -- otherwise the fields shift and the pin moves."""
    assert gfw.position_from("ODD;NAME;56.74939600;27.0279540", None) == (
        27.0279540, 56.74939600
    )


# --- the two claims --------------------------------------------------------


def test_a_detection_may_say_detected():
    """The one thing in this project's maritime domain entitled to the word."""
    record = gfw.build_record(feature(), OPTICAL, 4.0, NOW)
    assert record["detected"] is True


def test_matched_is_exactly_whether_gfw_correlated_a_vessel_id():
    unmatched = gfw.build_record(feature(), OPTICAL, 4.0, NOW)
    assert unmatched["matched"] is False
    assert unmatched["vessel_id"] is None

    matched = gfw.build_record(
        feature(props={"vessel_id": "b1e2c3d4e5f6"}), OPTICAL, 4.0, NOW
    )
    assert matched["matched"] is True
    assert matched["vessel_id"] == "b1e2c3d4e5f6"


def test_the_ais_correlation_is_attributed_to_gfw_on_every_record():
    """`matched` without it reads as this map's own finding. It is not."""
    for vessel_id in ("", "b1e2c3d4e5f6"):
        record = gfw.build_record(feature(props={"vessel_id": vessel_id}), OPTICAL, 4.0, NOW)
        assert "GFW" in record["match_basis"]
        # The measurement and the inference stay two fields, never one.
        assert record["detected"] is True


def test_absence_is_not_evidence_and_the_record_says_so():
    assert gfw.build_record(feature(), OPTICAL, 4.0, NOW)["footprint_known"] is False


def test_age_days_is_measured_from_the_scene_acquisition_time():
    record = gfw.build_record(feature(), OPTICAL, 4.0, NOW)
    assert record["time"] == REAL_STIME
    assert record["age_days"] == 5.0

    older = gfw.build_record(feature(), OPTICAL, 4.0, REAL_STIME + 42 * 86400 + 3600)
    assert older["age_days"] == 42.0


def test_a_detection_with_no_acquisition_time_is_dropped():
    """Undated, it would render beside live AIS with nothing to say it is old."""
    for stime in (None, 0, "", "2026-06-28"):
        assert gfw.build_record(feature(props={"stime": stime}), OPTICAL, 4.0, NOW) is None


def test_the_licence_travels_on_the_record_and_is_non_commercial():
    record = gfw.build_record(feature(), OPTICAL, 4.0, NOW)
    assert record["license"] == "CC BY-NC 4.0 (creativecommons.org/licenses/by-nc/4.0)"
    # GFW's own required form, which is dated and so cannot be a constant.
    assert record["attribution"] == (
        "Copyright 2026, Global Fishing Watch, Inc. Accessed on 2026-07-03."
    )


def test_the_record_id_names_the_sensor_so_two_datasets_cannot_collide():
    optical = gfw.build_record(feature(), gfw.DATASETS[0], 4.0, NOW)
    sar = gfw.build_record(feature(), gfw.DATASETS[1], 39.0, NOW)
    assert optical["id"] != sar["id"]
    assert optical["id"].startswith("optical:")
    assert sar["id"].startswith("sar:")
    assert optical["detection_id"] == sar["detection_id"] == REAL_ID


# --- measured staleness ----------------------------------------------------


def test_the_lag_is_measured_from_the_newest_scene_in_the_sweep():
    features = [
        feature(props={"id": f"G{n};56.7493960;27.0279540", "stime": REAL_STIME - n * 86400})
        for n in range(4)
    ]
    assert gfw.lag_for(features, REAL_STIME + 4 * 86400) == 4.0


def test_a_dataset_that_returned_nothing_has_no_measurable_lag():
    """"No data in the window" is what we know; how far behind it is, is not."""
    assert gfw.lag_for([], time.time()) is None


def test_the_measured_lag_is_carried_onto_every_record():
    records = gfw.build_records([feature()], gfw.DATASETS[1], NOW)
    assert [r["dataset_lag_days"] for r in records] == [5.0]


# --- coverage and bounds ---------------------------------------------------


def test_the_tile_budget_does_not_follow_the_ais_subscription():
    """AIS went global on 2026-08-08; this sweep deliberately did not.

    A z5 sweep of the whole planet is 1,024 tiles against a cap that keeps
    12,000 records, so ~98% of a 40-fold payload increase would be downloaded
    and discarded. The guard is that this reads WATCHED_WATERS, and the number
    below is what that costs today.
    """
    assert len(gfw.tiles_for(config.WATCHED_WATERS, gfw.TILE_ZOOM)) == 23
    assert len(gfw.tiles_for(config.AIS_BBOXES, gfw.TILE_ZOOM)) == 4 ** gfw.TILE_ZOOM


def test_the_tile_set_covers_the_watched_boxes_and_is_deduped():
    tiles = gfw.tiles_for(config.WATCHED_WATERS, gfw.TILE_ZOOM)
    assert len(tiles) == len(set(tiles))
    assert all(z == gfw.TILE_ZOOM for z, _x, _y in tiles)
    # Every corner of every watched box falls inside a tile that was requested.
    for lat_min, lon_min, lat_max, lon_max in config.WATCHED_WATERS:
        for lat in (lat_min, lat_max):
            for lon in (lon_min, lon_max):
                corner = gfw.tiles_for([(lat, lon, lat, lon)], gfw.TILE_ZOOM)
                assert corner[0] in tiles


def test_detections_outside_the_watched_boxes_are_clipped():
    """A z5 tile is ~11 degrees wide, so most of what a sweep downloads is not
    water this map watches. The layer's coverage has to stay a checkable claim."""
    atlantic = feature(props={"id": "G;-30.0000000;40.0000000"}, geom_lonlat=(-30.0, 40.0))
    assert gfw.build_records([feature(), atlantic], OPTICAL, NOW) == [
        gfw.build_record(feature(), OPTICAL, 5.0, NOW)
    ]


def test_records_are_bounded_and_the_newest_survive(monkeypatch):
    """entity_latest is keyed per detection, so nothing else stops it growing."""
    monkeypatch.setattr(gfw, "MAX_RECORDS_PER_DATASET", 3)
    features = [
        feature(props={"id": f"G{n};56.7493960;27.0279540", "stime": REAL_STIME - n * 3600})
        for n in range(10)
    ]
    records = gfw.build_records(features, OPTICAL, NOW)
    assert len(records) == 3
    assert [r["time"] for r in records] == [REAL_STIME - n * 3600 for n in range(3)]


def test_the_same_detection_seen_twice_is_stored_once():
    """Two watched boxes can share a tile; a duplicate row would double-count."""
    assert len(gfw.build_records([feature(), feature()], OPTICAL, NOW)) == 1


# --- the request -----------------------------------------------------------


def test_the_tile_url_is_the_verified_request():
    from datetime import date

    url = gfw.tile_url(
        "public-global-sar-presence:latest", 5, 25, 14, date(2026, 8, 1), date(2026, 8, 7)
    )
    assert url == (
        "https://gateway.api.globalfishingwatch.org/v3/4wings/tile/position/5/25/14"
        "?datasets[0]=public-global-sar-presence:latest"
        "&date-range=2026-08-01,2026-08-07"
        "&format=MVT"
        "&properties[0]=vessel_id"
    )


def test_the_identity_lookup_uses_the_singular_dataset_parameter():
    """`datasets=` answers 422 on this endpoint. It is the tile endpoint that
    takes the plural."""
    assert "?dataset=public-global-vessel-identity:latest" in gfw.IDENTITY_URL
    assert "datasets" not in gfw.IDENTITY_URL


def test_identity_is_resolved_once_per_vessel_and_never_during_a_sweep():
    """A sweep can hold thousands of matched detections; one request each would
    be a several-thousand-request pass for identity nobody asked to see."""
    import asyncio
    import inspect

    gfw._IDENTITY_CACHE.clear()

    class _Json(_Response):
        def json(self):
            return {"registryInfo": [{"name": "EXAMPLE"}]}

    client = _Client(_Json(200))
    assert asyncio.run(gfw.resolve_identity(client, "b1e2c3d4e5f6"))["registryInfo"]
    assert asyncio.run(gfw.resolve_identity(client, "b1e2c3d4e5f6"))["registryInfo"]
    assert len(client.urls) == 1

    # A 404 is a cached answer too -- an unresolvable id does not become
    # resolvable by being asked about again.
    assert asyncio.run(gfw.resolve_identity(_Client(_Response(404)), "gone")) is None
    assert gfw._IDENTITY_CACHE["gone"] is None

    assert "resolve_identity" not in inspect.getsource(gfw.ingest_once)
    assert "resolve_identity" not in inspect.getsource(gfw._sweep)


# --- 204 is not a failure --------------------------------------------------


class _Response:
    def __init__(self, status_code, content=b""):
        self.status_code = status_code
        self.content = content

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _Client:
    """Answers each request from `answer(url)`, and records what was asked for."""

    def __init__(self, answer):
        self.answer = answer if callable(answer) else (lambda _url: answer)
        self.urls = []

    async def get(self, url):
        self.urls.append(url)
        return self.answer(url)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _Health:
    def __init__(self):
        self.rows = []

    async def record(self, source, item_count, ok, error=None):
        self.rows.append((source, item_count, ok, error))


def _ingest(monkeypatch, answer, token="a-token"):
    health = _Health()
    snapshots = []

    async def record_snapshot(kind, items, id_field=None, id_fn=None):
        snapshots.append((kind, items, id_field))

    monkeypatch.setattr(config, "GFW_API_TOKEN", token)
    monkeypatch.setattr(storage, "record_source_health", health.record)
    monkeypatch.setattr(storage, "record_snapshot", record_snapshot)
    client = _Client(answer)
    monkeypatch.setattr(gfw.httpx, "AsyncClient", lambda **kwargs: client)

    import asyncio

    asyncio.run(gfw.ingest_once())
    return health, snapshots, client


def test_a_204_across_every_tile_records_no_failure(monkeypatch):
    """The live state of the SAR product. It is dry, not broken."""
    health, snapshots, client = _ingest(monkeypatch, _Response(204))

    assert health.rows == [("gfw_detections", 0, True, None)]
    assert snapshots == [("gfw_detections", [], "id")]
    assert client.urls, "the sweep still ran"
    assert gfw.LAST_SWEEPS["sar"].tiles_empty == gfw.LAST_SWEEPS["sar"].tiles
    assert gfw.LAST_SWEEPS["sar"].lag_days is None


def test_a_rejected_token_does_record_a_failure(monkeypatch):
    """Every tile erroring is a source failure, unlike every tile being empty."""
    health, snapshots, _client = _ingest(monkeypatch, _Response(401))

    assert snapshots == []
    (source, count, ok, error), = health.rows
    assert (source, count, ok) == ("gfw_detections", None, False)
    assert "401" in error


def test_one_dataset_failing_outright_is_not_hidden_by_the_other_being_dry(monkeypatch):
    """The exact pair of states these two products are in today.

    Checked per dataset rather than across the sweep: with optical failing every
    tile and SAR merely empty, a sweep-wide "did everything fail" test says no,
    and the layer goes green over a product that is not being collected at all.
    """
    def answer(url):
        return _Response(500) if "sentinel2" in url else _Response(204)

    health, snapshots, _client = _ingest(monkeypatch, answer)

    assert snapshots == []
    (source, count, ok, error), = health.rows
    assert (source, count, ok) == ("gfw_detections", None, False)
    assert error.startswith("optical:") and "500" in error


def test_a_missing_token_says_so_in_source_health(monkeypatch):
    """This process serves no /api/health of its own, so the backend would
    otherwise report "waiting for the ingest service" -- the wrong problem."""
    health, snapshots, client = _ingest(monkeypatch, _Response(204), token="")

    assert client.urls == []
    assert health.rows == [("gfw_detections", None, False, "GFW_API_TOKEN not set in .env")]
    assert snapshots == []


# --- the hand-rolled MVT decoder -------------------------------------------
#
# Built here byte by byte rather than checked in as an opaque fixture: the
# decoder exists instead of a dependency, so the spec it implements has to be
# visible next to it.


def _uvarint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | 0x80 if value else byte)
        if not value:
            return bytes(out)


def _zigzag(value: int) -> int:
    return (value << 1) if value >= 0 else ((-value << 1) - 1)


def _tag(field: int, wire: int) -> bytes:
    return _uvarint((field << 3) | wire)


def _len_field(field: int, payload: bytes) -> bytes:
    return _tag(field, 2) + _uvarint(len(payload)) + payload


def _varint_field(field: int, value: int) -> bytes:
    return _tag(field, 0) + _uvarint(value)


def _value(python_value) -> bytes:
    if isinstance(python_value, str):
        return _len_field(1, python_value.encode("utf-8"))
    if isinstance(python_value, float):
        return _tag(3, 1) + struct.pack("<d", python_value)
    return _varint_field(4, python_value)


def build_tile(features: list[tuple[dict, tuple[int, int]]], extent: int = 4096,
               layer_name: str = "main") -> bytes:
    """A minimal MVT v2 tile holding point features with string/number props."""
    keys: list[str] = []
    values: list = []
    body = b""
    for props, (px, py) in features:
        tags: list[int] = []
        for key, value in props.items():
            if key not in keys:
                keys.append(key)
            if value not in values:
                values.append(value)
            tags += [keys.index(key), values.index(value)]
        geometry = [(1 << 3) | 1, _zigzag(px), _zigzag(py)]  # MoveTo, count 1
        body += _len_field(2, (
            _len_field(2, b"".join(_uvarint(t) for t in tags))
            + _varint_field(3, 1)  # GeomType.POINT
            + _len_field(4, b"".join(_uvarint(g) for g in geometry))
        ))
    layer = (
        _varint_field(15, 2)
        + _len_field(1, layer_name.encode("utf-8"))
        + body
        + b"".join(_len_field(3, k.encode("utf-8")) for k in keys)
        + b"".join(_len_field(4, _value(v)) for v in values)
        + _varint_field(5, extent)
    )
    return _len_field(3, layer)


def _pixels_for(z: int, x: int, y: int, lon: float, lat: float, extent: int = 4096):
    """The inverse of gfw._tile_to_lonlat, so a tile can be built at a place."""
    import math

    size = extent * (2 ** z)
    px = round((lon + 180.0) / 360.0 * size) - x * extent
    sin = math.sin(math.radians(lat))
    fraction = 0.5 - math.log((1 + sin) / (1 - sin)) / (4 * math.pi)
    py = round(fraction * size) - y * extent
    return px, py


def test_the_decoder_reads_properties_and_a_point_geometry():
    z, x, y = 5, 25, 14
    px, py = _pixels_for(z, x, y, *REAL_GEOM_LONLAT)
    tile = build_tile([({"id": REAL_ID, "stime": REAL_STIME, "value": 1.0,
                         "vessel_id": ""}, (px, py))])

    (decoded,) = gfw.decode_tile(tile, z, x, y)
    assert decoded["props"] == {
        "id": REAL_ID, "stime": REAL_STIME, "value": 1.0, "vessel_id": "",
    }
    lon, lat = decoded["geom_lonlat"]
    # Round-tripped through the tile grid, so equal only to the grid's own
    # resolution -- which is the entire reason positions come from the id.
    assert lon == pytest.approx(REAL_GEOM_LONLAT[0], abs=0.01)
    assert lat == pytest.approx(REAL_GEOM_LONLAT[1], abs=0.01)


def test_the_decoder_ignores_layers_that_are_not_the_position_layer():
    tile = build_tile([({"id": REAL_ID}, (10, 10))], layer_name="something-else")
    assert gfw.decode_tile(tile, 5, 25, 14) == []


def test_the_decoder_honours_a_non_default_extent():
    z, x, y = 5, 25, 14
    for extent in (4096, 512):
        px, py = _pixels_for(z, x, y, *REAL_GEOM_LONLAT, extent=extent)
        tile = build_tile([({"id": REAL_ID}, (px, py))], extent=extent)
        (decoded,) = gfw.decode_tile(tile, z, x, y)
        lon, lat = decoded["geom_lonlat"]
        assert lon == pytest.approx(REAL_GEOM_LONLAT[0], abs=0.1)
        assert lat == pytest.approx(REAL_GEOM_LONLAT[1], abs=0.1)


def test_the_decoder_raises_rather_than_resyncing_on_a_wire_type_it_cannot_read():
    """A protobuf decoder that guesses a field's length produces plausible
    coordinates in the wrong ocean. _sweep drops the tile instead."""
    with pytest.raises(ValueError):
        list(gfw._fields(_tag(1, 3) + b"\x00"))


def test_a_tile_decodes_end_to_end_into_records():
    z, x, y = 5, 25, 14
    px, py = _pixels_for(z, x, y, *REAL_GEOM_LONLAT)
    tile = build_tile([
        ({"id": REAL_ID, "stime": REAL_STIME, "vessel_id": ""}, (px, py)),
        ({"id": REAL_ID.replace("F6B7", "AAAA"), "stime": REAL_STIME,
          "vessel_id": "b1e2c3d4e5f6"}, (px, py)),
    ])

    records = gfw.build_records(gfw.decode_tile(tile, z, x, y), OPTICAL, NOW)
    assert len(records) == 2
    assert sorted(r["matched"] for r in records) == [False, True]
    for record in records:
        assert record["lat"] == pytest.approx(27.0279540)
        assert record["lon"] == pytest.approx(56.74939600)
        assert record["sensor"] == "optical"
