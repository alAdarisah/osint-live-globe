// Task 13: the real detail card for fused conflict events (map/eventDetail.js).
//
// Three pieces get their own direct tests per the task brief: the
// reporting-lag formatter (including a negative lag, which happens in real
// GDELT data -- SQLDATE and DATEADDED are parsed by different rules, see
// backend/sources/gdelt.py's report_lag_days), the "moved from" path
// (original_lat/original_lon only exist on a "refined" geoverify.py
// verdict), and the nearby-infrastructure radius filter. The six block
// builders get their own coverage too, since each has to state its own
// provenance word and none of that is exercised by the three formatter
// tests alone.
//
// map/eventDetail.js only imports map/severity.js and utils/format.js --
// neither touches window/Leaflet -- so, unlike countryCardSections.test.js
// or intelPanel.test.js, no window.L stub is needed here. The loader shim
// is still required: every src file in this project uses Vite-style
// extensionless relative imports, which Node's own resolver cannot follow.

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
      return next(`${specifier}.js`, context);
    }
    return next(specifier, context);
  },
});

const {
  earliestCoveragePublished, reportingLagDays, formatReportingLag, formatMovedFrom,
  nearbyInfrastructure, NEARBY_MAX_SHOWN,
  buildHeaderBlock, buildCorroborationBlock, buildReliabilityBlock, buildGeolocationBlock,
  buildNearbyBlock, buildActionsBlock, buildEventDetailHtml,
} = await import("../src/map/eventDetail.js");

// A plausible fused conflict record (backend/sources/event_fusion.py's
// _merge_cluster plus reliability.assess()), overridable per test so each
// case only states the fields it actually varies.
function baseRecord(overrides = {}) {
  return {
    id: "gdelt:1",
    lat: 50.45,
    lon: 30.52,
    geo_precision: "locality",
    date: "2026-08-01",
    event_type: "Fighting",
    sub_event_type: "Fighting",
    actor1: "Ukrainian armed forces",
    actor2: "Russian armed forces",
    fatalities: 3,
    fatalities_reported: true,
    country: "Ukraine",
    location: "Kyiv, Ukraine",
    notes: "Shelling reported near Kyiv, three dead",
    summary: null,
    source: "gdelt",
    corroborated: true,
    corroborated_by: ["acled", "gdelt"],
    corroboration: "multi_dataset",
    outlet_count: 4,
    outlets: ["Reuters", "BBC News"],
    verified_outlets: ["Reuters"],
    mentions: 12,
    goldstein: -8,
    source_url: "https://example.com/kyiv-shelling",
    article_url: "https://example.com/kyiv-shelling",
    coverage: [
      { event_id: "1", title: "Shelling reported near Kyiv", url: "https://example.com/kyiv-shelling", outlet: "Reuters", published: "20260801150000" },
      { event_id: "2", title: "Kyiv hit again", url: "https://example.com/kyiv-2", outlet: "BBC News", published: "20260801120000" },
    ],
    coverage_event_ids: ["1", "2"],
    geo_verdict: "confirmed",
    geo_confidence: 88,
    geo_radius_km: 15,
    geo_text_place: "Kyiv",
    reliability: 78,
    reliability_band: "high",
    reliability_tier: "major",
    reliability_outlet: "Reuters",
    reliability_reasons: ["Reported by Reuters, a major international newsroom", "Carried by 4 newsrooms"],
    ...overrides,
  };
}

// ---------- reporting lag ----------

test("reportingLagDays: ordinary positive lag", () => {
  assert.equal(reportingLagDays("2026-08-01", "20260803120000"), 2);
});

test("reportingLagDays: same-day report is zero", () => {
  assert.equal(reportingLagDays("2026-08-05", "20260805050000"), 0);
});

// The brief calls this out by name: it happens in real data because `date`
// (SQLDATE, a bare day) and `date_added` (DATEADDED, a real timestamp) are
// parsed by different rules on the backend, so a report timestamped a few
// hours into the *previous* UTC day is ordinary, not a bug.
test("reportingLagDays: negative lag from a same-day-but-earlier timestamp", () => {
  assert.equal(reportingLagDays("2026-08-05", "20260804090000"), -1);
});

test("reportingLagDays: missing or unparseable inputs return null, never a guess", () => {
  assert.equal(reportingLagDays(null, "20260805050000"), null);
  assert.equal(reportingLagDays("2026-08-05", null), null);
  assert.equal(reportingLagDays("not-a-date", "20260805050000"), null);
  assert.equal(reportingLagDays("2026-08-05", "garbage"), null);
});

