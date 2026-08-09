"""Digitraffic weather-camera parsing: locations only, and never a sighting time.

This is a DeFlock-shaped locations layer, so the same two traps apply. The
coordinate is GeoJSON [lon, lat] (read backwards, every camera moves to the wrong
place), and ``dataUpdatedTime`` is a metadata refresh time, not an observation --
storing it as a plain ``time`` would dress a metadata update up as a sighting.
The preset image URLs are carried as metadata; the JPEG bytes never are.
"""

from backend.sources import digitraffic_weathercams as cams


def feature(camera_id="C0150200", coordinates=(24.94, 60.17), presets=None, **props):
    """One weathercam GeoJSON feature. `coordinates` is GeoJSON order [lon, lat]."""
    if presets is None:
        presets = [
            {"presetId": "C01502001", "imageUrl": "https://weathercam.digitraffic.fi/C0150200_1.jpg"},
            {"presetId": "C01502002", "imageUrl": "https://weathercam.digitraffic.fi/C0150200_2.jpg"},
        ]
    base = {
        "id": camera_id,
        "name": "vt1 Helsinki, Kehä III",
        "collectionStatus": "GATHERING",
        "dataUpdatedTime": "2026-08-09T12:00:00Z",
        "presets": presets,
    }
    base.update(props)
    return {
        "type": "Feature",
        "id": camera_id,
        "geometry": {"type": "Point", "coordinates": list(coordinates)},
        "properties": base,
    }


def collection(*features):
    return {"type": "FeatureCollection", "features": list(features)}


def test_coordinates_are_lon_lat_in_that_order():
    (cam,) = cams.parse_weathercams(collection(feature(coordinates=(24.9384, 60.1699))))
    assert (cam["lat"], cam["lon"]) == (60.1699, 24.9384)


def test_the_camera_id_keys_the_record():
    (cam,) = cams.parse_weathercams(collection(feature(camera_id="C1234567")))
    assert cam["id"] == "C1234567"
    assert cam["kind"] == "weathercam"


def test_the_metadata_time_is_named_as_one_never_as_an_observation():
    """dataUpdatedTime is when the station metadata refreshed, not a sighting.
    It must land under data_updated_time, with no plain time field to confuse."""
    (cam,) = cams.parse_weathercams(collection(feature()))
    assert cam["data_updated_time"] == "2026-08-09T12:00:00Z"
    assert "time" not in cam
    assert "observed_at" not in cam


def test_preset_image_urls_are_carried_as_metadata():
    (cam,) = cams.parse_weathercams(collection(feature()))
    assert cam["image_urls"] == [
        "https://weathercam.digitraffic.fi/C0150200_1.jpg",
        "https://weathercam.digitraffic.fi/C0150200_2.jpg",
    ]


def test_a_camera_with_no_presets_has_an_empty_url_list_not_a_crash():
    (cam,) = cams.parse_weathercams(collection(feature(presets=[])))
    assert cam["image_urls"] == []


def test_a_non_point_or_coordinate_less_feature_is_dropped():
    line = feature()
    line["geometry"] = {"type": "LineString", "coordinates": [[24.9, 60.1], [25.0, 60.2]]}
    noco = feature()
    noco["geometry"]["coordinates"] = []
    assert cams.parse_weathercams(collection(line, noco)) == []


def test_attribution_reaches_every_record():
    (cam,) = cams.parse_weathercams(collection(feature()))
    assert cam["source"] == "digitraffic"
    assert cam["license"] == "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY"


def test_an_empty_or_absent_collection_is_not_an_error():
    assert cams.parse_weathercams({}) == []
    assert cams.parse_weathercams({"type": "FeatureCollection", "features": []}) == []
    assert cams.parse_weathercams(None) == []
