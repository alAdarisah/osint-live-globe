"""The two biggest payloads are built once and re-downloaded never.

Measured on a real page load of the deployment before this existed:
/api/infrastructure was 8.3 MB decoded and 34 seconds wall-clock, rebuilt and
re-encoded from scratch on every request, with no ETag -- so a reload, a second
tab, or the three-minute poll each paid the whole thing again. /api/water was the
same shape one size down: it cached the *filter* pass and re-encoded up to 3.2 MB
of GeoJSON per hit.

Both halves are load-bearing and they fail differently, so both are pinned here:
drop the byte cache and the server burns CPU per client; drop the ETag and the
client burns bandwidth per poll.
"""

import asyncio
import json

import pytest
from starlette.requests import Request

from backend import app as app_mod


def _run(coro):
    return asyncio.run(coro)


def _req(headers=None):
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "method": "GET", "path": "/", "headers": raw,
                    "query_string": b""})


@pytest.fixture(autouse=True)
def _fresh_caches():
    app_mod._BUILT_PAYLOAD_CACHE.clear()
    app_mod._WATER_CACHE.clear()
    yield
    app_mod._BUILT_PAYLOAD_CACHE.clear()
    app_mod._WATER_CACHE.clear()


# --- the encoder ------------------------------------------------------------

def test_the_tag_is_the_content_and_nothing_else():
    """A content hash rather than a version counter, because these endpoints merge
    several inputs and there is no single counter to read. Exact by construction:
    the tag changes when and only when the body does."""
    body_a, etag_a = app_mod._encode_payload({"a": 1, "b": [1, 2, 3]})
    body_b, etag_b = app_mod._encode_payload({"a": 1, "b": [1, 2, 3]})
    assert (body_a, etag_a) == (body_b, etag_b), "equal payloads must tag equal"

    _, etag_c = app_mod._encode_payload({"a": 1, "b": [1, 2, 4]})
    assert etag_c != etag_a, "a changed payload must change the tag"


def test_the_encoding_is_the_one_the_rest_of_the_api_uses():
    """Compact separators, same as Starlette's JSONResponse. A payload encoded
    differently here would be a second JSON dialect on one API -- and would also
    quietly inflate the very responses this is meant to shrink."""
    body, _ = app_mod._encode_payload({"a": 1, "b": 2})
    assert body == b'{"a":1,"b":2}'
    assert b", " not in body and b": " not in body


def test_the_tag_is_quoted_and_short():
    """An ETag is a quoted string by RFC, and unquoted ones are silently ignored by
    some caches -- which would look exactly like the feature not working. Short
    because it rides every response on an endpoint polled every three minutes."""
    _, etag = app_mod._encode_payload({"x": 1})
    assert etag.startswith('"') and etag.endswith('"')
    assert len(etag) <= 20, etag


# --- the 304 path -----------------------------------------------------------

def test_a_client_holding_the_body_gets_no_body():
    entry = app_mod._encode_payload({"big": "payload"})
    _, etag = entry

    fresh = app_mod._built_json_response(_req(), entry, "public, max-age=86400")
    assert fresh.status_code == 200
    assert fresh.headers["ETag"] == etag
    assert fresh.headers["Cache-Control"] == "public, max-age=86400"

    repeat = app_mod._built_json_response(_req({"If-None-Match": etag}), entry,
                                          "public, max-age=86400")
    assert repeat.status_code == 304
    assert repeat.body == b"", "a 304 must not carry the body it is saying you have"
    # The validator has to come back on the 304 as well, or the next request has
    # nothing to send and the client falls back to downloading it again.
    assert repeat.headers["ETag"] == etag


def test_a_stale_tag_gets_the_new_body_rather_than_a_304():
    entry = app_mod._encode_payload({"v": 2})
    out = app_mod._built_json_response(_req({"If-None-Match": '"deadbeefdeadbeef"'}),
                                       entry, "public, max-age=86400")
    assert out.status_code == 200
    assert json.loads(out.body) == {"v": 2}


