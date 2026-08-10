// Simple monochrome SVG paths, colored via currentColor -- shared by every
// marker decorator in decorators.js and turned into Leaflet divIcons by
// buildDivIcon() below.

export const SVG = {
  news: '<rect x="4" y="5" width="16" height="14" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><line x1="7" y1="9" x2="17" y2="9" stroke="currentColor" stroke-width="1.6"/><line x1="7" y1="12.5" x2="17" y2="12.5" stroke="currentColor" stroke-width="1.6"/><line x1="7" y1="16" x2="13" y2="16" stroke="currentColor" stroke-width="1.6"/>',
  ship: '<path fill="currentColor" d="M3 15 L21 15 L18 20 L6 20 Z"/><path fill="currentColor" d="M11 3 L11 15 L17 12 Z"/>',
  // Wider hull + a row of cargo/tank domes -- distinct silhouette from the
  // plain wedge-hulled `ship` glyph so tankers stand out at a glance.
  tanker: '<path fill="currentColor" d="M2 14 L22 14 L19 20 L5 20 Z"/><circle cx="7" cy="11" r="2" fill="currentColor"/><circle cx="12" cy="10.5" r="2.3" fill="currentColor"/><circle cx="17" cy="11" r="2" fill="currentColor"/>',
  // A warship from above, bow at the top -- the only hull glyph drawn in plan
  // view, and the reason is that ship markers are rotated to their heading:
  // spinning `ship`'s side elevation round its centre produces a shape facing
  // nowhere, and a navy contact is the one hull where the direction it is
  // pointing is the point. Fine bow, parallel sides, transom stern, with the
  // three things that make a hull a warship rather than a freighter: a forward
  // gun mount, a blockish superstructure amidships, and a flight deck circle
  // aft. Hollow hull so all three stay legible inside it at 26px.
  warship: '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" ' +
    'd="M12 1.2c2.4 3 3.6 6.4 3.6 10v8.2c0 1.3-1.6 2.2-3.6 2.2s-3.6-.9-3.6-2.2v-8.2c0-3.6 1.2-7 3.6-10Z"/>' +
    '<circle cx="12" cy="8.6" r="1.6" fill="currentColor"/>' +
    '<path fill="currentColor" d="M9.7 11.4h4.6v4.6H9.7z"/>' +
    '<circle cx="12" cy="18.2" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  planeCommercial: '<path fill="currentColor" d="M12 1 L16 20 L12 16.5 L8 20 Z"/>',
  // "Military, role not established" -- the fallback every military aircraft
  // lands on when adsb.py's role heuristic has nothing to read (OpenSky-only
  // records carry no type description at all, and a callsign-prefix hit says
  // nothing about the airframe). It used to be a bare arrowhead, which is why
  // so much of the military layer looked like unlabelled triangles: an
  // aircraft with no known role got a shape that was not even an aircraft.
  // Now a plain swept-wing jet -- deliberately the least distinctive airframe
  // in the set, since the honest claim is "an aircraft, type unknown", but an
  // aircraft nonetheless.
  planeMilitary: '<path fill="currentColor" d="M12 1.4c1 1.9 1.5 4.2 1.5 6.9v9.4c0 1.8-.5 3.3-1.5 4.5-1-1.2-1.5-2.7-1.5-4.5V8.3c0-2.7.5-5 1.5-6.9Z"/>' +
    '<path fill="currentColor" d="M13.5 9.4 22 13.4v1.7l-8.5-2.1Z"/>' +
    '<path fill="currentColor" d="M10.5 9.4 2 13.4v1.7l8.5-2.1Z"/>' +
    '<path fill="currentColor" d="M13.5 18.2 17.4 20v1.2l-3.9-1.4Z"/>' +
    '<path fill="currentColor" d="M10.5 18.2 6.6 20v1.2l3.9-1.4Z"/>',
  planeOther: '<path fill="currentColor" d="M12 3 L15 19 L12 16.2 L9 19 Z"/>',
  // Plan view, because the marker is rotated to the aircraft's heading and a
  // side elevation spun round its centre reads as nothing at all. Rotor disc,
  // two blades through the hub, a slim pod and a tail boom carrying an offset
  // tail rotor -- the boom is what separates a helicopter from a compass rose
  // at 16px, so it runs well past the disc.
  helicopter: '<circle cx="12" cy="10.6" r="8.6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-opacity="0.55"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6.1 4.5 17.9 16.7M17.9 4.5 6.1 16.7"/>' +
    '<path fill="currentColor" d="M12 5.4c1.8 0 3.2 1.5 3.2 3.4v4.4c0 1.9-1.4 3.4-3.2 3.4s-3.2-1.5-3.2-3.4V8.8c0-1.9 1.4-3.4 3.2-3.4Z"/>' +
    '<path fill="currentColor" d="M11.1 15.6h1.8v6h-1.8z"/>' +
    '<path fill="currentColor" d="M9.1 19.6h1.9v3.4H9.1z"/>',

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
  // Every glyph below is a plan view with the nose at the top, because the
  // marker is rotated to the aircraft's track. They used to be the same
  // arrowhead wedge with one detail added on top -- a boom, a dish, a dot --
  // which at 15-21px meant the military layer read as a field of triangles.
  // Each is now an airframe first and a role second: the silhouette carries
  // the class, the added detail only names which one.
  //
  // A flying wing: nose forward, the whole body sweeping back into the tips.
  // The biggest and most distinctive shape in the set, which is right -- a
  // bomber is the one contact here a reader should never have to look twice at.
  planeBomber: '<path fill="currentColor" d="M12 1.6c1.2 2.4 1.8 5.2 1.8 8.4v6.6l8.4 4.6v1.4L13.8 20v1.8L12 23l-1.8-1.2V20l-8.4 2.6v-1.4l8.4-4.6V10c0-3.2.6-6 1.8-8.4Z"/>',
  // Swept-wing jet trailing a refuelling boom with its ruddevators spread --
  // the boom is the one thing only a tanker has, so it stays, but it now hangs
  // off an aircraft instead of off a triangle.
  planeTanker: '<path fill="currentColor" d="M12 2.2c1 1.8 1.5 4 1.5 6.6v8.4c0 1.5-.5 2.8-1.5 3.8-1-1-1.5-2.3-1.5-3.8V8.8c0-2.6.5-4.8 1.5-6.6Z"/>' +
    '<path fill="currentColor" d="M13.5 9.8 22.2 12.8v1.6l-8.7-1.8Z"/>' +
    '<path fill="currentColor" d="M10.5 9.8 1.8 12.8v1.6l8.7-1.8Z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M12 20.2v2.4"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M9.9 21.4 12 23.2l2.1-1.8"/>',
  // The rotodome sits over the rear fuselage as a ring rather than perched
  // above the nose: on a plan view the dish is a disc, and drawing it anywhere
  // but where it really rides made the aircraft look like it was towing a hoop.
  planeAwacs: '<path fill="currentColor" d="M12 2.6c1 1.8 1.5 3.9 1.5 6.4v8.6c0 1.5-.5 2.8-1.5 3.8-1-1-1.5-2.3-1.5-3.8V9c0-2.5.5-4.6 1.5-6.4Z"/>' +
    '<path fill="currentColor" d="M13.5 10.2 22 13v1.6l-8.5-1.6Z"/>' +
    '<path fill="currentColor" d="M10.5 10.2 2 13v1.6l8.5-1.6Z"/>' +
    '<circle cx="12" cy="15.4" r="3.8" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
    '<path fill="currentColor" d="M13.5 19.8 16.8 21.2v1.1l-3.3-1.1Z"/>' +
    '<path fill="currentColor" d="M10.5 19.8 7.2 21.2v1.1l3.3-1.1Z"/>',
  // Cheek fairings on the forward fuselage -- the Rivet Joint silhouette. A
  // shape nothing else in the set has, and specifically not an arc or a bar:
  // patrol already owns the arc under the hull and three types own a straight
  // wing, so recon needed a marking on the body itself.
  planeRecon: '<path fill="currentColor" d="M12 1.8c1 1.9 1.4 4.1 1.4 6.7v9.2c0 1.5-.5 2.8-1.4 3.7-.9-.9-1.4-2.2-1.4-3.7V8.5c0-2.6.4-4.8 1.4-6.7Z"/>' +
    '<path fill="currentColor" d="M13.4 5.2 16.4 6.4v3.4l-3-1Z"/>' +
    '<path fill="currentColor" d="M10.6 5.2 7.6 6.4v3.4l3-1Z"/>' +
    '<path fill="currentColor" d="M13.4 10.4 21.6 13.4V15l-8.2-1.8Z"/>' +
    '<path fill="currentColor" d="M10.6 10.4 2.4 13.4V15l8.2-1.8Z"/>' +
    '<path fill="currentColor" d="M13.4 18.4 16.8 20v1.1l-3.4-1.2Z"/>' +
    '<path fill="currentColor" d="M10.6 18.4 7.2 20v1.1l3.4-1.2Z"/>',
  // Wave train beneath the aircraft: a maritime patrol is a search pattern
  // flown over water, and the water is the whole distinction from a transport.
  planePatrol: '<path fill="currentColor" d="M12 2.4c1 1.8 1.5 3.9 1.5 6.5v8c0 1.5-.5 2.8-1.5 3.7-1-.9-1.5-2.2-1.5-3.7v-8c0-2.6.5-4.7 1.5-6.5Z"/>' +
    '<path fill="currentColor" d="M13.5 9.8 21.8 12.6v1.6l-8.3-1.6Z"/>' +
    '<path fill="currentColor" d="M10.5 9.8 2.2 12.6v1.6l8.3-1.6Z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
    'd="M3.4 21.6c1.7 0 1.7-1.5 3.4-1.5s1.7 1.5 3.4 1.5 1.7-1.5 3.4-1.5 1.7 1.5 3.4 1.5 1.7-1.5 3.4-1.5"/>',
  // MQ-9: long thin wing set well forward, and a V-tail. The splayed tail is
  // the giveaway -- no crewed type in this set has one, so a drone stays
  // readable even at the 15px it is drawn at.
  planeDrone: '<path fill="currentColor" d="M12 2.4c1.1 1.7 1.6 3.8 1.6 6.2v9.2c0 1.4-.5 2.6-1.6 3.4-1.1-.8-1.6-2-1.6-3.4V8.6c0-2.4.5-4.5 1.6-6.2Z"/>' +
    '<rect x="1.4" y="9.2" width="21.2" height="2.2" rx="1.1" fill="currentColor"/>' +
    '<path fill="currentColor" d="M13.4 17.4 18.4 21.4l-1.2 1.4-3.8-3.2Z"/>' +
    '<path fill="currentColor" d="M10.6 17.4 5.6 21.4l1.2 1.4 3.8-3.2Z"/>',
  // Heavy lifter: a fat fuselage under a wide straight wing, with a tailplane
  // nearly as broad. Told apart from the trainer -- the other straight-winged
  // glyph -- by bulk rather than by any added mark: that is exactly how the two
  // differ in the air.
  planeTransport: '<path fill="currentColor" d="M12 2c1.4 2.1 2.1 4.6 2.1 7.4v8.2c0 1.7-.7 3.2-2.1 4.4-1.4-1.2-2.1-2.7-2.1-4.4V9.4C9.9 6.6 10.6 4.1 12 2Z"/>' +
    '<rect x="1.4" y="9.8" width="21.2" height="2.4" rx="1" fill="currentColor"/>' +
    '<rect x="4.6" y="19.4" width="14.8" height="2.2" rx="1" fill="currentColor"/>',
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
  // ---- military bases (subtype icons) ----
  //
  // A naval base is a place, and it used to be drawn with `ship` -- the same
  // glyph, in the same yellow, as a US Navy vessel underway. A fixed shore
  // installation and a moving hull are not the same claim, and on this map they
  // were indistinguishable. It now wears the shield the other base subtypes use
  // (armyBase below, airfieldMilitary further down), with an anchor inside it:
  // the shield says "military site", the anchor says which service. Distinct
  // from the bare `anchor` glyph too, which is the NGA port gazetteer's mark
  // and carries no shield.
  navalBase: '<path fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-width="1.6" ' +
    'd="M12 2 L21 7 L21 13 C21 18 17 21.5 12 22 C7 21.5 3 18 3 13 L3 7 Z"/>' +
    '<circle cx="12" cy="7.4" r="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M12 8.9v8.6"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M9.2 10.8h5.6"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
    'd="M7.9 13.4c0 2.8 1.8 4.7 4.1 4.7s4.1-1.9 4.1-4.7"/>',
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

  // ---- DeFlock ALPR cameras (backend/sources/deflock.py) ----
  //
  // A wall/pole-mounted surveillance camera: hollow housing with a filled lens
  // and a tapered sensor block at the front, on a bracket. Deliberately quiet --
  // this is crowd-sourced location metadata sitting under the curated layers, the
  // same second-tier reading osmInfra's flatter glyphs get.
  alprCamera: '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" ' +
    'd="M3.4 6.8h10.8v5.6H3.4z"/>' +
    '<circle cx="6" cy="9.6" r="1.5" fill="currentColor"/>' +
    '<path fill="currentColor" d="M14.6 7.8l4.8-2v8l-4.8-2z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
    'd="M8.8 12.6v3.4M6 15.9h5.6"/>',

  // ---- railway points (OpenStreetMap, via backend/sources/osm_infra.py) ----
  //
  // A small train car -- rounded body, a window band and two wheels on a rail --
  // for the station/halt/yard/border nodes the osm_infra sweep now also carries.
  // Flatter and quieter than the curated infrastructure glyphs, matching the rest
  // of the OSM layer it rides inside.
  railway: '<rect x="6" y="3.6" width="12" height="12.2" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
    '<rect x="8.2" y="6" width="7.6" height="4" rx="0.8" fill="currentColor"/>' +
    '<circle cx="9" cy="18" r="1.4" fill="currentColor"/><circle cx="15" cy="18" r="1.4" fill="currentColor"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M6.2 20.8h11.6"/>',

  // ---- water bodies (Natural Earth, via backend/sources/water_bodies.py) ----
  //
  // Three stacked wave lines -- a legend-row glyph only, for the same reason
  // railway.line's `railway` glyph above is: the layer itself is a polygon
  // fill and a line, drawn by water.js's own style function, not by a marker
  // this SVG is turned into. Nothing chooses between shapes here (no
  // GLYPH_CHOICES entry), the same treatment the choropleth ramp gets and for
  // the same reason -- a fill has no shape to pick between.
  wave: '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
    'd="M2.5 8.5c2 -2 4 -2 6 0s4 2 6 0 4 -2 6 0 4 2 6 0"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
    'd="M2.5 14.5c2 -2 4 -2 6 0s4 2 6 0 4 -2 6 0 4 2 6 0"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
    'd="M2.5 20c2 -2 4 -2 6 0s4 2 6 0 4 -2 6 0 4 2 6 0"/>',

  // ---- shipping lanes (Task 20) ----
  //
  // A dashed diagonal with an arrowhead -- a schematic route, deliberately
  // distinct from `pipeline`'s wavy curve and `railway`'s station-box glyph
  // so a reader scanning the legend does not mistake one drawn line for
  // another. Legend-row only, like railway/wave above: the corridors
  // themselves are polylines drawn by renderShippingLanes, not markers this
  // SVG is turned into.
  shippingLane: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="4 3" ' +
    'stroke-linecap="round" d="M2.5 19.5 L17.5 6"/>' +
    '<path fill="currentColor" d="M14.6 3.6 L21 4.8 L18 9.2 Z"/>',
  // A small hull with two wake lines rising behind it -- "traffic density",
  // built from the same wedge-hulled silhouette as `ship` so the family
  // reads as maritime, plus `wave`'s stroke idiom for the density half of
  // the claim. Legend-row only: the wash itself is a canvas
  // (createLaneDensityLayers in layers.js), not a marker.
  laneDensity: '<path fill="currentColor" d="M3 15 L21 15 L18 20 L6 20 Z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
    'd="M2 9.5c1.6-1.6 3.2-1.6 4.8 0s3.2 1.6 4.8 0 3.2-1.6 4.8 0 3.2 1.6 4.8 0"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
    'd="M2 5.5c1.6-1.6 3.2-1.6 4.8 0s3.2 1.6 4.8 0 3.2-1.6 4.8 0 3.2 1.6 4.8 0"/>',
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

/**
 * Which glyphs an operator may choose from, per pin type.
 *
 * Curated rather than "every glyph for every token", and that is the whole
 * point of the table. A picker offering all ninety would let a refinery be drawn
 * as a raindrop, and the rule this map is built on -- every pin states what kind
 * of evidence it is -- survives only as long as the alternatives on offer are
 * all honest readings of the same thing. Each list is a set of glyphs that could
 * legitimately stand for that pin type; the first entry is the shipped default.
 *
 * The working rule for what may join a list: a glyph belongs if it comes from
 * the same *family* as the pin -- vessels for a hull, silhouettes for an
 * airframe, runway layouts for an airfield, industrial plant for industrial
 * plant, base types for a military site, the ring vocabulary for the pins that
 * are about something being absent. Within a family the choice is a matter of
 * how an operator wants their own map to read; across families it becomes a
 * claim about what the thing *is*, which is not the picker's to make. Hence
 * `navalBase` is offered for an OpenStreetMap military area and deliberately
 * not for either port token: both port layers are civil gazetteers, and drawing
 * one as a naval base would assert a military use no source here supports.
 *
 * Three groups are deliberately absent:
 *
 *   severity.*      colours the conflict pin but does not choose its glyph --
 *                   that comes from the event's own text (see EVENT_GLYPHS in
 *                   decorators.js). A token-keyed override would flatten
 *                   thirteen distinct claims into one.
 *   hazards         earthquake/volcano/flood carry no palette token at all, so
 *                   there is nothing here to key on.
 *   colour-only     event.corroborated, sanctions.designated and cable.route
 *                   name a recolour, a ring and a polyline -- none of them is a
 *                   pin with a glyph to swap. They are excluded from the size
 *                   and zoom dials for the same reason.
 */
export const GLYPH_CHOICES = Object.freeze({
  // ---- maritime ----
  //
  // The hull silhouettes are interchangeable between the three traffic classes:
  // which one a reader wants a navy hull drawn as is a question about their own
  // map, and the class is already carried by the colour. The four "something is
  // missing" pins additionally get the ring vocabulary, which is the shape
  // language this map uses for an absence rather than an object.
  "ship.navy": ["warship", "ship", "tanker", "darkShip", "anchor"],
  "ship.tanker": ["tanker", "ship", "warship", "stsTransfer", "darkShip", "anchor"],
  "ship.other": ["ship", "tanker", "warship", "darkShip", "anchor"],
  "dark.gap": ["darkShip", "hiddenRing", "connectivityLoss", "aisDisabling", "alertRing", "ship"],
  "dark.sts": ["stsTransfer", "tanker", "darkShip", "ship", "hiddenRing"],
  "gfw.gap": ["aisDisabling", "darkShip", "hiddenRing", "connectivityLoss", "alertRing"],
  "gfw.unmatched": ["hullDetection", "darkShip", "ship", "warship", "alertRing"],
  "gfw.matched": ["hullDetection", "ship", "tanker", "warship", "anchor"],
  // Anchor first, because that is what PORT_STYLE actually draws -- a hollow
  // anchor rather than the filled `port` glyph the curated infrastructure layer
  // uses, deliberately (see PORT_STYLE in decorators.js). The list led with
  // `port`, so the picker showed the wrong swatch as the shipped one and
  // "reset" moved the shape.
  "port.wpi": ["anchor", "port", "cableLanding", "lng"],
  "cable.landing": ["cableLanding", "port", "anchor", "connectivityLoss"],
  // A planned landing is a place that does not exist yet, so the hollow ring
  // belongs on it in a way it does not on the built one.
  "cable.planned": ["cableLanding", "hiddenRing", "port", "anchor"],
  // ---- air ----
  // Every airframe silhouette the dict draws, for the token that means "military,
  // role unknown" -- an operator who knows their theatre may well want the
  // unidentified ones drawn as whatever that theatre mostly flies.
  "aircraft.military": [
    "planeMilitary", "planeFighter", "planeBomber", "planeAwacs",
    "planeRecon", "planePatrol", "planeTanker", "planeTransport", "planeDrone",
    "planeTrainer", "helicopter",
  ],
  "aircraft.helicopter": ["helicopter", "planeOther", "planeMilitary", "planeTransport"],
  "aircraft.commercial": ["planeCommercial", "planeTransport", "planeOther", "planeTanker"],
  "aircraft.other": ["planeOther", "planeCommercial", "planeTrainer", "planeDrone", "helicopter"],
  // One list per tier, each led by the runway layout that tier ships with.
  // They used to share a single "airfield.civil" list, which meant picking a
  // shape for one tier picked it for all three -- so the only thing the control
  // could do was erase the size-and-shape gradient it was offering to tune.
  "airfield.large": ["airfieldLarge", "airfield", "airfieldSmall", "airfieldMilitary", "airBase", "planeCommercial"],
  "airfield.medium": ["airfield", "airfieldLarge", "airfieldSmall", "airfieldMilitary", "airBase", "planeCommercial"],
  "airfield.small": ["airfieldSmall", "airfield", "airfieldLarge", "airfieldMilitary", "airBase", "planeOther"],
  "airfield.military": [
    "airfieldMilitary", "airBase", "airfield", "airfieldLarge", "airfieldSmall",
    "planeMilitary", "radarBase",
  ],
  "czib.active": ["airspaceRestricted", "alertRing", "jammingSignal", "hiddenRing", "connectivityLoss"],
  // A withdrawn bulletin is a document that has been rescinded, so the two ways
  // of saying "this is no longer in force" -- the hollow ring and the record
  // mark -- are the alternatives worth having.
  "czib.withdrawn": ["airspaceRestricted", "hiddenRing", "recordMark", "alertRing"],
  // ---- infrastructure ----
  // The plant glyphs are interchangeable across the industrial tokens: which of
  // them reads as "heavy industry" at 14px is a matter of taste, and the kind is
  // named in the popup and carried by the colour either way.
  "infra.refinery": ["refinery", "powerPlant", "fab", "pipeline", "lng"],
  "infra.lng_terminal": ["lng", "refinery", "port", "pipeline", "anchor"],
  "infra.port": ["port", "anchor", "cableLanding", "lng"],
  "infra.desalination": ["desalination", "raindrop", "powerPlant", "dam", "fab"],
  "infra.nuclear": ["nuclear", "powerPlant", "refinery", "fab"],
  "infra.fab": ["fab", "powerPlant", "refinery", "nuclear"],
  "infra.pipeline": ["pipeline", "refinery", "lng", "powerPlant"],
  "osm.power": ["powerPlant", "nuclear", "refinery", "fab", "dam"],
  // Had exactly one entry, so the picker was suppressed entirely (see
  // GlyphPicker, which needs two shapes before it draws anything) -- a pin type
  // with a shape control that never appeared.
  "osm.border": ["borderCrossing", "railway", "recordMark", "alertRing"],
  // The four railway node kinds ship on one shape -- they are one family, and
  // four near-identical station glyphs would be a distinction nobody could read
  // at 12px. They get four *lists* anyway, because sharing one meant an
  // operator who wanted yards told apart from halts had no way to say so.
  //
  // Their alternatives are the settlement glyphs, sized the way the nodes
  // themselves are: a station is a place people arrive at, a halt is a smaller
  // one, and drawing them as a town and a hamlet is an honest reading of that.
  "osm.railway_station": ["railway", "borderCrossing", "city", "cityLarge", "logisticsBase"],
  "osm.railway_halt": ["railway", "borderCrossing", "cityTown", "cityMedium"],
  "osm.railway_yard": ["railway", "logisticsBase", "borderCrossing", "cityMedium"],
  "osm.railway_border": ["railway", "borderCrossing", "cityTown", "recordMark"],
  "railway.line": ["railway", "borderCrossing", "pipeline"],
  // Task 27: the OSM overlay's three line tokens -- same "colour-only token,
  // picker still offered" treatment as railway.line just above.
  "railway.electrified": ["railway", "borderCrossing", "pipeline"],
  "railway.nonElectrified": ["railway", "borderCrossing", "pipeline"],
  "railway.narrowGauge": ["railway", "borderCrossing", "pipeline"],
  // Task 27: a genuine marker (a live train position), so it gets the same
  // settlement-glyph alternatives the station points above do rather than
  // the line family's shapes.
  "railway.live": ["railway", "borderCrossing", "cityTown", "cityMedium"],
  // Same "colour-only token, picker still offered" treatment as railway.line
  // just above -- neither corridors nor the density wash draws a marker, but
  // the legend swatch next to their checkbox can still be any shape from the
  // same schematic-route/maritime family.
  "lanes.route": ["shippingLane", "pipeline", "railway"],
  "lanes.density": ["laneDensity", "ship", "tanker", "wave"],
  "dam.barrier": ["dam", "powerPlant", "raindrop", "desalination"],
  "deflock.camera": ["alprCamera", "radarBase", "jammingSignal", "hiddenRing"],
  "osm.military_airfield": [
    "airfieldMilitary", "airBase", "airfieldLarge", "airfield", "armyBase",
    "radarBase", "planeMilitary",
  ],
  // Every base type the dict draws, which is the point of this row: OSM says
  // "landuse=military" and nothing more, so what kind of installation it is, is
  // exactly the judgement an operator is entitled to make on their own map.
  "osm.military_area": [
    "armyBase", "jointBase", "missileBase", "radarBase", "logisticsBase",
    "airBase", "navalBase", "airfieldMilitary",
  ],
  // ---- space, news, diplomacy, places ----
  "satellite.stations": ["satellite", "satelliteMilitary", "globe", "launchPad"],
  "satellite.military": ["satelliteMilitary", "satellite", "radarBase", "globe"],
  // Task 24: the seven client-propagated groups all ship with the plain
  // `satellite` glyph (see SAT_ELEMENT_LAYERS in map/decorators.js) and offer
  // the same picker list as satellite.stations -- nothing about which group a
  // pin belongs to is a shape distinction, so there is no reason for one
  // group's picker to differ from another's.
  "satellite.navigation": ["satellite", "satelliteMilitary", "globe", "launchPad"],
  "satellite.weather": ["satellite", "satelliteMilitary", "globe", "launchPad"],
  "satellite.imaging": ["satellite", "satelliteMilitary", "globe", "launchPad"],
  "satellite.science": ["satellite", "satelliteMilitary", "globe", "launchPad"],
  "satellite.geo": ["satellite", "satelliteMilitary", "globe", "launchPad"],
  "satellite.starlink": ["satellite", "satelliteMilitary", "globe", "launchPad"],
  "satellite.oneweb": ["satellite", "satelliteMilitary", "globe", "launchPad"],
  // An upcoming launch is a thing that has not happened; a flown one is a
  // record of one that has. The last entry on each says so.
  "launch.upcoming": ["launchPad", "missileBase", "satellite", "alertRing"],
  "launch.flown": ["launchPad", "missileBase", "satellite", "recordMark"],
  "news.pin": ["news", "recordMark", "podium", "globe", "alertRing"],
  "officials.cooperative": ["handshake", "treaty", "aidHand", "podium", "recordMark"],
  "officials.hostile": ["threatFist", "demandHand", "severedTies", "mobilize", "alertRing", "podium"],
  "officials.neutral": ["podium", "recordMark", "handshake", "treaty", "news"],
  // One list per band, each led by the shape that band ships with. Sharing one
  // list was what let a single choice collapse the whole graduated-symbol
  // scheme onto one glyph.
  "city.capital": ["capital", "city", "cityLarge", "cityMedium", "cityTown", "globe"],
  "city.mega": ["city", "cityLarge", "cityMedium", "cityTown", "capital"],
  "city.large": ["cityLarge", "city", "cityMedium", "cityTown", "capital"],
  "city.medium": ["cityMedium", "cityLarge", "cityTown", "city", "capital"],
  "city.town": ["cityTown", "cityMedium", "cityLarge", "city", "capital"],
});

/** The glyph a token ships with -- the first entry in its list, or null. */
export function shippedGlyph(token) {
  return GLYPH_CHOICES[token]?.[0] ?? null;
}
