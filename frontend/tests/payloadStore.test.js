// The persistent payload cache, and the one rule that keeps it honest.
//
// api.js's ETag table is a module-level Map, so a reload started with nothing to
// send and the server had no choice but to hand back every body again -- 5.7 MB
// over the wire and 26 MB of JSON parsed on the main thread, measured on the
// deployment, every time the page was opened. The ETags now outlive the tab.
//
// The rule: a stored copy is only ever used when the server has said, for that
// exact ETag, that it is still current. A persistent cache that decided freshness
// for itself would be a source of quietly stale maps, which on this map is worse
// than being slow.
//
// IndexedDB does not exist under `node --test`, and that is itself the first
// thing worth pinning: every function has to answer "no cached copy" rather than
// throw, or the whole app stops loading wherever storage is unavailable -- a
// private window, a policy-locked browser, this test runner.

import test from "node:test";
import assert from "node:assert/strict";

import { readPayload, writePayload, prune, clearAll } from "../src/utils/payloadStore.js";
import { fetchJson } from "../src/api.js";

test("every entry point degrades to a no-op where IndexedDB is absent", async () => {
  assert.equal(typeof globalThis.indexedDB, "undefined", "this test needs no IndexedDB");
  assert.equal(await readPayload("/api/anything"), null);
  assert.equal(await writePayload("/api/anything", '"tag"', { a: 1 }), null);
  assert.equal(await prune(), null);
  assert.equal(await clearAll(), null);
});

test("a payload with no ETag is never stored", async () => {
  // There is nothing to validate it against later, so keeping it would be keeping
  // a copy that could only ever be served unchecked.
  assert.equal(await writePayload("/api/no-etag", null, { a: 1 }), null);
  assert.equal(await writePayload("/api/no-etag", "", { a: 1 }), null);
});

test("a fetch still works with no storage behind it", async () => {
  // The whole point of the degradation: the app runs exactly as it did before this
  // file existed.
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { ETag: '"abc"' },
  });
  try {
    assert.deepEqual(await fetchJson("/api/test-no-idb"), { ok: true });
  } finally {
    globalThis.fetch = original;
  }
});

test("a stored ETag is sent back, and a 304 answers from the stored copy", async () => {
  // The behaviour the whole file exists for, exercised against a fake store: a
  // reload sends If-None-Match for a URL it has never fetched in this page's
  // lifetime, and gets no body back.
  const store = new Map();
  const { readPayload: read, writePayload: write } = fakeStore(store);

  // First visit: no stored copy, full body, and the payload is kept.
  let sentHeaders = null;
  let served = 0;
  const fetchImpl = async (url, init) => {
    sentHeaders = init?.headers || null;
    served += 1;
    if (sentHeaders?.["If-None-Match"] === '"v1"') {
      // Hand-built rather than `new Response(..., {status: 304})`: 304 is a
      // null-body status and the Response constructor refuses it outright. Only
      // the three members the code under test reads are needed.
      return notModified('"v1"');
    }
    return new Response(JSON.stringify({ big: "payload" }), {
      status: 200, headers: { ETag: '"v1"' },
    });
  };

  const first = await simulate(fetchImpl, read, write, "/api/big");
  assert.deepEqual(first, { big: "payload" });
  assert.equal(store.size, 1, "nothing was persisted");

  // Second visit, fresh page: the memory table is empty, the store is not.
  const second = await simulate(fetchImpl, read, write, "/api/big");
  assert.deepEqual(second, { big: "payload" });
  assert.equal(sentHeaders["If-None-Match"], '"v1"');
  assert.equal(served, 2, "the second visit should still ask, just not download");
});

test("a changed ETag replaces the stored copy rather than serving the old one", async () => {
  const store = new Map();
  const { readPayload: read, writePayload: write } = fakeStore(store);
  const v1 = async () => new Response(JSON.stringify({ v: 1 }), { status: 200, headers: { ETag: '"a"' } });
  const v2 = async () => new Response(JSON.stringify({ v: 2 }), { status: 200, headers: { ETag: '"b"' } });

  assert.deepEqual(await simulate(v1, read, write, "/api/changing"), { v: 1 });
  assert.deepEqual(await simulate(v2, read, write, "/api/changing"), { v: 2 });
  assert.equal(store.get("/api/changing").etag, '"b"');
  assert.deepEqual(store.get("/api/changing").data, { v: 2 });
});

test("an entry past its age bound is not used", async () => {
  // Housekeeping rather than a freshness rule -- the server's ETag decides that --
  // but a URL the app stopped asking for must not hold storage quota for ever.
  const store = new Map();
  const { readPayload: read } = fakeStore(store);
  store.set("/api/ancient", { etag: '"old"', data: { a: 1 }, storedAt: Date.now() - 8 * 24 * 3600 * 1000 });
  assert.equal(await read("/api/ancient"), null);
});

// --- the fake -------------------------------------------------------------
//
// A Map standing in for the object store, with the same two rules the real one
// has: no ETag means no write, and an entry past a week is not returned.

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** A 304, which the Response constructor will not build. */
function notModified(etag) {
  return {
    status: 304,
    headers: { get: (name) => (name.toLowerCase() === "etag" ? etag : null) },
    json: async () => { throw new Error("a 304 has no body to read"); },
  };
}

function fakeStore(map) {
  return {
    async readPayload(url) {
      const row = map.get(url);
      if (!row || !row.etag) return null;
      if (Date.now() - (row.storedAt || 0) > MAX_AGE_MS) return null;
      return { etag: row.etag, data: row.data };
    },
    async writePayload(url, etag, data) {
      if (!etag) return null;
      map.set(url, { url, etag, data, storedAt: Date.now() });
      return true;
    },
  };
}

/** fetchJson's logic against injected collaborators -- a fresh page each call. */
async function simulate(fetchImpl, read, write, url) {
  const cached = await read(url);
  const headers = cached?.etag ? { "If-None-Match": cached.etag } : undefined;
  const resp = await fetchImpl(url, { headers });
  if (resp.status === 304 && cached) return cached.data;
  const data = await resp.json();
  const etag = resp.headers.get("ETag");
  if (etag) await write(url, etag, data);
  return data;
}
