// Simple monochrome SVG paths, colored via currentColor -- shared by every
// marker decorator in decorators.js and turned into Leaflet divIcons by
// buildDivIcon() below.

export const SVG = {
  burst: '<path fill="currentColor" d="M12 2 L14.2 9.2 L21.5 9.2 L15.6 13.6 L17.8 20.8 L12 16.4 L6.2 20.8 L8.4 13.6 L2.5 9.2 L9.8 9.2 Z"/>',
  news: '<rect x="4" y="5" width="16" height="14" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><line x1="7" y1="9" x2="17" y2="9" stroke="currentColor" stroke-width="1.6"/><line x1="7" y1="12.5" x2="17" y2="12.5" stroke="currentColor" stroke-width="1.6"/><line x1="7" y1="16" x2="13" y2="16" stroke="currentColor" stroke-width="1.6"/>',
  ship: '<path fill="currentColor" d="M3 15 L21 15 L18 20 L6 20 Z"/><path fill="currentColor" d="M11 3 L11 15 L17 12 Z"/>',
  planeCommercial: '<path fill="currentColor" d="M12 1 L16 20 L12 16.5 L8 20 Z"/>',
  planeMilitary: '<path fill="currentColor" d="M12 1 L22 19.5 L12 14.5 L2 19.5 Z"/>',
  planeOther: '<path fill="currentColor" d="M12 3 L15 19 L12 16.2 L9 19 Z"/>',
  helicopter: '<circle cx="12" cy="13" r="2" fill="currentColor"/><rect x="2" y="12" width="20" height="2" fill="currentColor"/><rect x="11" y="2" width="2" height="8" fill="currentColor"/><rect x="9" y="18" width="6" height="2" fill="currentColor"/>',
  // ---- critical infrastructure ----
  refinery: '<rect x="4" y="12" width="3" height="8" fill="currentColor"/><rect x="9" y="8" width="3" height="12" fill="currentColor"/><rect x="14" y="10" width="3" height="10" fill="currentColor"/><rect x="17" y="5" width="2" height="15" fill="currentColor"/><circle cx="18" cy="3.5" r="1.6" fill="currentColor"/>',
  pipeline: '<path fill="none" stroke="currentColor" stroke-width="2.4" d="M3 16 Q8 8 12 16 T21 16"/>',
  desalination: '<path fill="currentColor" d="M12 3 C12 3 6 11 6 15 a6 6 0 0 0 12 0 C18 11 12 3 12 3 Z"/>',
  lng: '<path fill="none" stroke="currentColor" stroke-width="2" d="M12 3 C8 7 8 11 12 13 C16 11 16 7 12 3 Z"/><rect x="7" y="14" width="10" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="2"/>',
  nuclear: '<circle cx="12" cy="12" r="2" fill="currentColor"/><g fill="currentColor"><path d="M12 12 L16 5 A8 8 0 0 1 20 12 Z"/><path d="M12 12 L20 12 A8 8 0 0 1 12.5 19.9 Z" transform="rotate(0 12 12)"/></g><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  port: '<path fill="currentColor" d="M4 17 L20 17 L17 21 L7 21 Z"/><rect x="11" y="4" width="2" height="13" fill="currentColor"/><path fill="currentColor" d="M13 5 L19 8 L13 10 Z"/>',
  fab: '<rect x="4" y="7" width="16" height="13" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="8" y="11" width="3" height="3" fill="currentColor"/><rect x="13" y="11" width="3" height="3" fill="currentColor"/><rect x="9" y="3" width="2" height="4" fill="currentColor"/><rect x="13" y="3" width="2" height="4" fill="currentColor"/>',
};

// A small crosshair/target glyph used by the news panel's "show on map"
// button -- not a map marker icon, but kept alongside SVG since it's the
// same monochrome-currentColor style.
export const NEWS_LOCATE_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<line x1="12" y1="2" x2="12" y2="6" stroke="currentColor" stroke-width="2"/><line x1="12" y1="18" x2="12" y2="22" stroke="currentColor" stroke-width="2"/>' +
  '<line x1="2" y1="12" x2="6" y2="12" stroke="currentColor" stroke-width="2"/><line x1="18" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="2"/></svg>';

export function buildDivIcon(L, svgInner, color, size, rotateDeg, extraClass) {
  const rot = Number.isFinite(rotateDeg) ? rotateDeg : 0;
  const html = `<div class="entity-icon-wrap" style="width:${size}px;height:${size}px;color:${color};transform:rotate(${rot}deg);">` +
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}">${svgInner}</svg></div>`;
  return L.divIcon({ html, className: extraClass || "", iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}
