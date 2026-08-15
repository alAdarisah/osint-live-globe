# Static Reference Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop re-downloading and re-parsing the reference layers that never move — railway linework, transmission lines, submarine cables, infrastructure sites, water bodies — so a returning reader pays a ~1 KB manifest instead of 4.7 MB of railways, while every line and pin stays as clickable as it is today.

**Architecture:** Three changes, each useful alone and each building on the last. First, reference documents get an ETag derived from their own bytes instead of from the process that served them, so a backend restart stops invalidating every reader's copy. Second, a tiny manifest lets the client answer "has this changed?" without asking for the document, and a persistent IndexedDB store keyed by content hash means an unchanged layer is read from disk with no network and no `JSON.parse` of a 20 MB string. Third, the line documents are sliced by the eleven conflict theatres they are already clipped to, so a reader looking at Ukraine downloads Ukraine.

**Tech Stack:** FastAPI + Starlette (backend), React 18 + Leaflet (frontend), Postgres `reference_snapshots` (storage), IndexedDB (client persistence), `node --test` and `pytest` (tests).

## Why not literally bake them into the map image

The instinct behind this task is right and worth stating, because it decides the design. A raster basemap tile is the cheapest possible way to carry geometry: it is fetched per viewport, it is immutable, and a browser or CDN caches it forever. The reason we cannot simply paint railways into the basemap is that a PNG has no properties — no `electrified`, no `operator`, no `gauge`, nothing to open a popup on. The moment the layer stops being clickable it stops being the thing this map is for.

What this plan does is take the three properties that make a tile cheap and apply them to data that stays clickable:

| Tile property | How this plan gets it |
|---|---|
| Immutable, cached forever | Content-hashed ETag + IndexedDB keyed by that hash (Tasks 1–4) |
| Only the visible piece is fetched | Theatre-sliced documents (Task 5) |
| Never re-parsed | Structured-clone read out of IndexedDB, not `JSON.parse` of the response (Task 3) |

A full MVT/PMTiles pyramid would get there too, and further. It is deliberately not this plan: it needs a tile generator (tippecanoe is a native binary, a real cost for a `docker-compose` stack), a vector-tile renderer on the Leaflet side, and a rebuild of every popup and style path that currently reads a plain record. Tasks 1–5 reach most of the same numbers with machinery this codebase already has. If railways is still the biggest thing on the wire after Task 5, the pyramid is the next task and this plan will have made it easier, not harder — the manifest and the store both survive it.

## What is actually being paid today

Measured against the running backend, from the code's own notes:

| Layer | Endpoint | Size | Fetched |
|---|---|---|---|
| Railways | `/api/railways` | **20.4 MB JSON / 4.7 MB wire** | once, lazily on toggle |
| Water (rivers) | `/api/water?kind=rivers` | 5.12 MB | on demand, bbox required |
| Water (lakes) | `/api/water?kind=lakes` | 3.19 MB | on demand |
| Water (marine) | `/api/water?kind=marine` | 1.19 MB | every boot |
| Cables + landings | `/api/cables` | ~1 MB | every boot |
| Infrastructure | `/api/infrastructure` | — | every boot |
| Power lines | `/api/power-lines` | — | every boot |
| Countries | `/api/countries` | — | **polled every 5 min** |
| Cities | `/api/cities` | — | **polled every 5 min** |

Three separate costs hide behind those numbers, and only one of them is bytes:

1. **Bytes.** Mitigated by `Cache-Control: public, max-age=86400` — until the ETag turns over.
2. **The ETag turning over.** `backend/app.py:54` mints `_PROCESS_TOKEN = uuid.uuid4().hex[:8]` per process, and `_cached_source_response` puts it in front of every ETag (`backend/app.py:522`). Every backend restart therefore invalidates every cached reference document for every reader, and the next revalidation after `max-age` lapses is a full re-download of bytes that did not change. This is the single largest avoidable cost in the list and Task 1 is ~40 lines.
3. **Parse and build.** `JSON.parse` of 20.4 MB on the main thread, then building Leaflet polylines for every line in eleven theatres, on **every session** — a warm HTTP cache does not help this at all. Only Tasks 3–5 touch it.

## Global Constraints

- Python 3.14, FastAPI/Starlette, `pytest`. Run backend tests with `python -m pytest backend/tests/ -q`.
- Frontend is dependency-free under test: `frontend/tests/*.test.js` run under `node --test` with nothing installed. **Any module a test imports must not import anything browser-shaped**, and must not use extensionless imports the bundler resolves (see `frontend/src/map/scene.js` for the pattern to follow, and note that `frontend/src/map/severity.js` is *not* testable for exactly this reason). Run with `cd frontend && npm test`.
- `cd frontend && npm run build` must stay clean.
- No new runtime dependencies, backend or frontend. IndexedDB is a platform API; `hashlib` and `json` are stdlib.
- Redis (`backend/cachestore.py`) and Postgres stay the system of record. Nothing in this plan becomes a second write path.
- A cache that can take the site down is worse than no cache: every new store degrades to "no opinion" on failure, the rule `cachestore.py` and `storage.py` already follow.
- `backend/tests/test_ais_health.py::test_the_ingest_process_actually_calls_it` fails on this branch before any of this work (a `ModuleNotFoundError` at `backend/ingest/__main__.py:18`). It is pre-existing and unrelated — do not chase it, and do not count it as a regression.

---

### Task 1: Content-hashed ETags for reference documents

Kill the process token for whole-document layers. Same bytes must mean the same ETag across restarts, redeploys, and two backends behind a load balancer.

**Files:**
- Create: `backend/refhash.py`
- Modify: `backend/app.py` (`_cached_source_response`, ~line 480–540)
- Test: `backend/tests/test_refhash.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `refhash.content_hash(name: str, version: int, payload) -> str` — a 16-character hex digest, memoised per `(name, version)`. `_cached_source_response(..., stable_etag: bool = False)` — when true, the ETag is built from the content hash instead of `_PROCESS_TOKEN`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_refhash.py`:

