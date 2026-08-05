// Collapsing co-located news pins into one, in screen space.
//
// This is a deliberate exception to the "no clustering anywhere" rule stated in
// layers.js, and it is scoped to the news layer only. The reason it earns the
// exception: news went from a 2-hour window to a 24-hour one, which multiplies
// the pin count by roughly ten in the places that generate the most coverage --
// and those are exactly the places a reader is most likely to be looking at.
// Every other layer's density is bounded by how much of the thing exists in the
// world; a news feed's is bounded by how long a window you chose.
//
// How it differs from declutter.js, which must not be confused with this:
//
//   declutter  moves overlapping icons apart. Nothing is grouped, nothing is
//              hidden, every item keeps its own marker and popup.
//   collapse   groups overlapping items into one marker that says how many it
//              stands for and lists all of them in its popup.
//
// They compose: collapse runs first and reduces the item count, then declutter
// separates whatever still overlaps. Nothing is lost either way -- a collapsed
// item is one click away, and it is still in the news panel and the country
// card, both of which read the unfiltered feed.

// Two pins closer than this share a marker. Sized against the news glyph
// (14-21px): a radius near the icon's own width means "these were going to
// overlap anyway", rather than grouping things a reader can already tell apart.
export const COLLAPSE_RADIUS_PX = 26;

// Above this zoom, individual pins are drawn. By then the projection has spread
// a city's coverage out enough that declutter's nudge is sufficient, and a
// reader who has zoomed this far in is asking to see the individual items.
export const COLLAPSE_MAX_ZOOM = 9;

/**
 * Group items that would land on top of each other into representative heads.
 *
 * @param {Array<object>} items          already filtered to the viewport
 * @param {(item:object) => {x:number,y:number}} project  latLng -> screen px
 * @param {(item:object) => number} rank  higher wins the head slot
 * @param {number} radiusPx
 * @returns {Array<object>} shallow copies of the heads, each carrying
 *   `collapsed` (the items it absorbed, itself first) and `collapsedCount`.
 *   Items that absorbed nothing are returned untouched.
 */
// Deterministic order decides which item becomes the head. Rank first, then a
// stable tiebreak -- feed order changes every poll and viewport filtering
// reorders again on every pan, so ordering by anything positional would hand
// the head slot to a different item each render. That matters more here than in
// declutter: the head's id is the marker's identity (see syncLayerMarkers), so
// a flapping head rebuilds DOM on every pan and the popup a reader has open
// belongs to a different item afterwards.
//
// Shared by both collapse functions rather than written twice: this property is
// the whole reason either of them is safe, and two copies that agree today are
// two copies that can stop agreeing.
function byRankThenId(rank) {
  return (a, b) => {
    const diff = rank(b) - rank(a);
    if (diff) return diff;
    const ka = String(a.event_id ?? a.id ?? "");
    const kb = String(b.event_id ?? b.id ?? "");
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}

export function collapseByProximity(items, project, rank, radiusPx = COLLAPSE_RADIUS_PX) {
  if (!items || items.length < 2) return items || [];

  const ordered = [...items].sort(byRankThenId(rank));

  // Same spatial-hash trick declutter uses: a cell of radiusPx guarantees any
  // pair within the radius lands in the same or an adjacent cell, which makes
  // the 3x3 scan exhaustive rather than approximate.
  const cell = Math.max(8, radiusPx);
  const grid = new Map();
  const heads = [];
  const radiusSq = radiusPx * radiusPx;

  for (const item of ordered) {
    const point = project(item);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;

    const cx = Math.floor(point.x / cell);
    const cy = Math.floor(point.y / cell);
    let host = null;
    for (let gx = cx - 1; gx <= cx + 1 && !host; gx++) {
      for (let gy = cy - 1; gy <= cy + 1 && !host; gy++) {
        const bucket = grid.get(`${gx}:${gy}`);
        if (!bucket) continue;
        for (const candidate of bucket) {
          const dx = candidate.x - point.x;
          const dy = candidate.y - point.y;
          if (dx * dx + dy * dy <= radiusSq) {
            host = candidate;
            break;
          }
        }
      }
    }

    if (host) {
      host.members.push(item);
      continue;
    }
    const entry = { x: point.x, y: point.y, item, members: [item] };
    const key = `${cx}:${cy}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(entry);
    else grid.set(key, [entry]);
    heads.push(entry);
  }

  return heads.map(({ item, members }) =>
    // A head standing only for itself is returned as-is, so the common case
    // allocates nothing and the decorators can treat `collapsedCount` as
    // "undefined means one".
    members.length < 2 ? item : { ...item, collapsed: members, collapsedCount: members.length }
  );
}

/**
 * Group items that share an exact key into representative heads.
 *
 * Same output contract as collapseByProximity: heads carry `collapsed` and
 * `collapsedCount`, and an item that absorbed nothing is returned untouched.
 *
 * This exists because the diplomacy layer's pile-ups are exact rather than
 * incidental. A capital-snapped record (backend/sources/capitals.py) and every
 * other record snapped to the same capital share one coordinate *by
 * construction*, and press releases from one institution likewise. Pixel
 * proximity is the wrong question to ask about them:
 *
 *   - at radius 0 the spatial hash still runs, and floating-point projection
 *     jitter can split a group that is genuinely one point;
 *   - at any radius > 0 two genuinely different nearby places get merged.
 *
 * An exact key cannot jitter and cannot over-merge. Items with a null key pass
 * through ungrouped -- a locality-precise diplomatic event is a real place and
 * must keep its own marker.
 *
 * No zoom argument on purpose: when to stop collapsing is the caller's
 * decision, exactly as it already is for collapseByProximity.
 *
 * @param {Array<object>} items
 * @param {(item:object) => (string|null|undefined)} keyFn  null means "do not group"
 * @param {(item:object) => number} rank  higher wins the head slot
 */
export function collapseByKey(items, keyFn, rank) {
  if (!items || items.length < 2) return items || [];

  const ordered = [...items].sort(byRankThenId(rank));
  const groups = new Map();
  // Every item becomes an entry, keyed or not, so the output stays in the input
  // order and the mapping below has exactly one shape to handle.
  const entries = [];

  for (const item of ordered) {
    const key = keyFn(item);
    const existing = key == null ? null : groups.get(key);
    if (existing) {
      existing.members.push(item);
      continue;
    }
    const entry = { item, members: [item] };
    if (key != null) groups.set(key, entry);
    entries.push(entry);
  }

  return entries.map(({ item, members }) =>
    members.length < 2 ? item : { ...item, collapsed: members, collapsedCount: members.length }
  );
}
