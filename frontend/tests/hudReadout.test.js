// The status strip's one rule: it never states a number it does not have.
//
// The design prototype this was built from hard-codes every figure in the HUD
// ("128" events, "6s" latency, "11/12" sources) and never updates one of them.
// That is fine in a mock and would be a lie in the product -- so these tests
// are mostly about the *absence* case, which is the one a demo never exercises
// and a cold start hits every time.

import test from "node:test";
import assert from "node:assert/strict";

import {
  UNKNOWN,
  ESCALATION_CEILING,
  escalationReadout,
  jammingReadout,
  ESCALATION_EXPLAINER,
  JAMMING_EXPLAINER,
  countReadout,
  sumCountReadout,
  layerCountReadout,
  latencyReadout,
  sourceRows,
  sourceReadout,
  formatCursorCoords,
  liveReadout,
} from "../src/components/chrome/hudLogic.js";

const EMPTY = [null, undefined, [], {}, 0, "", NaN];

test("every reader answers an absent feed with an explicit unknown", () => {
  // The whole module in one assertion, because the failure this guards against
  // is a *new* reader being added that returns 0. A zero here reads as
  // "measured, and nothing is happening", which over a dead feed is the worst
  // thing a status strip can say.
  for (const input of EMPTY) {
    assert.equal(escalationReadout(input).text, UNKNOWN, `escalationReadout(${String(input)})`);
    assert.equal(jammingReadout(input).text, UNKNOWN, `jammingReadout(${String(input)})`);
    assert.equal(latencyReadout(input).text, UNKNOWN, `latencyReadout(${String(input)})`);
    assert.equal(sourceReadout(input).text, UNKNOWN, `sourceReadout(${String(input)})`);
    assert.equal(countReadout(input, "adsbCivilian", "aircraft").text, UNKNOWN, `countReadout(${String(input)})`);
  }
  assert.equal(layerCountReadout(null).text, UNKNOWN);
  assert.equal(layerCountReadout("nonsense").text, UNKNOWN);
});

test("an unknown is marked as one, not just spelled as one", () => {
  // The dash is for the reader; `known` is for the caller, which uses it to
  // decide whether to dim the cell. A cell that renders "—" in the confident
  // style is a cell that looks broken rather than honest.
  assert.equal(escalationReadout([]).known, false);
  assert.equal(escalationReadout([{ ratio: 2 }]).known, true);
});

test("escalation reports the hottest zone and where its needle sits", () => {
  const zones = [
    { label: "Sahel", ratio: 1.4, current: 7, baseline_per_day: 5 },
    { label: "Red Sea", ratio: 3, current: 12, baseline_per_day: 4 },
  ];
  const out = escalationReadout(zones);
  assert.equal(out.text, "3×");
  assert.match(out.title, /Red Sea/);
  assert.match(out.title, /12 in the last 24h against 4\/day/);
  assert.equal(out.needle, 3 / ESCALATION_CEILING);
});

test("the escalation needle is clamped, and empty means no needle at all", () => {
  // Unbounded ratios against a fixed-width gradient: past the ceiling "worse"
  // stops being a distinction anyone can act on, and a needle off the end of
  // the bar is a rendering bug.
  assert.equal(escalationReadout([{ ratio: 40 }]).needle, 1);
  // Null, not 0. Parking the needle at the calm end of a calm-to-critical
  // gradient with no data behind it reads as "measured, and fine".
  assert.equal(escalationReadout([]).needle, null);
  assert.equal(escalationReadout([{ ratio: "not a number" }]).needle, null);
});

test("jamming reports the worst cell, not the average of a quiet grid", () => {
  // Averaging a global grid of mostly-quiet squares produces a number that is
  // true and says nothing.
  const cells = [{ jam_ratio: 0.02 }, { jam_ratio: 0.61 }, { jam_ratio: 0.05 }];
  assert.equal(jammingReadout(cells).text, "61%");
  assert.match(jammingReadout(cells).title, /3 cells loaded/);
  assert.equal(jammingReadout([{ jam_ratio: 1 }]).title.includes("1 cell loaded"), true);
});