test("formatReportingLag: positive, zero and negative lag all read as plain sentences", () => {
  assert.match(formatReportingLag("2026-08-01", "20260803120000"), /2 days after/);
  assert.match(formatReportingLag("2026-08-05", "20260805050000"), /same day/);
  const negative = formatReportingLag("2026-08-05", "20260804090000");
  assert.match(negative, /1 day before/);
  // Must not read as evidence of foreknowledge -- that is the whole reason
  // this case gets its own sentence rather than falling through to the
  // ordinary positive-lag phrasing with a bare minus sign.
  assert.match(negative, /not evidence/);
});

test("formatReportingLag: no dated first report says so rather than omitting the line", () => {
  assert.match(formatReportingLag(null, null), /not available/);
});

test("earliestCoveragePublished: the earliest published wins regardless of list order", () => {
  const coverage = [
    { published: "20260801150000" },
    { published: "20260801090000" },
    { published: "20260801230000" },
  ];
  assert.equal(earliestCoveragePublished(coverage), "20260801090000");
});

test("earliestCoveragePublished: empty or missing coverage is null, not a crash", () => {
  assert.equal(earliestCoveragePublished([]), null);
  assert.equal(earliestCoveragePublished(undefined), null);
  assert.equal(earliestCoveragePublished([{ published: null }]), null);
});

// ---------- "moved from" ----------

test("formatMovedFrom: a refined verdict states where it came from and why", () => {
  const record = baseRecord({
    lat: 50.45, lon: 30.52,
    original_lat: 49.0, original_lon: 32.0,
    original_geo_precision: "country",
    geo_reason: "placed only to country; the article names Kyiv",
  });
  const line = formatMovedFrom(record);
  assert.match(line, /Moved from 49\.000, 32\.000/);
  assert.match(line, /to 50\.450, 30\.520/);
  assert.match(line, /country-level geocode/);
  assert.match(line, /the article names Kyiv/);
});

test("formatMovedFrom: no original coordinate means the point was never moved", () => {
  assert.equal(formatMovedFrom(baseRecord()), null);
  // Half a pair is not a pair -- geoverify.py always writes both fields
  // together, so a record with only one is not a real "moved" case.
  assert.equal(formatMovedFrom(baseRecord({ original_lat: 49.0 })), null);
});

// ---------- nearby infrastructure ----------

const RAW = {
  dams: [{ name: "Near Dam", lat: 50.46, lon: 30.53 }, { name: "Far Dam", lat: 10, lon: 10 }],
  osmInfra: [
    { name: "Kyiv Power Plant", kind: "power_plant", lat: 50.44, lon: 30.51 },
    { name: "Some Airfield (OSM)", kind: "military_airfield", lat: 50.45, lon: 30.52 },
  ],
  cableLandings: [{ name: "A Landing", lat: 60, lon: 60 }],
  airports: [{ name: "Kyiv Intl", lat: 50.4, lon: 30.5 }],
  ports: [{ name: "Odesa Port", lat: 46.5, lon: 30.7 }],
};

test("nearbyInfrastructure: only sites inside the radius are returned, nearest first", () => {
  const items = nearbyInfrastructure(50.45, 30.52, 5000, RAW);
  const names = items.map((i) => i.name);
  assert.ok(names.includes("Near Dam"));
  assert.ok(names.includes("Kyiv Power Plant"));
  assert.ok(!names.includes("Far Dam"), "far outside the radius");
  assert.ok(!names.includes("A Landing"), "far outside the radius");
  // Sorted by distance.
  for (let i = 1; i < items.length; i += 1) {
    assert.ok(items[i].distanceKm >= items[i - 1].distanceKm);
  }
});

test("nearbyInfrastructure: only power_plant osmInfra rows count, not every kind", () => {
  const items = nearbyInfrastructure(50.45, 30.52, 5000, RAW);
  assert.ok(!items.some((i) => i.name === "Some Airfield (OSM)"),
    "military_airfield is an osmInfra kind, not the airfield category, and must not leak in");
});

test("nearbyInfrastructure: items with no coordinate are skipped, not thrown on", () => {
  const raw = { dams: [{ name: "No Coord Dam" }, { name: "Near Dam", lat: 50.46, lon: 30.53 }] };
  const items = nearbyInfrastructure(50.45, 30.52, 5000, raw);
  assert.deepEqual(items.map((i) => i.name), ["Near Dam"]);
});

test("nearbyInfrastructure: no radius, zero radius or a non-finite point returns nothing", () => {
  assert.deepEqual(nearbyInfrastructure(50.45, 30.52, null, RAW), []);
  assert.deepEqual(nearbyInfrastructure(50.45, 30.52, 0, RAW), []);
  assert.deepEqual(nearbyInfrastructure(50.45, 30.52, -100, RAW), []);
  assert.deepEqual(nearbyInfrastructure(null, 30.52, 5000, RAW), []);
});