```python
"""Content hashes for the whole-document reference layers.

The bug this closes: backend/app.py mints a per-process token and puts it in
front of every ETag, so two backends -- or one backend either side of a
redeploy -- disagree about the identity of bytes that never changed. Every
reader's cached copy of a 4.7 MB railways document is invalidated by a restart
that touched nothing.

A hash of the payload has the property the token was standing in for (a new
version is a new ETag) without the property that made it expensive (a new
*process* is a new ETag).
"""

from backend import refhash


def test_the_same_payload_hashes_the_same_across_processes():
    """The whole point. A restart re-enters at version 0 or version 7 with the
    same document, and a reader holding that document must be told so."""
    payload = {"lines": [{"source": "ne", "path": [[1.0, 2.0]]}]}
    assert refhash.content_hash("railways", 3, payload) == refhash.content_hash("railways", 3, payload)


def test_a_changed_payload_hashes_differently():
    a = {"lines": [{"source": "ne", "path": [[1.0, 2.0]]}]}
    b = {"lines": [{"source": "ne", "path": [[1.0, 2.5]]}]}
    refhash.reset()
    first = refhash.content_hash("railways", 1, a)
    refhash.reset()
    second = refhash.content_hash("railways", 1, b)
    assert first != second


def test_key_order_does_not_change_the_hash():
    """dict ordering is an artefact of how a document was built, not a fact
    about it -- and a source that starts emitting its keys in a different order
    must not invalidate every reader's copy."""
    refhash.reset()
    first = refhash.content_hash("cables", 1, {"a": 1, "b": 2})
    refhash.reset()
    second = refhash.content_hash("cables", 1, {"b": 2, "a": 1})
    assert first == second


def test_a_version_is_hashed_once_and_then_remembered(monkeypatch):
    """Railways is 20.4 MB. Re-hashing it per request would cost more than the
    ETag saves, so the digest is memoised against the version counter the
    poller already bumps (see backend/cache.py's SourceState.data setter).

    Counted by wrapping json.dumps rather than by instrumenting the payload:
    an earlier draft of this test used a dict subclass overriding __iter__,
    which json.dumps' C encoder does not reliably route through -- so it would
    have passed whether or not the memo worked, which is worse than no test."""
    refhash.reset()
    calls = []
    real_dumps = refhash.json.dumps

    def counting_dumps(*args, **kwargs):
        calls.append(1)
        return real_dumps(*args, **kwargs)

    monkeypatch.setattr(refhash.json, "dumps", counting_dumps)

    payload = {"lines": []}
    refhash.content_hash("railways", 5, payload)
    assert len(calls) == 1, "the first call should serialise exactly once"
    refhash.content_hash("railways", 5, payload)
    assert len(calls) == 1, "the second call re-serialised a payload it had already hashed"


def test_a_new_version_rehashes():
    refhash.reset()
    payload = {"lines": []}
    first = refhash.content_hash("railways", 1, payload)
    second = refhash.content_hash("railways", 2, {"lines": [{"source": "ne", "path": []}]})
    assert first != second


def test_an_unserialisable_payload_falls_back_rather_than_raising():
    """A reference document that cannot be hashed is a caching problem, not a
    serving problem. Same rule cachestore.py applies to Redis: degrade to no
    opinion, never take the endpoint down."""
    refhash.reset()
    digest = refhash.content_hash("odd", 1, {"when": object()})
    assert digest is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_refhash.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'backend.refhash'`

- [ ] **Step 3: Write the implementation**

Create `backend/refhash.py`:

```python
"""Content hashes for the whole-document reference layers.

backend/app.py's ETags lead with `_PROCESS_TOKEN`, a uuid minted at import.
That is correct but blunt: `state.version` restarts at 0 in a new process, so
without something process-scoped in front of it, version 3 in one process and
version 3 in another would claim to be the same bytes when they need not be.

The cost is that it is *also* true in the other direction, and that direction
is the expensive one. A redeploy that changed nothing about the railways
document still mints a new token, so every reader's cached 4.7 MB copy is
invalidated by a restart that touched no data at all.

A hash of the payload answers the same question properly: same bytes, same
ETag, whoever is serving and whenever. Memoised against the version counter
the pollers already bump (see backend/cache.py's SourceState.data setter), so
a 20 MB document is serialised once per refresh rather than once per request.
"""

import hashlib
import json
import logging

log = logging.getLogger("osint-globe.refhash")

# name -> (version, digest). Bounded by the number of reference layers, which
# is a handful and fixed at import -- not a cache that needs an eviction rule.
_digests: dict[str, tuple[int, str | None]] = {}


def reset() -> None:
    """Forget every memoised digest. For tests."""
    _digests.clear()


def content_hash(name: str, version: int, payload) -> str | None:
    """A short stable digest of `payload`, or None if it cannot be hashed.

    None means "no opinion" and callers must treat it as such -- fall back to
    the process-token ETag rather than serving an unconditional 200 or, worse,
    an ETag that does not vary. Same degradation rule backend/cachestore.py
    applies to a Redis that is down: a caching layer that can take the site
    down is worse than no caching layer.
    """
    cached = _digests.get(name)
    if cached is not None and cached[0] == version:
        return cached[1]
    try:
        # sort_keys because dict ordering is an artefact of how a document was
        # assembled rather than a fact about it, and a source that starts
        # emitting keys in a different order must not invalidate every reader's
        # copy. separators drops the whitespace json.dumps would otherwise put
        # in a 20 MB serialisation nobody reads.
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()
    except (TypeError, ValueError) as exc:
        log.warning("Could not hash the %s document, falling back to the process ETag: %s", name, exc)
        _digests[name] = (version, None)
        return None
    # 16 hex characters is 64 bits. An ETag only has to distinguish the
    # versions of one document from each other, and a collision there would
    # need two different revisions of the same layer to agree in 64 bits.
    digest = hashlib.sha256(raw).hexdigest()[:16]
    _digests[name] = (version, digest)
    return digest
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_refhash.py -q`
Expected: PASS, 6 passed

- [ ] **Step 5: Measure the hash cost before wiring it in**

This is a real step, not a formality: it decides whether the digest can be computed on the request path or has to move to a thread. Railways is the worst case at 20.4 MB.

```bash
python -c "
import json, time, hashlib
doc = {'lines': [{'source': 'ne', 'path': [[i*1e-4, i*1e-4]]*40} for i in range(120000)]}
t = time.perf_counter()
raw = json.dumps(doc, sort_keys=True, separators=(',', ':')).encode()
mid = time.perf_counter()
hashlib.sha256(raw).hexdigest()
end = time.perf_counter()
print(f'{len(raw)/1e6:.1f} MB  serialise {(mid-t)*1000:.0f} ms  sha256 {(end-mid)*1000:.0f} ms')
"
```

Record the number in the commit message. If the total exceeds ~250 ms, stop and convert `_cached_source_response` to compute the digest under `asyncio.to_thread` before continuing — a synchronous stall that long on the event loop would delay every other request, and this fires once per refresh per layer.

- [ ] **Step 6: Wire it into `_cached_source_response`**

In `backend/app.py`, add the import beside the existing ones:

```python
from backend import refhash
```

Then change the signature and the ETag line. The current signature ends `variant: str | None = None,` — add one parameter:

```python
def _cached_source_response(
    request: Request,
    source_name: str,
    region: str | None,
    filter_fn,
    max_age: int | None = None,
    bbox: str | None = None,
    variant: str | None = None,
    stable_etag: bool = False,
):
```

Replace the ETag construction (currently `etag = f'"{_PROCESS_TOKEN}:{state.version}:...'`) with:

```python
    # A whole-document reference layer identifies itself by its own bytes
    # rather than by the process serving them -- see backend/refhash.py. The
    # process token stays for everything else, and stays here too whenever the
    # hash comes back None, because an ETag that cannot distinguish two
    # documents is worse than one that is merely pessimistic.
    identity = f"{_PROCESS_TOKEN}:{state.version}"
    if stable_etag:
        digest = refhash.content_hash(source_name, state.version, state.data)
        if digest is not None:
            identity = digest
    etag = f'"{identity}:{region or "world"}:{box_key}:{variant_key}"'
```

- [ ] **Step 7: Opt the reference endpoints in**

Add `stable_etag=True` to each of these calls in `backend/app.py`. Leave every other caller alone — a live layer's ETag has no reason to survive a restart, and hashing FIRMS' 175k points per refresh would cost more than it saves.

- `railways_endpoint` (~line 933)
- `power_lines_endpoint` (~line 940)
- `cables` (~line 671)
- `railways stations` (~line 885, `rail_stations`)
- `countries` (~line 981)
- `cities` (~line 986)
- `airports` (~line 995)
- `osm_infra` (~line 620)