test("a count distinguishes 'nothing in view' from 'nothing received'", () => {
  // The distinction the drawer's own `visible (global total)` rows exist for:
  // a thinned view must never read as a broken feed, and vice versa.
  assert.equal(countReadout({ events: 0, eventsTotal: 0 }, "events", "events").text, UNKNOWN);
  const thinned = countReadout({ events: 0, eventsTotal: 1284 }, "events", "events");
  assert.equal(thinned.text, "0");
  assert.equal(thinned.known, true);
  assert.match(thinned.title, /0 events drawn here, of 1,284 held/);
});

test("a combined count survives one of its feeds being down", () => {
  // "Aircraft" is two feeds and "Vessels" is three. Blanking the whole cell
  // because one of them has not answered would hide the ones that have.
  const counts = {
    adsbCivilian: 12, adsbCivilianTotal: 5808,
    adsbMilitary: 3, adsbMilitaryTotal: 310,
  };
  const both = sumCountReadout(counts, ["adsbCivilian", "adsbMilitary"], "aircraft");
  assert.equal(both.text, "15");
  assert.match(both.title, /15 aircraft drawn here, of 6,118 held/);

  const halfDown = sumCountReadout(
    { adsbCivilian: 12, adsbCivilianTotal: 5808, adsbMilitary: 0, adsbMilitaryTotal: 0 },
    ["adsbCivilian", "adsbMilitary"],
    "aircraft",
  );
  assert.equal(halfDown.text, "12");
  assert.equal(halfDown.known, true);

  // Both down is still an honest unknown.
  assert.equal(sumCountReadout({}, ["adsbCivilian", "adsbMilitary"], "aircraft").text, UNKNOWN);
});

test("the layer count counts what the map is drawing, not what was asked for", () => {
  // layerState.on, not the wish table: a layer pinned on and held back by its
  // own zoom gate is not a layer on screen, and this cell claims to say what is.
  assert.equal(layerCountReadout({ events: true, ais: false, adsb: true }).text, "2");
  assert.match(layerCountReadout({ events: true }).title, /held back by its own zoom gate is not counted/);

  // `{}` is the map not having reported yet, not zero layers drawn -- and it is the
  // only case the old guard was ever going to meet, because useLeafletMap seeds
  // layerState as { on: {}, wish: {} }. It passed the typeof check and rendered a
  // confident "0 layers currently drawn" over a map that had not answered. This
  // test asserted that 0.
  assert.equal(layerCountReadout({}).text, UNKNOWN);
  assert.equal(layerCountReadout({}).known, false);
  // All four ways of having nothing to say agree.
  for (const nothing of [null, undefined, "not an object", {}]) {
    assert.equal(layerCountReadout(nothing).known, false);
  }
});

test("latency reports the stalest source, not the freshest", () => {
  // A strip that reports the best number it can find is a strip that hides the
  // feed that stopped.
  const health = {
    acled: { item_count: 10, seconds_since_success: 12 },
    ais: { item_count: 10, seconds_since_success: 4000 },
    adsb: { item_count: 10, seconds_since_success: 30 },
  };
  assert.equal(latencyReadout(health).text, "1h");
  assert.equal(latencyReadout({ a: { item_count: 1, seconds_since_success: 45 } }).text, "45s");
  assert.equal(latencyReadout({ a: { item_count: 1, seconds_since_success: 600 } }).text, "10m");
});

test("source rows are picked by shape, exactly as the drawer picks them", () => {
  // Same filter SourceStatusSection uses. Anything without an item_count is not
  // a source row, so a future addition to /api/health cannot render as a source
  // with undefined everything.
  const health = {
    acled: { item_count: 3, last_success: 1, seconds_since_success: 5 },
    owm_weather: { item_count: 0, key_configured: false },
    alerts: [{ subject: "ais" }],
    generated_at: 1234,
  };
  assert.deepEqual(sourceRows(health).map(([name]) => name), ["acled"]);
});

