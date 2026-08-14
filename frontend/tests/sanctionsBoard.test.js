// Task 41: SanctionsBoard's own logic -- aggregating backend/sources/
// sanctions.py's and backend/sources/maritime_watchlists.py's per-entity
// hits (already attached to /api/ships and /api/aircraft records as
// item.sanctions/item.watchlist) into rows, plus the coverage/empty-state
// reasoning that keeps "checked and found nothing" apart from "did not
// look." sanctionsBoardLogic.js imports nothing that touches window/Leaflet,
// so, like infraRiskPanel.test.js and chokepointPanel.test.js, this needs no
// DOM stub.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOARD_STATUS, CLAIM_CLASS_LABEL, FEED_STATE, LISTING_PROVENANCE, MATCH_PROVENANCE, MATCHED_ON_LABEL,
  MATCHED_ON_NOTE, SANCTIONS_BOARD_SORT_KEYS,
  boardCoverage, buildSanctionsBoardRows, canLocate, claimSummaryLine, classifyBoardStatus, coverageLine,
  emptyStateText, feedState, lastSeenLine, listedAsLine, matchedOnLine, positionLine, provenanceLine,
  secondaryIdLine, sortSanctionsBoard, undatedNote,
} from "../src/components/sanctionsBoardLogic.js";

// --- fixtures, shaped like the real records (see backend/sources/ais.py's
// _ships[mmsi] assembly and backend/sources/adsb.py's _record_from_airplanes_live) --

function vessel(overrides = {}) {
  return {
    mmsi: 244123456,
    imo: "9427366",
    callsign: "PH1234",
    name: "MV EXAMPLE",
    lat: 25.1, lon: 55.2, updated: 1786430000,
    ...overrides,
  };
}

function ofacVesselHit(overrides = {}) {
  return {
    listed_as: "EXAMPLE VESSEL",
    program: "SDGT",
    sdn_type: "vessel",
    matched_on: "imo",
    aliases: [],
    flag: "Panama",
    owner: "Example Shipping LLC",
    ent_num: "12345",
    ...overrides,
  };
}

function watchlistHit(overrides = {}) {
  return {
    listed_as: "EXAMPLE VESSEL",
    evidence: "state_action",
    evidence_classes: ["state_action"],
    evidence_note: "A port state has recorded an action against this hull.",
    risk: ["mare.detained"],
    datasets: ["black_sea_mou_detention"],
    listings: [],
    listing_count: 1,
    aliases: [],
    flag: "Panama",
    countries: [],
    matched_on: "mmsi",
    undated: true,
    source: "OpenSanctions maritime collection",
    source_url: "https://www.opensanctions.org/datasets/maritime/",
    licence: "CC BY-NC 4.0",
    ...overrides,
  };
}

function aircraft(overrides = {}) {
  return {
    icao24: "abc123",
    registration: "EP-GOL",
    callsign: "IRA170",
    lat: 35.7, lon: 51.4, updated: 1786430500,
    ...overrides,
  };
}

function ofacAircraftHit(overrides = {}) {
  return {
    listed_as: "EP-GOL",
    program: "IRAN",
    sdn_type: "aircraft",
    matched_on: "registration",
    aliases: [],
    flag: null,
    owner: null,
    ent_num: "67890",
    ...overrides,
  };
}

// --- buildSanctionsBoardRows: aggregation across both entity kinds ---------

test("a vessel with only an OFAC hit produces exactly one row, sourced ofac", () => {
  const v = vessel({ sanctions: ofacVesselHit() });
  const rows = buildSanctionsBoardRows([v], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "ofac");
  assert.equal(rows[0].kind, "vessel");
});

test("a vessel with only a watchlist hit produces exactly one row, sourced opensanctions", () => {
  const v = vessel({ watchlist: watchlistHit() });
  const rows = buildSanctionsBoardRows([v], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "opensanctions");
});

