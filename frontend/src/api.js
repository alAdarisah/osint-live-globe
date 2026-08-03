// Thin fetch layer -- every data source ultimately goes through fetchJson,
// and every region-scoped source goes through urlForRegion first so the
// backend's ?region= filtering (see backend/regions.py) kicks in uniformly.

export async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: ${resp.status}`);
  return resp.json();
}

export function urlForRegion(base, region) {
  if (!region) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}region=${encodeURIComponent(region)}`;
}
