// Thin fetch layer -- every data source ultimately goes through fetchJson,
// and every region-scoped source goes through urlForRegion first so the
// backend's ?region= filtering (see backend/regions.py) kicks in uniformly.
//
// Most sources are served through backend/app.py's _cached_source_response,
// which already computes a version-based ETag -- but until now nothing on
// the frontend ever sent it back as If-None-Match, so every poll re-fetched
// and re-parsed the full payload (FIRMS alone runs ~49k points) even when
// the backend had nothing new. Tracking the last ETag per URL and handling
// 304 here is what actually turns that server-side support into real
// bandwidth/parse savings, with zero backend changes needed.
const etagCache = new Map(); // url -> { etag, data }

// Each entry holds a whole decoded payload, and FIRMS alone can be ~49k
// points -- so this is capped rather than left to grow. It's keyed by full
// URL, and every region switch mints a new key (?region=...), so a session
// that browses all 11 conflict zones would otherwise pin ~11 copies of every
// source's payload in memory for the lifetime of the tab. The cap is
// generous enough that the sources actually being polled always stay warm;
// eviction is oldest-first, which for a Map means insertion order.
const ETAG_CACHE_MAX = 40;

function rememberEtag(url, etag, data) {
  // Re-insert to move an existing key to the newest position, so a
  // continuously-polled URL is never the one evicted.
  etagCache.delete(url);
  etagCache.set(url, { etag, data });
  while (etagCache.size > ETAG_CACHE_MAX) {
    const oldest = etagCache.keys().next().value;
    etagCache.delete(oldest);
  }
}

export async function fetchJson(url) {
  const cached = etagCache.get(url);
  const headers = cached?.etag ? { "If-None-Match": cached.etag } : undefined;
  const resp = await fetch(url, { headers });

  if (resp.status === 304 && cached) {
    rememberEtag(url, cached.etag, cached.data); // refresh its recency
    return cached.data;
  }
  if (!resp.ok) throw new Error(`${url}: ${resp.status}`);

  const data = await resp.json();
  const etag = resp.headers.get("ETag");
  if (etag) rememberEtag(url, etag, data);
  else etagCache.delete(url); // source doesn't ETag (e.g. /api/replay, /api/wind's own 304 path) -- nothing to reuse next time
  return data;
}

export function urlForRegion(base, region) {
  if (!region) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}region=${encodeURIComponent(region)}`;
}

/**
 * Append a viewport bbox, when the source takes one.
 *
 * Deliberately after the region parameter rather than instead of it: a bbox
 * narrows what the region already allows and can never widen it (see
 * regions.intersect on the backend), so a reader inside a selected zone gets
 * that zone clipped to what they can see and never a point from outside it.
 *
 * The value has to be snapped before it arrives here -- an unsnapped viewport
 * would mint a new URL, and therefore a new ETag and a full download, on every
 * pixel of pan. See bboxCellKey in useOsintData.js.
 */
export function urlWithBbox(base, bbox) {
  if (!bbox) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}bbox=${encodeURIComponent(bbox)}`;
}

/**
 * Append an already-formed `name=value` a source asks for at this zoom.
 *
 * The same shape as the two above and for the same reason: a distinct URL is a
 * distinct ETag and a distinct cache entry on both sides, so what goes in one
 * has to be a decision, not a detail. See sourceQueryFor in map/scene.js, which
 * is the only thing that produces these.
 */
export function urlWithQuery(base, query) {
  if (!query) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${query}`;
}

/**
 * The vessel-card endpoint (Task 17's /api/vessel/{mmsi}): one hull's
 * identity, inferred cargo/laden profile and recent port calls. A per-entity
 * route like /api/track, not a filtered source -- there is nothing to share
 * an ETag with, since it is keyed by a single MMSI a reader just clicked.
 */
export function vesselDetailUrl(mmsi) {
  return `/api/vessel/${encodeURIComponent(mmsi)}`;
}

/**
 * The port-card sibling: one port's recent arrivals and departures, read
 * from the same vessel_port_calls table via storage.port_calls_at rather
 * than storage.port_calls_for. A separate path from vesselDetailUrl above
 * because a port_id and an MMSI are different id spaces -- see the report
 * on Task 17 for why this took its own route instead of a query param.
 */
export function portCallsUrl(portId) {
  return `/api/vessel/port/${encodeURIComponent(portId)}`;
}
