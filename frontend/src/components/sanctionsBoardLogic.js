// Pure logic behind SanctionsBoard.jsx -- Task 41's aggregation of the
// per-entity sanctions matching that already runs on every vessel and
// aircraft (backend/sources/sanctions.py's for_vessel/for_aircraft,
// backend/sources/maritime_watchlists.py's for_vessel) into one board a
// reader can scan, instead of having to click every hull and airframe on the
// map to find out which ones are listed. Plain JS, no JSX and no window/
// Leaflet dependency, for the same reason chokepointPanelLogic.js and
// infraRiskPanelLogic.js are: this project's headless test suite
// (`node --test`, no build step) cannot import JSX at all -- see
// frontend/tests/sanctionsBoard.test.js.
//
// **The central rule this file exists to hold to**: OFAC and OpenSanctions
// answer two different questions, and this board never collapses them into
// one. sanctions.py's own module docstring: an OFAC hit is a government
// designation. maritime_watchlists.py's own docstring is explicit that its
// `_hit` deliberately carries "no score and no single 'flagged' boolean,"
// because a designation, a port-state detention and an allegation by an
// interested party are three different strengths of claim. A vessel can
// carry both kinds of hit at once (it is matched against both lists
// independently) -- when it does, that is *two rows*, one per source, never
// one row with two badges glued on. Aircraft only ever carry an OFAC hit:
// maritime_watchlists.py's own header says its collection is "VESSEL rows
// only," so there is no watchlist row shape for aircraft and this file does
// not invent one.
//
// **The matching rule, stated where the reader is.** sanctions.py's
// for_vessel docstring: vessels are matched on IMO first, then MMSI, then
// call sign, and never on name (a name is the easiest AIS field to change and
// the most duplicated). An IMO is assigned to a hull for life and survives
// renaming, reflagging and resale; an MMSI belongs to the radio licence and
// is reissued when a ship changes flag -- something a sanctioned ship does
// constantly; a call sign is free text a crew typed into a transponder. These
// are not equally strong evidence, and MATCHED_ON_LABEL/MATCHED_ON_NOTE below
// say so per row, not only in this comment. Aircraft only ever match on
// registration (OFAC lists an aircraft *by* its tail number), and
// maritime_watchlists.py has no call-sign rung at all -- there is no call
// sign anywhere in that file (see its own "Matching is IMO-only in practice"
// section).
//
// **Scope: "currently visible" means "in this map's own live feed," not
// "on screen right now."** Neither /api/ships (raw.ais) nor /api/aircraft
// (raw.adsb) is bbox-scoped -- see useOsintData.js's POLL_CONFIG, neither
// row carries `scoped: true` -- so both are already a world-wide snapshot the
// map holds in full regardless of where the camera is pointed or which
// layers are switched on, the identical scope SquawkAlertStrip.jsx already
// uses for "every aircraft currently squawking an emergency code." This board
// follows that precedent rather than inventing a viewport- or
// layer-visibility-scoped reading: a designated tanker sitting off Fujairah
// while the camera is over the Pacific and the AIS layer is switched off is
// still a designated tanker, and a board that silently dropped it because it
// was not drawn would be exactly the kind of quiet disagreement between two
// views of the same data this codebase's own history (see Task 12's note on
// the conflict-event filters) keeps finding and fixing.
//
// **"Found nothing" must never render the same as "did not look."** A zero-
// row board can mean at least four different things: the reference lists
// (OFAC, OpenSanctions) have not loaded, so nothing could have matched; the
// AIS or ADS-B feed has not loaded, so there was nothing to check; a feed
// loaded and is currently, genuinely empty; or everything loaded and checked
// clean. feedState/boardCoverage/classifyBoardStatus/emptyStateText below
// exist to keep those four apart, from backend/app.py's /api/health (which
// already tracks `last_success`/`item_count` per source) rather than from
// the entity records themselves -- an absent `item.sanctions` looks
// identical whether the sanctions list has 1,900 entries or has never
// downloaded, so the record alone cannot answer this.
import { fmtNumber, timeAgoFromUnix, utcClockFromUnix } from "../utils/format.js";

// ---------- the matching rule (sanctions.py / maritime_watchlists.py) ------

export const MATCHED_ON_LABEL = {
  imo: "IMO number",
  mmsi: "MMSI",
  callsign: "call sign",
  registration: "registration",
};

