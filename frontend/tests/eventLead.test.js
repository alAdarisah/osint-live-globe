// One event, four surfaces, one sentence.
//
// The map's tooltip, the map's popup, the detail card's <h3> and the intel feed's
// row all say what a fused event is. Three of them agreed; the feed fell back to
// `actor1 vs actor2` where the others fall back to `summary`. That looks like a
// cosmetic difference and is not, because of when each field exists:
// event_fusion.py writes `summary` only when `notes` is absent, so the fallback
// *is* the case that matters, and the feed was always the vaguer of the two.
//
// The equality below is the real requirement, so it is what gets asserted --
// rather than four separate expectations that could each be "right" while
// disagreeing.

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Every src file uses Vite-style extensionless relative imports, which Node's
// resolver cannot follow -- and a static import here would be resolved before
// this hook was installed, so the modules under test are pulled in dynamically
// below. Same arrangement as eventDetail.test.js, which this file sits beside.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
      return next(`${specifier}.js`, context);
    }
    return next(specifier, context);
  },
});

const { eventLeadLine, eventLeadKind, recordCardTitle, EVENT_FAMILY_FALLBACK } =
  await import("../src/map/eventLead.js");
const { buildHeaderBlock } = await import("../src/map/eventDetail.js");

/** The four precedence cases, as records. */
const CASES = {
  headline: {
    notes: "Drone strike on an oil depot kills 13, officials say",
    summary: null,
    event_type: "Use of conventional force",
    actor1: "RUSSIA",
    actor2: "CIVILIAN",
  },
  summaryOnly: {
    notes: null,
    summary: "Russian armed forces used armed force against Civilian in Kharkiv, Ukraine.",
    event_type: "Use of conventional force",
    actor1: "RUSSIA",
    actor2: "CIVILIAN",
  },
  familyOnly: {
    notes: null,
    summary: null,
    event_type: "Unconventional violence",
    actor1: "UNKNOWN",
    actor2: null,
  },
  nothing: { notes: null, summary: null, event_type: null },
};

test("the headline wins, then the coded sentence, then the family", () => {
  assert.equal(eventLeadLine(CASES.headline), CASES.headline.notes);
  assert.equal(eventLeadLine(CASES.summaryOnly), CASES.summaryOnly.summary);
  assert.equal(eventLeadLine(CASES.familyOnly), "Unconventional violence");
  assert.equal(eventLeadLine(CASES.nothing), EVENT_FAMILY_FALLBACK);
});

test("whitespace is not content", () => {
  // A scrape that returned an empty <h1> must fall through to the summary rather
  // than render a blank line where the headline goes.
  assert.equal(
    eventLeadLine({ notes: "   \n ", summary: "A sentence.", event_type: "X" }),
    "A sentence.",
  );
  assert.equal(eventLeadLine({ notes: "", summary: "  ", event_type: "X" }), "X");
});

test("the actors are never the lead", () => {
  // The regression this module exists to end. `actor1 vs actor2` names the
  // parties and not the act -- "Russian armed forces vs Civilians" could be a
  // strike, a statement or a negotiation -- and it was chosen in preference to a
  // sentence that says which.
  const lead = eventLeadLine(CASES.summaryOnly);
  assert.doesNotMatch(lead, / vs /);
  assert.match(lead, /Kharkiv/);
});

test("the detail card's headline is the same string the feed row uses", () => {
  // buildHeaderBlock is the card's own builder and the only one of the four that
  // can be exercised headlessly; the other three call eventLeadLine directly, so
  // asserting this one against it covers the agreement end to end.
  for (const [name, record] of Object.entries(CASES)) {
    const html = buildHeaderBlock({ ...record, date: "2026-08-17", coverage: [] });
    const h3 = html.match(/<h3>([\s\S]*?)<\/h3>/);
    assert.ok(h3, `${name}: the header block has no <h3>`);
    // The card escapes for HTML; compare on the escaped form of the same source.
    const expected = eventLeadLine(record).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    assert.equal(h3[1], expected, `${name}: the card and the row disagree`);
  }
});

test("the provenance word tracks which field was used", () => {
  // The card already says "reported" / "derived" / "inferred" beside the lead,
  // and a reader has to be able to tell a quoted headline from a sentence this
  // pipeline assembled. That mapping is the same decision as the precedence, so
  // it lives with it.
  assert.equal(eventLeadKind(CASES.headline), "reported");
  assert.equal(eventLeadKind(CASES.summaryOnly), "derived");
  assert.equal(eventLeadKind(CASES.familyOnly), "inferred");
  assert.equal(eventLeadKind(CASES.nothing), "inferred");
});

test("the detail card names the record it opened, whatever kind that is", () => {
  // It rendered the literal "Event detail" for every record of every layer,
  // because it reads detail.title and no decorator has ever returned one.
  assert.equal(recordCardTitle("events", CASES.headline), CASES.headline.notes);
  assert.equal(recordCardTitle("ais", { name: "EVER GIVEN", callsign: "H3RC" }), "EVER GIVEN");
  assert.equal(recordCardTitle("adsb", { name: null, callsign: "RCH471" }), "RCH471");
  assert.equal(recordCardTitle("officials", { headline: "Ministry summons envoy" }), "Ministry summons envoy");

  // Nothing to name it with: null, so the caller keeps its own fallback rather
  // than this inventing something. A fabricated title on a record that carries no
  // name would be the one outcome worse than a generic one.
  assert.equal(recordCardTitle("firms", { brightness: 320 }), null);
  assert.equal(recordCardTitle("firms", { name: "   " }), null);
});
