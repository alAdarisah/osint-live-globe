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
//             deployment's shared admin_config.json. That same reasoning
//             runs the other way too: App.jsx's own "Copy link" builder must
//             not spread the *whole* of settings.layerWish into a link
//             either, since that object is exactly what is persisted to
//             admin_config.json and a reader who never touched a checkbox
//             would otherwise ship a deployment's admin-pinned layer set to
//             whoever they hand the link to. See App.jsx's layerOverride
//             state and applyLayerOverrideChange below -- the link only ever
//             carries what a reader (this one, or whoever's link opened this
//             tab) actually chose.
//   filters   sparse diffs against DEFAULT_EVENT_FILTER / DEFAULT_VESSEL_FILTER
//             / DEFAULT_AIRCRAFT_FILTER (map/severity.js, utils/entityFilter.js)
//             -- the same three objects the map and IntelPanel already read,
//             so nothing here is a second copy of a filter shape that could
//             drift from the one everything else uses. One field of
//             DEFAULT_EVENT_FILTER is deliberately excluded -- see
//             EVENT_FILTER_URL_FIELDS below.
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
//   - IntelPanel's window and tab, and eventFilter.maxAgeDays with them.
//     IntelPanel.jsx owns maxAgeDays outright: it pushes
//     windowMaxAgeDays(windowHours) into it unconditionally on mount and on
//     every Window change (see that file's own comment on why there is only
//     one Window control left), so a value this format restored into
//     eventFilter would be silently overwritten within the same render --
//     carrying maxAgeDays without also carrying windowHours would ship a
//     field guaranteed not to stick. Rather than carry windowHours too (a
//     second reading-panel display preference, not a fact about the world
//     the way camera/layers/selection are), both are left out and
//     EVENT_FILTER_URL_FIELDS excludes maxAgeDays explicitly -- a
//     hand-crafted hash cannot smuggle it back in either.
//
//     Scope is not carried as its own field for the same "display
//     preference, not a fact about the world" reason, and it only *partly*
//     tracks the selection this file does carry regardless: IntelPanel
//     switches its own Scope control to "Selected country" automatically
//     when a country becomes selected (see IntelPanel.jsx's own effect), but
//     there is no equivalent effect for water -- a restored water selection
//     opens the water card without changing IntelPanel's scope at all.
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
//
// What a link cannot carry is not nothing, either -- two small functions
// below say so at each end, rather than leaving both sides silently
// guessing. omittedSelectionNote is what App.jsx's "Copy link" reads to tell
// the person *building* a link when the state on their own screen (a
// multi-country selection, an open state/district card, an open
// ship/aircraft/satellite record) will not survive the trip.
// describeUrlStateNotice is what UrlStateNotice.jsx reads to tell the person
// *opening* one that this format has known limits at all -- decode has no
// way to know what the sharer's screen actually held, only that this format
// could not have carried certain things whatever it was.
import { DEFAULT_EVENT_FILTER } from "./map/severity";
import { DEFAULT_VESSEL_FILTER, DEFAULT_AIRCRAFT_FILTER } from "./utils/entityFilter";

export const URL_STATE_VERSION = 1;

const SELECTION_KINDS = new Set(["country", "water"]);

// See the module doc's "IntelPanel's window and tab" entry above: maxAgeDays
// is IntelPanel's own field, unconditionally overwritten on mount, so it is
// excluded from both directions -- encodeViewState never writes it, and
// decodeViewState never accepts it even from a hand-crafted hash.
const EVENT_FILTER_URL_FIELDS = ["minSeverity", "showImprecise", "minConfidence"];
const VESSEL_FILTER_URL_FIELDS = Object.keys(DEFAULT_VESSEL_FILTER);
const AIRCRAFT_FILTER_URL_FIELDS = Object.keys(DEFAULT_AIRCRAFT_FILTER);

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

/** Only the keys of `patch` that are in `allowedKeys`, set, and differ from
 *  `base` -- the sparse diff every filter field is encoded as, so an
 *  all-default filter costs nothing in the URL. */
