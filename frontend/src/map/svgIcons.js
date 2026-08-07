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
  // Trainer: a small straight-winged aircraft. It is the largest single group
  // in the live military feed (96 of 310 -- T-6 Texans, T-38 Talons, T-45
  // Goshawks), and every one of them used to draw as the generic red wedge, so
  // the busiest thing on the military layer was also the least informative.
  // Straight wings and a stubby fuselage read as "not a combat aircraft" at a
  // glance, which is the distinction that matters here.
  planeTrainer: '<path fill="currentColor" d="M12 3 C12.8 4.6 13.1 6.4 13.1 8.4 L13.1 17.4 L12.6 20.6 L11.4 20.6 L10.9 17.4 L10.9 8.4 C10.9 6.4 11.2 4.6 12 3 Z"/>' +
    '<rect x="3.2" y="11.2" width="17.6" height="2.2" rx="1.1" fill="currentColor"/>' +
    '<rect x="7.6" y="18.6" width="8.8" height="1.8" rx="0.9" fill="currentColor"/>',
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
  // A country losing the internet (backend/sources/outages.py). The globe above
  // struck through, borrowing the same "signal, cancelled" slash jammingSignal
  // uses -- the two are the only layers on this map about connectivity being
  // taken away, and they should read as relatives at a glance.
  connectivityLoss: '<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    '<ellipse cx="12" cy="12" rx="3.8" ry="8.6" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<line x1="3.4" y1="12" x2="20.6" y2="12" stroke="currentColor" stroke-width="1.3"/>' +
    '<line x1="4.2" y1="19.8" x2="19.8" y2="4.2" stroke="currentColor" stroke-width="2.4"/>',
  // ---- aircraft status rings (backend/sources/adsb.py) ----
  //
  // Appended to whatever airframe glyph an aircraft already has, rather than
  // replacing it: an emergency does not stop a KC-135 being a tanker, and the
  // role glyph is still what a reader needs. Both are drawn at the very edge of
  // the 24x24 box so the wingtips stay readable underneath.
  alertRing: '<circle cx="12" cy="12" r="11.2" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  // A designation ring, for an OFAC-listed hull or airframe. Double-struck so
  // it cannot be confused with the single emergency ring above at a glance.
  sanctionRing: '<circle cx="12" cy="12" r="11.3" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<circle cx="12" cy="12" r="9.1" fill="none" stroke="currentColor" stroke-width="1.1" stroke-opacity="0.7"/>',
  // Runways seen from above, for the OurAirports reference layer. Deliberately
  // unlike every aircraft glyph: this is a place, not a contact. The four
  // variants differ in *layout*, not just in size, because size alone is only
  // legible when two fields happen to sit side by side:
  //
  //   large    two parallel runways -- the plan-view signature of a hub
  //   medium   one paved, marked runway (outline + centreline)
  //   small    one short unmarked strip, no surround at all
  //   military the same marked runway, inside the shield the base layers use
  //
  // The circle is the "this is a fixed place" surround, dropped on the small
  // strip: those are the most numerous fields on the map and the quietest ones,
  // so they get the least ink.
  airfieldLarge: '<g transform="rotate(-30 12 12)">' +
    '<rect x="2.6" y="7.9" width="18.8" height="2.7" rx="0.5" fill="currentColor"/>' +
    '<rect x="4.8" y="13.4" width="14.4" height="2.7" rx="0.5" fill="currentColor"/>' +
    '</g>' +
    '<circle cx="12" cy="12" r="9.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-opacity="0.55"/>',
  // Also the layer's own ticker glyph (LayersSection.jsx), so it has to stand
  // in for the whole layer as well as for the medium tier.
  airfield: '<g transform="rotate(-30 12 12)">' +
    '<rect x="2.4" y="10.3" width="19.2" height="3.4" rx="0.6" fill="currentColor" fill-opacity="0.18" stroke="currentColor" stroke-width="1.5"/>' +
    '<line x1="6.6" y1="12" x2="17.4" y2="12" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.6 2.4"/>' +
    '</g>' +
    '<circle cx="12" cy="12" r="9.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-opacity="0.55"/>',
  airfieldSmall: '<rect x="4.6" y="10.7" width="14.8" height="2.6" rx="0.4" fill="currentColor" transform="rotate(-30 12 12)"/>',
  // Same shield as armyBase, so a military field reads as a relative of the
  // military base layer rather than as a fourth unrelated shape, with the
  // medium field's marked runway held inside it instead of cutting across it.
  airfieldMilitary: '<path fill="none" stroke="currentColor" stroke-width="1.6" d="M12 2 L21 7 L21 13 C21 18 17 21.5 12 22 C7 21.5 3 18 3 13 L3 7 Z"/>' +
    '<g transform="rotate(-30 12 12)">' +
    '<rect x="9.8" y="6.2" width="4.4" height="11.6" rx="0.5" fill="currentColor" fill-opacity="0.18" stroke="currentColor" stroke-width="1.5"/>' +
    '<line x1="12" y1="8.8" x2="12" y2="15.2" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.3 2.1"/>' +
    '</g>',
  // Dashed, deliberately: the aircraft is *not* fully shown, and a broken
  // outline says that without a word.
  hiddenRing: '<circle cx="12" cy="12" r="11.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 2.6" stroke-opacity="0.9"/>',
  // ---- OpenStreetMap-derived infrastructure (backend/sources/osm_infra.py) ----
  //
  // Deliberately simpler and flatter than the curated infrastructure glyphs
  // above: these are crowd-sourced and are meant to read as a quieter,
  // second-tier layer sitting underneath them.
  powerPlant: '<path fill="none" stroke="currentColor" stroke-width="1.8" d="M4.6 20.4V9.2l7.4-5.6 7.4 5.6v11.2Z"/>' +
    '<path fill="currentColor" d="M12.9 8.4 9 14.2h2.4L10.9 19l4.1-6.2h-2.6Z"/>',
  borderCrossing: '<path fill="none" stroke="currentColor" stroke-width="1.8" d="M6 3.4v17.2M18 3.4v17.2"/>' +
    '<path fill="currentColor" d="M6 8.2h12v3.2H6Z"/>',
  // ---- orbital launches (backend/sources/launches.py) ----
  //
  // A rocket on the pad rather than in flight: the pin marks a place on the
  // ground, and a streaking rocket would read as something moving.
  launchPad: '<path fill="currentColor" d="M12 1.4c2.1 2.6 3.1 5.8 3.1 9.2v5.2H8.9v-5.2c0-3.4 1-6.6 3.1-9.2Z"/>' +
    '<path fill="currentColor" d="M8.9 12.4 6.2 17.8h2.7Zm6.2 0 2.7 5.4h-2.7Z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M6.6 21.4h10.8"/>',
  // ---- submarine cables (backend/sources/cables.py) ----
  //
  // A cable coming ashore: the line ends at a shore, the shore is the pin.
  cableLanding: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M2.4 16.4h7.2"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M14.4 16.4h7.2"/>' +
    '<circle cx="12" cy="16.4" r="2.6" fill="currentColor"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 13.8V5.6M8.6 8.4 12 5 15.4 8.4"/>',
  // ---- derived from our own AIS history (backend/sources/dark_vessels.py) ----
  //
  // Both are drawn broken or doubled rather than solid, because both mark an
  // inference rather than a report. A reader should be able to tell at a glance
  // that these two are a different kind of claim from every other pin.
  darkShip: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3.4 2.4" ' +
    'd="M3 14.6h18l-3 5.4H6Z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3.4 2.4" d="M11.4 3.6v11"/>' +
    '<line x1="4" y1="4" x2="20" y2="20" stroke="currentColor" stroke-width="2.2"/>',
  stsTransfer: '<path fill="currentColor" d="M1.4 13.6h9l-1.6 4.4H3Z"/>' +
    '<path fill="currentColor" d="M13.6 13.6h9l-1.6 4.4H15.2Z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="2.4 1.8" d="M10.4 11.4h3.2"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.6" d="M5.4 13.6V7.4M18.6 13.6V7.4"/>',
  // ---- natural hazards (backend/sources/hazards.py) ----
  //
  // A seismograph trace and a cone with a plume: both read as themselves at
  // 13px, and neither can be mistaken for the fire drop or the conflict
  // glyphs they will sit beside.
  earthquake: '<circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.45"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" ' +
    'd="M2.6 12h3.2l1.9-5.4 2.5 10.4 2.4-8.2 1.8 4.6 1.4-2.4h5.6"/>',
  volcano: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M2.8 20.4 9 9.6h6l6.2 10.8Z"/>' +
    '<path fill="currentColor" d="M9 9.6h6l-1.5 2.6h-3Z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 8.4V5.2M9 7.2 7.4 4.6M15 7.2l1.6-2.6"/>',
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
  // A national capital: cityLarge's rounded square with a star in it, so the
  // family relationship reads at a glance -- a capital is a city, marked. The
  // star is the near-universal cartographic convention for a seat of
  // government, which means it needs no legend to be understood (it has one
  // anyway, see PlacesSection).
  //
  // Doubles as the Officials & Diplomacy hub glyph: when several diplomatic
  // items are collapsed onto a capital, this is the shape that says where they
  // are. A single kind glyph would be a lie for a mixed group.
  capital: '<rect x="2.6" y="2.6" width="18.8" height="18.8" rx="1.8" fill="none" stroke="currentColor" stroke-width="2.4"/><path fill="currentColor" d="M12 5.8 L13.85 10.6 L19 10.9 L15 14.1 L16.3 19 L12 16.25 L7.7 19 L9 14.1 L5 10.9 L10.15 10.6 Z"/>',
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

  // --- Officials & Diplomacy -------------------------------------------
  //
  // Deliberately drawn from a different visual vocabulary than the conflict
  // glyphs above: no weapons, no blast shapes. These are things people said
  // and did in rooms, and a reader must never mistake one for an attack.
  //
  // A speaker behind a lectern.
  podium: '<circle cx="12" cy="3.6" r="2.2" fill="currentColor"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 6.6v4.2M8.4 8.6h7.2"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M6.6 11.4h10.8l-1.6 10.2H8.2Z"/>',
  // Two hands clasped -- the meeting glyph.
  handshake: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'd="M2.4 10.4 6 7.4h4l2 1.8 2-1.8h4l3.6 3v4.4L18 17.6l-2.6-2.4-1.8 1.4-1.6-1.4-1.8 1.4L8 17.6l-3.6-2.8Z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M12 9.2v5"/>',
  // A sealed document -- a signed agreement or treaty.
  treaty: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M5.4 2.4h9.2l4 4v11.4H5.4Z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M8.4 7.6h5M8.4 11h7.2"/>' +
    '<circle cx="16.4" cy="18.8" r="3" fill="currentColor"/>',
  // A pointing hand: something demanded of somebody else.
  demandHand: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'd="M10.4 12.2V4.6a1.8 1.8 0 0 1 3.6 0v5.8"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" ' +
    'd="M14 10.4a1.7 1.7 0 0 1 3.4 0v1a1.7 1.7 0 0 1 3.2.8v3.4c0 3.4-2.6 6-6 6h-2.2c-2.4 0-3.6-1.2-5-3.2l-2.6-3.8a1.8 1.8 0 0 1 2.8-2.2l2.8 2.8"/>',
  // A raised, closed fist -- a threat, without depicting a weapon.
  threatFist: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" ' +
    'd="M5.2 9.4a2 2 0 0 1 4 0m0 0a2 2 0 0 1 4 0m0 0a2 2 0 0 1 4 0v4.8c0 3.6-2.6 6.4-6.2 6.4S4.6 17.8 4.6 14.2v-2.6a1.9 1.9 0 0 1 3.8 0"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M8.6 5.2 7.4 2.6M12 4.4V2M15.4 5.2l1.2-2.6"/>',
  // A broken link -- relations cut, an ambassador expelled, sanctions imposed.
  severedTies: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
    'd="M9.6 14.4 7.4 16.6a3.6 3.6 0 0 1-5-5l2.2-2.2M14.4 9.6l2.2-2.2a3.6 3.6 0 0 1 5 5l-2.2 2.2"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12.4 3.4 13.6 6M3.4 12.4 6 13.6M18 10.4l2.6-1.2"/>',
  // Chevrons: forces moved, readiness raised. Force posture, not force used.
  mobilize: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" ' +
    'd="M4 9.6 12 3.4l8 6.2M4 15 12 8.8 20 15M4 20.6 12 14.4l8 6.2"/>',
  // An open hand offering -- aid provided.
  aidHand: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'd="M3 13.6h3.4l3 2.4h4a1.5 1.5 0 0 0 0-3h-3l-2-1.6h-5.4"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'd="M10.4 16h4.2l6-3.4a1.6 1.6 0 0 1 1.6 2.8l-6.4 4.4H6.4l-3.4-2"/>' +
    '<path fill="currentColor" d="M12 2.4c1.6 1.6 2.6 2.6 2.6 3.8a2.6 2.6 0 1 1-5.2 0c0-1.2 1-2.2 2.6-3.8Z"/>',

  // ---- Global Fishing Watch (backend/sources/gfw_gaps.py, gfw_detections.py) --
  //
  // Two glyphs from one publisher that must never read as the same claim.
  // The first is dashed like darkShip above, because it marks an inference
  // about an absence. The second is the only solid hull on this map that is
  // neither a live transponder nor an inference: an instrument saw it.
  //
  // A hull drawn broken, with the transmission arcs above it cut through: the
  // vessel is still there, the broadcast is what stopped. Deliberately a
  // relative of darkShip rather than a copy -- same subject, different hand.
  aisDisabling: '<path fill="none" stroke="currentColor" stroke-width="1.9" stroke-dasharray="3.2 2.2" ' +
    'stroke-linejoin="round" d="M3.4 15.4h17.2l-2.8 5H6.2Z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 15.4V9.6"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M8.8 8.4a4.6 4.6 0 0 1 6.4 0"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M6.4 5.6a8 8 0 0 1 11.2 0"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" d="M4.8 9.8 19.2 2.2"/>',
  // A solid hull held in a reticle's corners. Solid on purpose: this is the one
  // maritime record entitled to say *detected*, so nothing about it is drawn
  // broken. Unmatched detections additionally wear hiddenRing above.
  hullDetection: '<path fill="currentColor" d="M5.8 12.6h12.4l-2.3 4.6H8.1Z"/>' +
    '<path fill="currentColor" d="M11 6.6v6l4.4-2.4Z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ' +
    'd="M2.8 7.2V2.8h4.4M16.8 2.8h4.4v4.4M21.2 16.8v4.4h-4.4M7.2 21.2H2.8v-4.4"/>',

  // ---- EASA conflict-zone bulletins (backend/sources/czib.py) ----
  //
  // A flight information region with an aircraft inside it, struck through: the
  // claim is about a volume of airspace, not about any aircraft in it. Rounded
  // rather than square so it does not read as borderCrossing above.
  airspaceRestricted: '<rect x="2.6" y="4.6" width="18.8" height="14.8" rx="3.4" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
    '<path fill="currentColor" d="M12 7.8l2.9 8.2-2.9-1.9-2.9 1.9Z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M5.4 19.4 18.6 4.6"/>',

  // ---- GDACS floods (backend/sources/floods.py) ----
  //
  // A building standing in water rather than a raindrop: `desalination` above is
  // already a droplet and this is not weather. The waterline crossing the walls
  // is the whole glyph -- water where a structure is.
  flooding: '<path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" ' +
    'd="M7.4 16.8V8.4L12 4.6l4.6 3.8v8.4"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ' +
    'd="M2.4 14.8c1.9 0 1.9 1.7 3.8 1.7s1.9-1.7 3.8-1.7 1.9 1.7 3.8 1.7 1.9-1.7 3.8-1.7 1.9 1.7 3.8 1.7"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ' +
    'd="M2.4 18.8c1.9 0 1.9 1.7 3.8 1.7s1.9-1.7 3.8-1.7 1.9 1.7 3.8 1.7 1.9-1.7 3.8-1.7 1.9 1.7 3.8 1.7"/>',

  // ---- NGA World Port Index (backend/sources/ports.py) ----
  //
  // The bare chart symbol, hollow. Deliberately not `port` above, which is the
  // curated-infrastructure glyph and is filled: hollow-versus-solid is the same
  // argument osmInfra makes against infra -- a gazetteer sitting underneath a
  // hand-checked list.
  anchor: '<circle cx="12" cy="4.4" r="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" d="M12 6.8v13.6"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" d="M7.8 9.6h8.4"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ' +
    'd="M4.6 13.2c0 4.2 3.3 7.2 7.4 7.2s7.4-3 7.4-7.2"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M4.6 13.2l2.4 1.4M19.4 13.2 17 14.6"/>',

  // ---- Global Dam Watch (backend/sources/dams.py) ----
  //
  // A wall bowed against the water it holds, the impounded surface behind it and
  // the outflow past it. The curve is the point: a dam is a structure that is
  // holding something back, and the pin is sized by how much.
  dam: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
    'd="M14.8 3.2c-4.8 3.6-4.8 14 0 17.6"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'd="M2.8 8.2h8M2.8 11.8h7M2.8 15.4h8"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M15.4 11.8h5.8"/>',
};