Example — the railways one becomes:

```python
    return _cached_source_response(
        request, "railways", None, lambda data, _bounds: data,
        max_age=86400, stable_etag=True,
    )
```

- [ ] **Step 8: Write the endpoint-level test**

Append to `backend/tests/test_refhash.py`:

```python
import asyncio

from backend import app as app_mod
from backend.cache import registry


def _run(coro):
    return asyncio.run(coro)


class _Req:
    def __init__(self, if_none_match=None):
        self.headers = {"if-none-match": if_none_match} if if_none_match else {}


def test_the_railways_etag_survives_a_process_restart(monkeypatch):
    """The bug, end to end. Two processes hold the same document; the second
    must hand a reader who already has it a 304, not 4.7 MB."""
    refhash.reset()
    state = registry.ensure("railways", key_configured=True)
    state.data = {"lines": [{"source": "ne", "path": [[1.0, 2.0]]}]}

    monkeypatch.setattr(app_mod, "_PROCESS_TOKEN", "aaaaaaaa")
    app_mod._FILTERED_CACHE.clear()
    first = _run(app_mod.railways_endpoint(_Req()))
    etag = first.headers["etag"]

    # A different process, same document.
    monkeypatch.setattr(app_mod, "_PROCESS_TOKEN", "bbbbbbbb")
    app_mod._FILTERED_CACHE.clear()
    second = _run(app_mod.railways_endpoint(_Req(if_none_match=etag)))

    assert second.status_code == 304, "a restart re-sent a document that had not changed"
```

- [ ] **Step 9: Run the tests**

Run: `python -m pytest backend/tests/test_refhash.py backend/tests/test_cables.py backend/tests/test_countries.py backend/tests/test_cities.py backend/tests/test_airports.py -q`
Expected: PASS. If `_FILTERED_CACHE.clear()` does not exist on `LruTtlCache`, use `app_mod._FILTERED_CACHE = LruTtlCache(maxsize=256, ttl=300)` instead, importing `LruTtlCache` from `backend.ratelimit`.

- [ ] **Step 10: Run the full backend suite**

Run: `python -m pytest backend/tests/ -q`
Expected: 1 failure, and it is `test_ais_health.py::test_the_ingest_process_actually_calls_it` — the pre-existing one named in Global Constraints. Anything else is a regression.

- [ ] **Step 11: Commit**

```bash
git add backend/refhash.py backend/tests/test_refhash.py backend/app.py
git commit -m "Let a document that has not changed say so, even after a restart"
```

---

### Task 2: The reference manifest

One small endpoint that answers "which of these have changed?" without serving any of them. This is what lets the client skip the request entirely rather than merely skip the body.

**Files:**
- Modify: `backend/app.py` (new endpoint, place beside `/api/regions` ~line 380)
- Test: `backend/tests/test_reference_manifest.py`

**Interfaces:**
- Consumes: `refhash.content_hash` from Task 1.
- Produces: `GET /api/reference-manifest` → `{"layers": {<key>: {"hash": str, "url": str, "version": int}}}`. Keys are exactly: `railways`, `powerLines`, `cables`, `infrastructure`, `waterMarine`. The key is the client-side layer name, not the source name, because that is what the frontend stores against.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_reference_manifest.py`:

```python
"""/api/reference-manifest: which of the never-moving layers have moved.

The client asks this once at boot -- it is a few hundred bytes -- and then
asks for a document only if the hash it holds no longer matches. That is the
whole saving: not a smaller railways payload, but no railways request at all
on a session where nothing changed.
"""

import asyncio
import json

from backend import app as app_mod, refhash
from backend.cache import registry


def _run(coro):
    return asyncio.run(coro)


def _body(response):
    return json.loads(response.body)


def test_it_names_every_layer_the_client_persists():
    """A layer missing here is a layer that silently falls back to fetching on
    every boot, with nothing anywhere reporting that it did."""
    refhash.reset()
    for name in ("railways", "power_lines", "cables", "infrastructure", "water_marine"):
        state = registry.ensure(name, key_configured=True)
        state.data = {"lines": []}

    body = _body(_run(app_mod.reference_manifest()))

    assert set(body["layers"]) == {"railways", "powerLines", "cables", "infrastructure", "waterMarine"}


def test_each_entry_carries_a_hash_and_the_url_to_fetch_it_from():
    refhash.reset()
    state = registry.ensure("railways", key_configured=True)
    state.data = {"lines": [{"source": "ne", "path": [[1.0, 2.0]]}]}

    entry = _body(_run(app_mod.reference_manifest()))["layers"]["railways"]

    assert entry["url"] == "/api/railways"
    assert isinstance(entry["hash"], str) and len(entry["hash"]) == 16


def test_a_layer_that_has_never_polled_reports_a_null_hash():
    """Not an error and not an omission. version 0 means the placeholder, and
    a client that cached a null hash would cache the empty document -- so the
    null is what tells it to fetch and not to store."""
    refhash.reset()
    state = registry.ensure("power_lines", key_configured=True)
    state.version = 0
    body = _body(_run(app_mod.reference_manifest()))
    assert body["layers"]["powerLines"]["hash"] is None


def test_the_manifest_is_small_enough_to_be_free():
    """It is fetched on every boot, so its own size is the floor under what
    this whole mechanism can save. A few hundred bytes against 4.7 MB."""
    refhash.reset()
    for name in ("railways", "power_lines", "cables", "infrastructure", "water_marine"):
        state = registry.ensure(name, key_configured=True)
        state.data = {"lines": [{"source": "ne", "path": [[1.0, 2.0]]}]}
    response = _run(app_mod.reference_manifest())
    assert len(response.body) < 1024
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_reference_manifest.py -q`
Expected: FAIL with `AttributeError: module 'backend.app' has no attribute 'reference_manifest'`

- [ ] **Step 3: Write the implementation**

In `backend/app.py`, beside the `/api/regions` endpoint:

```python
# The whole-document layers a client is expected to keep on disk between
# sessions, as {client layer key: (source name, url)}. The client key rather
# than the source name is what a reader's IndexedDB is keyed on, so this table
# is the one place the two vocabularies meet.
#
# Membership is a claim: a layer here promises it is worth persisting, which
# means it changes on a scale of days at least. Nothing polled faster than its
# own readers belongs in it -- see the note on POLL_CONFIG in
# frontend/src/hooks/useOsintData.js for which those are.
_REFERENCE_LAYERS = {
    "railways": ("railways", "/api/railways"),
    "powerLines": ("power_lines", "/api/power-lines"),
    "cables": ("cables", "/api/cables"),
    "infrastructure": ("infrastructure", "/api/infrastructure"),
    "waterMarine": ("water_marine", "/api/water?kind=marine"),
}


