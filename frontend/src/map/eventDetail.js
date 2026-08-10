// The real detail card body for one fused conflict/violence record
// (kind === "events" in createMapController.js's recordDetail()).
//
// EventDetailCard.jsx used to render whatever `detail` string decorateEvent
// happened to build for the map's own Leaflet popup -- a summary written for
// a 320px hover bubble, not for a card a reader opened specifically to look
// something up. Every field below is already on the fused record (see
// backend/sources/event_fusion.py's _merge_cluster and
// backend/sources/reliability.py's assess()); this module is only the
// reading of it.
//
// Six blocks, each ending in its own provenance line -- see the project's
// honesty rule (measured/reported/derived/inferred, never a fifth word).
// decorateEvent's own popup detail is untouched: this module does not
// replace it, it is used *in addition*, only for the card opened via
// recordDetail()/openRecordDetail, and only for kind === "events". Every
// other kind, and the map's own pin popup for events, keeps rendering
// exactly what it always has.
//
// Plain JS, no JSX, so it is importable from the headless test harness --
// same split as intelPanelLogic.js/IntelPanel.jsx and
// placeInfoCardGrouping.js/PlaceInfoCard.jsx.

import { esc, fmtNumber, haversineKm, timeAgoFromDateAdded, parseGdeltDateAdded } from "../utils/format";
import { reliabilityBand, reliabilityColor, uncertaintyRadiusMetres, VERDICT_NOTE } from "./severity";

const SOURCE_LABEL = { acled: "ACLED", ucdp: "UCDP", gdelt: "GDELT" };

// ---------- formatters ----------

function parseIsoDateUtc(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * The date_added of the first report to reach us, out of the record's own
 * coverage list. _coverage_for (event_fusion.py) sorts newest-first and dedupes
 * on URL, so the earliest `published` in that list is not necessarily the
 * cluster's very first GDELT row -- it is the earliest of the (already
 * deduped) headlines that survived onto this record. That is the honest
 * answer available on the frontend: GDELT's date_added is "YYYYMMDDHHMMSS",
 * lexicographically sortable, so no parsing is needed to find the minimum.
 */
export function earliestCoveragePublished(coverage) {
  const values = (coverage || []).map((c) => c && c.published).filter(Boolean);
  if (!values.length) return null;
  return values.reduce((min, v) => (v < min ? v : min));
}

/**
 * Whole days between an event's stated date and when the first report of it
 * reached us -- the frontend equivalent of backend/sources/gdelt.py's
 * report_lag_days, applied to the merged record's own `date` (YYYY-MM-DD)
 * rather than a raw GDELT row's SQLDATE. Returns null when either input is
 * missing or unparseable, never a guessed number.
 */
export function reportingLagDays(dateStr, dateAddedStr) {
  const eventDate = parseIsoDateUtc(dateStr);
  const added = parseGdeltDateAdded(dateAddedStr);
  if (!eventDate || !added) return null;
  return Math.floor((added.getTime() - eventDate.getTime()) / 86400000);
}

/**
 * The reporting-lag sentence for the header block. Deliberately handles a
 * negative lag as ordinary data rather than an error: `date` is a bare day
 * and `date_added` carries a real timestamp, parsed by different rules on the
 * backend (SQLDATE vs DATEADDED, see gdelt.py's report_lag_days) -- so a
 * report timestamped a few hours into the day *before* the event's stated
 * date is real, observed data, not evidence of foreknowledge. Saying that
 * plainly is the whole point of a provenance-first card: a reader who saw
 * "-1 days" with no explanation would reasonably suspect a bug.
 */
export function formatReportingLag(dateStr, dateAddedStr) {
  const days = reportingLagDays(dateStr, dateAddedStr);
  if (days === null) return "Reporting lag not available — no dated first report on this record.";
  if (days > 1) return `First report reached us ${days} days after the event's stated date.`;
  if (days === 1) return "First report reached us the day after the event's stated date.";
  if (days === 0) return "First report reached us the same day as the event's stated date.";
  const abs = Math.abs(days);
  return `First report is dated ${abs} day${abs === 1 ? "" : "s"} before the event's stated date — `
    + "a reporting-date artifact (the event date and the report timestamp are parsed by different "
    + "rules), not evidence the report preceded the event.";
}