test("nearbyInfrastructure: an empty raw bag is empty results, not a crash", () => {
  assert.deepEqual(nearbyInfrastructure(50.45, 30.52, 5000, {}), []);
  assert.deepEqual(nearbyInfrastructure(50.45, 30.52, 5000, undefined), []);
});

// ---------- header block ----------

test("buildHeaderBlock: a real headline is provenance 'reported'", () => {
  const html = buildHeaderBlock(baseRecord());
  assert.match(html, /Shelling reported near Kyiv/);
  assert.match(html, /<b>reported<\/b>/);
});

test("buildHeaderBlock: no headline but a CAMEO sentence is provenance 'derived'", () => {
  const record = baseRecord({ notes: null, summary: "Russian armed forces shelled Ukrainian armed forces in Kyiv." });
  const html = buildHeaderBlock(record);
  assert.match(html, /Russian armed forces shelled/);
  assert.match(html, /<b>derived<\/b>/);
});

test("buildHeaderBlock: neither headline nor sentence falls back to the event family, provenance 'inferred'", () => {
  const record = baseRecord({ notes: null, summary: null, event_type: "Unconventional violence" });
  const html = buildHeaderBlock(record);
  assert.match(html, /Unconventional violence/);
  assert.match(html, /<b>inferred<\/b>/);
});

test("buildHeaderBlock: reporting lag line is present and uses the record's earliest coverage", () => {
  const html = buildHeaderBlock(baseRecord());
  // Earliest of the two coverage entries is 20260801120000, one day's worth
  // ahead of the record's own 2026-08-01 date -- same day, not "N days".
  assert.match(html, /same day/);
});

// ---------- corroboration block ----------

test("buildCorroborationBlock: lists datasets, outlet count and coverage links", () => {
  const html = buildCorroborationBlock(baseRecord());
  assert.match(html, /ACLED, GDELT/);
  assert.match(html, /Carried by 4 outlets/);
  assert.match(html, /href="https:\/\/example\.com\/kyiv-shelling"/);
  assert.match(html, /href="https:\/\/example\.com\/kyiv-2"/);
  assert.match(html, /<b>reported<\/b>/);
});

test("buildCorroborationBlock: no coverage says so rather than an empty list", () => {
  const html = buildCorroborationBlock(baseRecord({ coverage: [] }));
  assert.match(html, /No headlines are attached/);
});

// ---------- reliability block ----------

test("buildReliabilityBlock: an unscored record (pre-reliability.py replay) says so", () => {
  const html = buildReliabilityBlock(baseRecord({ reliability: undefined, reliability_band: undefined }));
  assert.match(html, /Not scored/);
});

test("buildReliabilityBlock: a scored record shows the band, reasons and provenance", () => {
  const html = buildReliabilityBlock(baseRecord());
  assert.match(html, /78\/100/);
  assert.match(html, /Reliable/);
  assert.match(html, /Reported by Reuters, a major international newsroom/);
  assert.match(html, /rel-high/);
  assert.match(html, /<b>derived<\/b>/);
});

// A record can carry a named band (reliability_band, which survives replay)
// without a finite numeric score -- reliabilityBand() (severity.js) resolves
// the band from the name alone in that case, and buildReliabilityBlock has
// to show *something* for the bar/number rather than "NaN/100". It falls
// back to the band's own floor (band.min), same guard decorators.js's own
// reliabilityBlock uses for the popup version of this bar.
test("buildReliabilityBlock: a named band with no finite score falls back to the band's floor", () => {
  const html = buildReliabilityBlock(baseRecord({ reliability: undefined, reliability_band: "high" }));
  assert.match(html, /70\/100/); // RELIABILITY_BANDS' "high" entry: min 70
  assert.match(html, /Reliable/);
  assert.match(html, /rel-high/);
});

// ---------- geolocation block ----------

test("buildGeolocationBlock: a moved (refined) record states the move and why", () => {
  const record = baseRecord({
    geo_verdict: "refined",
    original_lat: 49.0,
    original_lon: 32.0,
    original_geo_precision: "country",
    geo_reason: "placed only to country; the article names Kyiv",
  });
  const html = buildGeolocationBlock(record);
  assert.match(html, /Moved from/);
  assert.match(html, /<b>derived<\/b>/);
});

test("buildGeolocationBlock: an unmoved confirmed record makes no move claim", () => {
  const html = buildGeolocationBlock(baseRecord());
  assert.ok(!html.includes("Moved from"));
  assert.match(html, /<b>derived<\/b>/);
});