@app.get("/api/reference-manifest")
async def reference_manifest():
    """What the never-moving layers currently hash to.

    Fetched at boot, before any of the documents themselves. A client holding a
    matching hash skips the request entirely rather than skipping the body,
    which is the difference between a 304 round trip per layer and none.

    `no-cache` rather than a max-age: this is the thing that decides whether
    everything else is fresh, and a browser sitting on a cached copy of it
    would pin a reader to a stale railways document for the length of the
    max-age. It is a few hundred bytes; the round trip is the point.
    """
    layers = {}
    for key, (source_name, url) in _REFERENCE_LAYERS.items():
        if not registry.has(source_name):
            layers[key] = {"hash": None, "url": url, "version": 0}
            continue
        state = registry.get(source_name)
        # version 0 is the placeholder a source is constructed with, not a
        # document -- see _cached_source_response's own note on why it refuses
        # to hand out a long cache before the first real poll.
        digest = refhash.content_hash(source_name, state.version, state.data) if state.version else None
        layers[key] = {"hash": digest, "url": url, "version": state.version}
    return JSONResponse({"layers": layers}, headers={"Cache-Control": "no-cache"})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_reference_manifest.py -q`
Expected: PASS, 4 passed

- [ ] **Step 5: Commit**

```bash
git add backend/app.py backend/tests/test_reference_manifest.py
git commit -m "Let a reader ask what has changed without asking for all of it"
```

---

### Task 3: The client-side document store

IndexedDB, keyed by content hash. This is the task that kills the `JSON.parse`, so keep the pure decision logic in its own testable module — `node --test` has no IndexedDB, and a store whose *policy* is only exercised in a browser is a store whose policy is not tested.

**Files:**
- Create: `frontend/src/data/refPolicy.js` (pure, testable)
- Create: `frontend/src/data/refStore.js` (IndexedDB wrapper, thin)
- Test: `frontend/tests/refPolicy.test.js`

**Interfaces:**
- Consumes: the manifest shape from Task 2.
- Produces:
  - `decideFetch(layerKey, manifest, cachedHash) -> {action: "reuse"|"fetch"|"fetch-nostore", url: string|null, hash: string|null}`
  - `openStore() -> Promise<IDBDatabase|null>` (null when IndexedDB is unavailable — private mode, quota refusal, an old browser)
  - `readHash(db, layerKey) -> Promise<string|null>` — one small read, used by Task 4 to build the plan before touching any document
  - `readDocument(db, layerKey, hash) -> Promise<object|null>`
  - `writeDocument(db, layerKey, hash, doc) -> Promise<void>` (never rejects)

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/refPolicy.test.js`:

```js
// What the reference store decides, asserted.
//
// The decision is kept apart from IndexedDB on purpose. `node --test` has no
// IDB, so policy living inside the store wrapper would be policy nothing ever
// checks -- and the expensive mistakes here are all policy: reusing a document
// whose hash moved (a reader sees last week's linework and cannot tell), or
// storing a document the backend has not really polled yet (a reader pins the
// empty placeholder and the layer stays blank until the hash changes).

import test from "node:test";
import assert from "node:assert/strict";

import { decideFetch } from "../src/data/refPolicy.js";

const MANIFEST = {
  layers: {
    railways: { hash: "abc123def4567890", url: "/api/railways", version: 7 },
    powerLines: { hash: null, url: "/api/power-lines", version: 0 },
  },
};

test("the reference fetch decision", async (t) => {
  await t.test("reuses a stored document when the hash still matches", () => {
    // The whole point: no request, no parse, no 304 round trip.
    assert.deepEqual(decideFetch("railways", MANIFEST, "abc123def4567890"), {
      action: "reuse", url: null, hash: "abc123def4567890",
    });
  });

  await t.test("fetches when the hash has moved", () => {
    assert.deepEqual(decideFetch("railways", MANIFEST, "0000000000000000"), {
      action: "fetch", url: "/api/railways", hash: "abc123def4567890",
    });
  });

  await t.test("fetches when nothing is stored yet", () => {
    assert.deepEqual(decideFetch("railways", MANIFEST, null), {
      action: "fetch", url: "/api/railways", hash: "abc123def4567890",
    });
  });

  await t.test("fetches but does not store a layer the backend has not polled", () => {
    // hash null means version 0, the placeholder a source is constructed with.
    // Storing that would pin an empty document under a hash that will not
    // change until the first real poll -- so the layer would stay blank for
    // the reader who happened to boot during startup, and only for them.
    assert.deepEqual(decideFetch("powerLines", MANIFEST, null), {
      action: "fetch-nostore", url: "/api/power-lines", hash: null,
    });
  });

  await t.test("fetches without storing when the manifest itself is missing", () => {
    // A backend too old to serve the manifest, or one that failed to. The
    // layer must still load -- degrading to today's behaviour is the whole
    // safety property here.
    assert.deepEqual(decideFetch("railways", null, "abc123def4567890"), {
      action: "fetch-nostore", url: null, hash: null,
    });
    assert.deepEqual(decideFetch("railways", { layers: {} }, "abc123def4567890"), {
      action: "fetch-nostore", url: null, hash: null,
    });
  });

  await t.test("never reuses on a hash of the wrong shape", () => {
    // Defensive rather than theoretical: a truncated or half-written IDB entry
    // is the one way a reader silently gets geometry that is not what the
    // backend has, and it is cheap to refuse.
    for (const bad of ["", "abc", null, undefined, 12345]) {
      assert.equal(
        decideFetch("railways", MANIFEST, bad).action,
        "fetch",
        `a stored hash of ${JSON.stringify(bad)} should not be reused`
      );
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test`
Expected: FAIL with `Cannot find module '.../src/data/refPolicy.js'`

- [ ] **Step 3: Write `refPolicy.js`**

Create `frontend/src/data/refPolicy.js`:

```js
// Whether a reference layer needs fetching at all.
//
// Deliberately dependency-free and deliberately not inside refStore.js: the
// store is IndexedDB plumbing that `node --test` cannot exercise, and every
// mistake worth catching here is a decision rather than a database call.
// Same discipline map/scene.js follows for the same reason.

/** A digest as backend/refhash.py mints them: 16 hex characters. */
function isHash(value) {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
}

/**
 * What to do about `layerKey`, given the manifest and what is on disk.
 *
 *   reuse          the stored copy is current -- no request, no parse
 *   fetch          get it and store it under the manifest's hash
 *   fetch-nostore  get it, draw it, and store nothing
 *
 * The third is not a failure mode, it is the honest answer in two cases: a
 * backend with no manifest (older, or one that errored), and a layer whose
 * poller has not run yet. Both must still put geometry on the map -- degrading
 * to exactly today's behaviour is the property that makes this safe to ship.
 */
export function decideFetch(layerKey, manifest, cachedHash) {
  const entry = manifest?.layers?.[layerKey];
  if (!entry || !entry.url) {
    return { action: "fetch-nostore", url: null, hash: null };
  }
  if (!isHash(entry.hash)) {
    // The backend is serving this layer but has not polled it yet.
    return { action: "fetch-nostore", url: entry.url, hash: null };
  }
  if (isHash(cachedHash) && cachedHash === entry.hash) {
    return { action: "reuse", url: null, hash: entry.hash };
  }
  return { action: "fetch", url: entry.url, hash: entry.hash };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test`
Expected: PASS, 6 new subtests under "the reference fetch decision"

- [ ] **Step 5: Write `refStore.js`**

Create `frontend/src/data/refStore.js`:

```js
// The reference documents, kept on the reader's disk between sessions.
//
// What this saves is not bytes -- Cache-Control already saves most of those --
// it is the JSON.parse. Railways is 20.4 MB of JSON, and a warm HTTP cache
// still hands the browser a 4.7 MB compressed body to inflate and parse on the
// main thread on every single session. Read back out of IndexedDB it arrives
// as a structured clone: no parse, off the critical path, and no request.
//
// **Every function here degrades to "no opinion".** A browser in private mode,
// a reader who refused the quota, a half-written entry -- each one returns null
// or resolves to nothing, and the caller falls back to fetching exactly as it
// does today. Same rule backend/cachestore.py applies to Redis: a caching layer
// that can take the map down is worse than no caching layer.

const DB_NAME = "osint-reference";
const DB_VERSION = 1;
const STORE = "documents";

/**
 * Open the database, or resolve null if this browser will not give us one.
 *
 * Never rejects. The failure cases are ordinary (private browsing, a storage
 * policy, a quota refusal) and none of them are worth a console error on a map
 * that works fine without this.
 */
export function openStore() {
  return new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve) => {
    let request;
    try {
      request = fn(db.transaction(STORE, mode).objectStore(STORE));
    } catch {
      resolve(null);
      return;
    }
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => resolve(null);
  });
}

/** What hash is stored for this layer, or null. One small read, no document. */
export async function readHash(db, layerKey) {
  if (!db) return null;
  const entry = await tx(db, "readonly", (store) => store.get(`${layerKey}:hash`));
  return typeof entry === "string" ? entry : null;
}

/**
 * The stored document, but only if it was stored under `hash`.
 *
 * The hash check is not belt-and-braces -- it is what makes a half-written
 * entry harmless. The document and its hash are two records, and a tab killed
 * between the two writes leaves them disagreeing; serving that document would
 * draw geometry the backend does not have, which is the one failure this store
 * must not have.
 */
export async function readDocument(db, layerKey, hash) {
  if (!db || !hash) return null;
  const stored = await readHash(db, layerKey);
  if (stored !== hash) return null;
  return tx(db, "readonly", (store) => store.get(`${layerKey}:doc`));
}

/**
 * Store a document and the hash it was fetched under.
 *
 * Document first, hash second, and the order is the durability argument: a tab
 * killed between them leaves a document nobody will read (readDocument checks
 * the hash) rather than a hash promising a document that is not there.
 */
export async function writeDocument(db, layerKey, hash, doc) {
  if (!db || !hash || doc == null) return;
  await tx(db, "readwrite", (store) => store.put(doc, `${layerKey}:doc`));
  await tx(db, "readwrite", (store) => store.put(hash, `${layerKey}:hash`));
}
```

- [ ] **Step 6: Verify the build**

Run: `cd frontend && npm run build`
Expected: `✓ built` with no new warnings.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/data/refPolicy.js frontend/src/data/refStore.js frontend/tests/refPolicy.test.js
git commit -m "Keep the linework a reader already downloaded, and the parse with it"
```

---

### Task 4: Wire the boot fetches through the store

**Files:**
- Modify: `frontend/src/hooks/useOsintData.js` (~lines 745–860, the boot-fetch block)
- Test: `frontend/tests/refPolicy.test.js` (extend)

**Interfaces:**
- Consumes: `decideFetch` (Task 3), `openStore`/`readHash`/`readDocument`/`writeDocument` (Task 3), `/api/reference-manifest` (Task 2).
- Produces:
  - `planReferenceLoad(manifest, stored) -> {reuse: string[], fetch: {layerKey, url, hash, store}[]}` in `refPolicy.js` — pure, and the part this task tests.
  - `loadReferenceLayers(deliver) -> Promise<Set<string>>` inside `useOsintData.js` — the IndexedDB-and-network half, verified in the browser at Step 6 rather than unit-tested, because `node --test` has no IndexedDB.
  - `deliverReferenceLayer(layerKey, data)` inside `useOsintData.js` — maps a manifest key onto the existing raw-slot delivery calls.

- [ ] **Step 1: Write the failing test**

Append to `frontend/tests/refPolicy.test.js`:

```js
import { planReferenceLoad } from "../src/data/refPolicy.js";

