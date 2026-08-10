// Task 35: deep-linkable views. What goes in the URL's hash is a deliberately
// small slice of everything this app now tracks -- see below for what is
// carried and, just as importantly, what is not.
//
// The hash always starts with a version token ("v1."), so a link built by a
// future, incompatible version of this scheme is rejected outright rather
// than silently misread -- see decodeViewState's own note. The rest is one
// URI-encoded JSON object holding only the fields that differ from the
// default view, so a fresh session and an all-defaults link decode to the
// exact same object; the "empty hash" case (nothing after the version, or no
// hash at all) is just the sparsest version of that.
//
// ---------------------------------------------------------------------------
// What is carried, and why
//
//   camera    {lat, lon, zoom} -- the one thing every other field here is
//             answering "on top of". Rounded (4dp / 2dp) because a shared
//             link is meant to be read, not just decoded.
//   layers    a sparse tri-state override table, exactly settings.layerWish's
//             own shape (map/scene.js's resolver decides everything not
//             listed here). App.jsx restores it into the map controller's
//             session-only layer wishes, never through Admin Mode's settings
//             actions -- a link a reader opens must never rewrite this
//             deployment's shared admin_config.json.
//   filters   sparse diffs against DEFAULT_EVENT_FILTER / DEFAULT_VESSEL_FILTER
//             / DEFAULT_AIRCRAFT_FILTER (map/severity.js, utils/entityFilter.js)
//             -- the same three objects the map and IntelPanel already read,
//             so nothing here is a second copy of a filter shape that could
//             drift from the one everything else uses.
//   selection at most one {kind: "country"|"water", id} -- see "what is not
//             carried" below for the rest of what the brief's own inventory
//             lists under "selection", and why only these two made the cut.
//   replayAt  a past moment (ms epoch), or absent for "live". Restoring it
//             re-issues the same /api/replay fetch the scrubber itself would
//             (see useReplay.js's initialReplayAt).
//
// What is deliberately left out, and why
//
//   - Country multi-select. Only the single focused country travels, as
//     `selection`. Carrying the whole set is easy to encode; restoring it
//     safely is not -- each addition is a stateful, additive click against
//     whatever the map already has selected, so replaying N of them on load
//     needs to happen in sequence after the first has settled, and a partial
//     failure partway through would leave a link-opener's selection silently
//     short of what the link's author saw. One focused place matches what is
//     actually drawn (one open card) and needs no such sequencing.
//   - admin-1/admin-2 (state/district). Both are drill-downs of a country
//     selection that has to exist first, loaded asynchronously
//     (syncSubdivisions), before either can be picked by key -- and neither
//     has a restore-by-key entry point on the map controller today. A real
//     feature, not a field this format can just add.
//   - Ship, aircraft, satellite. Each names one row in a feed that reflows
//     every 15-60 seconds and is not guaranteed to still be in it by the
//     time a link is opened -- exactly the situation openRecordDetail's own
//     "No longer listed" card already exists to state honestly for a stale
//     in-session click. Doing the same for a fresh page load needs a
//     poll-and-retry story this pass does not build.
//   - IntelPanel's scope/window/tab. Scope is either World/Current view
//     (recomputed from camera, needs no field of its own) or already follows
//     the country/water `selection` this file does carry when it is
//     deliberate; window and tab are the reading panel's own display
//     preference, not a fact about the world the way the other fields are.
//   - RegionBar's conflict-zone pick. Not named in the brief's own inventory
//     of state to consider, and it re-scopes server-side fetches in a way
//     that would need its own careful restore path -- left for later.
//   - Admin Mode's configuration. Explicitly out of scope per the brief:
//     that lives in admin_config.json, is shared across every viewer of this
//     deployment, and must never be reachable through a URL a reader can
//     hand around.
//
// Nothing here identifies the person who made the link -- every field is a
// fact about the map (where it is pointed, what it is showing, what moment
// it is showing), never about the browser or session that built the URL.
import { DEFAULT_EVENT_FILTER } from "./map/severity";
import { DEFAULT_VESSEL_FILTER, DEFAULT_AIRCRAFT_FILTER } from "./utils/entityFilter";

export const URL_STATE_VERSION = 1;

const SELECTION_KINDS = new Set(["country", "water"]);

// A shared link's free-text filter query is a search string about ships or
// aircraft, not about the person who typed it -- but an unbounded string
// still has no business bloating a URL, so it is clamped the same way a
// pasted-in query anywhere else in this app would be.
const MAX_FILTER_TEXT = 200;

function round(n, dp) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Only the keys of `patch` that are set and differ from `base` -- the sparse
 *  diff every filter field is encoded as, so an all-default filter costs
 *  nothing in the URL. */
function diffFrom(base, patch) {
  if (!patch || typeof patch !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    if (base[key] === value) continue;
    out[key] = typeof value === "string" ? value.slice(0, MAX_FILTER_TEXT) : value;
  }
  return out;
}

/** Only the keys `defaults` itself declares, and only when the value's shape
 *  matches the default's -- a hand-edited or truncated hash cannot inject an
 *  unknown field, or the wrong type, into a filter object the rest of this
 *  app then reads without checking. `maxAgeDays`'s default is `null` (no
 *  cap) rather than a number, so that one field accepts either a finite
 *  number or null; every other field must match its default's own type. */
function sanitizeFilterPatch(patch, defaults) {
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in defaults)) continue;
    if (defaults[key] === null) {
      if (value === null || Number.isFinite(value)) out[key] = value;
      continue;
    }
    if (typeof value !== typeof defaults[key]) continue;
    out[key] = typeof value === "string" ? value.slice(0, MAX_FILTER_TEXT) : value;
  }
  return out;
}