test("a vessel with both an OFAC and a watchlist hit produces two separate rows, never merged", () => {
  const v = vessel({ sanctions: ofacVesselHit(), watchlist: watchlistHit() });
  const rows = buildSanctionsBoardRows([v], []);
  assert.equal(rows.length, 2);
  const sources = rows.map((r) => r.source).sort();
  assert.deepEqual(sources, ["ofac", "opensanctions"]);
  // Neither row carries the other source's own fields -- e.g. the OFAC row
  // has no evidence_note-derived claimNote and the watchlist row has no
  // program, because the two claims are never folded into one object.
  const ofacRow = rows.find((r) => r.source === "ofac");
  const wlRow = rows.find((r) => r.source === "opensanctions");
  assert.equal(ofacRow.program, "SDGT");
  assert.equal(wlRow.program, null);
});

test("a vessel with neither hit produces no rows", () => {
  const rows = buildSanctionsBoardRows([vessel()], []);
  assert.deepEqual(rows, []);
});

test("an aircraft with an OFAC hit produces one row, kind aircraft", () => {
  const a = aircraft({ sanctions: ofacAircraftHit() });
  const rows = buildSanctionsBoardRows([], [a]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "aircraft");
  assert.equal(rows[0].source, "ofac");
});

test("an aircraft never produces an opensanctions row -- maritime_watchlists.py is vessel-only", () => {
  // Even if an aircraft record somehow carried a `watchlist` key (it never
  // does in practice -- adsb.py only ever sets `sanctions`), this board must
  // not invent a watchlist row shape for it.
  const a = aircraft({ sanctions: ofacAircraftHit(), watchlist: watchlistHit() });
  const rows = buildSanctionsBoardRows([], [a]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "ofac");
});

test("an aircraft with no sanctions hit produces no rows", () => {
  assert.deepEqual(buildSanctionsBoardRows([], [aircraft()]), []);
});

test("aggregates across both kinds and multiple entities at once", () => {
  const rows = buildSanctionsBoardRows(
    [
      vessel({ mmsi: 1, sanctions: ofacVesselHit() }),
      vessel({ mmsi: 2, watchlist: watchlistHit() }),
      vessel({ mmsi: 3 }), // no hit -- contributes nothing
    ],
    [aircraft({ icao24: "a1", sanctions: ofacAircraftHit() })]
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.kind).sort(), ["aircraft", "vessel", "vessel"]);
});

