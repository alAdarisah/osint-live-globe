"""power_lines.py re-shapes whatever osm_infra.py's own sweep last stored --
serialize() is the one piece of logic in the module worth pinning directly;
the poll loop itself is exercised the same way railways.py's is not, by the
persistence-coverage structural tests.
"""

from backend.sources import power_lines


def test_serialize_carries_the_lines_and_the_capped_regions_through():
    doc = {
        "attribution": "OpenStreetMap contributors",
        "provenance": "OpenStreetMap Overpass, power=line|cable, swept daily",
        "lines": [{"id": "osm:way/1", "path": [[1, 1], [2, 2]]}],
        "truncated_regions": ["russia_ukraine"],
    }
    out = power_lines.serialize(doc)
    assert out["lines"] == doc["lines"]
    assert out["truncated_regions"] == ["russia_ukraine"]
    assert out["attribution"] == "OpenStreetMap contributors"
    assert out["provenance"] == doc["provenance"]


def test_serialize_sorts_the_truncated_regions():
    doc = {"lines": [], "truncated_regions": ["sudan", "sahel"]}
    assert power_lines.serialize(doc)["truncated_regions"] == ["sahel", "sudan"]


def test_serialize_of_an_empty_document_never_errors():
    """The document is missing entirely, not just empty, the moment this
    module starts before osm_infra.py's ingest sweep has ever run -- the same
    "not swept yet" case railways.py's own OSM half handles."""
    out = power_lines.serialize({})
    assert out["lines"] == []
    assert out["truncated_regions"] == []
    assert "not worldwide" in out["provenance"]
    assert "power=line|cable" in out["provenance"]


def test_serialize_falls_back_to_its_own_provenance_string_when_the_stored_document_has_none():
    out = power_lines.serialize({"lines": [{"id": "osm:way/1", "path": [[1, 1], [2, 2]]}]})
    assert "power=line|cable" in out["provenance"]
