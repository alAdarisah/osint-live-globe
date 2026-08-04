// Nudges same-layer markers apart when they'd otherwise land on the exact
// same screen pixel at the current zoom -- distinct real events/objects a
// few pixels apart should both stay visible instead of one hiding under the
// other with no visual sign there's a second pin underneath. This is NOT
// clustering (see layers.js's "no clustering anywhere" note, still true):
// nothing gets grouped into a numbered bubble, every item keeps its own
// icon and popup, it's just placed a few px off its literal projected point
// when another item of the same layer already claimed that spot.
//
// Cheap by construction: only ever runs over a layer's already
// bounds-filtered + zoom-gated visible subset (each renderer computes that
// before calling this), which stays small by design -- that's what the
// zoom gates exist for.

const BUCKET_PX = 22; // ~ one marker's footprint
const SPIRAL_STEP_PX = 10;
const MAX_SPIRAL_TRIES = 12;

// 12-point spiral offsets (angle steps of 30deg, growing radius) -- cheap
// deterministic fan-out, good enough at the handful-of-collisions scale this
// ever has to resolve.
function spiralOffset(tryIndex) {
  const ring = Math.floor(tryIndex / 6) + 1;
  const angle = (tryIndex % 6) * (Math.PI / 3);
  const r = ring * SPIRAL_STEP_PX;
  return { dx: Math.cos(angle) * r, dy: Math.sin(angle) * r };
}

function bucketKey(x, y) {
  return `${Math.round(x / BUCKET_PX)}:${Math.round(y / BUCKET_PX)}`;
}

/**
 * @param {Array<{x:number,y:number}>} points screen-space points, one per
 *   visible item, same order/length as the item list the caller positions.
 * @returns {Array<{x:number,y:number}>} adjusted points, same order/length.
 */
export function declutterPoints(points) {
  const occupied = new Set();
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    let { x, y } = points[i];
    let key = bucketKey(x, y);
    if (occupied.has(key)) {
      const ox = x, oy = y;
      let placed = false;
      for (let t = 0; t < MAX_SPIRAL_TRIES; t++) {
        const { dx, dy } = spiralOffset(t);
        const cx = ox + dx, cy = oy + dy;
        const candidateKey = bucketKey(cx, cy);
        if (!occupied.has(candidateKey)) {
          x = cx;
          y = cy;
          key = candidateKey;
          placed = true;
          break;
        }
      }
      if (!placed) {
        // Every nearby spiral slot is taken (a genuine dense pile) -- leave
        // it at its real point rather than flinging it arbitrarily far.
        x = ox;
        y = oy;
      }
    }
    occupied.add(key);
    out[i] = { x, y };
  }
  return out;
}
