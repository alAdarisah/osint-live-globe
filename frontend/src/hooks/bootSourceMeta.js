// What a boot-screen log line is allowed to say about a source, derived from
// the outcome useOsintData.js recorded for it. Kept as plain functions in their
// own module rather than inside useOsintData.js or LoadingScreen.jsx so the
// claims can be tested directly -- the suite in frontend/tests stays free of
// React and the DOM.

// Rows in a payload, or null when the payload is not the kind of thing that has
// rows. Null and 0 are deliberately different answers: "nothing to count" is
// not "counted nothing", and the log renders them differently. Array.isArray is
// the guard rather than a truthy `.length` check, so a string is never reported
// by its character count.
export function countOf(data) {
  if (Array.isArray(data)) return data.length;
  if (data && Array.isArray(data.features)) return data.features.length;
  return null;
}

// Why a fetch failed, in the fewest words that are still true. A response that
// came back with a bad status has a number worth showing; a fetch that rejected
// before any response existed does not, and must not be given one.
export function failureDetail(err) {
  if (err && typeof err.status === "number") return `HTTP ${err.status}`;
  return "unreachable";
}

function formatElapsed(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// The dim second line under a source's label, or null when there is nothing
// true to put there yet. `detail` wins over the numbers because a source that
// failed has a reason worth more than the milliseconds it spent failing.
export function formatBootMeta(source) {
  if (!source || source.status === "pending") return null;
  if (source.detail) return source.detail;
  if (source.ms == null) return null;
  const elapsed = formatElapsed(source.ms);
  if (source.count == null) return elapsed;
  return `${source.count.toLocaleString("en-US")} rows · ${elapsed}`;
}
