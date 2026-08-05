// Simple monochrome SVG paths, colored via currentColor -- shared by every
// marker decorator in decorators.js and turned into Leaflet divIcons by
// buildDivIcon() below.

export const SVG = {
  news: '<rect x="4" y="5" width="16" height="14" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><line x1="7" y1="9" x2="17" y2="9" stroke="currentColor" stroke-width="1.6"/><line x1="7" y1="12.5" x2="17" y2="12.5" stroke="currentColor" stroke-width="1.6"/><line x1="7" y1="16" x2="13" y2="16" stroke="currentColor" stroke-width="1.6"/>',
  ship: '<path fill="currentColor" d="M3 15 L21 15 L18 20 L6 20 Z"/><path fill="currentColor" d="M11 3 L11 15 L17 12 Z"/>',
  // Wider hull + a row of cargo/tank domes -- distinct silhouette from the
  // plain wedge-hulled `ship` glyph so tankers stand out at a glance.
  tanker: '<path fill="currentColor" d="M2 14 L22 14 L19 20 L5 20 Z"/><circle cx="7" cy="11" r="2" fill="currentColor"/><circle cx="12" cy="10.5" r="2.3" fill="currentColor"/><circle cx="17" cy="11" r="2" fill="currentColor"/>',
  planeCommercial: '<path fill="currentColor" d="M12 1 L16 20 L12 16.5 L8 20 Z"/>',
  planeMilitary: '<path fill="currentColor" d="M12 1 L22 19.5 L12 14.5 L2 19.5 Z"/>',
  planeOther: '<path fill="currentColor" d="M12 3 L15 19 L12 16.2 L9 19 Z"/>',
  helicopter: '<circle cx="12" cy="13" r="2" fill="currentColor"/><rect x="2" y="12" width="20" height="2" fill="currentColor"/><rect x="11" y="2" width="2" height="8" fill="currentColor"/><rect x="9" y="18" width="6" height="2" fill="currentColor"/>',

  // ---- military aircraft, by role (decorators.js's MILITARY_ROLE_STYLE) --
  // distinct silhouettes so e.g. a bomber and an AEW aircraft don't read as
  // the same generic "military plane" glyph (planeMilitary above is kept as
  // the fighter/no-role-known glyph).
  // A real fighter silhouette -- spindle fuselage, sharply swept wings and
  // separate tail stabilators -- rather than the plain delta wedge it replaces
  // (planeMilitary), which was indistinguishable from the generic
  // "military, role unknown" glyph that still uses that wedge.
  planeFighter: '<path fill="currentColor" d="M12 0.6 C12.9 2.6 13.4 5 13.4 7.6 L13.4 16.4 L12.9 21.6 L11.1 21.6 L10.6 16.4 L10.6 7.6 C10.6 5 11.1 2.6 12 0.6 Z"/>' +
    '<path fill="currentColor" d="M13.4 9.2 L21.6 17.4 L21.6 19 L13.4 15.4 Z"/>' +
    '<path fill="currentColor" d="M10.6 9.2 L2.4 17.4 L2.4 19 L10.6 15.4 Z"/>' +
    '<path fill="currentColor" d="M13.4 17.6 L17.6 21 L17.6 22.2 L13.4 20.4 Z"/>' +
    '<path fill="currentColor" d="M10.6 17.6 L6.4 21 L6.4 22.2 L10.6 20.4 Z"/>',
  planeBomber: '<path fill="currentColor" d="M12 2 L20 17 L12 13.5 L4 17 Z"/><path fill="currentColor" d="M9 13 L9 20 L12 18.5 L15 20 L15 13 Z"/>',
  planeTanker: '<path fill="currentColor" d="M12 1 L20 17 L12 13.5 L4 17 Z"/><line x1="12" y1="13.5" x2="12" y2="23" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="23" r="1.4" fill="currentColor"/>',
  planeAwacs: '<path fill="currentColor" d="M12 6 L18 19 L12 16 L6 19 Z"/><ellipse cx="12" cy="6" rx="5" ry="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  planeRecon: '<path fill="currentColor" d="M12 1 L13.2 18 L12 21 L10.8 18 Z"/><path fill="currentColor" d="M8 14 L16 14 L12 16.5 Z"/>',
  planePatrol: '<path fill="currentColor" d="M12 2 L19 17 L12 14 L5 17 Z"/><path fill="none" stroke="currentColor" stroke-width="1.4" d="M6 20 Q9 18.5 12 20 T18 20"/>',
  planeDrone: '<path fill="currentColor" d="M12 5 L18 15 L12 12.5 L6 15 Z"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
  planeTransport: '<rect x="10" y="4" width="4" height="16" rx="1.5" fill="currentColor"/><rect x="3" y="12" width="18" height="3" rx="1" fill="currentColor"/>',
  // ---- critical infrastructure ----
  refinery: '<rect x="4" y="12" width="3" height="8" fill="currentColor"/><rect x="9" y="8" width="3" height="12" fill="currentColor"/><rect x="14" y="10" width="3" height="10" fill="currentColor"/><rect x="17" y="5" width="2" height="15" fill="currentColor"/><circle cx="18" cy="3.5" r="1.6" fill="currentColor"/>',
  pipeline: '<path fill="none" stroke="currentColor" stroke-width="2.4" d="M3 16 Q8 8 12 16 T21 16"/>',
  desalination: '<path fill="currentColor" d="M12 3 C12 3 6 11 6 15 a6 6 0 0 0 12 0 C18 11 12 3 12 3 Z"/>',
  lng: '<path fill="none" stroke="currentColor" stroke-width="2" d="M12 3 C8 7 8 11 12 13 C16 11 16 7 12 3 Z"/><rect x="7" y="14" width="10" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="2"/>',
  nuclear: '<circle cx="12" cy="12" r="2" fill="currentColor"/><g fill="currentColor"><path d="M12 12 L16 5 A8 8 0 0 1 20 12 Z"/><path d="M12 12 L20 12 A8 8 0 0 1 12.5 19.9 Z" transform="rotate(0 12 12)"/></g><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  port: '<path fill="currentColor" d="M4 17 L20 17 L17 21 L7 21 Z"/><rect x="11" y="4" width="2" height="13" fill="currentColor"/><path fill="currentColor" d="M13 5 L19 8 L13 10 Z"/>',
  fab: '<rect x="4" y="7" width="16" height="13" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="8" y="11" width="3" height="3" fill="currentColor"/><rect x="13" y="11" width="3" height="3" fill="currentColor"/><rect x="9" y="3" width="2" height="4" fill="currentColor"/><rect x="13" y="3" width="2" height="4" fill="currentColor"/>',
  satellite: '<rect x="9.5" y="9.5" width="5" height="5" rx="1" fill="currentColor" transform="rotate(45 12 12)"/><rect x="1" y="10.5" width="6" height="3" fill="currentColor" transform="rotate(45 4 12)"/><rect x="17" y="10.5" width="6" height="3" fill="currentColor" transform="rotate(45 20 12)"/><circle cx="17" cy="6" r="1.4" fill="currentColor"/>',
  // Military/reconnaissance satellite: upright bus with gridded panels and a
  // downward-looking sensor cone over a ground-scan arc -- deliberately a
  // different silhouette from the tilted `satellite` glyph above (kept for
  // stations/uncategorised objects) so a SAR-Lupe pin never reads as the ISS.
  satelliteMilitary: '<rect x="10" y="6" width="4" height="7" rx="0.6" fill="currentColor"/>' +
    '<rect x="2" y="7.2" width="7" height="4.6" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<rect x="15" y="7.2" width="7" height="4.6" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<line x1="5.5" y1="7.2" x2="5.5" y2="11.8" stroke="currentColor" stroke-width="1"/>' +
    '<line x1="18.5" y1="7.2" x2="18.5" y2="11.8" stroke="currentColor" stroke-width="1"/>' +
    '<path fill="currentColor" d="M10.4 13 L13.6 13 L15.4 17 L8.6 17 Z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.3" d="M7 19 Q12 22.4 17 19"/>',
  // ---- military bases (subtype icons; air/naval reuse planeMilitary/ship) ----
  armyBase: '<path fill="currentColor" d="M12 2 L21 7 L21 13 C21 18 17 21.5 12 22 C7 21.5 3 18 3 13 L3 7 Z" fill-opacity="0.18" stroke="currentColor" stroke-width="1.6"/><path fill="currentColor" d="M12 6 L17 9 L12 12 L7 9 Z"/>',
  missileBase: '<path fill="currentColor" d="M12 2 C15 6 15.5 11 14.5 15 L9.5 15 C8.5 11 9 6 12 2 Z"/><path fill="currentColor" d="M9.5 15 L7 20 L10 18.5 Z"/><path fill="currentColor" d="M14.5 15 L17 20 L14 18.5 Z"/><rect x="10.5" y="15" width="3" height="5" fill="currentColor"/>',
  jointBase: '<path fill="currentColor" d="M12 2 L14.2 9.2 L21.5 9.2 L15.6 13.6 L17.8 20.8 L12 16.4 L6.2 20.8 L8.4 13.6 L2.5 9.2 L9.8 9.2 Z" fill-opacity="0.85"/>',
  logisticsBase: '<rect x="3" y="8" width="18" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" d="M3 8 L12 3 L21 8"/><line x1="12" y1="8" x2="12" y2="20" stroke="currentColor" stroke-width="1.6"/>',
  radarBase: '<path fill="none" stroke="currentColor" stroke-width="2" d="M4 18 A8 8 0 0 1 20 18"/><path fill="none" stroke="currentColor" stroke-width="2" d="M8 18 A4 4 0 0 1 16 18"/><circle cx="12" cy="18" r="1.6" fill="currentColor"/><line x1="12" y1="18" x2="18" y2="7" stroke="currentColor" stroke-width="2"/>',
  // A single runway seen from above: threshold bars at both ends and a dashed
  // centreline, set on a diagonal so it never lines up with the map's own
  // graticule or with a pipeline. Two earlier attempts failed for opposite
  // reasons -- a control tower read as unidentifiable scenery, and crossed
  // runways in a rounded frame read as an X-in-a-box, i.e. a close button. The
  // markings are what make this one a runway rather than a slanted bar, so
  // they are drawn at stroke widths that survive the 20px pin size.
  airBase: '<g transform="rotate(-35 12 12)">' +
    '<rect x="9" y="1.8" width="6" height="20.4" rx="0.8" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-width="1.7"/>' +
    '<line x1="12" y1="6.4" x2="12" y2="17.6" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2.8"/>' +
    '<line x1="10.1" y1="4" x2="13.9" y2="4" stroke="currentColor" stroke-width="1.4"/>' +
    '<line x1="10.1" y1="20" x2="13.9" y2="20" stroke="currentColor" stroke-width="1.4"/>' +
    '</g>',

  // ---- layer-ticker glyphs (LayersSection.jsx/PlacesSection.jsx/
  // WeatherSection.jsx) -- these stand in for a layer that either has no
  // single representative marker icon of its own (FIRMS/jamming render as
  // heatmaps, weather layers are raster tiles, countries/cities aren't
  // marker-based at all) or needs a generic category glyph.
  fire: '<path fill="currentColor" d="M12 2 C8 7 5 10 5 14 a7 7 0 0 0 14 0 C19 10 16 7 12 2 Z"/><path fill="#0b0d10" d="M12 10 C10 13 9 14.5 9 16.5 a3 3 0 0 0 6 0 C15 14.5 14 13 12 10 Z"/>',
  jammingSignal: '<path fill="none" stroke="currentColor" stroke-width="2" d="M4 18 A8 8 0 0 1 20 18"/><path fill="none" stroke="currentColor" stroke-width="2" d="M8 18 A4 4 0 0 1 16 18"/><circle cx="12" cy="18" r="1.6" fill="currentColor"/><line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2.4"/>',
  globe: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><ellipse cx="12" cy="12" rx="4" ry="9" fill="none" stroke="currentColor" stroke-width="1.4"/><line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="1.4"/>',
  // ---- cities, as graduated symbols by population (decorators.js's
  // CITY_TIERS) ----
  //
  // Rank reads off the shape as well as the size, so a megacity is still
  // obviously a megacity next to a town when both are drawn small, and a lone
  // pin is still readable with nothing to compare it against. Complexity grows
  // with rank -- a solid dot survives 8px, a skyline does not, so the skyline
  // is only ever used at 18px.
  cityTown: '<circle cx="12" cy="12" r="8" fill="currentColor"/>',
  cityMedium: '<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="2.6"/><circle cx="12" cy="12" r="3.6" fill="currentColor"/>',
  cityLarge: '<rect x="3.4" y="3.4" width="17.2" height="17.2" rx="1.6" fill="none" stroke="currentColor" stroke-width="2.8"/><circle cx="12" cy="12" r="3.4" fill="currentColor"/>',
  // Also the Places-ticker glyph for the cities layer as a whole.
  city: '<rect x="3" y="11" width="5.4" height="10" fill="currentColor"/><rect x="9.8" y="5.5" width="5" height="15.5" fill="currentColor"/><rect x="16.2" y="8.5" width="4.8" height="12.5" fill="currentColor"/>',
  raindrop: '<path fill="currentColor" d="M12 2 C8 8 5 11 5 15 a7 7 0 0 0 14 0 C19 11 16 8 12 2 Z"/>',
  cloud: '<path fill="currentColor" d="M7 18 a4 4 0 0 1 0 -8 a5 5 0 0 1 9.6 -1.5 A4.5 4.5 0 0 1 17 18 Z"/>',
  wind: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M3 8 H14 a3 3 0 1 0 -3 -3"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M3 16 H17 a3 3 0 1 1 -3 3"/>',
  // ---- conflict & violence event types (see decorators.js's
  // ACLED_EVENT_ICON) ----
  //
  // One recognisable object per kind of event, rather than one shape reused at
  // different colours. The set this replaces had `explosion` defined as a
  // byte-for-byte copy of `burst`, and `burst` was also the fallback for any
  // label that matched nothing -- so in practice almost every conflict pin on
  // the map was the same eight-pointed star, and the only other common glyph
  // (crossed swords) read as three slashes at 13-31px.
  //
  // All of these are drawn in currentColor only. The old violenceCivilians
  // punched its detail out in a hardcoded `#0b0d10`, which is invisible
  // against the light theme's background.

  // Finned bomb, falling.
  airstrike: '<path fill="currentColor" d="M12 21.6c-2.3-2-3.6-4.4-3.6-7 0-3.5 1.4-6.2 3.6-8.2 2.2 2 3.6 4.7 3.6 8.2 0 2.6-1.3 5-3.6 7z"/>' +
    '<path fill="currentColor" d="M9.5 7.4 6.6 2.6l3.4 1.3L12 1.4l2 2.5 3.4-1.3-2.9 4.8z"/>',
  // Howitzer: wheeled trail, raised barrel, muzzle blast.
  artillery: '<path fill="currentColor" d="M2 17.6h11.4l-1.7 3.8H3.4z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M6.2 16.6 15.4 8"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M17.2 7.2 21.4 4.2M18 9.4l4.2-1M15.4 4.6 16.6 1.2"/>',
  // Quadcopter seen from above.
  droneStrike: '<circle cx="12" cy="12" r="2.6" fill="currentColor"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.8" d="M6.6 6.6 17.4 17.4M17.4 6.6 6.6 17.4"/>' +
    '<circle cx="5" cy="5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    '<circle cx="19" cy="5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    '<circle cx="5" cy="19" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    '<circle cx="19" cy="19" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  // Bullet in flight with impact rays.
  smallArms: '<path fill="currentColor" d="M2 9.2h8.6l4.2 2.8-4.2 2.8H2z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M17 12h4.6M16.4 8.6 20 5.8M16.4 15.4 20 18.2"/>',
  // Deliberately irregular: a symmetric star reads as a rating, an asymmetric
  // jagged burst reads as a detonation.
  blast: '<path fill="currentColor" d="M12 1.5 14.3 8 21.7 6.8 16.2 11.4 21.1 16.2 14.8 15.5 12.3 21.8 9.5 15.6 2.9 16.8 7.7 11.6 3.3 5.9 10.5 7.8Z"/>',
  // Two arrowheads driven into each other.
  clash: '<path fill="currentColor" d="M2 3.6 10.4 12 2 20.4Z"/><path fill="currentColor" d="M22 3.6 13.6 12 22 20.4Z"/>',
  // A person, struck.
  civilianHarm: '<circle cx="14.5" cy="4.6" r="2.6" fill="currentColor"/>' +
    '<path fill="currentColor" d="M11.1 8.8h6.8l1.7 6.3-2.4.7-.6-2.3V22h-1.9v-5.4h-1.2V22h-1.9v-8.5l-.6 2.3-2.4-.7z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M1.6 5.4 4.8 7.6M1.6 12h3.6M1.6 18.6 4.8 16.4"/>',
  // A person held between two brackets -- taken, not merely harmed.
  abduction: '<circle cx="12" cy="6" r="2.6" fill="currentColor"/>' +
    '<path fill="currentColor" d="M8.6 10.2h6.8l1.4 5.6-2.3.7-.5-2V22h-1.9v-5.2h-1.2V22H9v-7.5l-.5 2-2.3-.7z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M5 2.6H2.2v18.8H5M19 2.6h2.8v18.8H19"/>',
  // Flag planted on hatched ground.
  occupation: '<rect x="4.6" y="2" width="2.1" height="17.2" fill="currentColor"/>' +
    '<path fill="currentColor" d="M6.7 3.2 18.6 6.6 6.7 10Z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M1.6 19.2h20.8M4 22.4l2.2-2.2M9 22.4l2.2-2.2M14 22.4l2.2-2.2M19 22.4l2.2-2.2"/>',
  // Ringed and barred: nothing in, nothing out.
  siege: '<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="2.6"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" d="M6.1 6.1 17.9 17.9"/>',
  // Three raised fists at different heights -- a crowd, not one person.
  riot: '<path fill="currentColor" d="M3.4 22v-6.4a1.7 1.7 0 0 1 3.4 0V22Z"/><circle cx="5.1" cy="14.4" r="2.3" fill="currentColor"/>' +
    '<path fill="currentColor" d="M10.3 22V9.6a1.7 1.7 0 0 1 3.4 0V22Z"/><circle cx="12" cy="8.4" r="2.4" fill="currentColor"/>' +
    '<path fill="currentColor" d="M17.2 22v-9a1.7 1.7 0 0 1 3.4 0V22Z"/><circle cx="18.9" cy="11.8" r="2.3" fill="currentColor"/>',
  // A banner between two poles -- a march, distinct from occupation's flag.
  protest: '<rect x="2.6" y="3" width="1.9" height="19" fill="currentColor"/>' +
    '<rect x="19.5" y="3" width="1.9" height="19" fill="currentColor"/>' +
    '<rect x="4.5" y="5.6" width="15" height="8.2" fill="none" stroke="currentColor" stroke-width="2"/>',
  // Fallback, and the glyph for CAMEO 180 "unconventional violence,
  // unspecified" -- which is genuinely "something violent, we do not know
  // what", so drawing it as a hazard mark is the honest answer rather than a
  // guess at a weapon.
  unknownViolence: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M12 2.2 22.4 20.6H1.6Z"/>' +
    '<rect x="11" y="9" width="2" height="6" rx="1" fill="currentColor"/>' +
    '<circle cx="12" cy="17.6" r="1.3" fill="currentColor"/>',
  // UCDP's reviewed record: a hollow survey mark, not an event glyph. It must
  // never read like something that just happened (see decorateHistoricalEvent).
  recordMark: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M12 2.8 21.2 12 12 21.2 2.8 12Z"/>' +
    '<circle cx="12" cy="12" r="2.4" fill="currentColor"/>',
};