// One sentence per identifier, restating sanctions.py's own for_vessel
// docstring reasoning (the ordering it matches in exists for exactly this
// reason) rather than a generic "match found." Deliberately this board's own
// copy rather than an import of decorators.js's SANCTION_MATCH_NOTE: that
// module reads `window.L` at import time (see AirfieldActivityPanel.jsx's
// own note on why panel logic files stay clear of it), which this file must
// not do if frontend/tests/sanctionsBoard.test.js is to run under plain
// `node --test`.
export const MATCHED_ON_NOTE = {
  imo: "Permanent and specific to the hull -- survives renaming, reflagging and resale. The strongest "
    + "identifier match this board makes.",
  mmsi: "Tied to the radio licence, not the hull, and reissued when a vessel changes flag -- something a "
    + "sanctioned ship does often. Treat as strong but not conclusive.",
  callsign: "Free text typed into the AIS transponder by the crew. The weakest identifier match this board "
    + "makes, and it can be wrong.",
  registration: "How OFAC lists an aircraft -- by its tail number. Registrations are reassigned after a sale, "
    + "so a match names the airframe OFAC listed, not necessarily today's operator.",
};

// ---------- the claim taxonomy (both sources, one vocabulary) --------------
//
// An OFAC hit is always, definitionally, a formal government designation --
// that is what OFAC's Specially Designated Nationals list *is* -- so every
// OFAC row is built with claimClass "designation" below. A watchlist row
// takes whatever class maritime_watchlists.py's own `evidence` field says
// (which can also be "designation," when the risk token behind it is an EU/
// UK/Canada/Switzerland/UN listing OpenSanctions itself recorded) --
// deliberately the same vocabulary as OFAC's, since both really are the same
// *kind* of claim; they only differ in which authority made it, which is
// what sourceLabel/sourceFullLabel say instead. This is the one place a
// label is shared between the two sources, and it is shared because the two
// sources' own vocabularies already agree here -- see
// maritime_watchlists.py's own _RISK_EVIDENCE table.
export const CLAIM_CLASS_LABEL = {
  designation: "Designation",
  state_action: "Port-state action (detention or ban)",
  allegation: "Allegation",
  unclassified: "Listed under an unrecognised risk tag",
};

// Presentational only -- a way to tell four claim strengths apart on the row
// at a glance, not a fact about any of them. Reuses colours already in this
// app's palette: #ff3b30 is decorators.js's own SANCTION_COLOR (the ring
// colour on a designated marker), #ff9500 is style.css's existing
// .stale-ping amber (already this app's colour for "real data, just not
// current"), and the two greys are var(--text-dim)'s own value and one shade
// darker.
export const CLAIM_CLASS_COLOR = {
  designation: "#ff3b30",
  state_action: "#ff9500",
  allegation: "#8f9bb3",
  unclassified: "#5c6478",
};

export const SOURCE_LABEL = { ofac: "OFAC", opensanctions: "OpenSanctions" };

// sanctions.py's own SDN_URL -- the actual publication endpoint this map's
// own collector reads, not a guessed-at landing page. maritime_watchlists.py
// ships its own source/source_url/licence per hit (a CC BY-NC 4.0 condition,
// per that file's own header), so a watchlist row reads those off the record
// itself rather than from a constant here.
export const OFAC_SOURCE = {
  name: "US Treasury OFAC Specially Designated Nationals list",
  url: "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV",
};

// The one fixed sentence every OFAC row carries, worded like decorators.js's
// own sanctionDetail (the marker popup for the identical listing) so the
// board and the popup a reader might open next never say two different
// things about what an OFAC hit means -- own copy for the reason
// MATCHED_ON_NOTE above gives, not an import.
export const OFAC_CLAIM_NOTE = "A formal designation by the US Treasury's Office of Foreign Assets Control. "
  + "The list is refreshed daily and re-published whole; a match is against the list as published, not a "
  + "claim about what this vessel or aircraft is doing now.";

// ---------- row aggregation --------------------------------------------

function kindLabel(kind) {
  return kind === "aircraft" ? "Aircraft" : "Vessel";
}

/** The value of whichever identifier actually fired the match, read off the
 * live entity record rather than off the listing -- the listing only says
 * *which kind* matched (`matched_on`), the entity carries the value. */
function identifierValue(kind, matchedOn, entity) {
  if (kind === "aircraft") return entity?.registration || null;
  if (matchedOn === "imo") return entity?.imo || null;
  if (matchedOn === "mmsi") return entity?.mmsi != null ? String(entity.mmsi) : null;
  if (matchedOn === "callsign") return entity?.callsign || null;
  return null;
}

