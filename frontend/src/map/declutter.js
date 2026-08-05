// One placement pass over every visible icon on the map, of every layer, at
// once. Returns a screen-space nudge per item so that two things a few pixels
// apart both stay clickable instead of one hiding completely under the other.
//
// This is NOT clustering (see layers.js's "no clustering anywhere" note, still
// true): nothing is grouped into a numbered bubble, every item keeps its own
// icon and its own popup, and nothing is hidden. It is also not a change of
// position: callers apply the result as a visual offset only, so the marker's
// LatLng, its popup anchor and every distance calculation still use the real
// coordinate (see createMapController's applyPlacement).
//
// Three things the previous per-layer version got wrong, all of which showed
// up as "icons collide and stack all over the map":
//
//   * it ran once per layer, so nothing arbitrated *between* layers -- an
//     infrastructure pin and a conflict pin, or a tanker and a navy ship, were
//     free to land on the same pixel. Satellites, cities and infrastructure
//     never ran it at all.
//   * collisions were detected by rounding both points into one 22px grid cell,
//     so two icons 2px apart that happened to straddle a cell boundary were
//     declared clear. That misses roughly half of real overlaps.
//   * the cell was a fixed 22px regardless of the icon's actual size, and these
//     range from an 8px city dot to a 31px critical-severity conflict pin.
//
// Deliberately zoom-gated by the caller: displacement is only applied once
// zoomed in (see DECLUTTER_MIN_ZOOM), because a screen-space nudge necessarily
// changes as the projection scales, and a pin that shifts a few pixels every
// time you zoom reads as the map being unstable. Zoomed out, crowding is
// accepted; zoomed in, everything is reachable.

const PAD_PX = 2;       // breathing room between two icon edges
// 5 rings of 8. Measured on a country-wide city view (112 cities at zoom 6,
// the densest thing this map draws): 3 rings left 70 overlapping pairs, since a
// small icon's ring 3 only reaches ~18px and a pile that big needs further to
// go. Beyond 5 rings the displacement is larger than the leader line can
// honestly annotate, so anything still stuck stays on its true point.
const MAX_TRIES = 40;
const MIN_STEP_PX = 6;

/**
 * @param {Array<{uid:string, x:number, y:number, r:number, priority:number}>} items
 *   Screen-space centre, radius in px, and a layer priority (higher keeps its
 *   true position; lower yields).
 * @returns {Map<string, {dx:number, dy:number}>} offsets, only for items that
 *   actually moved.
 */
export function placeAll(items) {
  const out = new Map();
  if (items.length < 2) return out;

  // Deterministic: highest priority first, then by uid. Feed order changes
  // every poll and viewport filtering reorders again on every pan, so ordering
  // by anything positional would hand the same collision to a different winner
  // each render and make the whole map twitch.
  const order = [...items].sort(
    (a, b) => b.priority - a.priority || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)
  );

  let maxR = 0;
  for (const item of items) if (item.r > maxR) maxR = item.r;
  // Any colliding pair is closer than r1 + r2 + PAD <= 2*maxR + PAD, so a cell
  // this size guarantees both land in the same or an adjacent cell -- which is
  // what makes the 3x3 scan below exhaustive rather than approximate.
  const cell = Math.max(8, (maxR + PAD_PX) * 2);
  const grid = new Map();

  function collides(x, y, r) {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.get(`${gx}:${gy}`);
        if (!bucket) continue;
        for (const p of bucket) {
          const dx = p.x - x;
          const dy = p.y - y;
          const min = p.r + r + PAD_PX;
          if (dx * dx + dy * dy < min * min) return true;
        }
      }
    }
    return false;
  }

  function insert(p) {
    const key = `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(p);
    else grid.set(key, [p]);
  }

  for (const item of order) {
    let x = item.x;
    let y = item.y;
    if (collides(x, y, item.r)) {
      // Rings of 8, alternate rings half a step out of phase so the second ring
      // fills the gaps the first one left rather than sitting directly behind it.
      const step = Math.max(MIN_STEP_PX, item.r + PAD_PX);
      for (let t = 0; t < MAX_TRIES; t++) {
        const ring = Math.floor(t / 8) + 1;
        const angle = ((t % 8) * Math.PI) / 4 + (ring % 2 === 0 ? Math.PI / 8 : 0);
        const cx = item.x + Math.cos(angle) * ring * step;
        const cy = item.y + Math.sin(angle) * ring * step;
        if (!collides(cx, cy, item.r)) {
          x = cx;
          y = cy;
          break;
        }
      }
      // No free slot anywhere nearby: leave it at its real point rather than
      // flinging it somewhere arbitrary. It still gets inserted below, so it
      // continues to push later items away.
    }
    insert({ x, y, r: item.r });
    // Whole pixels: the offset is rendered into the icon's HTML string, and
    // createMapController's updateMarker decides whether to repaint by
    // comparing that string. Sub-pixel values would differ on every render and
    // rebuild every marker's DOM element on every pan.
    const dx = Math.round(x - item.x);
    const dy = Math.round(y - item.y);
    if (dx !== 0 || dy !== 0) out.set(item.uid, { dx, dy });
  }
  return out;
}
