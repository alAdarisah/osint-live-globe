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

// ---------- one request per URL in flight ----------
//
// Measured on a real page load of the deployment before this existed: 67 API
// requests, of which /api/satellites/elements went out six times, /api/chokepoints
// three, and eight more endpoints twice -- all concurrently, from callers that each
// want the same data and cannot see each other. The ETag cache cannot help, because
// it is filled by the response: everything issued before the first one lands misses.
//
// The cost that matters is not the bandwidth. Two callers asking for
// /api/infrastructure at once cost two 8 MB downloads and two 8 MB JSON parses on
// the main thread.

function countingFetch(body, { delayMs = 0, status = 200 } = {}) {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (status !== 200) return new Response("", { status });
    return new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json" },
    });
  };
  return { fn, calls: () => calls };
}

test("concurrent callers for one URL share a single request", async () => {
  const original = globalThis.fetch;
  const { fn, calls } = countingFetch({ ok: 1 }, { delayMs: 10 });
  globalThis.fetch = fn;
  try {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => fetchJson("/api/test-dedupe")),
    );
    assert.equal(calls(), 1, `six callers made ${calls()} requests`);
    // And every one of them gets the payload, not just the first.
    for (const r of results) assert.deepEqual(r, { ok: 1 });
  } finally {
    globalThis.fetch = original;
  }
});

test("callers are handed the same decoded object, not six copies of it", async () => {
  // The parse is the expensive half on a multi-megabyte payload, so sharing the
  // request has to mean sharing the result rather than re-decoding per caller.
  const original = globalThis.fetch;
  const { fn } = countingFetch({ big: [1, 2, 3] }, { delayMs: 5 });
  globalThis.fetch = fn;
  try {
    const [a, b] = await Promise.all([
      fetchJson("/api/test-identity"), fetchJson("/api/test-identity"),
    ]);
    assert.equal(a, b, "two callers decoded the body twice");
  } finally {
    globalThis.fetch = original;
  }
});

test("different URLs are not deduplicated into each other", async () => {
  const original = globalThis.fetch;
  let seen = [];
  globalThis.fetch = async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ url }), { status: 200 });
  };
  try {
    const [a, b] = await Promise.all([
      fetchJson("/api/test-a"), fetchJson("/api/test-b"),
    ]);
    assert.deepEqual(seen.sort(), ["/api/test-a", "/api/test-b"]);
    assert.deepEqual(a, { url: "/api/test-a" });
    assert.deepEqual(b, { url: "/api/test-b" });
  } finally {
    globalThis.fetch = original;
  }
});

test("a later caller gets a fresh request rather than the finished one", async () => {
  // Deduplication is only for requests still in flight. Reusing a settled promise
  // would turn this into a cache with no expiry, and the ETag path above is the
  // thing that decides whether a payload can be reused -- it revalidates.
  const original = globalThis.fetch;
  const { fn, calls } = countingFetch({ n: 1 });
  globalThis.fetch = fn;
  try {
    await fetchJson("/api/test-sequential");
    await fetchJson("/api/test-sequential");
    assert.equal(calls(), 2, "a settled request was reused as a cache");
  } finally {
    globalThis.fetch = original;
  }
});

test("a failed request does not wedge its URL", async () => {
  // A rejected promise left in the map would hand every future caller the old
  // failure for ever -- a poll that fails once would never recover.
  const original = globalThis.fetch;
  let attempt = 0;
  globalThis.fetch = async () => {
    attempt += 1;
    if (attempt === 1) return new Response("", { status: 503 });
    return new Response(JSON.stringify({ recovered: true }), { status: 200 });
  };
  try {
    await assert.rejects(() => fetchJson("/api/test-recovery"));
    assert.deepEqual(await fetchJson("/api/test-recovery"), { recovered: true });
    assert.equal(attempt, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("concurrent callers all see the same failure", async () => {
  const original = globalThis.fetch;
  const { fn, calls } = countingFetch(null, { delayMs: 5, status: 500 });
  globalThis.fetch = fn;
  try {
    const settled = await Promise.allSettled(
      Array.from({ length: 3 }, () => fetchJson("/api/test-shared-failure")),
    );
    assert.equal(calls(), 1);
    for (const s of settled) {
      assert.equal(s.status, "rejected");
      assert.equal(s.reason.status, 500);
    }
  } finally {
    globalThis.fetch = original;
  }
});