test("the dots spend their space on the sources that are wrong", () => {
  // Five dots for twelve sources: showing the first five in object order means
  // a failing source can be invisible purely because of where it sits in a JSON
  // payload.
  const health = {
    a: { item_count: 1, last_success: 1, seconds_since_success: 5 },
    b: { item_count: 1, last_success: 1, seconds_since_success: 5 },
    c: { item_count: 1, last_success: 1, seconds_since_success: 5 },
    d: { item_count: 1, last_success: 1, seconds_since_success: 5 },
    e: { item_count: 1, last_success: 1, seconds_since_success: 5 },
    // Configured and still failing: a real outage, not a missing key.
    dead: { item_count: 0, key_configured: true, last_success: null, last_error: "timeout" },
    // Not configured at all -- the drawer calls this `warn` rather than `err`
    // (SourceStatusSection.jsx), and the strip must not disagree with it.
    nokey: { item_count: 0, key_configured: false, last_error: "no key" },
  };
  const out = sourceReadout(health, 3);
  assert.equal(out.text, "5/7");
  assert.deepEqual(out.dots.map((d) => d.state), ["err", "warn", "ok"]);
  assert.equal(out.dots[0].name, "dead");
  assert.match(out.title, /dead: failing/);
  // "not configured here" rather than "no key": it names what is true of this
  // deployment rather than of the source, and a reader who sees it has nothing to
  // fix. The old wording read like a fault.
  assert.match(out.title, /nokey: not configured here/);
});

test("all-healthy says so rather than listing nothing", () => {
  const health = { a: { item_count: 1, last_success: 1, seconds_since_success: 5 } };
  // "within their own cadence", because that is now the actual test -- each source
  // against its own reporting interval rather than all 57 against one flat half
  // hour. See utils/sourceState.js.
  assert.equal(sourceReadout(health).title, "All 1 sources reporting within their own cadence.");
});

test("cursor coordinates are hemisphere-signed to three decimals", () => {
  assert.equal(formatCursorCoords(26, 30), "26.000°N 30.000°E");
  assert.equal(formatCursorCoords(-33.9249, -18.4241), "33.925°S 18.424°W");
  assert.equal(formatCursorCoords(0, 0), "0.000°N 0.000°E");
});

test("a longitude past the antimeridian is wrapped, not printed", () => {
  // The camera is fenced inside one world copy (createMapController's maxBounds),
  // so this should not arise -- but Leaflet still reports raw container-relative
  // longitudes during a fling, and "412.500°E" is not a place.
  assert.equal(formatCursorCoords(10, 412.5), "10.000°N 52.500°E");
  assert.equal(formatCursorCoords(10, -190), "10.000°N 170.000°E");
  assert.equal(formatCursorCoords(10, 200), "10.000°N 160.000°W");
});

test("an off-map cursor reads as unknown", () => {
  assert.equal(formatCursorCoords(null, null), UNKNOWN);
  assert.equal(formatCursorCoords(NaN, 5), UNKNOWN);
  assert.equal(formatCursorCoords(undefined, undefined), UNKNOWN);
});

test("replay is stated, not implied", () => {
  // The whole reason replay could be handed to readers: the strip says the map
  // is not live, in words, with the moment it is showing instead.
  assert.equal(liveReadout({ isReplaying: false }).text, "LIVE");
  assert.equal(liveReadout({}).live, true);

  const back = liveReadout({ isReplaying: true, replayAt: Date.UTC(2026, 7, 14, 9, 30) });
  assert.equal(back.live, false);
  assert.equal(back.text, "NOT LIVE");
  assert.match(back.title, /2026-08-14 09:30 UTC/);
  assert.match(back.title, /Live updates are paused/);

  // Replaying with no moment yet resolved still says it is not live.
  assert.equal(liveReadout({ isReplaying: true }).text, "NOT LIVE");
});

// ---------- what the two measured cells explain ----------
//
// Escalation and GPS jam are the only two figures in the strip that are a
// measurement rather than a count, and they were the two whose tooltips said only
// what the number currently was. "Kashmir is running 3.1× its own 7-day baseline"
// is faithful and assumes the reader already knows what is being counted, against
// what, and whether 3.1 is a lot. "100% of aircraft reporting bad GPS fixes" reads
// as an emergency when it can be three aircraft out of three, in one hex, on
// yesterday's data.

test("both measured cells explain the metric before reporting the reading", () => {
  const escalation = escalationReadout([{ label: "Sahel", ratio: 3, current: 9, baseline_per_day: 3 }]);
  const jamming = jammingReadout([{ jam_ratio: 0.6, bad: 12, good: 8 }]);
  for (const [name, out, explainer] of [
    ["escalation", escalation, ESCALATION_EXPLAINER],
    ["jamming", jamming, JAMMING_EXPLAINER],
  ]) {
    assert.ok(out.title.startsWith(explainer), `${name} does not lead with the explanation`);
    assert.match(out.title, /Right now:/, `${name} does not report the live reading`);
    // The explanation first, the reading last. A tooltip that opens with today's
    // number teaches nothing on the second read.
    assert.ok(out.title.indexOf("Right now:") > explainer.length - 1, name);
  }
});