// Which glyph an Officials & Diplomacy record gets, keyed on the `kind` the
// backend assigns (cameo.KIND_BY_ROOT for CAMEO-coded rows,
// official_feeds.classify_kind for press releases). One table so the map and
// the control panel's legend can never disagree about what a shape means.
export const OFFICIALS_KIND_ICON = {
  statement: SVG.podium,
  meeting: SVG.handshake,
  agreement: SVG.treaty,
  demand: SVG.demandHand,
  threat: SVG.threatFist,
  rupture: SVG.severedTies,
  posture: SVG.mobilize,
  aid: SVG.aidHand,
  protest: SVG.protest,
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

// `badge` is the count on a collapsed news pin (see collapse.js). Rendered into
// the same HTML string as everything else, for the same repaint reason -- a
// badge expressed through a class or a data attribute would never trigger
// setIcon when the count changed.
export function buildDivIcon(L, svgInner, color, size, rotateDeg, extraClass, opacity, wrapClass, offset, badge) {
  const rot = Number.isFinite(rotateDeg) ? rotateDeg : 0;
  const alpha = Number.isFinite(opacity) ? opacity : 1;
  const dx = offset?.dx || 0;
  const dy = offset?.dy || 0;
  const cls = wrapClass ? `entity-icon-wrap ${wrapClass}` : "entity-icon-wrap";
  const shift = dx || dy ? `translate(${dx}px,${dy}px) ` : "";
  // Capped at "99+": past that the exact number tells a reader nothing they
  // can act on, and a four-digit chip is wider than the pin it sits on.
  const chip = badge > 1
    ? `<span class="pin-badge">${badge > 99 ? "99+" : badge}</span>`
    : "";

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
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}">${svgInner}</svg>${chip}</div>`;
  // `entity-marker` makes the Leaflet-positioned outer element click-through so
  // the only hit target is the wrapper at its shifted position -- otherwise a
  // nudged icon left a second, invisible target sitting at its true point.
  const outerClass = extraClass ? `entity-marker ${extraClass}` : "entity-marker";
  return L.divIcon({ html, className: outerClass, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}
