// Admin edits, applied to a feed on its way in.
//
// Every payload passes through here between the fetch and anything that reads
// it (see useOsintData.js's `transform`), so one edit reaches the map, the news
// ticker, the notable-activity board and the country cards at once -- they are
// all reading the same arrays, and an edit that only reached the map would put
// the panels into permanent disagreement with the pins.
//
// Edits are stored by record id, never by array position: these feeds are
// re-fetched every 10-60 seconds and a record's index is meaningless between
// polls. A record that has vanished from the feed keeps its (now inert) entry
// rather than being cleaned up -- an id can come back, and a poll that happened
// to miss it is not evidence that it will not.

import { EDITABLE_SOURCES } from "./defaults";

const SOURCE_BY_KEY = Object.fromEntries(EDITABLE_SOURCES.map((s) => [s.key, s]));

// The one field name that is not data: it marks a record as hidden rather than
// setting anything on it.
export const HIDDEN_FLAG = "__hidden";

/**
 * @param {string} key      the feed's key ("events", "gdelt", "officials", ...)
 * @param {any} data        whatever the endpoint returned
 * @param {object} allEdits the settings' `data` block
 * @returns the payload the app should use -- the original array when this feed
 *   has no edits at all, so the common case costs one lookup and no copying.
 */
export function applyOverrides(key, data, allEdits) {
  const source = SOURCE_BY_KEY[key];
  if (!source || !Array.isArray(data)) return data;

  const entry = allEdits?.[key];
  const edits = entry?.edits || {};
  const added = entry?.added || [];
  if (!added.length && !Object.keys(edits).length) return data;

  const out = [];
  for (const item of data) {
    const patch = edits[item[source.idField]];
    if (!patch) {
      out.push(item);
      continue;
    }
    if (patch[HIDDEN_FLAG]) continue; // hidden means gone from every view, not greyed out in one
    const merged = { ...item, ...patch };
    delete merged[HIDDEN_FLAG];
    // Marks the record everywhere it is rendered. Popups read it to say the
    // values on screen are not what the source served -- an edited pin that
    // does not admit it would be the single most misleading thing on the map.
    merged.__edited = true;
    out.push(merged);
  }

  for (const record of added) {
    const patch = edits[record[source.idField]];
    if (patch?.[HIDDEN_FLAG]) continue;
    out.push({ ...record, ...patch, __edited: true, __added: true });
  }

  return out;
}