test("the explanation is there even when the cell has nothing to report", () => {
  // The empty state is where a reader is most likely to hover: the cell says "—" and
  // the question is what it would have said. Answering only "no cells are loaded"
  // explains the silence without explaining the metric.
  for (const out of [escalationReadout([]), escalationReadout([{ ratio: "x" }])]) {
    assert.ok(out.title.startsWith(ESCALATION_EXPLAINER));
    assert.equal(out.known, false);
  }
  for (const out of [jammingReadout([]), jammingReadout([{ jam_ratio: "x" }])]) {
    assert.ok(out.title.startsWith(JAMMING_EXPLAINER));
    assert.equal(out.known, false);
  }
});

test("the escalation explanation says it is not a badness score", () => {
  // The single most available misreading: the cell is red, it is called Escalation,
  // and it sits next to a severity-coloured bar. It is a ratio against a zone's own
  // history, so a quiet region can top it on a handful of events.
  assert.match(ESCALATION_EXPLAINER, /not how bad it is/);
  assert.match(ESCALATION_EXPLAINER, /24 hours/);
  assert.match(ESCALATION_EXPLAINER, /7 days/);
  assert.match(ESCALATION_EXPLAINER, /1×/, "no anchor for what a normal reading looks like");
  // The two thresholds a reader would otherwise have to infer from the code.
  assert.match(ESCALATION_EXPLAINER, /at least 3 events/);
  assert.match(ESCALATION_EXPLAINER, new RegExp(`${ESCALATION_CEILING}×`));
});

test("the jamming explanation gives the sample size and the staleness", () => {
  // Both are things the number cannot say for itself and both change how much it is
  // worth: it is one cell rather than an average, the cell can qualify on two
  // aircraft, and the publisher updates once a day.
  assert.match(JAMMING_EXPLAINER, /worst single cell, not an average/);
  assert.match(JAMMING_EXPLAINER, /aircraft count beside it/);
  assert.match(JAMMING_EXPLAINER, /once a day/);
  // And that an empty reading is not a clean bill of health -- the feed drops
  // everything under 25% before this ever sees it.
  assert.match(JAMMING_EXPLAINER, /25%/);
  assert.match(JAMMING_EXPLAINER, /not that GPS is\s+fine everywhere/);
});

test("the jamming reading names the aircraft behind the percentage", () => {
  // The fact the old wording left out, and the one that decides whether 100% is
  // alarming. jamming.py has carried per-cell good/bad counts all along and nothing
  // was reading them; a cell qualifies on two aircraft (MIN_TRAFFIC).
  const thin = jammingReadout([{ jam_ratio: 1, bad: 3, good: 0 }]);
  assert.equal(thin.text, "100%");
  assert.match(thin.title, /3 of 3 aircraft/);

  const solid = jammingReadout([{ jam_ratio: 0.6, bad: 120, good: 80 }]);
  assert.match(solid.title, /120 of 200 aircraft/);
});

test("a cell with no aircraft counts still reports, without inventing a sample", () => {
  // Replay snapshots predate the good/bad fields. The percentage is still real; the
  // denominator is simply absent, and a fabricated one would be worse than none.
  const out = jammingReadout([{ jam_ratio: 0.42 }]);
  assert.equal(out.text, "42%");
  assert.ok(!/aircraft in it/.test(out.title), "invented a sample size");
  assert.match(out.title, /worst tracked cell is 42%/);
});

test("the worst cell's own counts are the ones reported", () => {
  // Not the first cell's, and not a sum across cells. The percentage and the sample
  // have to describe the same cell or the pair is nonsense.
  const out = jammingReadout([
    { jam_ratio: 0.3, bad: 3, good: 7 },
    { jam_ratio: 0.9, bad: 9, good: 1 },
    { jam_ratio: 0.5, bad: 5, good: 5 },
  ]);
  assert.equal(out.text, "90%");
  assert.match(out.title, /9 of 10 aircraft/);
  assert.match(out.title, /out of 3 cells loaded/);
});
