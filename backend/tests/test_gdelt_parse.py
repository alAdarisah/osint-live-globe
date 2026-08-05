"""Column-position and parsing tests for backend/sources/gdelt.py.

These exist because every field in the conflict pipeline is read by integer
column index out of a headerless TSV. A wrong index does not raise -- it
silently returns a neighbouring field, which is how "country" ended up
holding a full place string for years. Each test below pins one index by
asserting on a value that could only have come from the right column.
"""

from backend.sources import gdelt
from backend.tests.conftest import gdelt_row, gdelt_tsv


def _one(**overrides) -> dict:
    parsed = gdelt._parse_events(gdelt_tsv(gdelt_row(**overrides)))
    assert len(parsed) == 1, "fixture row should parse to exactly one event"
    return parsed[0]


def test_parses_core_columns_by_position():
    event = _one()
    assert event["event_id"] == "1316898062"
    assert event["lat"] == 46.6354
    assert event["lon"] == 32.6169
    assert event["actor1"] == "RUSSIA"
    assert event["actor2"] == "AIR FORCE"
    assert event["actor2_type"] == "MIL"
    assert event["event_code"] == "190"
    assert event["event_root_code"] == 19
    assert event["quad_class"] == 4
    assert event["goldstein"] == -10.0
    assert event["mentions"] == 2
    assert event["date_added"] == "20260805101500"
    assert event["location"] == "Kherson, Khersons'ka Oblast', Ukraine"


def test_parses_every_quad_class_and_routes_by_it():
    """Quad 1/2 (cooperation) used to be dropped at parse time, which is why the
    app had no view of diplomacy: CAMEO root 04 -- one leader meeting, visiting
    or hosting another -- is quad class 1. They are parsed now, and the
    narrowing each layer needs happens where the rows are routed instead."""
    for quad in ("1", "2", "3", "4"):
        assert len(gdelt._parse_events(gdelt_tsv(gdelt_row(quad=quad)))) == 1, quad
    # ...and the conflict window is still exactly quad 3/4, which is what
    # event_fusion reads. This is the assertion the old one was really making.
    parsed = gdelt._parse_events(gdelt_tsv(
        gdelt_row(quad="1", event_id="1"),
        gdelt_row(quad="2", event_id="2"),
        gdelt_row(quad="3", event_id="3"),
        gdelt_row(quad="4", event_id="4"),
    ))
    conflict = [ev for ev in parsed if ev["quad_class"] in (3, 4)]
    assert sorted(ev["event_id"] for ev in conflict) == ["3", "4"]


def test_drops_rows_without_usable_coordinates():
    assert gdelt._parse_events(gdelt_tsv(gdelt_row(lat=""))) == []
    assert gdelt._parse_events(gdelt_tsv(gdelt_row(lon="not-a-number"))) == []


def test_drops_short_rows():
    short = gdelt_row()[:40]
    assert gdelt._parse_events(gdelt_tsv(short)) == []


def test_verified_domain_becomes_an_agency_name():
    assert _one(source_url="https://www.reuters.com/world/x")["source_name"] == "Reuters"
    assert _one(source_url="https://edition.cnn.com/x")["source_name"] == "CNN"
    # An unverified domain still parses -- event_fusion needs the structured
    # event even when no headline will ever be scraped for it.
    assert _one(source_url="https://some-content-farm.example/x")["source_name"] is None


def test_mojibake_repair_only_fires_on_double_encoded_text():
    # Real double-encoded UTF-8 (cp1252 round trip) is repaired...
    assert gdelt._fix_mojibake("KÃ¶ln") == "Köln"
    assert gdelt._fix_mojibake("Ã‰vry") == "Évry"
    # ...and text that merely contains those characters legitimately is not.
    assert gdelt._fix_mojibake("Köln") == "Köln"
    assert gdelt._fix_mojibake("Zurich") == "Zurich"
    assert gdelt._fix_mojibake("") == ""


def test_dedup_key_prefers_article_url():
    keyed = gdelt._dedup_key({"source_url": "https://x.example/a", "event_id": "1"})
    assert keyed == "https://x.example/a"
    # No URL: fall back to the event's own id rather than collapsing every
    # URL-less row into a single bucket.
    assert gdelt._dedup_key({"source_url": "", "event_id": "1"}) == "evt:1"