/**
 * The "moved from" sentence for the geolocation block, or null when the
 * record's coordinate was never moved. `original_lat`/`original_lon` only
 * exist on a "refined" verdict (geoverify.py's GEO_FIELDS) -- every other
 * verdict leaves the source's own coordinate untouched, which is why absence
 * of these two fields is exactly the "not moved" case, not a missing value.
 */
export function formatMovedFrom(record) {
  const origLat = record?.original_lat;
  const origLon = record?.original_lon;
  if (!Number.isFinite(origLat) || !Number.isFinite(origLon)) return null;
  const lat = Number.isFinite(record.lat) ? record.lat.toFixed(3) : "unknown";
  const lon = Number.isFinite(record.lon) ? record.lon.toFixed(3) : "unknown";
  const precision = record.original_geo_precision ? ` (${record.original_geo_precision}-level geocode)` : "";
  const reason = (record.geo_reason || "").trim();
  return `Moved from ${origLat.toFixed(3)}, ${origLon.toFixed(3)}${precision} to ${lat}, ${lon}`
    + (reason ? ` — ${reason}.` : ".");
}

// Which raw feed backs each Nearby category, and the human label for it.
// Task 28: power_plant used to be a *kind* inside raw.osmInfra; it is now
// its own feed, raw.powerPlants (see createMapController.js's applyData
// split, the same move Task 27 made for the four railway kinds).
const NEARBY_LABEL = {
  dam: "Dam / reservoir",
  power_plant: "Power plant",
  cable_landing: "Submarine cable landing",
  airfield: "Airfield",
  port: "Port",
};

/**
 * Infrastructure sites within `radiusMetres` of (lat, lon), nearest first.
 *
 * Exported and radius-only (no bbox pre-filter) so it is exercised directly by
 * the task brief's own "nearby-infrastructure radius filter" test: given a
 * point, a radius and the raw layer arrays, which sites are inside it and how
 * far away is each one. Only layers already loaded into `raw` this session
 * are searched -- an unloaded layer's sites are not counted as absent, which
 * is why buildNearbyBlock below says so in its own provenance line.
 */
export function nearbyInfrastructure(lat, lon, radiusMetres, raw = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  if (!Number.isFinite(radiusMetres) || radiusMetres <= 0) return [];
  const radiusKm = radiusMetres / 1000;
  const categories = [
    ["dam", raw.dams],
    ["power_plant", raw.powerPlants],
    ["cable_landing", raw.cableLandings],
    ["airfield", raw.airports],
    ["port", raw.ports],
  ];
  const out = [];
  for (const [category, items] of categories) {
    for (const item of items || []) {
      if (typeof item.lat !== "number" || typeof item.lon !== "number") continue;
      const distanceKm = haversineKm(lat, lon, item.lat, item.lon);
      if (distanceKm > radiusKm) continue;
      out.push({ category, name: item.name || NEARBY_LABEL[category], distanceKm });
    }
  }
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}

// ---------- blocks ----------

// One line, every block: which of the app's four provenance words applies,
// and what it means for this specific value -- never just the bare word.
function provenanceLine(word, note) {
  return `<div class="meta provenance-line"><b>${esc(word)}</b>${note ? ` — ${esc(note)}` : ""}</div>`;
}

function wrapBlock(className, inner) {
  return `<div class="event-detail-block ${className}">${inner}</div>`;
}

export function buildHeaderBlock(record) {
  const headline = (record.notes || "").trim();
  const cameo = (record.summary || "").trim();
  const family = record.event_type || "Conflict event";
  const subtype = record.sub_event_type && record.sub_event_type !== record.event_type
    ? record.sub_event_type : null;
  const lead = headline || cameo || family;
  const date = record.date || null;
  const earliest = earliestCoveragePublished(record.coverage);
  const reportedAt = earliest ? timeAgoFromDateAdded(earliest) : null;
  const lagLine = date && earliest
    ? formatReportingLag(date, earliest)
    : "Reporting lag not available — no dated first report on this record.";

  let word = "inferred";
  let note = "No headline or coded sentence is available; only the coded event family is known.";
  if (headline) {
    word = "reported";
    note = "Headline text as published by the cited newsroom.";
  } else if (cameo) {
    word = "derived";
    note = "Sentence assembled from the event's coded fields (actor, action, location), not quoted from an article.";
  }

  return wrapBlock("event-header-block", `
    <h3>${esc(lead)}</h3>
    <div class="meta">${esc(family)}${subtype ? ` &mdash; ${esc(subtype)}` : ""}${date ? ` &middot; ${esc(date)}` : ""}</div>
    <div class="meta">${esc(lagLine)}${reportedAt ? ` (first report ${esc(reportedAt)})` : ""}</div>
    ${provenanceLine(word, note)}`);
}

