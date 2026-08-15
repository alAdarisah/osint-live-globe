// fetchJson's rejection is the only thing that survives a failed poll, so
// whatever the boot screen wants to say about a failure has to be reachable
// from that error object. Parsing it back out of the message string would tie
// the UI to a log format and would put a full API URL on the splash screen.

import test from "node:test";
import assert from "node:assert/strict";

import { fetchJson } from "../src/api.js";

test("a bad response rejects with its numeric status attached", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 503 });
  try {
    await assert.rejects(
      () => fetchJson("/api/test-bad-status"),
      (err) => {
        assert.equal(err.status, 503);
        // The message is unchanged from what it has always been, so anything
        // already reading it keeps working.
        assert.match(err.message, /\/api\/test-bad-status: 503$/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a transport failure rejects with no status at all", async () => {
  // There was no response, so there is no status. Defaulting to one would let
  // the boot screen report an HTTP error that never happened.
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    await assert.rejects(
      () => fetchJson("/api/test-unreachable"),
      (err) => err.status === undefined
    );
  } finally {
    globalThis.fetch = original;
  }
});
