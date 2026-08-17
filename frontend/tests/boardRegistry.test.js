import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  BOARDS, DEFAULT_OPEN_BOARDS, OPEN_BOARDS_KEY,
  toggleBoard, isBoardOpen, openBoards, loadOpenBoards, saveOpenBoards,
} from "../src/components/chrome/boardRegistry.js";

test("every board still has the tested logic module behind it", () => {
  // The guard this file exists for. Rebuilding a board's rows inside the new
  // chrome and leaving its tested sibling module behind is the easy mistake in
  // a redesign, and it does not show up as a failure anywhere else -- the panel
  // would look right and quietly stop being the thing the tests cover.
  for (const board of BOARDS) {
    const path = fileURLToPath(new URL(`../src/components/${board.logic}`, import.meta.url));
    assert.ok(existsSync(path), `${board.id} names ${board.logic}, which does not exist`);
  }
});

test("the table is well formed and its ids are unique", () => {
  assert.equal(BOARDS.length, 4);
  assert.equal(new Set(BOARDS.map((b) => b.id)).size, BOARDS.length);
  for (const board of BOARDS) {
    assert.ok(board.label, `${board.id} has no label`);
    assert.ok(board.note, `${board.id} has no note`);
  }
});

test("the default open set is one real board", () => {
  // Not none (which would make the Boards menu the only evidence the stack
  // exists) and not all four (which fills the right-hand third of the map
  // before the reader has asked anything).
  assert.equal(DEFAULT_OPEN_BOARDS.length, 1);
  for (const id of DEFAULT_OPEN_BOARDS) {
    assert.ok(BOARDS.some((b) => b.id === id), `${id} is not a board`);
  }
});

test("toggling adds and removes, and is its own inverse", () => {
  const once = toggleBoard([], "cables");
  assert.deepEqual(once, ["cables"]);
  assert.deepEqual(toggleBoard(once, "cables"), []);
  assert.deepEqual(toggleBoard(null, "cables"), ["cables"]);
});

test("the stack's order is the table's, not the order things were switched on", () => {
  // Otherwise the same set of boards can be arranged two ways and the stack
  // appears to shuffle itself when a reader closes one and reopens it.
  const clickedBackwards = ["cables", "airfields", "chokepoints"]
    .reduce((open, id) => toggleBoard(open, id), []);
  assert.deepEqual(clickedBackwards, ["chokepoints", "airfields", "cables"]);
});

test("an unknown id cannot enter the set", () => {
  assert.deepEqual(toggleBoard([], "not-a-board"), []);
});

test("open boards come back as entries, in order", () => {
  const entries = openBoards(["cables", "chokepoints"]);
  assert.deepEqual(entries.map((b) => b.id), ["chokepoints", "cables"]);
  assert.equal(isBoardOpen(["cables"], "cables"), true);
  assert.equal(isBoardOpen(["cables"], "airfields"), false);
  assert.equal(isBoardOpen(null, "cables"), false);
});

test("a stored set survives a round trip", () => {
  let value = null;
  const storage = { getItem: () => value, setItem: (_k, v) => { value = v; } };
  saveOpenBoards(["chokepoints", "cables"], storage);
  assert.deepEqual(loadOpenBoards(storage), ["chokepoints", "cables"]);
});

test("a stored id for a board that no longer exists is dropped", () => {
  // It would otherwise sit in the set forever, counted by the menu and rendered
  // by nothing.
  const storage = { getItem: () => JSON.stringify(["chokepoints", "retired-board"]) };
  assert.deepEqual(loadOpenBoards(storage), ["chokepoints"]);
});

test("corrupt or absent storage falls back to the default, not to empty", () => {
  for (const bad of ["{", "null", '"nope"', "{}"]) {
    assert.deepEqual(loadOpenBoards({ getItem: () => bad }), DEFAULT_OPEN_BOARDS, bad);
  }
  assert.deepEqual(loadOpenBoards(null), DEFAULT_OPEN_BOARDS);
});

test("a storage that refuses to write does not throw out", () => {
  // Private mode, or a full quota -- the same bargain every other stored
  // preference in this app strikes: it works for the session, it is just not
  // remembered.
  const full = { setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.equal(saveOpenBoards(["cables"], full), false);
  assert.equal(saveOpenBoards(["cables"], null), true);
});

test("the storage key is its own", () => {
  assert.equal(OPEN_BOARDS_KEY, "osint-open-boards");
});