def test_the_response_still_says_it_is_json():
    """Served as raw bytes now rather than through JSONResponse, so the media type
    is this function's responsibility -- and a payload arriving as
    application/octet-stream is one the browser will not parse."""
    out = app_mod._built_json_response(_req(), app_mod._encode_payload({"a": 1}),
                                       "public, max-age=86400")
    assert out.media_type == "application/json"


# --- the endpoints ----------------------------------------------------------

def test_infrastructure_builds_once_for_many_clients(monkeypatch):
    """The server half. Every call below the cache is a Postgres read, two merges
    over the OSM sweep and 8 MB of JSON encoding, and none of it is per-client
    work."""
    builds = 0
    real = app_mod._build_infrastructure_payload

    async def counting():
        nonlocal builds
        builds += 1
        return await real()

    monkeypatch.setattr(app_mod, "_build_infrastructure_payload", counting)

    first = _run(app_mod.infrastructure_list(_req()))
    assert first.status_code == 200
    for _ in range(4):
        _run(app_mod.infrastructure_list(_req()))
    assert builds == 1, f"rebuilt {builds} times for 5 requests"


def test_infrastructure_answers_304_to_a_client_that_has_it(monkeypatch):
    """The client half, and the one that mattered most: this endpoint measured 8.3 MB
    on the wire with no validator at all, so a reload downloaded all of it again."""
    first = _run(app_mod.infrastructure_list(_req()))
    etag = first.headers["ETag"]
    assert len(first.body) > 0

    again = _run(app_mod.infrastructure_list(_req({"If-None-Match": etag})))
    assert again.status_code == 304
    assert again.body == b""


def test_infrastructure_still_serves_the_whole_document():
    """The cache must not have changed what is served, only how often it is built."""
    body = json.loads(_run(app_mod.infrastructure_list(_req())).body)
    for key in ("sites", "pipelines", "lanes", "military_bases",
                "pipelines_truncated_regions"):
        assert key in body, key
    assert body["sites"], "the curated site list came back empty"


def _stub_water(monkeypatch):
    """Two kinds with genuinely different contents, and a read counter.

    Without a stub both kinds answer with the same empty FeatureCollection, which
    a content-hashed ETag correctly gives the same tag -- so a test comparing the
    two tags would be asserting on the fixture rather than on the cache key.
    """
    docs = {
        "water_marine": {"type": "FeatureCollection",
                         "features": [{"type": "Feature", "properties": {"id": "sea"},
                                       "geometry": {"type": "Point", "coordinates": [0, 0]}}]},
        "water_lakes": {"type": "FeatureCollection",
                        "features": [{"type": "Feature", "properties": {"id": "lake"},
                                      "geometry": {"type": "Point", "coordinates": [1, 1]}}]},
    }
    reads = []

    async def reference(name):
        reads.append(name)
        return docs.get(name)

    monkeypatch.setattr(app_mod.storage, "reference", reference)
    return reads


def test_water_keys_its_cache_by_kind(monkeypatch):
    """Keyed on (kind, bbox) as it always was -- the change is what the entry holds.
    Two kinds sharing one entry is the failure a coarser key would produce, and it
    would be silent: the map would draw lakes where the seas should be."""
    _stub_water(monkeypatch)
    marine = _run(app_mod.water_endpoint(_req(), kind="marine"))
    lakes = _run(app_mod.water_endpoint(_req(), kind="lakes"))
    assert marine.headers["ETag"] != lakes.headers["ETag"], "two kinds, one tag"
    assert json.loads(marine.body)["features"][0]["properties"]["id"] == "sea"
    assert json.loads(lakes.body)["features"][0]["properties"]["id"] == "lake"