test("row ids are unique per source+kind+entity, so React keys never collide", () => {
  const rows = buildSanctionsBoardRows(
    [vessel({ mmsi: 1, sanctions: ofacVesselHit(), watchlist: watchlistHit() })],
    [aircraft({ icao24: "a1", sanctions: ofacAircraftHit() })]
  );
  const ids = rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("non-array inputs read as nothing to check, not a throw", () => {
  assert.deepEqual(buildSanctionsBoardRows(null, undefined), []);
  assert.deepEqual(buildSanctionsBoardRows("nope", 5), []);
});

test("never mutates the vessel/aircraft arrays it was given", () => {
  const vessels = [vessel({ sanctions: ofacVesselHit() })];
  const aircraftList = [aircraft({ sanctions: ofacAircraftHit() })];
  const vSnapshot = JSON.parse(JSON.stringify(vessels));
  const aSnapshot = JSON.parse(JSON.stringify(aircraftList));
  buildSanctionsBoardRows(vessels, aircraftList);
  assert.deepEqual(vessels, vSnapshot);
  assert.deepEqual(aircraftList, aSnapshot);
});

// --- matched-on display: the strength-of-claim rule, per row --------------

test("MATCHED_ON_LABEL and MATCHED_ON_NOTE cover exactly the four identifiers sanctions.py matches on", () => {
  assert.deepEqual(Object.keys(MATCHED_ON_LABEL).sort(), ["callsign", "imo", "mmsi", "registration"]);
  assert.deepEqual(Object.keys(MATCHED_ON_NOTE).sort(), ["callsign", "imo", "mmsi", "registration"]);
});

test("a vessel matched on IMO shows the IMO value, not the MMSI or call sign", () => {
  const v = vessel({ sanctions: ofacVesselHit({ matched_on: "imo" }) });
  const [row] = buildSanctionsBoardRows([v], []);
  assert.equal(row.matchedOn, "imo");
  assert.equal(row.identifierValue, v.imo);
  assert.equal(matchedOnLine(row), `Matched on IMO number: ${v.imo}`);
});

test("a vessel matched on MMSI shows the MMSI value, stringified", () => {
  const v = vessel({ sanctions: ofacVesselHit({ matched_on: "mmsi" }) });
  const [row] = buildSanctionsBoardRows([v], []);
  assert.equal(row.identifierValue, String(v.mmsi));
  assert.ok(matchedOnLine(row).includes("MMSI"));
});

test("a vessel matched on call sign shows the call sign, and it is the weakest match", () => {
  const v = vessel({ sanctions: ofacVesselHit({ matched_on: "callsign" }) });
  const [row] = buildSanctionsBoardRows([v], []);
  assert.equal(row.identifierValue, v.callsign);
  assert.match(MATCHED_ON_NOTE.callsign, /weakest/i);
});

test("an aircraft is always matched on registration, never on icao24", () => {
  const a = aircraft({ sanctions: ofacAircraftHit() });
  const [row] = buildSanctionsBoardRows([], [a]);
  assert.equal(row.matchedOn, "registration");
  assert.equal(row.identifierValue, a.registration);
});

test("a missing identifier value reads as 'not currently broadcast', not a blank or a throw", () => {
  const v = vessel({ imo: null, sanctions: ofacVesselHit({ matched_on: "imo" }) });
  const [row] = buildSanctionsBoardRows([v], []);
  assert.equal(row.identifierValue, null);
  assert.match(matchedOnLine(row), /not currently broadcast/);
});

test("IMO and MMSI are not presented as equally strong evidence", () => {
  assert.match(MATCHED_ON_NOTE.imo, /strongest/i);
  assert.match(MATCHED_ON_NOTE.mmsi, /not conclusive/i);
  assert.notEqual(MATCHED_ON_NOTE.imo, MATCHED_ON_NOTE.mmsi);
});

test("secondaryIdLine shows the feed's own MMSI only when the match itself fired on something else", () => {
  const matchedOnCallsign = buildSanctionsBoardRows([vessel({ mmsi: 999, sanctions: ofacVesselHit({ matched_on: "callsign" }) })], [])[0];
  assert.match(secondaryIdLine(matchedOnCallsign), /MMSI 999/);
  const matchedOnMmsi = buildSanctionsBoardRows([vessel({ mmsi: 999, sanctions: ofacVesselHit({ matched_on: "mmsi" }) })], [])[0];
  assert.equal(secondaryIdLine(matchedOnMmsi), "");
});

test("secondaryIdLine always shows an aircraft's icao24, since it is never what was matched on", () => {
  const row = buildSanctionsBoardRows([], [aircraft({ icao24: "deadbe", sanctions: ofacAircraftHit() })])[0];
  assert.match(secondaryIdLine(row), /ICAO24 deadbe/);
});

// --- claim taxonomy: OFAC vs. OpenSanctions, and OpenSanctions' own three kinds ---

test("an OFAC hit is always the designation claim class", () => {
  const row = buildSanctionsBoardRows([vessel({ sanctions: ofacVesselHit() })], [])[0];
  assert.equal(row.claimClass, "designation");
  assert.equal(claimSummaryLine(row), `Vessel · ${CLAIM_CLASS_LABEL.designation} · Programme: SDGT`);
});

test("a watchlist hit's claim class follows its own evidence field, not OFAC's", () => {
  const stateAction = buildSanctionsBoardRows([vessel({ watchlist: watchlistHit({ evidence: "state_action" }) })], [])[0];
  assert.equal(stateAction.claimClass, "state_action");
  const allegation = buildSanctionsBoardRows([vessel({ mmsi: 2, watchlist: watchlistHit({ evidence: "allegation" }) })], [])[0];
  assert.equal(allegation.claimClass, "allegation");
});

test("an unrecognised evidence class falls back to unclassified rather than throwing or inventing a class", () => {
  const row = buildSanctionsBoardRows([vessel({ watchlist: watchlistHit({ evidence: "some_future_tag" }) })], [])[0];
  assert.equal(row.claimClass, "unclassified");
});

test("a watchlist row's claim note is the backend's own evidence_note, verbatim -- never recomposed", () => {
  const note = "A named party alleges this hull is involved in something.";
  const row = buildSanctionsBoardRows([vessel({ watchlist: watchlistHit({ evidence_note: note }) })], [])[0];
  assert.equal(row.claimNote, note);
});

// Review fix: OFAC rows used to carry `undated: false`, so undatedNote()
// never fired for them -- an OFAC row read as more current than it is,
// purely by the absence of the caveat a watchlist row always carried. Both
// sources' listings are undated in this pipeline; the reason differs per
// source, and both wordings below are pinned so neither can silently drift
// back into implying one source is dated and the other is not, or into
// implying "old"/"stale" instead of merely "unknown."

test("an OFAC vessel row is undated, same as a watchlist row -- the asymmetry this was fixed for", () => {
  const ofacRow = buildSanctionsBoardRows([vessel({ sanctions: ofacVesselHit() })], [])[0];
  assert.equal(ofacRow.undated, true);
  const wlRow = buildSanctionsBoardRows([vessel({ watchlist: watchlistHit() })], [])[0];
  assert.equal(wlRow.undated, true);
});

test("an OFAC aircraft row is undated too", () => {
  const row = buildSanctionsBoardRows([], [aircraft({ sanctions: ofacAircraftHit() })])[0];
  assert.equal(row.undated, true);
});

test("undatedNote pins the exact OFAC unknown-date sentence, distinct from OpenSanctions' own", () => {
  const ofacRow = buildSanctionsBoardRows([vessel({ sanctions: ofacVesselHit() })], [])[0];
  assert.equal(
    undatedNote(ofacRow),
    "OFAC's SDN list carries no per-entry date through this pipeline, so when this entry was added or "
      + "last revised is not known here."
  );

  const wlRow = buildSanctionsBoardRows([vessel({ watchlist: watchlistHit({ undated: true }) })], [])[0];
  assert.equal(
    undatedNote(wlRow),
    "This dataset carries no dates at all, by its own account -- a listing from years ago and one "
      + "made this week are indistinguishable rows in it."
  );

  // The two reasons are worded differently -- OFAC's pipeline simply carries
  // no date field, OpenSanctions' own file states outright it dates nothing
  // -- so a reader is never given one borrowed sentence for both.
  assert.notEqual(undatedNote(ofacRow), undatedNote(wlRow));
});

test("neither unknown-date sentence says or implies the listing is old or stale", () => {
  const ofacRow = buildSanctionsBoardRows([vessel({ sanctions: ofacVesselHit() })], [])[0];
  const wlRow = buildSanctionsBoardRows([vessel({ watchlist: watchlistHit({ undated: true }) })], [])[0];
  for (const text of [undatedNote(ofacRow), undatedNote(wlRow)]) {
    assert.doesNotMatch(text, /\bstale\b/i);
    assert.doesNotMatch(text, /\bold\b/i);
    assert.doesNotMatch(text, /out of date/i);
  }
});

test("undatedNote is empty only for a row that is not undated at all", () => {
  const row = { ...buildSanctionsBoardRows([vessel({ sanctions: ofacVesselHit() })], [])[0], undated: false };
  assert.equal(undatedNote(row), "");
});

// --- listedAsLine / lastSeenLine / positionLine / canLocate ---------------

test("listedAsLine reports the source's own listed name, or says it was not stated", () => {
  const row = buildSanctionsBoardRows([vessel({ sanctions: ofacVesselHit({ listed_as: "MV RENAMED" }) })], [])[0];
  assert.equal(listedAsLine(row), "Listed as: MV RENAMED");
  const noName = buildSanctionsBoardRows([vessel({ sanctions: ofacVesselHit({ listed_as: null }) })], [])[0];
  assert.match(listedAsLine(noName), /not stated/);
});

test("lastSeenLine reads the entity's own last position report, never the listing's date", () => {
  const row = buildSanctionsBoardRows([vessel({ updated: 1786430000, sanctions: ofacVesselHit() })], [])[0];
  assert.match(lastSeenLine(row), /ago/);
  assert.match(lastSeenLine(row), /UTC/);
});

test("lastSeenLine says the report time is not stated rather than printing a bad date", () => {
  const row = buildSanctionsBoardRows([vessel({ updated: null, sanctions: ofacVesselHit() })], [])[0];
  assert.equal(lastSeenLine(row), "Last position report: not stated by the feed");
});

test("canLocate/positionLine agree with each other and with a real lat/lon", () => {
  const row = buildSanctionsBoardRows([vessel({ lat: 10, lon: 20, sanctions: ofacVesselHit() })], [])[0];
  assert.equal(canLocate(row), true);
  assert.equal(positionLine(row), "10.00, 20.00");
});

test("canLocate is false and positionLine says so when a position is missing", () => {
  const row = buildSanctionsBoardRows([vessel({ lat: null, lon: null, sanctions: ofacVesselHit() })], [])[0];
  assert.equal(canLocate(row), false);
  assert.equal(positionLine(row), "position not stated");
});

// --- provenance: two separate claims, never "measured" or "inferred" -----

test("LISTING_PROVENANCE is reported and MATCH_PROVENANCE is derived, never measured or inferred", () => {
  assert.equal(LISTING_PROVENANCE, "reported");
  assert.equal(MATCH_PROVENANCE, "derived");
});

test("every row carries both provenance words explicitly, for both sources", () => {
  const ofacRow = buildSanctionsBoardRows([vessel({ sanctions: ofacVesselHit() })], [])[0];
  assert.equal(ofacRow.listingProvenance, "reported");
  assert.equal(ofacRow.matchProvenance, "derived");
  const wlRow = buildSanctionsBoardRows([vessel({ watchlist: watchlistHit() })], [])[0];
  assert.equal(wlRow.listingProvenance, "reported");
  assert.equal(wlRow.matchProvenance, "derived");
});

test("provenanceLine states who reported the listing and what identifier the match was derived from", () => {
  const row = buildSanctionsBoardRows([vessel({ sanctions: ofacVesselHit({ matched_on: "imo" }) })], [])[0];
  const line = provenanceLine(row);
  assert.match(line, /reported/);
  assert.match(line, /derived/);
  assert.match(line, /OFAC/);
  assert.match(line, /IMO number/);
  assert.doesNotMatch(line, /measured/);
  assert.doesNotMatch(line, /\binferred\b/);
});

// --- sortSanctionsBoard -----------------------------------------------

test("sorts by last seen, most recent first by default", () => {
  const rows = [
    { id: "a", updated: 100 }, { id: "b", updated: 300 }, { id: "c", updated: 200 },
  ];
  assert.deepEqual(sortSanctionsBoard(rows, "updated").map((r) => r.id), ["b", "c", "a"]);
});

test("sorts ascending when asked", () => {
  const rows = [{ id: "a", updated: 100 }, { id: "b", updated: 300 }];
  assert.deepEqual(sortSanctionsBoard(rows, "updated", "asc").map((r) => r.id), ["a", "b"]);
});

test("a row with no last-seen time sorts below every real timestamp", () => {
  const rows = [{ id: "no_time", updated: undefined }, { id: "old", updated: 1 }];
  assert.deepEqual(sortSanctionsBoard(rows, "updated", "desc").map((r) => r.id), ["old", "no_time"]);
});

test("sorts by name alphabetically", () => {
  const rows = [{ id: "z", name: "Zed" }, { id: "b", name: "Black" }];
  assert.deepEqual(sortSanctionsBoard(rows, "name", "asc").map((r) => r.id), ["b", "z"]);
});

test("ties break on id, so two rows tied on the sort key hold a stable order", () => {
  const rows = [{ id: "z", updated: 5 }, { id: "a", updated: 5 }];
  assert.deepEqual(sortSanctionsBoard(rows, "updated").map((r) => r.id), ["a", "z"]);
});

test("sorting never mutates the array it was given", () => {
  const rows = [{ id: "a", updated: 1 }, { id: "b", updated: 2 }];
  const original = [...rows];
  sortSanctionsBoard(rows, "updated");
  assert.deepEqual(rows, original);
});

test("an unknown sort key falls back to updated rather than throwing", () => {
  const rows = [{ id: "a", updated: 1 }, { id: "b", updated: 2 }];
  assert.deepEqual(sortSanctionsBoard(rows, "not_a_real_key").map((r) => r.id), ["b", "a"]);
});

test("SANCTIONS_BOARD_SORT_KEYS lists every axis the panel can sort by", () => {
  assert.deepEqual(SANCTIONS_BOARD_SORT_KEYS.sort(), ["name", "updated"]);
});

// --- feedState / boardCoverage / classifyBoardStatus / emptyStateText -----
// The empty-state discipline: "found nothing" must never render like "did
// not look." Four distinguishable situations, all producing a zero-row board.

test("feedState: an absent or non-object health entry is unknown", () => {
  assert.equal(feedState(undefined), FEED_STATE.UNKNOWN);
  assert.equal(feedState(null), FEED_STATE.UNKNOWN);
});

test("feedState: last_success null means this source has never completed a poll", () => {
  assert.equal(feedState({ last_success: null, item_count: 0 }), FEED_STATE.NOT_LOADED);
});

test("feedState: succeeded at least once but currently empty is loaded_empty, not not_loaded", () => {
  assert.equal(feedState({ last_success: 1786430000, item_count: 0 }), FEED_STATE.LOADED_EMPTY);
});

test("feedState: succeeded and currently holds items is loaded", () => {
  assert.equal(feedState({ last_success: 1786430000, item_count: 1866 }), FEED_STATE.LOADED);
});

function health(overrides = {}) {
  return {
    ais: { last_success: null, item_count: 0 },
    adsb: { last_success: 1786430000, item_count: 11367 },
    sanctions: { last_success: 1786430000, item_count: 1866 },
    maritime_watchlists: { last_success: 1786430000, item_count: 9195 },
    ...overrides,
  };
}

test("boardCoverage reads all four feeds this board depends on", () => {
  const cov = boardCoverage(health());
  assert.deepEqual(cov, {
    vessels: FEED_STATE.NOT_LOADED,
    aircraft: FEED_STATE.LOADED,
    ofac: FEED_STATE.LOADED,
    opensanctions: FEED_STATE.LOADED,
  });
});

test("classifyBoardStatus: before /api/health has ever answered, the board is loading", () => {
  assert.equal(classifyBoardStatus({}), BOARD_STATUS.LOADING);
});

test("classifyBoardStatus: neither reference list loaded -- nothing could have matched", () => {
  const h = health({
    sanctions: { last_success: null, item_count: 0 },
    maritime_watchlists: { last_success: null, item_count: 0 },
  });
  assert.equal(classifyBoardStatus(h), BOARD_STATUS.NO_REFERENCE_DATA);
});

test("classifyBoardStatus: at least one reference list loaded is ready, even if the other is not", () => {
  const h = health({ maritime_watchlists: { last_success: null, item_count: 0 } });
  assert.equal(classifyBoardStatus(h), BOARD_STATUS.READY);
});

test("emptyStateText: a non-empty board has nothing to say -- null, the row list renders instead", () => {
  assert.equal(emptyStateText(health(), 3), null);
});

test("emptyStateText: loading state says so before guessing at a reason", () => {
  assert.match(emptyStateText({}, 0), /checking/i);
});

test("emptyStateText: neither reference list loaded reads as 'cannot say', never 'clean'", () => {
  const h = health({
    sanctions: { last_success: null, item_count: 0 },
    maritime_watchlists: { last_success: null, item_count: 0 },
  });
  const text = emptyStateText(h, 0);
  assert.match(text, /cannot say/i);
});

test("emptyStateText: reference lists loaded but the vessel feed has not -- says so per feed, not just 'empty'", () => {
  // This is the actual state of the dev instance this task was built
  // against: ADS-B has traffic, AIS has not received a frame yet.
  const text = emptyStateText(health(), 0);
  assert.match(text, /AIS vessel feed: not loaded yet/);
  assert.match(text, /ADS-B aircraft feed: 11,367 loaded/);
});

test("emptyStateText: everything loaded and genuinely zero matches is distinguishable from the other two cases", () => {
  const h = health({ ais: { last_success: 1786430000, item_count: 500 } });
  const text = emptyStateText(h, 0);
  assert.match(text, /AIS vessel feed: 500 loaded/);
  assert.doesNotMatch(text, /cannot say/i);
  assert.doesNotMatch(text, /checking/i);
});

test("coverageLine: a feed that loaded but is currently empty reads as 'loaded, currently empty', not 'not loaded'", () => {
  const h = health({ ais: { last_success: 1786430000, item_count: 0 } });
  assert.match(coverageLine(h), /AIS vessel feed: loaded, currently empty/);
});