function diffFrom(base, patch, allowedKeys) {
  if (!patch || typeof patch !== "object") return {};
  const out = {};
  for (const key of allowedKeys) {
    const value = patch[key];
    if (value === undefined || value === null) continue;
    if (base[key] === value) continue;
    out[key] = typeof value === "string" ? value.slice(0, MAX_FILTER_TEXT) : value;
  }
  return out;
}

/** Only the keys in `allowedKeys`, and only when the value's shape matches
 *  the default's -- a hand-edited or truncated hash cannot inject an
 *  unknown field, the wrong type, or a field this format deliberately does
 *  not carry (see EVENT_FILTER_URL_FIELDS) into a filter object the rest of
 *  this app then reads without checking. A default of `null` (only
 *  maxAgeDays ships one, and that field is never in `allowedKeys` here, but
 *  this stays general rather than hard-coding the one exception) accepts
 *  either a finite number or null; every other field must match its
 *  default's own type. */
function sanitizeFilterPatch(patch, defaults, allowedKeys) {
  const out = {};
  for (const key of allowedKeys) {
    if (!(key in patch)) continue;
    const value = patch[key];
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

  const ef = diffFrom(DEFAULT_EVENT_FILTER, state.filters?.event, EVENT_FILTER_URL_FIELDS);
  if (Object.keys(ef).length) payload.ef = ef;
  const vf = diffFrom(DEFAULT_VESSEL_FILTER, state.filters?.vessel, VESSEL_FILTER_URL_FIELDS);
  if (Object.keys(vf).length) payload.vf = vf;
  const af = diffFrom(DEFAULT_AIRCRAFT_FILTER, state.filters?.aircraft, AIRCRAFT_FILTER_URL_FIELDS);
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

  // A real encoded hash always has a "v<n>." prefix followed by *something*
  // (encodeViewState always appends at least "%7B%7D", an empty JSON
  // object) -- so a non-empty string with no dot at all cannot be one of
  // this format's own links. Reading it as "an empty view, no error" (the
  // dot === -1 branch used to fall through to that) mistook a hash cut off
  // right after its version token -- "v1" on its own -- for a deliberate
  // hash-less load instead of the truncation it actually is.
  const dot = raw.indexOf(".");
  if (dot === -1) return { state: defaultViewState(), error: "malformed" };

  const versionToken = raw.slice(0, dot);
  const match = /^v(\d+)$/.exec(versionToken);
  if (!match) return { state: defaultViewState(), error: "malformed" };
  if (Number(match[1]) !== URL_STATE_VERSION) return { state: defaultViewState(), error: "unknown-version" };

  const body = raw.slice(dot + 1);
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
    state.filters.event = sanitizeFilterPatch(payload.ef, DEFAULT_EVENT_FILTER, EVENT_FILTER_URL_FIELDS);
  }
  if (payload.vf && typeof payload.vf === "object") {
    state.filters.vessel = sanitizeFilterPatch(payload.vf, DEFAULT_VESSEL_FILTER, VESSEL_FILTER_URL_FIELDS);
  }
  if (payload.af && typeof payload.af === "object") {
    state.filters.aircraft = sanitizeFilterPatch(payload.af, DEFAULT_AIRCRAFT_FILTER, AIRCRAFT_FILTER_URL_FIELDS);
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

/**
 * The reducer behind App.jsx's `layerOverride` state -- the fix for two
 * review findings at once (a "Copy link" republishing the deployment's whole
 * admin-pinned layer set, and a restored link's layer choice fighting the
 * checkbox that is supposed to override it forever after).
 *
 * `prev` starts as `{ ...urlState.state.layers }` -- whatever a followed
 * link asked for -- and from then on this is the *only* place that changes
 * it, called from the same handler (onToggleLayer) that already writes the
 * click through to the map and to Admin Mode's persisted settings. A
 * boolean click sets this key to the new value (so the reader's own latest
 * choice, not the link's, wins when App.jsx spreads
 * `{...settings.layerWish, ...layerOverride}` for the map, and so a
 * follow-up "Copy link" carries the reader's real choice rather than the
 * value the link itself arrived with); `null`/`undefined` (a "hand this
 * layer back to the resolver" click) removes the key entirely, the same
 * "absent means unset" contract settings.layerWish itself uses. Either way,
 * this map only ever holds keys a reader (this one, or whoever's link
 * opened this tab) has actually made a choice about -- never a copy of
 * admin_config.json's own pinned layer set, which is exactly what made the
 * old `{...settings.layerWish, ...urlState.state.layers}` share-link
 * construction leak the deployment's configuration to a reader who never
 * touched a checkbox.
 *
 * A pure reducer (no state, no controller/settings calls) so this one seam
 * -- the actual bug both findings trace back to -- has a headless test
 * (urlState.test.js), even though the App.jsx wiring around it does not.
 */
export function applyLayerOverrideChange(prev, key, visible) {
  if (visible === null || visible === undefined) {
    if (!(key in prev)) return prev;
    const next = { ...prev };
    delete next[key];
    return next;
  }
  if (prev[key] === visible) return prev;
  return { ...prev, [key]: visible };
}

/**
 * What App.jsx's "Copy link" reads to tell the person building a link that
 * part of what is on their screen will not survive it -- the fix for the
 * other silent half of narrowing "selection" to one country-or-water pick:
 * neither end of a link said so. The recipient's half is UrlStateNotice's
 * job (a static description of the format's own limits, since decode has no
 * way to know what the sharer's screen actually held); this is the
 * sharer's half, computed from what App.jsx can see directly.
 *
 * @param {{countrySelectionCount: number, hasSubdivision: boolean,
 *   hasDistrict: boolean, hasOpenRecord: boolean}} current
 * @returns {string|null} a plain-language list of what is not included, or
 *   null when there is nothing to say.
 */
export function omittedSelectionNote(current = {}) {
  const parts = [];
  if ((current.countrySelectionCount || 0) > 1) {
    parts.push(`${current.countrySelectionCount} selected countries (only the focused one is included)`);
  }
  if (current.hasSubdivision) parts.push("the open state/province card");
  if (current.hasDistrict) parts.push("the open district card");
  if (current.hasOpenRecord) parts.push("the open record");
  if (!parts.length) return null;
  return `This link does not include: ${parts.join(", ")}.`;
}

const RESTORED_SOMETHING_KEYS = ["camera", "selection"];

/** Whether `state` (defaultViewState()'s own shape) actually restored
 *  anything, vs. being the all-defaults object an empty or all-error hash
 *  also decodes to. Exported alongside describeUrlStateNotice mainly so it
 *  can be asserted on its own. */
function viewStateRestoredSomething(state) {
  if (RESTORED_SOMETHING_KEYS.some((key) => state[key])) return true;
  if (state.replayAt != null) return true;
  if (Object.keys(state.layers).length) return true;
  return ["event", "vessel", "aircraft"].some((kind) => Object.keys(state.filters[kind]).length);
}

/**
 * What UrlStateNotice renders, decided from decodeViewState's own output --
 * the recipient's half of the review's Important 2 (the sharer's half is
 * omittedSelectionNote above, computed by App.jsx's "Copy link" from state
 * decode cannot see). `error` always wins when present -- the brief's own
 * "must fail cleanly and visibly" requirement. Otherwise, a real followed
 * link (one that actually restored a camera, a selection, layers, filters or
 * a replay moment -- not a plain hash-less visit) gets a one-time reminder
 * that this format has known limits: it cannot say whether the *sharer's*
 * screen held a multi-country selection, a drill-down, or an open record,
 * only that decodeViewState would have dropped one silently if it had.
 *
 * @param {{state: object, error: null|"unknown-version"|"malformed"}} urlState
 *   decodeViewState's own return shape.
 * @returns {{tone: "warn"|"info", message: string}|null}
 */
export function describeUrlStateNotice(urlState) {
  if (urlState?.error === "unknown-version") {
    return {
      tone: "warn",
      message: "This link was written by a version of this app that no longer matches this one, so it could not be read -- showing the default view instead.",
    };
  }
  if (urlState?.error === "malformed") {
    return {
      tone: "warn",
      message: "This link looks incomplete or altered (cut off in a paste, an email footer...) and could not be read -- showing the default view instead.",
    };
  }
  if (!urlState?.state || !viewStateRestoredSomething(urlState.state)) return null;
  return {
    tone: "info",
    message: "This link restores camera, layers, filters, one selection and the replay moment -- it does not carry a multi-country selection, a state/district drill-down, or an open ship/aircraft/satellite record.",
  };
}