def test_water_reads_storage_once_per_key_and_304s_after(monkeypatch):
    reads = _stub_water(monkeypatch)
    first = _run(app_mod.water_endpoint(_req(), kind="marine"))
    for _ in range(3):
        _run(app_mod.water_endpoint(_req(), kind="marine"))
    assert reads.count("water_marine") == 1, f"re-read storage {reads.count('water_marine')} times"

    repeat = _run(app_mod.water_endpoint(_req({"If-None-Match": first.headers["ETag"]}),
                                         kind="marine"))
    assert repeat.status_code == 304
    assert repeat.body == b""


def test_water_still_refuses_rivers_without_a_bbox():
    """The gate this endpoint already had, checked because the cache lookup now sits
    near it: a caching rewrite that answered before validating would serve a 5 MB
    document the endpoint is supposed to refuse."""
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as raised:
        _run(app_mod.water_endpoint(_req(), kind="rivers"))
    assert raised.value.status_code == 400


# --- coordinate precision ---------------------------------------------------

def test_floats_are_rounded_and_everything_else_is_left_alone():
    """Applied to the whole structure rather than to named coordinate fields,
    because the geometry that dominates these payloads is bare nested arrays with
    no field name to key on."""
    out = app_mod._round_floats({
        "lat": 31.899612345678,
        "lon": -34.682512345678,
        "path": [[1.123456789, 2.987654321], [3.5, 4.0]],
        "name": "Palmachim 12.3456789",
        "count": 42,
        "flag": True,
        "missing": None,
        "nested": {"deep": [{"v": 0.123456789}]},
    })
    assert out["lat"] == 31.89961
    assert out["lon"] == -34.68251
    assert out["path"] == [[1.12346, 2.98765], [3.5, 4.0]]
    # A string that happens to contain a long number is not a number.
    assert out["name"] == "Palmachim 12.3456789"
    assert out["count"] == 42 and isinstance(out["count"], int)
    assert out["flag"] is True
    assert out["missing"] is None
    assert out["nested"]["deep"][0]["v"] == 0.12346


def test_five_decimals_is_the_stated_precision():
    """1.1 m at the equator, which is finer than anything this map claims to know --
    the cursor readout says so in as many words. Change this and the map starts
    either paying for noise or losing real position."""
    assert app_mod.COORDINATE_DECIMALS == 5


def test_rounding_actually_shrinks_a_realistic_payload():
    """The point of the exercise, asserted rather than assumed. Cable landing
    geometry arrives as raw float repr -- fourteen and fifteen decimals -- and is
    41% smaller gzipped once rounded."""
    import gzip
    raw = {"lines": [[[i / 7, i / 3] for i in range(400)]]}
    before, _ = app_mod._encode_payload(raw)
    after, _ = app_mod._encode_payload(app_mod._round_floats(raw))
    assert len(after) < len(before) * 0.6, f"{len(before)} -> {len(after)}"
    assert len(gzip.compress(after, 6)) < len(gzip.compress(before, 6))


def test_rounding_does_not_lose_a_position_anyone_could_see():
    """The check that this trims noise rather than data: five decimals is about a
    metre, and every layer on this map states an uncertainty far larger."""
    lat, lon = 51.4779123456, -0.0014567890
    out = app_mod._round_floats({"lat": lat, "lon": lon})
    assert abs(out["lat"] - lat) < 1e-5
    assert abs(out["lon"] - lon) < 1e-5


def test_a_payload_already_at_five_decimals_is_unchanged():
    """/api/countries and the marine water set are already rounded upstream. If this
    changed them it would be re-rounding, and the byte-identical result is what says
    the transform is idempotent."""
    already = {"path": [[12.34567, -1.2], [0.0, 90.0]]}
    assert app_mod._round_floats(already) == already
    assert app_mod._round_floats(app_mod._round_floats(already)) == already


# --- brotli, for the entries whose bytes are already cached -----------------
#
# Not a general compression layer: GZipMiddleware still handles every other
# response. This is for the two caches whose key space is a handful of entries,
# where the encoding is paid once and reused -- which is the only reason a
# seventeen-second quality setting is affordable at all. Measured on
# /api/infrastructure: gzip 1,479 KB in 0.33 s, brotli q11 897 KB in 16.8 s.