export function buildCorroborationBlock(record) {
  const sources = (record.corroborated_by && record.corroborated_by.length
    ? record.corroborated_by : [record.source]).filter(Boolean);
  const sourceNames = sources.map((s) => SOURCE_LABEL[s] || s).join(", ");
  const outletCount = record.outlet_count || 0;
  const verified = record.verified_outlets || [];
  const coverage = record.coverage || [];

  const coverageRows = coverage.map((c) => {
    const when = c.published ? timeAgoFromDateAdded(c.published) : "";
    const meta = [c.outlet, when].filter(Boolean).map(esc).join(" &middot; ");
    const title = esc(c.title || "");
    const link = c.url
      ? `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
      : title;
    return `<li>${link}${meta ? `<span class="coverage-meta">${meta}</span>` : ""}</li>`;
  }).join("");

  return wrapBlock("event-corroboration-block", `
    <h4>Corroboration</h4>
    <div class="meta">Datasets: ${esc(sourceNames || "unknown")}</div>
    <div class="meta">${outletCount
      ? `Carried by ${fmtNumber(outletCount)} outlet${outletCount === 1 ? "" : "s"}`
      : "No outlet count on this record"}${
        verified.length ? ` &middot; ${verified.length} on this app's allowlist` : ""}</div>
    ${coverageRows
      ? `<ul class="coverage-list">${coverageRows}</ul>`
      : '<div class="meta">No headlines are attached to this record.</div>'}
    ${provenanceLine(
      "reported",
      "Outlet names, counts and headlines as carried by the cited newsrooms. Which datasets agree "
        + "with each other is derived by comparing their independent reports, not itself a reported fact.",
    )}`);
}

export function buildReliabilityBlock(record) {
  const band = reliabilityBand(record);
  if (!band) {
    return wrapBlock("event-reliability-block", `
      <h4>Reliability</h4>
      <div class="meta">Not scored — this record predates reliability scoring.</div>`);
  }
  const score = Number.isFinite(record.reliability) ? record.reliability : band.min;
  const reasons = record.reliability_reasons || [];
  return wrapBlock(`event-reliability-block rel-block rel-${band.key}`, `
    <h4>Reliability</h4>
    <div class="sev-bar"><span style="width:${Math.max(2, score)}%;background:${reliabilityColor(band)}"></span></div>
    <div class="meta">${score}/100 &mdash; ${esc(band.label)}</div>
    ${reasons.length ? `<ul class="sev-reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
    ${provenanceLine(
      "derived",
      "Score computed from who is behind this report, how many independent outlets carried it, and "
        + "whether a human analyst coded it — see the reasons above for exactly what moved it.",
    )}`);
}

// One provenance word per geoverify.py verdict -- see that module's own
// header for what each one means. "unverified" gets its own note rather than
// falling into the "no verdict at all" branch: it is a real answer (nothing
// readable confirmed or contradicted the coordinate), not a missing field.
const GEO_VERDICT_PROVENANCE = {
  structured: ["reported", "Placed by a human analyst from the underlying reporting, not machine-geocoded."],
  confirmed: ["derived", "Position checked against the reporting's own text and confirmed."],
  refined: ["derived", "Position moved up from a coarser geocode after the reporting named a specific place inside it."],
  contested: ["inferred", "The reporting names somewhere else; the pin has not been moved, only doubted."],
  dateline_suspect: ["inferred", "The only place the reporting names is where the article was filed from, not the event."],
  unverified: ["inferred", "No readable article text confirmed or contradicted this coordinate."],
};

// VERDICT_NOTE (map/severity.js) has no "unverified" entry -- decorators.js's
// own comment on it says why: "unverified is deliberately silent" in a hover
// popup, because it is the default state of most pins and printing a note for
// it there would bury the two verdicts that actually matter. That reasoning
// does not carry over here: a reader who opened this card asked the placement
// question directly, so silence would read as "nothing to say" rather than
// "we checked and could not confirm or contradict it", which is the true
// answer. Falling back to the bare word "unverified" (VERDICT_NOTE[verdict]
// undefined) would be worse than either -- a label standing in for a
// sentence -- so this gets its own line instead of sharing VERDICT_NOTE's.
function geoPrimaryLine(verdict) {
  if (!verdict) return "No placement verdict recorded — this record predates automatic placement checking.";
  if (verdict === "unverified") {
    return "No readable article text confirmed or contradicted this coordinate; it stands at the source's own precision.";
  }
  return VERDICT_NOTE[verdict] || verdict;
}

export function buildGeolocationBlock(record) {
  const verdict = record.geo_verdict || null;
  const confidence = Number.isFinite(record.geo_confidence) ? record.geo_confidence : null;
  const radiusMetres = uncertaintyRadiusMetres(record);
  const radiusKm = radiusMetres !== null ? radiusMetres / 1000 : null;
  const textPlace = record.geo_text_place || null;
  const moved = formatMovedFrom(record);

  const primary = geoPrimaryLine(verdict);
  const [word, note] = GEO_VERDICT_PROVENANCE[verdict] || ["inferred", "No placement verdict is recorded on this record."];

  return wrapBlock("event-geolocation-block", `
    <h4>Geolocation</h4>
    <div class="meta">${esc(primary)}</div>
    ${textPlace ? `<div class="meta">Reporting names: ${esc(textPlace)}</div>` : ""}
    ${radiusKm !== null
      ? `<div class="meta">Uncertainty radius: ${radiusKm < 10 ? radiusKm.toFixed(1) : Math.round(radiusKm)} km${
          confidence !== null ? ` &middot; placement confidence ${confidence}/100` : ""}</div>`
      : ""}
    ${moved ? `<div class="meta moved-note">${esc(moved)}</div>` : ""}
    ${provenanceLine(word, note)}`);
}

export const NEARBY_MAX_SHOWN = 10;

export function buildNearbyBlock(record, raw) {
  const radiusMetres = uncertaintyRadiusMetres(record);
  if (radiusMetres === null) {
    return wrapBlock("event-nearby-block", `
      <h4>Nearby infrastructure</h4>
      <div class="meta">No uncertainty radius on this record, so no search was run.</div>`);
  }
  const items = nearbyInfrastructure(record.lat, record.lon, radiusMetres, raw);
  const shown = items.slice(0, NEARBY_MAX_SHOWN);
  const more = items.length - shown.length;
  const radiusKm = radiusMetres / 1000;
  const rows = shown.map((i) => {
    const dist = i.distanceKm < 1 ? `${Math.round(i.distanceKm * 1000)} m` : `${i.distanceKm.toFixed(1)} km`;
    return `<li>${esc(NEARBY_LABEL[i.category] || i.category)}: ${esc(i.name)} &mdash; ${dist}</li>`;
  }).join("");

  return wrapBlock("event-nearby-block", `
    <h4>Nearby infrastructure</h4>
    <div class="meta">Within the event's own ${radiusKm < 10 ? radiusKm.toFixed(1) : Math.round(radiusKm)} km uncertainty radius${
      items.length ? "" : " — none of the layers loaded in this session have a site here"}.</div>
    ${rows ? `<ul class="event-nearby-list">${rows}</ul>` : ""}
    ${more > 0 ? `<div class="meta">+${more} more within radius</div>` : ""}
    ${provenanceLine(
      "derived",
      "Straight-line distance from this event's own coordinate to each site's reported position, "
        + "using the record's own stated uncertainty radius. Only layers already loaded in this "
        + "session are searched — a layer nobody has turned on is not evidence of an empty area.",
    )}`);
}

export function buildActionsBlock(record) {
  const hasPoint = Number.isFinite(record.lat) && Number.isFinite(record.lon);
  const sourceUrl = record.source_url || null;
  const hasCoverage = (record.coverage || []).length > 0;
  return wrapBlock("event-actions-block", `
    <h4>Actions</h4>
    <div class="meta">${hasPoint
      ? 'Use "Show on map" above to locate this event.'
      : "This record has no coordinate to locate."}</div>
    ${sourceUrl
      ? `<div><a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open source article</a></div>`
      : `<div class="meta">${hasCoverage
          ? "See the coverage list above for source links."
          : "No source article is linked to this record."}</div>`}`);
}

/** The full card body for one fused conflict record. See this module's own header. */
export function buildEventDetailHtml(record, raw = {}) {
  return [
    buildHeaderBlock(record),
    buildCorroborationBlock(record),
    buildReliabilityBlock(record),
    buildGeolocationBlock(record),
    buildNearbyBlock(record, raw),
    buildActionsBlock(record),
  ].join("");
}
