// Simple monochrome SVG paths, colored via currentColor -- shared by every
// marker decorator in decorators.js and turned into Leaflet divIcons by
// buildDivIcon() below.

export const SVG = {
  burst: '<path fill="currentColor" d="M12 2 L14.2 9.2 L21.5 9.2 L15.6 13.6 L17.8 20.8 L12 16.4 L6.2 20.8 L8.4 13.6 L2.5 9.2 L9.8 9.2 Z"/>',
  news: '<rect x="4" y="5" width="16" height="14" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><line x1="7" y1="9" x2="17" y2="9" stroke="currentColor" stroke-width="1.6"/><line x1="7" y1="12.5" x2="17" y2="12.5" stroke="currentColor" stroke-width="1.6"/><line x1="7" y1="16" x2="13" y2="16" stroke="currentColor" stroke-width="1.6"/>',
  ship: '<path fill="currentColor" d="M3 15 L21 15 L18 20 L6 20 Z"/><path fill="currentColor" d="M11 3 L11 15 L17 12 Z"/>',
  // Wider hull + a row of cargo/tank domes -- distinct silhouette from the
  // plain wedge-hulled `ship` glyph so tankers stand out at a glance.
  tanker: '<path fill="currentColor" d="M2 14 L22 14 L19 20 L5 20 Z"/><circle cx="7" cy="11" r="2" fill="currentColor"/><circle cx="12" cy="10.5" r="2.3" fill="currentColor"/><circle cx="17" cy="11" r="2" fill="currentColor"/>',
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
  satellite: '<rect x="9.5" y="9.5" width="5" height="5" rx="1" fill="currentColor" transform="rotate(45 12 12)"/><rect x="1" y="10.5" width="6" height="3" fill="currentColor" transform="rotate(45 4 12)"/><rect x="17" y="10.5" width="6" height="3" fill="currentColor" transform="rotate(45 20 12)"/><circle cx="17" cy="6" r="1.4" fill="currentColor"/>',
  // ---- military bases (subtype icons; air/naval reuse planeMilitary/ship) ----
  armyBase: '<path fill="currentColor" d="M12 2 L21 7 L21 13 C21 18 17 21.5 12 22 C7 21.5 3 18 3 13 L3 7 Z" fill-opacity="0.18" stroke="currentColor" stroke-width="1.6"/><path fill="currentColor" d="M12 6 L17 9 L12 12 L7 9 Z"/>',
  missileBase: '<path fill="currentColor" d="M12 2 C15 6 15.5 11 14.5 15 L9.5 15 C8.5 11 9 6 12 2 Z"/><path fill="currentColor" d="M9.5 15 L7 20 L10 18.5 Z"/><path fill="currentColor" d="M14.5 15 L17 20 L14 18.5 Z"/><rect x="10.5" y="15" width="3" height="5" fill="currentColor"/>',
  jointBase: '<path fill="currentColor" d="M12 2 L14.2 9.2 L21.5 9.2 L15.6 13.6 L17.8 20.8 L12 16.4 L6.2 20.8 L8.4 13.6 L2.5 9.2 L9.8 9.2 Z" fill-opacity="0.85"/>',
  logisticsBase: '<rect x="3" y="8" width="18" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" d="M3 8 L12 3 L21 8"/><line x1="12" y1="8" x2="12" y2="20" stroke="currentColor" stroke-width="1.6"/>',
  radarBase: '<path fill="none" stroke="currentColor" stroke-width="2" d="M4 18 A8 8 0 0 1 20 18"/><path fill="none" stroke="currentColor" stroke-width="2" d="M8 18 A4 4 0 0 1 16 18"/><circle cx="12" cy="18" r="1.6" fill="currentColor"/><line x1="12" y1="18" x2="18" y2="7" stroke="currentColor" stroke-width="2"/>',
  // ---- ACLED/UCDP/Conflict Watch event types (see decorators.js's
  // ACLED_EVENT_ICON) ----
  battle: '<path fill="currentColor" d="M3 3 L11 11 L9 13 L1 5 Z"/><path fill="currentColor" d="M21 3 L13 11 L15 13 L23 5 Z"/><rect x="10.9" y="13" width="2.2" height="9" fill="currentColor" transform="rotate(45 12 17.5)"/>',
  explosion: '<path fill="currentColor" d="M12 2 L14.2 9.2 L21.5 9.2 L15.6 13.6 L17.8 20.8 L12 16.4 L6.2 20.8 L8.4 13.6 L2.5 9.2 L9.8 9.2 Z"/>',
  violenceCivilians: '<path fill="currentColor" d="M12 2 L22 20 L2 20 Z"/><rect x="11" y="9" width="2" height="6" fill="#0b0d10"/><circle cx="12" cy="17" r="1.2" fill="#0b0d10"/>',
  riot: '<path fill="currentColor" d="M9 22 L9 13 C9 11 10 10 10 8 L10 3 a1.3 1.3 0 0 1 2.6 0 L12.6 8 L13.2 8 L13.2 4 a1.2 1.2 0 0 1 2.4 0 L15.6 8.3 L16.1 8.3 L16.1 5 a1.1 1.1 0 0 1 2.2 0 L18.3 12 C18.3 15 17 15.5 17 18 L17 22 Z"/>',
  protest: '<rect x="5" y="3" width="2" height="19" fill="currentColor"/><path fill="currentColor" d="M7 4 L19 7 L7 10 Z"/>',
  strategicDevelopment: '<path fill="currentColor" d="M12 2 L14.6 9.6 L22 9.6 L16 14.2 L18.2 22 L12 17.2 L5.8 22 L8 14.2 L2 9.6 L9.4 9.6 Z" fill-opacity="0.35"/><circle cx="12" cy="12" r="3.4" fill="currentColor"/>',
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