/**
 * The default view: what an empty hash, or a hash this code refuses to read,
 * decodes to -- every field a reader who follows a plain, hash-less link
 * would already see.
 */
export function defaultViewState() {
  return {
    camera: null,
    layers: {},
    filters: { event: {}, vessel: {}, aircraft: {} },
    selection: null,
    replayAt: null,
  };
}

/**
 * @param {object} [state] see defaultViewState's shape; every field is
 *   optional, and a missing one is treated as "unset" rather than as "reset
 *   to default" (there is no difference for this format: unset *is* how a
 *   default is spelled).
 * @returns {string} the hash's full content, with no leading "#" -- callers
 *   that write to `location.hash` or build a shareable link add that
 *   themselves.
 */
export function encodeViewState(state = {}) {
  const payload = {};

  const camera = state.camera;
  if (camera && Number.isFinite(camera.lat) && Number.isFinite(camera.lon) && Number.isFinite(camera.zoom)) {
    payload.c = [round(camera.lat, 4), round(camera.lon, 4), round(camera.zoom, 2)];
  }

  const layers = state.layers;
  if (layers && typeof layers === "object") {
    const sparse = {};
    for (const [key, value] of Object.entries(layers)) {
      if (typeof value === "boolean") sparse[key] = value;
    }
    if (Object.keys(sparse).length) payload.l = sparse;
  }

  const ef = diffFrom(DEFAULT_EVENT_FILTER, state.filters?.event);
  if (Object.keys(ef).length) payload.ef = ef;
  const vf = diffFrom(DEFAULT_VESSEL_FILTER, state.filters?.vessel);
  if (Object.keys(vf).length) payload.vf = vf;
  const af = diffFrom(DEFAULT_AIRCRAFT_FILTER, state.filters?.aircraft);
  if (Object.keys(af).length) payload.af = af;

  const sel = state.selection;
  if (sel && SELECTION_KINDS.has(sel.kind) && sel.id != null && String(sel.id) !== "") {
    payload.s = [sel.kind, String(sel.id)];
  }

  if (Number.isFinite(state.replayAt)) payload.r = Math.round(state.replayAt);

  return `v${URL_STATE_VERSION}.${encodeURIComponent(JSON.stringify(payload))}`;
}

/**
 * @param {string} [hash] `location.hash`, with or without its leading "#", or
 *   anything else a caller might hand this (empty, undefined, a hash left
 *   over from a browser extension) -- never thrown on, whatever it is.
 * @returns {{state: object, error: null|"unknown-version"|"malformed"}}
 *   `state` is always a complete, valid view (defaultViewState() merged with
 *   whatever could be salvaged), so a caller never has to null-check it --
 *   only `error` says whether the hash was actually honoured. A field this
 *   function cannot make sense of is dropped on its own rather than failing
 *   the whole decode, so one corrupted number does not also cost the camera
 *   position sitting right next to it in the payload.
 */
export function decodeViewState(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  if (!raw) return { state: defaultViewState(), error: null };

  const dot = raw.indexOf(".");
  const versionToken = dot === -1 ? raw : raw.slice(0, dot);
  const match = /^v(\d+)$/.exec(versionToken);
  if (!match) return { state: defaultViewState(), error: "malformed" };
  if (Number(match[1]) !== URL_STATE_VERSION) return { state: defaultViewState(), error: "unknown-version" };

  const body = dot === -1 ? "" : raw.slice(dot + 1);
  if (!body) return { state: defaultViewState(), error: null };

  let payload;
  try {
    payload = JSON.parse(decodeURIComponent(body));
  } catch {
    // A truncated link (cut off by a chat client, an email footer, a
    // half-copied paste) decodes to a bad %-escape or invalid JSON -- either
    // way this is the one place that catches it, so it fails cleanly instead
    // of throwing out of a render.
    return { state: defaultViewState(), error: "malformed" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { state: defaultViewState(), error: "malformed" };
  }

  const state = defaultViewState();

  if (Array.isArray(payload.c) && payload.c.length === 3 && payload.c.every(Number.isFinite)) {
    state.camera = { lat: payload.c[0], lon: payload.c[1], zoom: payload.c[2] };
  }

  if (payload.l && typeof payload.l === "object" && !Array.isArray(payload.l)) {
    for (const [key, value] of Object.entries(payload.l)) {
      if (key && typeof value === "boolean") state.layers[key] = value;
    }
  }

  if (payload.ef && typeof payload.ef === "object") {
    state.filters.event = sanitizeFilterPatch(payload.ef, DEFAULT_EVENT_FILTER);
  }
  if (payload.vf && typeof payload.vf === "object") {
    state.filters.vessel = sanitizeFilterPatch(payload.vf, DEFAULT_VESSEL_FILTER);
  }
  if (payload.af && typeof payload.af === "object") {
    state.filters.aircraft = sanitizeFilterPatch(payload.af, DEFAULT_AIRCRAFT_FILTER);
  }

  if (
    Array.isArray(payload.s) && payload.s.length === 2
    && SELECTION_KINDS.has(payload.s[0]) && typeof payload.s[1] === "string" && payload.s[1]
  ) {
    state.selection = { kind: payload.s[0], id: payload.s[1] };
  }

  if (Number.isFinite(payload.r)) state.replayAt = payload.r;

  return { state, error: null };
}
