// Which records are new to a layer since the last time it was asked.
//
// Kept out of createMapController because it is the one part of the arrival
// flash with a right and a wrong answer, and that file is not somewhere a pure
// function can be tested.

/**
 * @param {Set|null} previousIds  null on the first call for a layer
 * @param {Array<object>} items   the layer's full payload, not the visible slice
 * @param {string} idField        ID_FIELD's entry for this layer
 * @returns {{ids: Set, arrived: Set}}
 */
export function newArrivals(previousIds, items, idField) {
  const ids = new Set();
  for (const item of items || []) {
    const id = item?.[idField];
    if (id === undefined || id === null) continue;
    ids.add(id);
  }
  // A null previous set means this layer is being seeded, not updated. Every id
  // is new by definition and none of them is news.
  if (previousIds === null || previousIds === undefined) return { ids, arrived: new Set() };

  const arrived = new Set();
  for (const id of ids) if (!previousIds.has(id)) arrived.add(id);
  return { ids, arrived };
}
