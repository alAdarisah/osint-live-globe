import test from "node:test";
import assert from "node:assert/strict";

import {
  WATCHLIST_KEY, MAX_ITEMS,
  watchKey, normalizeEntry, loadWatchlist, saveWatchlist,
  addWatch, removeWatch, isWatched,
} from "../src/utils/watchlist.js";

/** A localStorage-shaped object, optionally one that refuses to write. */
function fakeStorage(initial = null, { full = false } = {}) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      if (full) throw new Error("QuotaExceededError");
      value = next;
    },
    read: () => value,
  };
}

const ENTRY = { kind: "events", id: "acled-1", label: "Artillery, Kupiansk", lat: 49.7, lon: 37.6 };

test("an entry needs the two things that make it openable", () => {
  // kind and id are how a row asks for the same detail card a map pin opens
  // (recordDetail(kind, id)). Without both there is nothing to open and nothing
  // to deduplicate against, so the entry is refused rather than stored broken.
  assert.ok(normalizeEntry(ENTRY));
  assert.equal(normalizeEntry({ id: "x" }), null);
  assert.equal(normalizeEntry({ kind: "events" }), null);
  assert.equal(normalizeEntry({ kind: "  ", id: "x" }), null);
  assert.equal(normalizeEntry(null), null);
  assert.equal(normalizeEntry("nope"), null);
});

test("a position that does not exist stays null rather than becoming 0,0", () => {
  // A country or an aggregate is a legitimate thing to pin and has no single
  // point. Storing zeroes would put it in the Gulf of Guinea and the row would
  // happily fly there.
  const noPlace = normalizeEntry({ kind: "country", id: "SDN", label: "Sudan" });
  assert.equal(noPlace.lat, null);
  assert.equal(noPlace.lon, null);

  // ...but a real 0 is a real coordinate and must survive.
  const nullIsland = normalizeEntry({ kind: "events", id: "x", lat: 0, lon: 0 });
  assert.equal(nullIsland.lat, 0);
  assert.equal(nullIsland.lon, 0);
});

test("an entry with no label still says something", () => {
  assert.equal(normalizeEntry({ kind: "adsb", id: "abc123" }).label, "adsb abc123");
});

test("pinning the same record twice changes nothing, by identity", () => {
  // Identity, not just content: the caller uses it to decide whether anything
  // needs writing or repainting, so a fresh array on every duplicate click
  // would make each one a storage write.
  const once = addWatch([], ENTRY);
  assert.equal(once.length, 1);
  const twice = addWatch(once, ENTRY);
  assert.equal(twice, once);
});

test("the newest pin leads, and the ceiling drops the oldest", () => {
  let list = [];
  for (let i = 0; i < MAX_ITEMS + 10; i += 1) {
    list = addWatch(list, { kind: "events", id: `e${i}` });
  }
  assert.equal(list.length, MAX_ITEMS);
  assert.equal(list[0].id, `e${MAX_ITEMS + 9}`, "newest first");
  assert.ok(!list.some((item) => item.id === "e0"), "oldest evicted");
});

test("removing is by key, and a miss changes nothing", () => {
  const list = addWatch([], ENTRY);
  assert.deepEqual(removeWatch(list, watchKey("events", "acled-1")), []);
  assert.equal(removeWatch(list, watchKey("events", "nope")), list);
  assert.equal(removeWatch([], "anything").length, 0);
});

test("the same id under two kinds is two different records", () => {
  // `kind:id` rather than id alone: an AIS hull and a conflict event can
  // perfectly well share an identifier, and pinning one must not shadow the
  // other.
  let list = addWatch([], { kind: "events", id: "7" });
  list = addWatch(list, { kind: "ais", id: "7" });
  assert.equal(list.length, 2);
  assert.equal(isWatched(list, "events", "7"), true);
  assert.equal(isWatched(list, "ais", "7"), true);
  assert.equal(isWatched(list, "adsb", "7"), false);
});

test("a round trip through storage preserves the list", () => {
  const storage = fakeStorage();
  const list = addWatch([], ENTRY);
  assert.equal(saveWatchlist(list, storage), true);
  assert.deepEqual(loadWatchlist(storage), list);
});

test("corrupt storage reads as an empty list, not as a crash", () => {
  // Every one of these is reachable: a hand-edited value, a truncated write, a
  // payload from a future version of the format.
  for (const bad of ["{", "null", "[]", '{"v":1}', '{"v":99,"items":[]}', '{"v":1,"items":"nope"}']) {
    assert.deepEqual(loadWatchlist(fakeStorage(bad)), [], bad);
  }
  assert.deepEqual(loadWatchlist(null), []);
  assert.deepEqual(loadWatchlist({ getItem() { throw new Error("blocked"); } }), []);
});

test("a stored entry that is no longer usable is dropped, not rendered broken", () => {
  const stored = JSON.stringify({
    v: 1,
    items: [ENTRY, { kind: "events" }, null, { id: "orphan" }],
  });
  const list = loadWatchlist(fakeStorage(stored));
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "acled-1");
});

test("a storage that refuses to write does not throw out", () => {
  // Private mode, or a full quota. The list still works for the session; it
  // just will not be remembered -- the same bargain useAccordion and
  // useDraggablePanel already strike.
  assert.equal(saveWatchlist([ENTRY], fakeStorage(null, { full: true })), false);
  assert.equal(saveWatchlist([ENTRY], null), true);
});

test("the storage key is its own, not the panel-layout record", () => {
  // "Reset panel layout" wipes the panel-positions key. A reader who resets
  // where their cards sit has not asked to lose what they were tracking.
  assert.equal(WATCHLIST_KEY, "osint-watchlist");
  assert.notEqual(WATCHLIST_KEY, "osint-panel-positions");
});