function baseRow(entity, kind, source) {
  return {
    kind,
    source,
    sourceLabel: SOURCE_LABEL[source],
    name: entity?.name || entity?.callsign || (kind === "aircraft" ? "Unnamed aircraft" : "Unnamed vessel"),
    lat: Number.isFinite(entity?.lat) ? entity.lat : null,
    lon: Number.isFinite(entity?.lon) ? entity.lon : null,
    updated: Number.isFinite(entity?.updated) ? entity.updated : null,
    // The feed's own key for this record (mmsi for a ship, icao24 for an
    // aircraft) -- distinct from the *matched* identifier, and shown
    // separately (see secondaryIdLine) because the two are genuinely
    // different fields for an aircraft (icao24 vs registration).
    trackedId: kind === "aircraft" ? (entity?.icao24 || null) : (entity?.mmsi != null ? String(entity.mmsi) : null),
  };
}

/** Zero, one or two rows for one vessel record -- one per source that has a
 * hit on it, never merged. See this module's own header note for why. */
function vesselRows(v) {
  const rows = [];
  if (v?.sanctions) {
    const matchedOn = v.sanctions.matched_on || null;
    rows.push({
      ...baseRow(v, "vessel", "ofac"),
      id: `ofac:vessel:${v.mmsi}`,
      claimClass: "designation",
      claimLabel: CLAIM_CLASS_LABEL.designation,
      claimNote: OFAC_CLAIM_NOTE,
      listedAs: v.sanctions.listed_as || null,
      matchedOn,
      identifierValue: identifierValue("vessel", matchedOn, v),
      program: v.sanctions.program || null,
      sourceFullLabel: OFAC_SOURCE.name,
      sourceUrl: OFAC_SOURCE.url,
      undated: false,
    });
  }
  if (v?.watchlist) {
    const w = v.watchlist;
    const matchedOn = w.matched_on || null;
    const claimClass = CLAIM_CLASS_LABEL[w.evidence] ? w.evidence : "unclassified";
    rows.push({
      ...baseRow(v, "vessel", "opensanctions"),
      id: `opensanctions:vessel:${v.mmsi}`,
      claimClass,
      claimLabel: CLAIM_CLASS_LABEL[claimClass],
      // The backend's own words for what this evidence class means
      // (maritime_watchlists.py's EVIDENCE_MEANING, shipped on every hit as
      // `evidence_note`) -- read verbatim rather than recomposed, so this
      // board can never say something different from what the source data
      // itself states.
      claimNote: w.evidence_note || null,
      listedAs: w.listed_as || null,
      matchedOn,
      identifierValue: identifierValue("vessel", matchedOn, v),
      program: null,
      sourceFullLabel: w.source || "OpenSanctions maritime collection",
      sourceUrl: w.source_url || null,
      listingCount: w.listing_count || 0,
      // maritime_watchlists.py's own hit sets this true on every match --
      // "the file dates nothing." Carried through rather than assumed, so a
      // row can never silently imply currency the source itself disclaims.
      undated: w.undated === true,
    });
  }
  return rows;
}

/** Zero or one row for one aircraft record. maritime_watchlists.py is a
 * vessel-only collection (see this module's header note), so an aircraft
 * never gets a second, OpenSanctions row the way a vessel can. */
function aircraftRows(a) {
  if (!a?.sanctions) return [];
  const matchedOn = a.sanctions.matched_on || null;
  return [{
    ...baseRow(a, "aircraft", "ofac"),
    id: `ofac:aircraft:${a.icao24}`,
    claimClass: "designation",
    claimLabel: CLAIM_CLASS_LABEL.designation,
    claimNote: OFAC_CLAIM_NOTE,
    listedAs: a.sanctions.listed_as || null,
    matchedOn,
    identifierValue: identifierValue("aircraft", matchedOn, a),
    program: a.sanctions.program || null,
    sourceFullLabel: OFAC_SOURCE.name,
    sourceUrl: OFAC_SOURCE.url,
    undated: false,
  }];
}

/**
 * `vessels` (raw.ais) and `aircraft` (raw.adsb) -> one flat row list, both
 * kinds and (for a vessel) both sources represented as their own rows. Never
 * mutates either input array. A non-array input reads as "nothing to check"
 * rather than throwing -- the same "absent feed is not an error" contract
 * every other reader of these two feeds follows.
 */
export function buildSanctionsBoardRows(vessels, aircraft) {
  const v = Array.isArray(vessels) ? vessels : [];
  const a = Array.isArray(aircraft) ? aircraft : [];
  return [...v.flatMap(vesselRows), ...a.flatMap(aircraftRows)];
}

// ---------- per-row display strings (Task 38/40 review discipline: every
// composed string lives here, testable, not inline in SanctionsBoard.jsx) --

export function canLocate(row) {
  return Number.isFinite(row?.lat) && Number.isFinite(row?.lon);
}

