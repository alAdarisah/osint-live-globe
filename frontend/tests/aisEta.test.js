// Task 14: the AIS ETA renderer (formatAisEta, in frontend/src/utils/format.js).
//
// format.js touches nothing but plain strings and numbers, so no window.L
// stub is needed here -- only the extensionless-import shim every test file
// in this project needs for Node's own resolver.

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

const { formatAisEta } = await import("../src/utils/format.js");

test("formatAisEta: month, day, hour and minute all present renders a date and a time", () => {
  assert.equal(formatAisEta({ month: 7, day: 14, hour: 6, minute: 30 }), "Jul 14, 06:30");
});

test("formatAisEta: only month and day (no hour/minute broadcast) renders a date with no time", () => {
  assert.equal(formatAisEta({ month: 12, day: 1 }), "Dec 1");
});

test("formatAisEta: midnight (hour 0) and on-the-hour (minute 0) are real values, not 'not available'", () => {
  // ITU-R M.1371 uses 0 as an ordinary hour/minute value -- only 24 and 60
  // are the field's own "not available" sentinels (see below). A formatter
  // that treated 0 as falsy here would drop a real midnight ETA.
  assert.equal(formatAisEta({ month: 3, day: 5, hour: 0, minute: 0 }), "Mar 5, 00:00");
});

// ---------- the "not available" sentinels AIS actually uses ----------

test("formatAisEta: month 13 (out of the 1-12 range) means the whole ETA is unavailable", () => {
  assert.equal(formatAisEta({ month: 13, day: 4, hour: 6, minute: 0 }), null);
});

test("formatAisEta: month 0 means the whole ETA is unavailable", () => {
  assert.equal(formatAisEta({ month: 0, day: 4 }), null);
});

test("formatAisEta: day 0 means the whole ETA is unavailable", () => {
  assert.equal(formatAisEta({ month: 6, day: 0 }), null);
});

test("formatAisEta: day 32 (out of the 1-31 range) means the whole ETA is unavailable", () => {
  assert.equal(formatAisEta({ month: 6, day: 32 }), null);
});

test("formatAisEta: hour 24 is 'not available' for the time only -- the date still renders", () => {
  assert.equal(formatAisEta({ month: 7, day: 14, hour: 24, minute: 30 }), "Jul 14");
});

test("formatAisEta: minute 60 is 'not available' for the time only -- the date still renders", () => {
  assert.equal(formatAisEta({ month: 7, day: 14, hour: 6, minute: 60 }), "Jul 14");
});

// ---------- absent or malformed input ----------

test("formatAisEta: no eta object at all returns null, not a guess", () => {
  assert.equal(formatAisEta(null), null);
  assert.equal(formatAisEta(undefined), null);
});

test("formatAisEta: a non-object eta returns null rather than throwing", () => {
  assert.equal(formatAisEta("not an object"), null);
  assert.equal(formatAisEta(42), null);
});

test("formatAisEta: a fractional month or day is never a real AIS value", () => {
  assert.equal(formatAisEta({ month: 7.5, day: 14 }), null);
  assert.equal(formatAisEta({ month: 7, day: 14.5 }), null);
});

test("formatAisEta: never returns a string that reads as a year", () => {
  const text = formatAisEta({ month: 12, day: 31, hour: 23, minute: 59 });
  assert.doesNotMatch(text, /\b(19|20)\d{2}\b/);
});