// A small crosshair/target glyph used by the news panel's "show on map"
// button -- not a map marker icon, but kept alongside SVG since it's the
// same monochrome-currentColor style.
export const NEWS_LOCATE_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<line x1="12" y1="2" x2="12" y2="6" stroke="currentColor" stroke-width="2"/><line x1="12" y1="18" x2="12" y2="22" stroke="currentColor" stroke-width="2"/>' +
  '<line x1="2" y1="12" x2="6" y2="12" stroke="currentColor" stroke-width="2"/><line x1="18" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="2"/></svg>';

// `opacity`, `wrapClass` and `offset` are rendered into the HTML string rather
// than into divIcon's className, and that placement matters: createMapController's
// updateMarker skips setIcon when the HTML is unchanged, so anything expressed
// only through className would never trigger a repaint when it changes.
//
// `offset` is the declutter nudge (see declutter.js): a *visual* shift only.
// The marker itself stays on its true LatLng -- that is what keeps popups,
// tooltips and every distance calculation honest -- so when the shift is big
// enough to notice, a thin leader line is drawn from the glyph back to the real
// point rather than letting the map quietly misplace things.
const LEADER_MIN_PX = 8;

export function buildDivIcon(L, svgInner, color, size, rotateDeg, extraClass, opacity, wrapClass, offset) {
  const rot = Number.isFinite(rotateDeg) ? rotateDeg : 0;
  const alpha = Number.isFinite(opacity) ? opacity : 1;
  const dx = offset?.dx || 0;
  const dy = offset?.dy || 0;
  const cls = wrapClass ? `entity-icon-wrap ${wrapClass}` : "entity-icon-wrap";
  const shift = dx || dy ? `translate(${dx}px,${dy}px) ` : "";

  // Suppressed on rotated glyphs (ships/aircraft): the wrapper's rotation would
  // spin the leader too, so it would point somewhere meaningless.
  let leader = "";
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (!rot && dist >= LEADER_MIN_PX) {
    const angle = (Math.atan2(-dy, -dx) * 180) / Math.PI;
    leader = `<span class="pin-leader" style="width:${Math.round(dist)}px;transform:rotate(${angle.toFixed(1)}deg);"></span>`;
  }

  const html =
    `<div class="${cls}" style="width:${size}px;height:${size}px;color:${color};opacity:${alpha};transform:${shift}rotate(${rot}deg);">` +
    leader +
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}">${svgInner}</svg></div>`;
  // `entity-marker` makes the Leaflet-positioned outer element click-through so
  // the only hit target is the wrapper at its shifted position -- otherwise a
  // nudged icon left a second, invisible target sitting at its true point.
  const outerClass = extraClass ? `entity-marker ${extraClass}` : "entity-marker";
  return L.divIcon({ html, className: outerClass, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}