export function claimSummaryLine(row) {
  const parts = [kindLabel(row?.kind), CLAIM_CLASS_LABEL[row?.claimClass] || row?.claimClass || "listed"];
  if (row?.program) parts.push(`Programme: ${row.program}`);
  return parts.join(" · ");
}

export function listedAsLine(row) {
  return `Listed as: ${row?.listedAs || "not stated by the source"}`;
}

export function matchedOnLine(row) {
  const label = MATCHED_ON_LABEL[row?.matchedOn] || row?.matchedOn || "an identifier";
  return row?.identifierValue
    ? `Matched on ${label}: ${row.identifierValue}`
    : `Matched on ${label} (value not currently broadcast)`;
}

/** Secondary line for the feed's own key when it differs from what the
 * listing actually matched on -- e.g. an aircraft's icao24 versus the
 * registration OFAC matched, or a vessel's MMSI when the match itself fired
 * on IMO or call sign. "" (render nothing) when the two would say the same
 * thing twice. */
export function secondaryIdLine(row) {
  if (!row?.trackedId) return "";
  if (row.kind === "aircraft") return `Tracked in this feed as ICAO24 ${row.trackedId}`;
  if (row.matchedOn === "mmsi") return "";
  return `Tracked in this feed as MMSI ${row.trackedId}`;
}

export function lastSeenLine(row) {
  if (!Number.isFinite(row?.updated)) return "Last position report: not stated by the feed";
  return `Last position report: ${timeAgoFromUnix(row.updated)} · ${utcClockFromUnix(row.updated)}`;
}

export function positionLine(row) {
  return canLocate(row) ? `${row.lat.toFixed(2)}, ${row.lon.toFixed(2)}` : "position not stated";
}

/** The undated caveat, worded like maritime_watchlists.py's own popup text
 * (decorators.js's watchlistDetail) -- "" for a row that carries no such
 * caveat (every OFAC row; a watchlist row is undated:true unconditionally
 * today, but this reads the flag rather than assuming). Deliberately never
 * conflated with lastSeenLine above: "last seen" is this entity's own most
 * recent position report, a fact about the AIS/ADS-B feed; "undated" is
 * about the *listing*, a fact about the sanctions/watchlist source, and the
 * two answer different questions about different things. */
export function undatedNote(row) {
  return row?.undated
    ? "This list carries no dates -- a listing from years ago and one made this week are indistinguishable rows in it."
    : "";
}

// ---------- sorting ----------------------------------------------------

// Sorts below every real timestamp (always a positive unix time) -- the same
// NO_TOTAL/NO_COUNT sentinel idiom infraRiskPanelLogic.js and
// chokepointPanelLogic.js both use, so a row with no stated position report
// floats to the bottom of "most recent first" instead of tying with a row
// seen a second ago.
const NO_TIME = -1;

const SORT_VALUE = {
  updated: (row) => (Number.isFinite(row?.updated) ? row.updated : NO_TIME),
  name: (row) => (row?.name || "").toLowerCase(),
};

export const SANCTIONS_BOARD_SORT_KEYS = Object.keys(SORT_VALUE);

/** `rows`, ordered by `sortKey` -- a new array, never mutating the input.
 * Ties break on `id`, which is unique per row (source+kind+feed key), so two
 * rows tied on the sorted figure always render in the same relative order
 * rather than swapping on every poll. */
export function sortSanctionsBoard(rows, sortKey = "updated", direction = "desc") {
  const valueOf = SORT_VALUE[sortKey] || SORT_VALUE.updated;
  const factor = direction === "asc" ? 1 : -1;
  return [...(rows || [])].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av < bv) return -1 * factor;
    if (av > bv) return 1 * factor;
    return (a?.id || "").localeCompare(b?.id || "");
  });
}

// ---------- coverage / empty-state (the honesty half of this board) --------
//
// Read from backend/app.py's /api/health, which already tracks
// last_success/item_count per source (backend/cache/registry.py) --
// independent of the entity records themselves, because an absent
// `item.sanctions` on a ship looks identical whether the OFAC list has 1,900
// entries or has never downloaded once. Only /api/health can tell those
// apart, so the board's honesty about *why* it is empty depends on reading
// it, not on the row count alone.

export const FEED_STATE = {
  UNKNOWN: "unknown", // /api/health has not been fetched yet at all
  NOT_LOADED: "not_loaded", // fetched, but this source has never completed a poll
  LOADED_EMPTY: "loaded_empty", // completed a poll at least once, currently holds nothing
  LOADED: "loaded", // completed a poll at least once, currently holds at least one item
};