test("buildGeolocationBlock: a structured (human-coded) record is provenance 'reported'", () => {
  const html = buildGeolocationBlock(baseRecord({ geo_verdict: "structured", geo_confidence: 92 }));
  assert.match(html, /<b>reported<\/b>/);
});

test("buildGeolocationBlock: unverified is its own honest note, not 'no verdict recorded'", () => {
  const html = buildGeolocationBlock(baseRecord({ geo_verdict: "unverified", geo_text_place: null }));
  assert.match(html, /No readable article text/);
  assert.ok(!html.includes("predates automatic placement checking"));
  assert.match(html, /<b>inferred<\/b>/);
});

test("buildGeolocationBlock: a record with no verdict field at all says it predates the check", () => {
  const html = buildGeolocationBlock(baseRecord({ geo_verdict: undefined }));
  assert.match(html, /predates automatic placement checking/);
});

// ---------- nearby block ----------

test("buildNearbyBlock: no uncertainty radius means no search was run", () => {
  const html = buildNearbyBlock(baseRecord({ geo_radius_km: undefined }), RAW);
  assert.match(html, /no search was run/);
});

test("buildNearbyBlock: a radius with matches lists them and states the radius", () => {
  const html = buildNearbyBlock(baseRecord({ geo_radius_km: 5 }), RAW);
  assert.match(html, /5(\.0)? km uncertainty radius/);
  assert.match(html, /Near Dam/);
  assert.match(html, /<b>derived<\/b>/);
});

test("buildNearbyBlock: a radius with nothing in it says so plainly", () => {
  const html = buildNearbyBlock(baseRecord({ geo_radius_km: 5 }), {});
  assert.match(html, /none of the layers loaded in this session/);
});

test("buildNearbyBlock: more than NEARBY_MAX_SHOWN sites are capped, with a '+N more' line", () => {
  const many = Array.from({ length: NEARBY_MAX_SHOWN + 3 }, (_, i) => ({
    name: `Dam ${i}`, lat: 50.45 + i * 0.001, lon: 30.52,
  }));
  const html = buildNearbyBlock(baseRecord({ geo_radius_km: 50 }), { dams: many });
  assert.match(html, /\+3 more within radius/);
});

// ---------- actions block ----------

test("buildActionsBlock: a source URL is a real link", () => {
  const html = buildActionsBlock(baseRecord());
  assert.match(html, /href="https:\/\/example\.com\/kyiv-shelling"/);
  assert.match(html, /Open source article/);
});

test("buildActionsBlock: no source URL but real coverage points at the list above", () => {
  const html = buildActionsBlock(baseRecord({ source_url: null }));
  assert.match(html, /coverage list above/);
});

test("buildActionsBlock: neither a source URL nor coverage says nothing is linked", () => {
  const html = buildActionsBlock(baseRecord({ source_url: null, coverage: [] }));
  assert.match(html, /No source article is linked/);
});

test("buildActionsBlock: no coordinate means no locate line", () => {
  const html = buildActionsBlock(baseRecord({ lat: null, lon: null }));
  assert.match(html, /no coordinate to locate/);
});

// ---------- the assembled card ----------

test("buildEventDetailHtml: all six blocks are present exactly once", () => {
  const html = buildEventDetailHtml(baseRecord(), RAW);
  const blockCount = (html.match(/class="event-detail-block/g) || []).length;
  assert.equal(blockCount, 6);
  for (const heading of ["Corroboration", "Reliability", "Geolocation", "Nearby infrastructure", "Actions"]) {
    assert.ok(html.includes(`>${heading}<`), `missing heading: ${heading}`);
  }
});

test("buildEventDetailHtml: works with only the minimal fields a bare ACLED/UCDP cluster has", () => {
  const minimal = {
    id: "acled:1",
    lat: 15.5,
    lon: 32.5,
    date: "2026-07-20",
    event_type: "Battle",
    sub_event_type: "Battle",
    notes: null,
    summary: null,
    source: "acled",
    corroborated: false,
    corroborated_by: ["acled"],
    outlet_count: 0,
    outlets: [],
    verified_outlets: [],
    coverage: [],
    geo_verdict: "structured",
    geo_confidence: 92,
    geo_radius_km: 5,
    geo_text_place: null,
    reliability: 88,
    reliability_band: "high",
    reliability_reasons: ["Coded from the underlying reporting by a human analyst"],
  };
  // Must not throw on a record with no `coverage`/`outlets` content and no
  // GDELT-only fields at all -- this is the shape a pure ACLED/UCDP cluster
  // (no GDELT member ever joined it) actually has.
  const html = buildEventDetailHtml(minimal, {});
  assert.match(html, /Battle/);
  assert.match(html, /Coded from the underlying reporting by a human analyst/);
});
