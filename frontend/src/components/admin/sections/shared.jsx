// What more than one admin section needs, or will as this panel grows.
//
// Split out of AdminPanel.jsx alongside the section files themselves: a later
// task in this plan adds five more sections (Water, Filters, Inference, Cards,
// Performance) and a dozen new layer rows, and most of that growth touches
// these exact tables -- a new layer gets an entry in STACK_LABEL if its stack
// key differs from its settings key, and possibly in ADOPTED_BY or
// EXTRA_TOKENS_UNDER if it recolours or rides another layer's pin types.
// Keeping them here, rather than inline in whichever section happens to read
// them first, is what lets that task extend a table instead of hunting for it.
import { PALETTE_GROUPS, DEFAULT_COLORS, TOKEN_LAYER, tokenHasSize } from "../../../map/iconTheme";
import { SETTINGS_LAYERS } from "../../../settings/defaults";
import { IconField } from "../fields";

// Every key that can appear in the stack, in the words the rest of the panel
// uses. `vehicles` and `cables` are the two that stand for more than themselves
// (see STACK_ALIAS in map/iconTheme.js), and both say so.
export const STACK_LABEL = {
  ...Object.fromEntries(SETTINGS_LAYERS.map((l) => [l.key, l.label])),
  // Task 24 added satImaging/satGeo/satStarlink/satOneweb to this same shared
  // WebGL canvas (see STACK_ALIAS in map/iconTheme.js) -- ships, aircraft and
  // now four of the seven client-propagated satellite layers all draw on it,
  // so they share this one row in the stack order rather than getting four
  // more.
  vehicles: "Ships, aircraft & bulk satellites (one canvas)",
  cables: "Submarine cables & landings",
  outagePoints: "Internet disruption (IODA)",
  outageRegionPoints: "Internet disruption, sub-national (IODA)",
  firms: "Fires / thermal anomalies (FIRMS)",
  jamming: "GPS/radio jamming (GPSJam)",
};

// Two tokens name a colour that is only ever drawn as part of another layer, so
// they are adopted by it rather than left to the shared group at the bottom: a
// corroborated conflict pin is a conflict pin recoloured, and a cable route is
// the line its landing points sit on. Everything else with no layer of its own
// is genuinely shared -- the OFAC ring is drawn on hulls *and* airframes, and
// the choropleth paints whole countries.
export const ADOPTED_BY = { "event.corroborated": "events", "cable.route": "cables" };

// Cable landings have no row of their own in SETTINGS_LAYERS -- one checkbox
// covers the routes and the places they come ashore, because a cable and its
// landing are one fact -- so its pin types are shown under Submarine cables.
// railwayPoints (Task 27) rides the same arrangement: the station/halt/yard/
// border points have no checkbox of their own either, mirroring "railways"'
// visibility exactly (see setLayerVisible in createMapController.js), so
// their tokens surface under the Railways admin block rather than a
// railwayPoints section nobody would ever see.
export const EXTRA_TOKENS_UNDER = { cables: "cableLandings", railways: "railwayPoints" };

export const TOKENS_BY_LAYER = (() => {
  const byLayer = {};
  for (const group of PALETTE_GROUPS) {
    for (const token of group.tokens) {
      const layerKey = TOKEN_LAYER[token.id] || ADOPTED_BY[token.id];
      if (!layerKey) continue;
      (byLayer[layerKey] ||= []).push(token);
    }
  }
  return byLayer;
})();

export const SHARED_TOKENS = PALETTE_GROUPS.flatMap((group) =>
  group.tokens.filter((token) => !TOKEN_LAYER[token.id] && !ADOPTED_BY[token.id])
);

export const TOKEN_LABEL = Object.fromEntries(
  PALETTE_GROUPS.flatMap((group) => group.tokens.map((token) => [token.id, token.label]))
);

/**
 * Whether a layer's pin types earn their own size/zoom dials, on top of the
 * layer-wide ones.
 *
 * The test that removes a duplication the panel used to have: a layer's Size
 * sat in one section and its pin types' sizes in another, and for a layer that
 * draws exactly one kind of pin those were the same dial asked for twice. So the
 * narrow, per-pin dial is offered only where it can say something the layer-wide
 * one cannot -- when a layer holds more than one *sizable* kind of pin.
 * `sizable` rather than `tokens.length`, because a layer whose only extra token
 * is a colour-only one (events, with its corroborated recolour) still counts by
 * its real pin types.
 */
export function perPinDials(tokens) {
  return tokens.filter((t) => tokenHasSize(t.id)).length > 1;
}

/**
 * The colours that are not one layer's to own.
 *
 * The OFAC ring is drawn on a hull and on an airframe, and the choropleth ramp
 * paints whole countries rather than pins -- so filing either under a single
 * layer would put the control somewhere it is only half true.
 */
export function SharedColours({ settings, actions }) {
  if (!SHARED_TOKENS.length) return null;
  return (
    <div className="admin-layer-block admin-shared-colours">
      <div className="admin-subhead">Shared colours</div>
      <div className="admin-note">
        Not tied to one layer: the designation ring is drawn on ships and aircraft alike, and the
        country fill covers whole countries rather than pins.
      </div>
      {SHARED_TOKENS.map((token) => (
        <IconField
          key={token.id}
          label={token.label}
          color={settings.icons.colors[token.id] || DEFAULT_COLORS[token.id]}
          defaultColor={DEFAULT_COLORS[token.id]}
          onColorChange={(value) => actions.setColor(token.id, value)}
          size={null}
          onSizeChange={() => {}}
          onZoomChange={() => {}}
          onZoomMaxChange={() => {}}
          onGlyphChange={() => {}}
        />
      ))}
    </div>
  );
}

/**
 * Which pin types in this layer are not following its gate.
 *
 * Without it the layer slider looks broken from here: it is moved, the map does
 * not change, and the reason is a number set two sections up on one kind of pin
 * inside it. Silent while nothing in the layer has been given its own zoom,
 * which is every layer until someone sets one.
 */
export function PinTypesNote({ layerKey, zooms }) {
  const held = Object.entries(zooms || {})
    .filter(([token, zoom]) => Number.isFinite(zoom) && TOKEN_LAYER[token] === layerKey)
    .sort((a, b) => a[1] - b[1]);
  if (!held.length) return null;
  return (
    <div className="admin-note">
      Held back further by their own zoom, under <b>Map icons</b>:{" "}
      {held.map(([token, zoom]) => `${TOKEN_LABEL[token] || token} (z${zoom})`).join(", ")}.
    </div>
  );
}

// Where the configuration currently stands, in the header so it is visible from
// every section rather than only from the one that talks about files.
export function SyncBadge({ sync }) {
  if (!sync) return null;
  const label = {
    loading: "reading config…",
    saving: "saving…",
    saved: "saved",
    "local-only": "this browser only",
    error: "not saved",
  }[sync.state] || sync.state;
  const title = {
    "local-only": `The backend did not answer, so this configuration is stored in this browser only${
      sync.detail ? ` (${sync.detail})` : ""
    }.`,
    error: sync.detail || "The last save failed.",
    saved: sync.savedAt
      ? `data/admin_config.json, last written ${new Date(sync.savedAt * 1000).toLocaleString()}`
      : "Stored in data/admin_config.json",
  }[sync.state];
  return (
    <span className={`admin-sync admin-sync-${sync.state}`} title={title}>
      {label}
    </span>
  );
}