def test_a_client_that_cannot_take_brotli_is_never_sent_it():
    entry = (b'{"a":1}', '"tag"', b"pretend-brotli")
    out = app_mod._built_json_response(_req(), entry, "public, max-age=86400")
    assert out.body == b'{"a":1}'
    assert "content-encoding" not in {k.lower() for k in out.headers}


def test_a_client_that_can_take_brotli_gets_the_smaller_body():
    entry = (b'{"a":1}', '"tag"', b"pretend-brotli")
    out = app_mod._built_json_response(_req({"Accept-Encoding": "gzip, deflate, br"}),
                                       entry, "public, max-age=86400")
    assert out.body == b"pretend-brotli"
    assert out.headers["Content-Encoding"] == "br"


def test_an_entry_with_no_variant_yet_still_answers():
    """The first client for a cache entry, and every client on a deployment without
    the wheel. The identity bytes are always present, so this cannot fail to
    answer -- which is what lets the compression be optional."""
    entry = (b'{"a":1}', '"tag"')
    out = app_mod._built_json_response(_req({"Accept-Encoding": "br"}), entry,
                                       "public, max-age=86400")
    assert out.body == b'{"a":1}'
    assert "content-encoding" not in {k.lower() for k in out.headers}


def test_every_answer_varies_on_the_encoding():
    """Including the ones that did not themselves come back compressed, and that is
    the point: the *resource* varies by encoding, so a shared cache that saw only
    the identity answer must not hand it to a client that would have earned the
    brotli one."""
    for entry in [(b"{}", '"t"'), (b"{}", '"t"', b"br")]:
        for accept in [{}, {"Accept-Encoding": "br"}]:
            out = app_mod._built_json_response(_req(accept), entry, "no-cache")
            assert out.headers["Vary"] == "Accept-Encoding"


def test_a_304_carries_no_encoding_and_no_body():
    entry = (b'{"a":1}', '"tag"', b"pretend-brotli")
    out = app_mod._built_json_response(_req({"If-None-Match": '"tag"', "Accept-Encoding": "br"}),
                                       entry, "public, max-age=86400")
    assert out.status_code == 304
    assert out.body == b""
    assert "content-encoding" not in {k.lower() for k in out.headers}


def test_the_accept_header_is_read_case_insensitively():
    assert app_mod._brotli_supported(_req({"Accept-Encoding": "GZIP, BR"}))
    assert app_mod._brotli_supported(_req({"Accept-Encoding": "br"}))
    assert not app_mod._brotli_supported(_req({"Accept-Encoding": "gzip, deflate"}))
    assert not app_mod._brotli_supported(_req())


def test_the_quality_is_the_one_past_the_window_cliff():
    """Brotli's levels below 10 use a small sliding window and land within 1.5% of
    gzip on this data -- q9 measured 1,461 KB against gzip's 1,479 KB, for four times
    the CPU. The whole reason to run a second encoder is the window that opens at
    q10, so a level below it would be pure cost."""
    assert app_mod.BROTLI_QUALITY >= 10


def test_scheduling_outside_an_event_loop_is_survivable():
    """The handlers are called directly by several tests in this suite, with no loop
    running. That must not raise -- a compression that cannot be scheduled is a
    response that is merely larger."""
    app_mod._compress_in_background(app_mod._BUILT_PAYLOAD_CACHE, "nothing-here")


def test_the_high_cardinality_cache_is_left_on_gzip():
    """_FILTERED_CACHE is keyed by source, version, region, viewport cell and
    variant, so it turns over constantly and holds hundreds of entries. Compressing
    each at q11 would spend far more CPU than it ever saved bandwidth -- the
    amortisation that justifies it for the other two caches simply is not there."""
    import inspect
    source = inspect.getsource(app_mod._cached_source_response)
    assert "_compress_in_background" not in source
