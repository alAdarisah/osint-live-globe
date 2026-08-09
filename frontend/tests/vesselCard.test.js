// Task 17: the two vessel-card sections (Cargo, Port calls) decorateAis adds
// to the ship popup, and decoratePort's "Recent arrivals and departures"
// sibling. Both are fed by a fetch that lands after the popup is already
// open (see createMapController.js's loadVesselDetail/loadPortTraffic), so
// what these tests hold the line on is that every state that fetch can be in
// -- absent/"loading", "error", "ready" -- renders something honest rather
// than nothing: the brief requires a failure to say "unavailable", not
// silently vanish, and requires the cargo fold to open with AIS's own
// limits before it says anything inferred.
//
// map/decorators.js pulls in map/leafletGlobal.js (reads `window.L` at
// module scope) and map/svgIcons.js's buildDivIcon (calls L.divIcon), so this
// stubs just enough of window.L to satisfy those imports, the same way
// waterCard.test.js and pinZoom.test.js do. Nothing here touches Leaflet or
// the DOM otherwise -- only decorateAis/decoratePort's returned `.detail`
// HTML string is asserted on.

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

globalThis.window = {
  L: {
    geoJSON: () => ({}),
    divIcon: (opts) => ({ options: opts }),
  },
};

const { decorateAis, decoratePort } = await import("../src/map/decorators.js");

const MMSI = "244660724";
const SHIP = { mmsi: MMSI, name: "MV Test Hull", ship_type: 70 };

const PROFILE = {
  mmsi: MMSI,
  cargo_class: "tanker",
  laden_state: "laden",
  laden_state_reason: null,
  draught_current: 14.2,
  draught_max_seen: 14.5,
  draught_min_seen: 8.1,
  sample_count: 12,
  laden_threshold: 0.85,
  ballast_threshold: 0.55,
  min_sample_threshold: 5,
  implied_trade: "Implied only from AIS, not a cargo manifest: last port call was Test Port. No commodity is asserted.",
  updated: 1_700_000_000,
};

const PORT_CALL = {
  mmsi: MMSI, port_id: "test-port", port_name: "Test Port", port_country: "Testland",
  arrived_at: 1_699_000_000, departed_at: 1_699_010_000,
  draught_in: 14.3, draught_out: 9.9, confidence: "exact",
};

const CONFIDENCE_RADII = { exact: 3.0, proximity: 15.0, inferred: 50.0 };

// --- decorateAis: Cargo (inferred) + Port calls ------------------------------

test("an unselected ship's popup carries neither new section at all", () => {
  const { detail } = decorateAis(SHIP, { selectedMmsi: "000000000" });
  assert.doesNotMatch(detail, /Cargo \(inferred\)/);
  assert.doesNotMatch(detail, /Port calls/);
});

test("a selected ship with no vesselDetail yet shows loading, not nothing", () => {
  const { detail } = decorateAis(SHIP, { selectedMmsi: MMSI, vesselDetail: undefined });
  assert.match(detail, /Cargo \(inferred\)/);
  assert.match(detail, /AIS does not broadcast cargo/);
  assert.match(detail, /Port calls/);
  // Two "Loading" sections -- cargo and port calls both wait on the same
  // fetch, and neither may claim an answer it does not have yet.
  assert.equal((detail.match(/Loading/g) || []).length, 2);
});

test("a failed fetch says unavailable in both new sections, per the brief", () => {
  const { detail } = decorateAis(SHIP, { selectedMmsi: MMSI, vesselDetail: { status: "error" } });
  assert.match(detail, /Cargo inference unavailable/);
  assert.match(detail, /Port-call history unavailable/);
});

test("a ready profile shows cargo class, laden verdict, thresholds and sample count", () => {
  const vesselDetail = {
    status: "ready",
    data: { profile: PROFILE, port_calls: [PORT_CALL], open_call: null, confidence_radius_km: CONFIDENCE_RADII },
  };
  const { detail } = decorateAis(SHIP, { selectedMmsi: MMSI, vesselDetail });
  assert.match(detail, /Tanker/);
  assert.match(detail, /Laden/);
  assert.match(detail, /85%/); // laden threshold
  assert.match(detail, /55%/); // ballast threshold
  assert.match(detail, /12 samples/);
  assert.match(detail, /No commodity is asserted/);
});

test("a hull with no profile yet says so rather than showing a blank fold", () => {
  const vesselDetail = { status: "ready", data: { profile: null, port_calls: [], open_call: null } };
  const { detail } = decorateAis(SHIP, { selectedMmsi: MMSI, vesselDetail });
  assert.match(detail, /No inferred profile held for this hull yet/);
});

test("the port-calls table carries the row's confidence and the distance it stands for", () => {
  const vesselDetail = {
    status: "ready",
    data: { profile: PROFILE, port_calls: [PORT_CALL], open_call: null, confidence_radius_km: CONFIDENCE_RADII },
  };
  const { detail } = decorateAis(SHIP, { selectedMmsi: MMSI, vesselDetail });
  assert.match(detail, /Test Port/);
  assert.match(detail, /Testland/);
  assert.match(detail, /exact/);
  // The confidence tier alone never claims berth contact -- the radius
  // behind it (from confidence_radius_km) has to be visible too.
  assert.match(detail, /within 3 km/);
});

test("an open call is called out on its own line, not just as a row with no departure", () => {
  const vesselDetail = {
    status: "ready",
    data: {
      profile: PROFILE, port_calls: [{ ...PORT_CALL, departed_at: null }],
      open_call: { ...PORT_CALL, departed_at: null }, confidence_radius_km: CONFIDENCE_RADII,
    },
  };
  const { detail } = decorateAis(SHIP, { selectedMmsi: MMSI, vesselDetail });
  assert.match(detail, /Currently in port/);
  assert.match(detail, /still in port/); // the table row's own dwell cell
});

// --- decoratePort: Recent arrivals and departures ---------------------------

const PORT_ITEM = { id: "test-port", name: "Test Port", country: "Testland" };

test("a port popup with no traffic fetch yet shows loading, not nothing", () => {
  const { detail } = decoratePort(PORT_ITEM, { portDetail: undefined });
  assert.match(detail, /Recent arrivals and departures/);
  assert.match(detail, /Loading/);
});

test("a failed port-traffic fetch says unavailable", () => {
  const { detail } = decoratePort(PORT_ITEM, { portDetail: { status: "error" } });
  assert.match(detail, /Recent traffic unavailable/);
});

test("a ready port-traffic answer lists the vessel and its confidence radius", () => {
  const portDetail = {
    status: "ready",
    data: {
      port_calls: [{ ...PORT_CALL, vessel_name: "MV Test Hull" }],
      confidence_radius_km: CONFIDENCE_RADII,
    },
  };
  const { detail } = decoratePort(PORT_ITEM, { portDetail });
  assert.match(detail, /MV Test Hull/);
  assert.match(detail, /within 3 km/);
});
