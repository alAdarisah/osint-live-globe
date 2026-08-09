// Task 14: flagForMmsi (frontend/src/utils/mmsi.js).
//
// mmsi.js touches nothing but plain strings and numbers, so no window.L stub
// or module-resolution shim is needed beyond Node's own ESM loader -- and even
// that needs help, since every src file in this project uses Vite-style
// extensionless relative imports.

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

const { flagForMmsi } = await import("../src/utils/mmsi.js");

// ---------- ordinary ship station (9 digits, MID is the first three) ----------

test("flagForMmsi: a spread of ordinary-ship MIDs resolve to their flag state", () => {
  assert.deepEqual(flagForMmsi(366999999), { mid: "366", country: "United States of America" });
  assert.deepEqual(flagForMmsi(431012345), { mid: "431", country: "Japan" });
  assert.deepEqual(flagForMmsi(636123456), { mid: "636", country: "Liberia" });
  assert.deepEqual(flagForMmsi(538001234), { mid: "538", country: "Marshall Islands" });
  assert.deepEqual(flagForMmsi(419555000), { mid: "419", country: "India" });
  assert.deepEqual(flagForMmsi(525111222), { mid: "525", country: "Indonesia" });
});

test("flagForMmsi: a string MMSI resolves the same way as a number", () => {
  assert.deepEqual(flagForMmsi("366999999"), { mid: "366", country: "United States of America" });
});

// ---------- unallocated MID ----------

test("flagForMmsi: a MID in the real 2-7 range but not in the table is unallocated, not a guess", () => {
  // 260 sits between Norway's 259 and Poland's 261 and is not itself
  // assigned in the ITU table this module carries.
  assert.equal(flagForMmsi(260123456), null);
});

// ---------- malformed MMSI ----------

test("flagForMmsi: non-numeric, wrong-length and negative input all return null", () => {
  assert.equal(flagForMmsi("ABC123456"), null); // not digits
  assert.equal(flagForMmsi("12345"), null);      // too short for any real form
  assert.equal(flagForMmsi("1234567890"), null); // too long for any real form
  assert.equal(flagForMmsi(-366999999), null);   // MMSIs are never negative
  assert.equal(flagForMmsi(366999999.5), null);  // MMSIs are never fractional
  assert.equal(flagForMmsi(null), null);
  assert.equal(flagForMmsi(undefined), null);
});

test("flagForMmsi: a 9-digit number with a reserved, unidentifiable prefix returns null", () => {
  // Starts "1" but not "111" -- not the SAR-aircraft form, and 1 is never a
  // real MID's first digit either.
  assert.equal(flagForMmsi(199123456), null);
  // Starts "9" but not "99" -- not the AtoN form, same reasoning.
  assert.equal(flagForMmsi(912345678), null);
});

// ---------- the forms that lose a leading zero as a plain integer ----------

test("flagForMmsi: 9-digit ordinary ship and 8-digit group-call forms both resolve", () => {
  // Ordinary ship station: MID is the first three digits outright.
  assert.deepEqual(flagForMmsi(234567890), { mid: "234", country: "United Kingdom" });
  // Group ship call (0MIDXXXXX) stored as a JSON number loses its leading
  // zero and arrives as an 8-digit value -- MID is still the first three.
  assert.deepEqual(flagForMmsi(23456789), { mid: "234", country: "United Kingdom" });
});

test("flagForMmsi: a coast station (00MIDXXXX) loses both leading zeros, arriving as 7 digits", () => {
  assert.deepEqual(flagForMmsi(2341234), { mid: "234", country: "United Kingdom" });
});

// ---------- forms whose MID sits away from the front, at full width ----------

test("flagForMmsi: SAR aircraft (111MIDXXX) reads the MID after the fixed 111 prefix", () => {
  assert.deepEqual(flagForMmsi("111234567"), { mid: "234", country: "United Kingdom" });
});

test("flagForMmsi: AtoN (99MIDXXXX) reads the MID after the fixed 99 prefix", () => {
  assert.deepEqual(flagForMmsi("992341234"), { mid: "234", country: "United Kingdom" });
});

test("flagForMmsi: craft associated with a parent ship (98MIDXXXX) reads the MID after the fixed 98 prefix", () => {
  assert.deepEqual(flagForMmsi("982341234"), { mid: "234", country: "United Kingdom" });
});

test("flagForMmsi: a bare leading 8 (not '98') is a handheld VHF allocation this module doesn't parse, not craft-associated", () => {
  // "81..." starts with 8 but its second digit isn't 9, so this is not the
  // 98MIDXXXX craft-associated form -- and reading it as one (treating "1"
  // through "9" as if it were the fixed "9" of "98") would print a flag for
  // a station this module has no business identifying. Must return null,
  // never a guessed country.
  assert.equal(flagForMmsi("812345678"), null);
});

test("flagForMmsi: an 8-digit value that doesn't start with a real MID digit is malformed, not a group call", () => {
  // A group call's remaining digits after the dropped zero always start with
  // a real MID (2-7); "99999999" starts with 9, which is never a MID digit.
  assert.equal(flagForMmsi(99999999), null);
});
