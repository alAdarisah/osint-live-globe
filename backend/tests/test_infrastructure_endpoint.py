"""GET /api/infrastructure -- Task 28's pipeline merge, the one piece of
async logic app.py added around backend/infrastructure.py's otherwise-static
serialize(). Follows test_lanes_endpoint.py's style: call the route function
directly and monkeypatch storage.reference to a fixed fake.
"""

import asyncio
import json

import pytest
from starlette.requests import Request

from backend import app as app_mod


@pytest.fixture(autouse=True)
def _fresh_payload_cache():
    """The endpoint now builds and encodes once per TTL, keyed on a constant.

    That is the point of it in production -- N clients in a five-minute window
    cost one 8 MB build between them -- and it means that without this, the
    second test in this file reads the first one's fixture. Cleared before and
    after, so a test that populates the cache cannot leak into another file
    either.
    """
    app_mod._BUILT_PAYLOAD_CACHE.clear()
    yield
    app_mod._BUILT_PAYLOAD_CACHE.clear()


def _run(coro):
    return asyncio.run(coro)


def _body(response):
    return json.loads(response.body)


def _req(headers=None):
    """The bare Request these endpoints now take.

    They take one because both gained an ETag: the handler has to read
    If-None-Match to answer 304. Nothing else about the request is consulted, so
    an empty ASGI scope is the whole fixture.
    """
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "method": "GET", "path": "/", "headers": raw,
                    "query_string": b""})


def test_curated_pipeline_routes_are_wrapped_with_their_own_source():
    records = _run(app_mod._curated_pipeline_records())
    assert records, "backend/infrastructure.py's PIPELINE_ROUTES must not be empty"
    first = records[0]
    assert first["source"] == "curated"
    # `path`, not `coords` -- so the frontend reads one field name for both
    # the curated and the OSM half instead of branching on source.
    assert "path" in first and "coords" not in first
    assert first["path"] == app_mod.infrastructure.PIPELINE_ROUTES[0]["coords"]


def test_infrastructure_endpoint_merges_osm_pipelines_after_the_curated_ones(monkeypatch):
    osm_doc = {
        "lines": [{"id": "osm:way/1", "source": "osm", "path": [[1, 1], [2, 2]], "substance": "gas"}],
    }

    async def reference(name):
        assert name == "pipelines_osm"
        return osm_doc

    monkeypatch.setattr(app_mod.storage, "reference", reference)

    body = _body(_run(app_mod.infrastructure_list(_req())))

    assert body["pipelines"][-1] == osm_doc["lines"][0]
    assert body["pipelines"][0]["source"] == "curated"
    # sites/lanes are untouched by the merge -- still infrastructure.py's own
    # static lists.
    assert body["sites"] == app_mod.infrastructure.INFRA_SITES + app_mod.infrastructure.MILITARY_BASES
    assert body["lanes"] == app_mod.infrastructure.SHIPPING_LANES


def test_infrastructure_endpoint_serves_only_the_curated_routes_when_osm_has_not_swept_yet(monkeypatch):
    """A missing "pipelines_osm" document is "not swept yet", the same reading
    railways.py's own OSM half gives an empty reference() result -- not an
    error, and not a reason to drop the curated fallback."""
    async def reference(name):
        return None

    monkeypatch.setattr(app_mod.storage, "reference", reference)

    body = _body(_run(app_mod.infrastructure_list(_req())))
    curated = _run(app_mod._curated_pipeline_records())
    assert body["pipelines"] == curated
    assert body["pipelines_truncated_regions"] == []


# --- review fix (Task 28, Critical): truncated_regions must reach the wire --


def test_infrastructure_endpoint_carries_pipelines_truncated_regions_through(monkeypatch):
    """osm_infra.py computes and stores this exactly like power_lines_osm's
    own truncated_regions (see serialize_pipelines) -- it must not be read
    into osm_doc here and then dropped on the floor before the response is
    built, or a theatre that hit MAX_PIPELINE_WAYS reads as "OSM mapped less
    here" with nothing saying it was capped."""
    osm_doc = {"lines": [], "truncated_regions": ["sahel", "russia_ukraine"]}

    async def reference(name):
        return osm_doc

    monkeypatch.setattr(app_mod.storage, "reference", reference)

    body = _body(_run(app_mod.infrastructure_list(_req())))
    # Sorted, so two sweeps that found the same capped set in a different
    # order never look like a change to a reader comparing two responses --
    # same discipline serialize_pipelines/serialize_power_lines already apply.
    assert body["pipelines_truncated_regions"] == ["russia_ukraine", "sahel"]


# --- Task 29: military_bases, the same source-tagged merge for installations -


def test_military_bases_carries_curated_sites_even_before_any_osm_sweep():
    """registry.get("osm_infra") never having been registered (a bare unit
    test, or a fresh process before the ingest mirror's first tick) must read
    as "OSM has nothing yet", not crash the endpoint."""
    body = _body(_run(app_mod.infrastructure_list(_req())))
    assert len(body["military_bases"]) == len(app_mod.infrastructure.MILITARY_BASES)
    assert all(s["source"] == "curated" for s in body["military_bases"])


def test_military_bases_folds_in_a_mirrored_osm_sweep(monkeypatch):
    from backend.cache import registry

    site = app_mod.infrastructure.MILITARY_BASES[0]
    osm_match = {
        "id": "osm:way/99", "kind": "military_airfield", "lat": site["lat"], "lon": site["lon"],
        "name": f"{site['name']} (OSM)", "named": True, "operator": None, "region_key": None,
    }
    state = registry.register("osm_infra", key_configured=True)
    state.data = [osm_match]
    try:
        body = _body(_run(app_mod.infrastructure_list(_req())))
        osm_rec = next(s for s in body["military_bases"] if s["source"] == "osm")
        assert osm_rec["matched_curated_id"] == site["id"]
    finally:
        # Leave the shared registry as this test found it, so a later test in
        # the same process does not see a stray "osm_infra" entry.
        del registry._sources["osm_infra"]


def test_infrastructure_endpoint_truncated_regions_default_to_empty(monkeypatch):
    async def reference(name):
        return None

    monkeypatch.setattr(app_mod.storage, "reference", reference)

    body = _body(_run(app_mod.infrastructure_list(_req())))
    assert body["pipelines_truncated_regions"] == []
