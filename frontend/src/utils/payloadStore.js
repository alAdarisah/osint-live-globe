// A payload cache that survives the tab being reloaded.
//
// The ETag machinery in api.js works and saves nothing across a reload, because
// the map it reads from is a module-level `Map`: a fresh page has no ETags to
// send, so it sends none, and the server -- which would happily have answered
// 304 -- has no choice but to hand over the whole body again. Measured on the
// deployment, that is 5.7 MB over the wire and 26 MB of JSON parsed on the main
// thread, repeated in full every time the page is opened.
//
// So the ETags are kept here instead, in IndexedDB, alongside the payload they
// belong to. A reload then asks each endpoint the same question the poll asks --
// "still this one?" -- and mostly gets 304 and no body.
//
// What this is not: a cache that decides for itself whether data is still good.
// A stored copy is only ever used when the server has said, for that exact ETag,
// that it is current. That is what keeps a persistent cache from becoming a
// source of quietly stale maps -- the freshness decision stays where it already
// was, on the server, and this only avoids re-sending bytes it has already
// judged unchanged.
//
// Lazy by design. Nothing is read at startup: a hydration pass would put the
// cost back where it was, several megabytes of structured-clone reads before the
// first paint. Each URL is looked up only when something asks for it.

const DB_NAME = "osint-payloads";
const STORE = "responses";
const DB_VERSION = 1;

// Entries older than this are ignored on read and swept on write. The server's
// ETag decides correctness, so this is a housekeeping bound rather than a
// freshness rule: it stops a URL the app stopped requesting -- an old region
// key, a retired endpoint -- from occupying the origin's storage quota for ever.
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// IndexedDB is unavailable in a private window in some browsers, disabled by
// policy in others, and absent under `node --test`. Every function here answers
// with "no cached copy" in that case rather than throwing, so the app runs
// exactly as it did before this file existed.
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "url" });
        // Swept by age on write; see prune below.
        store.createIndex("storedAt", "storedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // Another tab holding an old version open. Rather than hang, give up and run
    // uncached -- a blocked upgrade is not a reason to stop loading the map.
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function withStore(mode, run) {
  return openDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction(STORE, mode);
      } catch {
        resolve(null);
        return;
      }
      const result = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result.value);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  }).catch(() => null);
}

/**
 * The stored {etag, data} for a URL, or null.
 *
 * Returns null for an entry past MAX_AGE_MS rather than deleting it here: a read
 * should not have to open a write transaction, and the next write sweeps it.
 */
export function readPayload(url) {
  return withStore("readonly", (store) => {
    const result = { value: null };
    const request = store.get(url);
    request.onsuccess = () => {
      const row = request.result;
      if (!row || !row.etag) return;
      if (Date.now() - (row.storedAt || 0) > MAX_AGE_MS) return;
      result.value = { etag: row.etag, data: row.data };
    };
    return result;
  });
}

/**
 * Store a payload against the ETag the server gave it.
 *
 * Fire-and-forget: nothing awaits this, and a failure -- a quota error on a
 * 54 MB payload is the realistic one -- must not fail the fetch that produced
 * the data. The app has the payload in memory either way; all that is lost is
 * the head start on the next reload.
 */
export function writePayload(url, etag, data) {
  if (!etag) return Promise.resolve(null);
  return withStore("readwrite", (store) => {
    store.put({ url, etag, data, storedAt: Date.now() });
    return { value: true };
  });
}

/**
 * Drop entries older than MAX_AGE_MS.
 *
 * Called once, well after load, rather than on every write: a cursor walk is not
 * something to put in front of a payload the app is waiting for.
 */
export function prune() {
  return withStore("readwrite", (store) => {
    const cutoff = Date.now() - MAX_AGE_MS;
    const index = store.index("storedAt");
    const request = index.openCursor(IDBKeyRange.upperBound(cutoff));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    return { value: true };
  });
}

/** Everything this origin has stored, for the admin panel and for tests. */
export function clearAll() {
  return withStore("readwrite", (store) => {
    store.clear();
    return { value: true };
  });
}