test("planning a whole boot", async (t) => {
  await t.test("asks the network only for what moved", () => {
    const manifest = {
      layers: {
        railways: { hash: "aaaaaaaaaaaaaaaa", url: "/api/railways", version: 3 },
        cables: { hash: "bbbbbbbbbbbbbbbb", url: "/api/cables", version: 9 },
      },
    };
    const stored = { railways: "aaaaaaaaaaaaaaaa", cables: "cccccccccccccccc" };

    const plan = planReferenceLoad(manifest, stored);

    assert.deepEqual(plan.reuse, ["railways"]);
    assert.deepEqual(plan.fetch.map((p) => p.layerKey), ["cables"]);
  });

  await t.test("plans every layer even when none are stored", () => {
    const manifest = {
      layers: {
        railways: { hash: "aaaaaaaaaaaaaaaa", url: "/api/railways", version: 3 },
        cables: { hash: "bbbbbbbbbbbbbbbb", url: "/api/cables", version: 9 },
      },
    };
    const plan = planReferenceLoad(manifest, {});
    assert.deepEqual(plan.reuse, []);
    assert.equal(plan.fetch.length, 2);
    assert.ok(plan.fetch.every((p) => p.store === true));
  });

  await t.test("a missing manifest plans nothing, so the caller keeps its own path", () => {
    // Not "plans everything": the boot fetches already work. This function
    // opting out is what makes the whole mechanism additive.
    const plan = planReferenceLoad(null, {});
    assert.deepEqual(plan, { reuse: [], fetch: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test`
Expected: FAIL with `The requested module '../src/data/refPolicy.js' does not provide an export named 'planReferenceLoad'`

- [ ] **Step 3: Add `planReferenceLoad` to `refPolicy.js`**

```js
/**
 * One boot's worth of decisions, from the manifest and what is on disk.
 *
 * `stored` is {layerKey: hash} -- read in one pass before this is called, so
 * the plan is a pure function of two documents and can be asserted without a
 * database.
 *
 * A missing manifest plans *nothing* rather than planning everything, and that
 * asymmetry is deliberate: the boot fetches in useOsintData.js already work,
 * so an empty plan leaves them exactly as they are. This mechanism can only
 * ever remove work, never become the thing that has to succeed.
 */
export function planReferenceLoad(manifest, stored = {}) {
  const plan = { reuse: [], fetch: [] };
  const layers = manifest?.layers;
  if (!layers) return plan;
  for (const layerKey of Object.keys(layers)) {
    const decision = decideFetch(layerKey, manifest, stored[layerKey] ?? null);
    if (decision.action === "reuse") {
      plan.reuse.push(layerKey);
    } else if (decision.url) {
      plan.fetch.push({
        layerKey,
        url: decision.url,
        hash: decision.hash,
        store: decision.action === "fetch",
      });
    }
  }
  return plan;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test`
Expected: PASS

- [ ] **Step 5: Wire it into the boot block**

In `frontend/src/hooks/useOsintData.js`, add the imports:

```js
import { planReferenceLoad } from "../data/refPolicy";
import { openStore, readHash, readDocument, writeDocument } from "../data/refStore";
```

Add this, and call it at the top of the same effect that currently runs the `fetchJson("/api/cables")` / `/api/power-lines` / `/api/water?kind=marine` / `/api/infrastructure` boot fetches. It returns the set of layers it handled, so those existing fetches can skip the ones it served:

```js
  /**
   * Load the never-moving layers from disk where possible.
   *
   * Returns the set of layer keys it delivered. Anything not in that set is
   * still the caller's problem, which is what lets this be added in front of
   * the existing boot fetches rather than replacing them: a browser with no
   * IndexedDB, or a backend with no manifest, hands back an empty set and
   * every fetch below runs exactly as it does today.
   */
  async function loadReferenceLayers(deliver) {
    let manifest = null;
    try {
      manifest = await fetchJson("/api/reference-manifest");
    } catch {
      return new Set(); // an older backend; the boot fetches below cover it
    }
    const db = await openStore();
    const stored = {};
    if (db) {
      for (const layerKey of Object.keys(manifest?.layers || {})) {
        stored[layerKey] = await readHash(db, layerKey);
      }
    }
    const plan = planReferenceLoad(manifest, stored);
    const handled = new Set();

    for (const layerKey of plan.reuse) {
      const doc = await readDocument(db, layerKey, stored[layerKey]);
      // A hash that matched but a document that did not come back is a
      // half-written entry (see refStore.readDocument). Leave it unhandled and
      // let the ordinary fetch below have it.
      if (doc == null) continue;
      deliver(layerKey, doc);
      handled.add(layerKey);
    }

    for (const { layerKey, url, hash, store } of plan.fetch) {
      try {
        const doc = await fetchJson(url);
        deliver(layerKey, doc);
        handled.add(layerKey);
        if (store && db) await writeDocument(db, layerKey, hash, doc);
      } catch (err) {
        // Unhandled on purpose -- the boot fetch below is the retry.
        console.warn(`Reference layer ${layerKey} did not load from ${url}:`, err);
      }
    }
    return handled;
  }
```

Then guard each existing boot fetch on the result, moving it inside the `.then` rather than editing its body. The point is that the existing `fetchJson(...).then(...).catch(...)` chains are **not modified at all** — each is only wrapped, so a layer this task fails to serve still loads exactly as it does today. For cables:

```js
    // Wraps the four existing boot fetches -- cables, power lines, marine
    // water, infrastructure -- without changing any of them. `handled` names
    // the layers already delivered from disk or by the manifest-driven fetch
    // above; everything else falls through to the code that was always here.
    loadReferenceLayers(deliverReferenceLayer).then((handled) => {
      if (cancelled) return;

      if (!handled.has("cables")) {
        // The existing chain, moved inside this guard and otherwise untouched:
        // fetchJson("/api/cables").then(...).catch(...) exactly as written at
        // useOsintData.js:753 before this task.
        fetchJson("/api/cables")
          .then((data) => {
            if (cancelled) return;
            publishFetchOutcome(
              recordCoverageRef.current, onDataRef.current, "cableLandings",
              { status: "fetched", fetchedAt: Date.now(), bbox: null, scoped: false },
              [["cables", data?.cables || []], ["cableLandings", data?.landings || []]]
            );
          })
          .catch((err) => console.warn("Failed to load submarine cables:", err));
      }

      // …and the same `if (!handled.has(<key>))` guard around each of the
      // /api/power-lines, /api/water?kind=marine and /api/infrastructure
      // chains, with their bodies copied across unchanged.
    });
```

`deliverReferenceLayer` maps a manifest key onto the existing `onDataRef.current` calls, so the delivery shape is identical whichever path served it:

```js
  // One place the manifest's layer keys meet the raw-slot names the map reads,
  // so a document served from disk is indistinguishable from one just fetched.
  // cables and infrastructure each split one payload into two slots -- exactly
  // as their own boot fetches already do -- which is why this is a table of
  // functions rather than a rename.
  function deliverReferenceLayer(layerKey, data) {
    const onData = onDataRef.current;
    if (layerKey === "railways") return onData("railways", data || { lines: [] });
    if (layerKey === "powerLines") return onData("powerLines", data || { lines: [] });
    if (layerKey === "waterMarine") {
      return onData("water", data || { type: "FeatureCollection", features: [] });
    }
    if (layerKey === "cables") {
      return publishFetchOutcome(
        recordCoverageRef.current, onData, "cableLandings",
        { status: "fetched", fetchedAt: Date.now(), bbox: null, scoped: false },
        [["cables", data?.cables || []], ["cableLandings", data?.landings || []]]
      );
    }
    if (layerKey === "infrastructure") {
      const sites = Array.isArray(data) ? data : (data?.sites || []);
      return publishFetchOutcome(
        recordCoverageRef.current, onData, "infra",
        { status: "fetched", fetchedAt: Date.now(), bbox: null, scoped: false },
        [["infra", sites], ["pipelines", data?.pipelines || []]]
      );
    }
  }
```

**Note on railways:** it is `FETCH_MANUAL` and loaded through the `ONE_SHOT` table, not at boot. Leave that as it is — instead, have `fetchOneShotRef.current("railways")` consult the store first, by calling `loadReferenceLayers` filtered to that one key. Do not move railways to boot: lazy-on-toggle is a bigger saving than caching, and this task must not undo it.

- [ ] **Step 6: Verify in the browser**

```bash
cd frontend && npm run build
```

Then start the preview and check the real behaviour — this is the first task whose win is invisible to both test suites:

1. `preview_start` the `frontend-dev` config.
2. Load the map, open the railways toggle, wait for it to draw.
3. Reload. In the network panel, `/api/reference-manifest` should be the only reference request; `/api/railways` should not appear at all.
4. Confirm a railway line still opens a popup naming its source (`ne` or `osm`) and, for OSM lines, its operator and electrification.
5. `read_console_messages` — no errors.

Record the before/after transferred-bytes figure for the reload in the commit message.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/data/refPolicy.js frontend/src/hooks/useOsintData.js frontend/tests/refPolicy.test.js
git commit -m "Read the unchanging layers off disk instead of off the network"
```

---

### Task 5: Serve line documents by theatre

Everything above stops a reader paying *twice*. This stops them paying for ten theatres to look at one.

**Files:**
- Modify: `backend/regions.py` (add `filter_lines`)
- Modify: `backend/app.py` (`railways_endpoint`, `power_lines_endpoint`)
- Test: `backend/tests/test_region_lines.py`

**Interfaces:**
- Consumes: `regions.bounds_for`, `regions.parse_bbox`, `regions.intersect` (all existing).
- Produces: `regions.filter_lines(doc: dict, bounds) -> dict` — a `{lines: [...], ...}` document with `lines` clipped to `bounds`, every other key carried through unchanged.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_region_lines.py`:

```python
"""Clipping a line document to a theatre.

Railways is 20.4 MB because it holds all eleven conflict theatres at once, and
a reader is looking at one. This is the filter that lets the endpoint answer
`?region=russia_ukraine` with Ukraine's linework instead of the world's.

A line is not a point, which is the whole reason regions.filter_points cannot
do this: a line is in view if *any* of it is, and clipping to the vertices
inside the box would cut every run at the border and leave the map looking like
the track stops there.
"""

from backend import regions

DOC = {
    "provenance": "Natural Earth 1:10m + OpenStreetMap",
    "truncated_regions": ["sudan"],
    "lines": [
        {"source": "ne", "path": [[50.0, 30.0], [50.1, 30.1]]},          # Ukraine
        {"source": "osm", "path": [[24.0, 54.0], [24.1, 54.1]],           # Persian Gulf
         "name": "Etihad Rail", "electrified": "no"},
        {"source": "ne", "path": [[35.0, 139.0]]},                        # Japan, no theatre
    ],
}


def test_a_bounds_of_none_is_the_whole_document():
    assert regions.filter_lines(DOC, None) == DOC


def test_only_the_lines_touching_the_box_survive():
    ukraine = regions.bounds_for("russia_ukraine")
    out = regions.filter_lines(DOC, ukraine)
    assert [line["source"] for line in out["lines"]] == ["ne"]
    assert out["lines"][0]["path"] == [[50.0, 30.0], [50.1, 30.1]]


def test_a_line_is_kept_whole_when_any_of_it_is_in_view():
    """Not clipped at the border. A run cut at the box edge would draw as track
    that stops at a line on the map that is not on the ground."""
    crossing = {"source": "ne", "path": [[50.0, 30.0], [60.0, 60.0]]}
    out = regions.filter_lines({"lines": [crossing]}, regions.bounds_for("russia_ukraine"))
    assert out["lines"] == [crossing]


def test_every_other_key_travels_unchanged():
    """provenance is what the popup states, and truncated_regions is how a
    reader learns a theatre was capped rather than empty. A filter that dropped
    either would take the layer's honesty with it."""
    out = regions.filter_lines(DOC, regions.bounds_for("russia_ukraine"))
    assert out["provenance"] == DOC["provenance"]
    assert out["truncated_regions"] == ["sudan"]


def test_a_document_with_no_lines_key_is_returned_as_is():
    assert regions.filter_lines({"note": "not swept"}, regions.bounds_for("sahel")) == {"note": "not swept"}


def test_a_line_with_no_usable_path_is_dropped_rather_than_crashing():
    doc = {"lines": [{"source": "ne"}, {"source": "ne", "path": []}, {"source": "ne", "path": "nonsense"}]}
    assert regions.filter_lines(doc, regions.bounds_for("sahel"))["lines"] == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_region_lines.py -q`
Expected: FAIL with `AttributeError: module 'backend.regions' has no attribute 'filter_lines'`

- [ ] **Step 3: Write the implementation**

Add to `backend/regions.py`, beside `filter_points` and `filter_geojson`:

```python
def filter_lines(doc: dict, bounds: Bounds | None) -> dict:
    """A `{lines: [...]}` document clipped to `bounds`.

    The third filter in this module, and it exists because a line is not a
    point and not a GeoJSON feature. filter_points asks whether a coordinate is
    inside the box; a run of track is inside if *any* of it is, and a line that
    leaves the box is kept whole rather than cut at the edge -- a clipped run
    would draw as track that stops at a border that is not on the ground.

    Every key but `lines` travels through untouched. That is not tidiness:
    `provenance` is what the popup states about which source a line came from,
    and `truncated_regions` is how a reader learns a theatre was capped rather
    than genuinely empty. A filter that dropped either would take the layer's
    honesty with it.
    """
    if bounds is None or not isinstance(doc, dict) or "lines" not in doc:
        return doc
    kept = []
    for line in doc.get("lines") or []:
        path = line.get("path") if isinstance(line, dict) else None
        if not isinstance(path, list):
            continue
        for point in path:
            if (
                isinstance(point, (list, tuple))
                and len(point) >= 2
                and isinstance(point[0], (int, float))
                and isinstance(point[1], (int, float))
                and _in_bounds(point[0], point[1], bounds)
            ):
                kept.append(line)
                break
    return {**doc, "lines": kept}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_region_lines.py -q`
Expected: PASS, 6 passed

- [ ] **Step 5: Let the endpoints take a region**

In `backend/app.py`, replace `railways_endpoint` and `power_lines_endpoint`:

```python
@app.get("/api/railways")
async def railways_endpoint(request: Request, region: str | None = None):
    """Rail linework, optionally clipped to one conflict theatre.

    Whole-document by default, which is what it has always been and what a
    client with no theatre in mind still gets. The `region` parameter is the
    saving: the stored document holds all eleven theatres at once (see
    backend/sources/railways.py's _theatre_boxes) and is 20.4 MB, while a
    reader is looking at one of them.

    Region rather than bbox on purpose. A bbox changes on every pan and would
    mint a new ETag and a new cache entry each time, which for a document this
    size is worse than serving it whole. There are eleven regions and they do
    not move, so eleven immutable answers is the entire key space.
    """
    return _cached_source_response(
        request, "railways", region, regions.filter_lines,
        max_age=86400, stable_etag=True,
    )


@app.get("/api/power-lines")
async def power_lines_endpoint(request: Request, region: str | None = None):
    # Same shape, same reasoning, same clipping as /api/railways above.
    return _cached_source_response(
        request, "power_lines", region, regions.filter_lines,
        max_age=86400, stable_etag=True,
    )
```

- [ ] **Step 6: Add the endpoint test**

Append to `backend/tests/test_region_lines.py`:

```python
import asyncio
import json

from backend import app as app_mod
from backend.cache import registry


class _Req:
    headers = {}


def test_the_railways_endpoint_clips_to_a_named_region():
    state = registry.ensure("railways", key_configured=True)
    state.data = DOC
    body = json.loads(asyncio.run(app_mod.railways_endpoint(_Req(), region="russia_ukraine")).body)
    assert len(body["lines"]) == 1
    assert body["provenance"] == DOC["provenance"]


def test_no_region_still_serves_the_whole_document():
    """The default has to stay what it was: a client that does not know about
    regions must not silently start getting less."""
    state = registry.ensure("railways", key_configured=True)
    state.data = DOC
    body = json.loads(asyncio.run(app_mod.railways_endpoint(_Req())).body)
    assert len(body["lines"]) == 3
```

- [ ] **Step 7: Run the tests**

Run: `python -m pytest backend/tests/test_region_lines.py backend/tests/test_railways.py -q`
Expected: PASS. If `backend/tests/test_railways.py` does not exist, drop it from the command.

- [ ] **Step 8: Measure the win**

With a backend holding a real railways document:

```bash
curl -s -o /dev/null -w "whole: %{size_download} bytes\n" "http://127.0.0.1:8000/api/railways"
curl -s -o /dev/null -w "ukraine: %{size_download} bytes\n" "http://127.0.0.1:8000/api/railways?region=russia_ukraine"
```

Put both numbers in the commit message. If the theatre slice is not meaningfully smaller, stop and report — it would mean the eleven boxes are far more lopsided than assumed, and the client change in Step 9 is not worth making.

- [ ] **Step 9: Have the client ask for the theatre it is showing**

In `frontend/src/hooks/useOsintData.js`, the `ONE_SHOT` railways entry gains the region the map is currently scoped to, and its store key gains it too, so eleven theatres cache as eleven entries rather than overwriting one:

```js
    const ONE_SHOT = {
      railways: {
        // Scoped to the selected theatre when there is one. The layer is
        // MANUAL and off by default, so the reader who turns it on has almost
        // always chosen a theatre first -- and if they have not, this is the
        // whole document exactly as before.
        url: (region) => urlForRegion("/api/railways", region),
        deliver: (data) => onDataRef.current("railways", data || { lines: [] }),
        label: "railway linework",
      },
    };
```

Key the one-shot guard and the IndexedDB entry on `railways:${region || "world"}` rather than on `railways`, so switching theatre fetches the new one instead of believing it already has it.

- [ ] **Step 10: Verify in the browser**

Start the preview, select the Russia / Ukraine theatre, turn railways on, and confirm from the network panel that the request carries `?region=russia_ukraine` and is a fraction of the whole document. Then switch to Taiwan Strait and confirm a second, separate fetch. Screenshot the layer drawn over each.

- [ ] **Step 11: Commit**

```bash
git add backend/regions.py backend/app.py backend/tests/test_region_lines.py frontend/src/hooks/useOsintData.js
git commit -m "Send a reader the theatre they are looking at, not all eleven"
```

---

### Task 6: Stop polling what does not move

The cheapest task in the plan and the one with the least machinery. `countries` and `cities` are polled every five minutes for data the backend refreshes once a day.

**Files:**
- Modify: `frontend/src/hooks/useOsintData.js` (`POLL_CONFIG`, ~lines 87–89)
- Test: `frontend/tests/pollCadence.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `POLL_CONFIG` exported from `useOsintData.js` so a test can assert it. If exporting it drags browser-shaped imports into the test, move the array to `frontend/src/data/pollConfig.js` and import it from both places — the module must stay loadable under `node --test`.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/pollCadence.test.js`:

```js
// No source may be polled faster than the backend can refresh it.
//
// A client poll that outruns its server-side refresh cannot deliver anything
// sooner -- it can only arrive at the same document again. The ETag makes each
// of those a cheap 304 rather than a full body, so this is about round trips
// rather than megabytes, and round trips are what a reader on a phone pays for
// in battery and a backend pays for in connections.
//
// The numbers on the right are the backend's own, from backend/config.py and
// the source modules' refresh loops. When one of those changes, this test is
// what makes the client's cadence change with it instead of drifting.

import test from "node:test";
import assert from "node:assert/strict";

import { POLL_CONFIG } from "../src/data/pollConfig.js";

const MINUTE = 60000;

// layer key -> how often the backend can possibly produce something new, ms.
const BACKEND_REFRESH = {
  countries: 24 * 60 * MINUTE,  // reference geometry, refetched daily
  cities: 24 * 60 * MINUTE,     // GeoNames index, refetched daily
  airports: 24 * 60 * MINUTE,   // refetched daily
  deflock: 24 * 60 * MINUTE,    // mirror refreshes daily
  ports: 12 * 60 * MINUTE,      // World Port Index, twice a day at most
  dams: 7 * 24 * 60 * MINUTE,   // figshare, weekly at most
};

test("reference layers are not polled faster than they can change", async (t) => {
  await t.test("every reference layer polls at an hour or slower", () => {
    // An hour is the floor rather than the daily refresh itself: a client left
    // open overnight should pick the new file up in the morning without a
    // reload, and an hourly 304 is a negligible price for that.
    for (const [key] of Object.entries(BACKEND_REFRESH)) {
      const entry = POLL_CONFIG.find((c) => c.key === key);
      if (!entry) continue; // not polled at all is strictly better
      assert.ok(
        entry.intervalMs >= 60 * MINUTE,
        `${key} polls every ${entry.intervalMs / MINUTE} min for data that changes daily`
      );
    }
  });

  await t.test("no reference layer polls faster than its backend refresh", () => {
    for (const [key, refresh] of Object.entries(BACKEND_REFRESH)) {
      const entry = POLL_CONFIG.find((c) => c.key === key);
      if (!entry) continue;
      assert.ok(
        entry.intervalMs <= refresh,
        `${key} polls slower (${entry.intervalMs}ms) than its own refresh (${refresh}ms) -- a reader would miss a day`
      );
    }
  });

  await t.test("the live layers are untouched by this rule", () => {
    // Guarding the guard: a rule about reference data that quietly slowed the
    // AIS or conflict feeds would be a much worse bug than the one it fixed.
    const ais = POLL_CONFIG.find((c) => c.key === "ais");
    const events = POLL_CONFIG.find((c) => c.key === "events");
    assert.ok(ais.intervalMs <= 30000, "ships should still poll on a live cadence");
    assert.ok(events.intervalMs <= 2 * MINUTE, "conflict events should still poll on a live cadence");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test`
Expected: FAIL — `Cannot find module '.../src/data/pollConfig.js'`, and after Step 3, `countries polls every 5 min for data that changes daily`.

- [ ] **Step 3: Move `POLL_CONFIG` to its own module and retune the reference entries**

Create `frontend/src/data/pollConfig.js` holding the existing `POLL_CONFIG` array verbatim — **every comment moves with it**, they carry the measurements behind each number — and import it back into `useOsintData.js`:

```js
import { POLL_CONFIG } from "../data/pollConfig";
```

Then change exactly these two entries:

```js
  // Country boundary geometry. Was five minutes, which asked a hundred times a
  // day for a file the backend refetches once -- ninety-nine of those answered
  // 304 at zero bytes, and the hundredth was the point. An hour still picks up
  // the new file inside a session left open overnight, which is the only thing
  // polling this at all was ever for.
  { key: "countries", url: "/api/countries", intervalMs: 60 * 60000 },
  // The GeoNames city index, on the same clock and for the same reason:
  // refetched daily server-side, and the places in it do not move.
  { key: "cities", url: "/api/cities", intervalMs: 60 * 60000 },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test`
Expected: PASS

- [ ] **Step 5: Check nothing else read `POLL_CONFIG` from its old home**

Run: `grep -rn "POLL_CONFIG" frontend/src frontend/tests`
Expected: only `frontend/src/data/pollConfig.js` (the definition), `frontend/src/hooks/useOsintData.js` (the import), and the new test.

- [ ] **Step 6: Verify the build and the map**

```bash
cd frontend && npm run build
```

Start the preview and confirm cities and country boundaries still draw. They are boot-fetched as well as polled, so a broken poll would not be visible immediately — check the network panel over two minutes and confirm neither is being requested.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/data/pollConfig.js frontend/src/hooks/useOsintData.js frontend/tests/pollCadence.test.js
git commit -m "Stop asking a hundred times a day for a file that changes once"
```

---

## What this is expected to buy

Stated as predictions so they can be checked rather than assumed. Measure each one during the task that claims it and correct this table in the same commit if reality disagrees.

| | Before | After |
|---|---|---|
| Reload with railways on, warm | up to 4.7 MB + 20.4 MB parse | ~1 KB manifest, no parse |
| Reload after a backend restart | every reference document re-downloaded | nothing re-downloaded |
| Railways over one theatre | all eleven | one |
| Reference polls per hour | 24 (countries + cities at 5 min) | 2 |

## What this plan deliberately does not do

- **No vector tile pyramid.** Argued at the top. Task 5 is the cheap 80%; the pyramid stays available afterwards and is easier for the manifest existing.
- **No service worker.** It would cache the *responses*, which `Cache-Control` already does, and would not touch the parse — the cost this plan is actually chasing. It also adds an update-lifecycle problem to a map whose freshness is the entire product.
- **No change to what any layer contains.** Every property that opens a popup today — `source`, `name`, `operator`, `gauge`, `electrified`, `provenance`, `truncated_regions` — is carried through every filter and every store unchanged. Tasks 3 and 5 each have an explicit test for this, because a caching change that quietly drops a field is the kind of bug that surfaces months later in a popup nobody opened.
- **No eviction policy for the IndexedDB store.** Five layers, one entry each, replaced in place on a hash change. If a later task keys entries by theatre as well (Task 5, Step 9), that becomes 5 × 11 and is worth revisiting; at five it is not a cache, it is five files.
