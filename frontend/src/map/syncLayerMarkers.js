// Generic keyed diff: adds markers for new items, updates in place for items
// whose marker already exists (no DOM churn / no cluster rebuild), and
// removes markers for items no longer present. This -- not clearLayers() +
// rebuild-everything -- is what makes pan/zoom smooth, since it used to run
// on every poll AND every moveend.
export function syncLayerMarkers(markerMap, group, items, idFn, buildFn, updateFn) {
  const seen = new Set();
  const toAdd = [];
  for (const item of items) {
    const id = idFn(item);
    seen.add(id);
    const existing = markerMap.get(id);
    if (existing) {
      updateFn(existing, item);
    } else {
      const marker = buildFn(item);
      markerMap.set(id, marker);
      toAdd.push(marker);
    }
  }
  const toRemove = [];
  for (const [id, marker] of markerMap) {
    if (!seen.has(id)) {
      toRemove.push(marker);
      markerMap.delete(id);
    }
  }
  // Bulk addLayers/removeLayers are a MarkerClusterGroup-only optimization --
  // plain L.layerGroup (used for the never-clustered military aircraft
  // layer) only has the singular addLayer/removeLayer.
  if (toRemove.length) {
    if (group.removeLayers) group.removeLayers(toRemove);
    else toRemove.forEach((m) => group.removeLayer(m));
  }
  if (toAdd.length) {
    if (group.addLayers) group.addLayers(toAdd);
    else toAdd.forEach((m) => group.addLayer(m));
  }
}