/** One /api/health entry (e.g. `health.ais`) -> which of the four states
 * above it is in. */
export function feedState(sourceHealth) {
  if (!sourceHealth || typeof sourceHealth !== "object") return FEED_STATE.UNKNOWN;
  if (sourceHealth.last_success == null) return FEED_STATE.NOT_LOADED;
  return (sourceHealth.item_count || 0) > 0 ? FEED_STATE.LOADED : FEED_STATE.LOADED_EMPTY;
}

// The four /api/health keys this board depends on, and the plain-language
// name each gets in the coverage line -- see backend/app.py's registry.health()
// and backend/sources/{ais,adsb,sanctions,maritime_watchlists}.py's own
// registry.register() calls for where these four keys come from.
const FEED_HEALTH_KEY = { vessels: "ais", aircraft: "adsb", ofac: "sanctions", opensanctions: "maritime_watchlists" };
const FEED_DISPLAY_LABEL = {
  vessels: "AIS vessel feed", aircraft: "ADS-B aircraft feed",
  ofac: "OFAC SDN list", opensanctions: "OpenSanctions maritime collection",
};

/** `health` (the whole /api/health body) -> {vessels, aircraft, ofac,
 * opensanctions}, each a FEED_STATE value. */
export function boardCoverage(health) {
  const out = {};
  for (const key of Object.keys(FEED_HEALTH_KEY)) {
    out[key] = feedState(health?.[FEED_HEALTH_KEY[key]]);
  }
  return out;
}

export const BOARD_STATUS = {
  // /api/health itself has not answered even once -- every one of the four
  // feeds this board depends on is FEED_STATE.UNKNOWN. Transient: the first
  // /api/health response (useHealth.js fetches immediately on mount) resolves
  // this within moments, the same footing InfraRiskPanel's own LOADING state
  // has before its own first fetch lands.
  LOADING: "loading",
  // Neither reference list (OFAC, OpenSanctions) has ever loaded -- nothing
  // could have matched anything, and a zero-row board here means exactly
  // that, not "checked and clean." The brief's own named empty-state case.
  NO_REFERENCE_DATA: "no_reference_data",
  // At least one reference list has data. Rows may still be [] -- that is a
  // real "checked and found nothing," or a feed that has not loaded, or both
  // -- and emptyStateText below is what tells those apart in words.
  READY: "ready",
};

export function classifyBoardStatus(health) {
  const cov = boardCoverage(health);
  if (Object.values(cov).every((s) => s === FEED_STATE.UNKNOWN)) return BOARD_STATUS.LOADING;
  const noReference = [cov.ofac, cov.opensanctions].every(
    (s) => s === FEED_STATE.UNKNOWN || s === FEED_STATE.NOT_LOADED
  );
  return noReference ? BOARD_STATUS.NO_REFERENCE_DATA : BOARD_STATUS.READY;
}

/** One clause per feed, stating what this board could and could not check --
 * always available, not only in the empty-state case, the same discipline
 * InfraRiskPanel.jsx's own coverage paragraph follows for its five Nearby
 * categories. */
export function coverageLine(health) {
  const cov = boardCoverage(health);
  return Object.keys(FEED_DISPLAY_LABEL).map((key) => {
    const label = FEED_DISPLAY_LABEL[key];
    const state = cov[key];
    if (state === FEED_STATE.UNKNOWN) return `${label}: status unknown`;
    if (state === FEED_STATE.NOT_LOADED) return `${label}: not loaded yet`;
    if (state === FEED_STATE.LOADED_EMPTY) return `${label}: loaded, currently empty`;
    const h = health?.[FEED_HEALTH_KEY[key]];
    return `${label}: ${fmtNumber(h?.item_count)} loaded`;
  }).join(" · ");
}

/**
 * The sentence the panel body shows in place of a row list -- null when
 * `rowCount` is genuinely > 0 (there is a list to show instead). Three
 * distinct wordings for three distinct reasons a board can otherwise look
 * the same empty way, per this module's own header note and the brief's own
 * named test case.
 */
export function emptyStateText(health, rowCount) {
  if (rowCount > 0) return null;
  const status = classifyBoardStatus(health);
  if (status === BOARD_STATUS.LOADING) return "Checking source status…";
  if (status === BOARD_STATUS.NO_REFERENCE_DATA) {
    return "Nothing has been checked yet -- neither the OFAC SDN list nor the OpenSanctions maritime collection "
      + "has loaded. An empty board right now means \"cannot say,\" not \"clean.\"";
  }
  return `No OFAC- or OpenSanctions-matched vessel or aircraft in this map's current feed. ${coverageLine(health)}`;
}
