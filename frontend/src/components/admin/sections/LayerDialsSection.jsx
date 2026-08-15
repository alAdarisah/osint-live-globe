// Everything else about how a layer draws -- its size, its opacity, its zoom
// gate, and the colour of every kind of pin in it. One row per layer, filed
// under the six subject headings the reader's own control drawer uses (see
// settings/layerGroups.js, which both lists read).
//
// The rows are grouped by layer rather than split across two sections,
// because split is how the same dial ended up offered twice (see LayerBlock
// below). The subject headings are the opposite problem, arriving later: the
// list was flat and in the order layers were added to the app, so ships from
// one AIS feed sat rows away from ships from another and an operator looking
// for "everything about ships" read all 46 rows.
//
// The headings are plain headers, not a third collapsible tier: this section
// already collapses, and so does every layer row inside it. A middle tier
// would put two clicks between an operator and any dial, on a screen whose
// whole purpose is reaching one.
//
// Named LayerDialsSection, not LayersSection, so it does not collide with the
// control-panel's own LayersSection (frontend/src/components/controlPanel/
// LayersSection.jsx) -- that one turns layers on and off; this one tunes how
// an already-visible layer looks.
import { PanelGroup } from "../../controlPanel/Collapsible";
import { SliderField, IconField, CheckField } from "../fields";
import { DEFAULT_COLORS, TOKEN_LAYER, tokenHasSize, tokenHasZoom, glyphChoicesFor } from "../../../map/iconTheme";
import { shippedDrawZoom } from "../../../map/scene";
import { SETTINGS_LAYERS, COUNTRY_ONLY_LAYERS } from "../../../settings/defaults";
import { LAYER_GROUPS } from "../../../settings/layerGroups";
import {
  EXTRA_TOKENS_UNDER, TOKENS_BY_LAYER, perPinDials,
  SharedColours, PinTypesNote,
} from "./shared";

// The terms live in a plain .js module so `node --test` can assert on them --
// this file is JSX and cannot be imported there. See layerSectionTerms.js.
export { SEARCH_TERMS } from "./layerSectionTerms";

// Keyed once at module scope rather than searched per row: the render walks
// LAYER_GROUPS now, which holds keys, while every row's label and defaults
// still come from SETTINGS_LAYERS.
const LAYER_BY_KEY = Object.fromEntries(SETTINGS_LAYERS.map((l) => [l.key, l]));

// `isOpen`/`onToggle` are the raw pair from AdminPanel's useAccordion, not a
// single boolean -- this section needs one open/closed state per layer
// (`adm-layer-<key>`, one per SETTINGS_LAYERS row) on top of its own
// (`adm-layers`), and a single boolean could only ever answer for one of them.
export default function LayerDialsSection({ settings, actions, isOpen, onToggle }) {
  return (
    <PanelGroup id="adm-layers" title="Layers" open={isOpen("adm-layers")} onToggle={onToggle}>
      <SavedLayerStates wishes={settings.layerWish} onClear={actions.clearLayerWishes} />
      <div className="admin-note">
        One layer per row, expanded to show everything that layer has: how big it is drawn, how
        solid, the zoom it starts drawing at, and the colour of every kind of pin in it.
        <b> Any zoom</b> means no gate &mdash; where seven of these ship, because a navy hull, an
        aircraft squawking an emergency or a rescinded airspace warning is worth seeing from the
        world board.
      </div>
      {LAYER_GROUPS.map((group) => (
        <div key={group.id} className="admin-layer-group">
          <h4 className="admin-group-heading" id={`grp-${group.id}`}>{group.title}</h4>
          {group.keys.map((key) => {
            const layer = LAYER_BY_KEY[key];
            // Filed in a group but with no SETTINGS_LAYERS row to render.
            // tests/layerGroups.test.js makes this impossible to ship, so this
            // is a guard against a half-applied hot reload rather than a state
            // the built app can reach.
            if (!layer) return null;
            return (
              <LayerBlock
                key={layer.key}
                layer={layer}
                settings={settings}
                actions={actions}
                open={isOpen(`adm-layer-${layer.key}`)}
                onToggle={onToggle}
              />
            );
          })}
        </div>
      ))}
      <SharedColours settings={settings} actions={actions} />
    </PanelGroup>
  );
}

/**
 * What the control drawer's checkboxes have been left set to, and the way back.
 *
 * Every checkbox in that drawer is now saved (see setLayerWish in
 * useAppSettings.js), which is what makes this necessary rather than tidy: a
 * checkbox is a boolean and the resolver's own answer is a third state, so once
 * a layer has been ticked or unticked there is no gesture in the drawer that
 * hands it back. This is that gesture. It is here rather than in the drawer
 * because it is a statement about the saved configuration, not about the map.
 */
function SavedLayerStates({ wishes, onClear }) {
  const entries = Object.entries(wishes || {});
  const on = entries.filter(([, visible]) => visible).length;
  const off = entries.length - on;
  return (
    <div className="admin-note">
      Ticking a layer in the control drawer saves it: what is on when you leave is what this
      deployment comes up with, in every browser this backend serves.{" "}
      {entries.length === 0 ? (
        <>Nothing is pinned &mdash; every layer is still chosen by zoom, by what the camera is over
        and by what you have clicked.</>
      ) : (
        <>
          {on} pinned on, {off} pinned off. Those layers no longer answer to the scene resolver.
          <button type="button" className="admin-wide-btn" onClick={onClear}>
            Hand every layer back to the resolver
          </button>
        </>
      )}
    </div>
  );
}

/**
 * One layer, with every dial that belongs to it.
 *
 * The panel used to ask for the same thing twice. A layer's Size sat in one
 * section and its pin types' sizes in another, and for the ten layers that draw
 * exactly one kind of pin those are the same dial: Cities' layer size and the
 * "City / capital" size multiplied to the same number, and nothing said which
 * one to reach for. Same for the zoom gate, in the same two places.
 *
 * So the narrow dial is offered only where it can say something the broad one
 * cannot -- when a layer holds more than one kind of pin. Infrastructure has
 * seven, and "nuclear sites bigger than refineries" is a real instruction that
 * the layer dial cannot express. Cities has one, and there the layer dial *is*
 * the pin dial, so the row carries a colour and nothing else.
 */
function LayerBlock({ layer, settings, actions, open, onToggle }) {
  const style = settings.layers[layer.key];
  const tokens = [
    ...(TOKENS_BY_LAYER[layer.key] || []),
    ...(TOKENS_BY_LAYER[EXTRA_TOKENS_UNDER[layer.key]] || []),
  ];
  // An ungated layer starts the slider at 0, which is the same thing: the map's
  // own minimum zoom is 2, so nothing on it can be below 0. That is what lets
  // one control cover both cases instead of the ungated layers having none.
  const shippedGate = layer.zoomGate ?? 0;
  const sizable = perPinDials(tokens);
  // Per token, not per block. A cable landing is shown under Submarine cables
  // but answers to its own gate (cableLandings draws from z5, cables is
  // ungated), so reading the block's number would tell it it inherits "any
  // zoom" when it does not.
  const gateOf = (tokenId) => {
    const key = TOKEN_LAYER[tokenId] || layer.key;
    const configured = settings.layers[key]?.minZoom;
    return Number.isFinite(configured) ? configured : shippedDrawZoom(key);
  };

  return (
    <details
      className="admin-layer-block"
      open={open}
      onToggle={(e) => onToggle(`adm-layer-${layer.key}`, e.currentTarget.open)}
    >
      <summary className="admin-layer-summary">
        <span className="admin-layer-name">{layer.label}</span>
        {/* The swatches are the whole point of a shut row: they say what this
            layer looks like on the map without opening anything. */}
        <span className="admin-layer-swatches">
          {tokens.slice(0, 6).map((token) => (
            <i
              key={token.id}
              className="admin-swatch"
              style={{ background: settings.icons.colors[token.id] || DEFAULT_COLORS[token.id] }}
            />
          ))}
        </span>
      </summary>

      <div className="admin-layer-body">
        <SliderField
          label="Size"
          value={style.scale}
          defaultValue={1}
          min={0.3}
          max={3}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(value) => actions.setLayerStyle(layer.key, { scale: value })}
        />
        <SliderField
          label="Opacity"
          value={style.opacity}
          defaultValue={1}
          min={0.1}
          max={1}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(value) => actions.setLayerStyle(layer.key, { opacity: value })}
        />
        <SliderField
          label="Shows from zoom"
          value={style.minZoom ?? shippedGate}
          defaultValue={shippedGate}
          min={0}
          max={12}
          step={1}
          format={(v) => (v === 0 ? "any zoom" : `z${v}`)}
          onChange={(value) =>
            actions.setLayerStyle(layer.key, { minZoom: value === shippedGate ? null : value })
          }
        />
        {/* 19 is one past the map's deepest zoom, so the far right of the track
            is "no ceiling" rather than a limit nobody could reach. Storing null
            there is what makes dragging it back the reset, the same way the
            floor above resets by returning to its shipped number. */}
        <SliderField
          label="Hides past zoom"
          value={style.maxZoom ?? 19}
          defaultValue={19}
          min={1}
          max={19}
          step={1}
          format={(v) => (v >= 19 ? "no limit" : `z${v}`)}
          onChange={(value) =>
            actions.setLayerStyle(layer.key, { maxZoom: value >= 19 ? null : value })
          }
        />
        {/* Offered only on the layers that draw individual pins -- see
            COUNTRY_ONLY_LAYERS for the kinds of layer left out and why there is
            nothing here for them to clip. */}
        {COUNTRY_ONLY_LAYERS.has(layer.key) && (
          <CheckField
            label="Only with a country selected"
            note="Hidden until a country is clicked, then clipped to that country's borders. Its own zoom gate still applies — a selection makes the layer eligible, it does not bring it below the zoom above."
            checked={style.countryOnly === true}
            onChange={(value) => actions.setLayerStyle(layer.key, { countryOnly: value })}
          />
        )}

        {tokens.length > 0 && (
          <>
            <div className="admin-subhead">
              {tokens.length === 1 ? "Pin colour" : `Pin types (${tokens.length})`}
            </div>
            {sizable && (
              <div className="admin-note">
                Each kind of pin can also be sized and held back on its own, on top of the layer
                dials above &mdash; which is how one layer keeps its nuclear sites on the world board
                and its refineries for a closer look. A pin type can only be held back past its
                layer&apos;s gate, never brought forward through it: below that gate the layer is
                often not fetched at all.
              </div>
            )}
            {tokens.map((token) => (
              <IconField
                key={token.id}
                label={token.label}
                color={settings.icons.colors[token.id] || DEFAULT_COLORS[token.id]}
                defaultColor={DEFAULT_COLORS[token.id]}
                onColorChange={(value) => actions.setColor(token.id, value)}
                size={sizable && tokenHasSize(token.id) ? settings.icons.sizes[token.id] ?? 1 : null}
                onSizeChange={(value) => actions.setTokenSize(token.id, value)}
                zoom={sizable && tokenHasZoom(token.id) ? settings.icons.zooms[token.id] ?? null : undefined}
                layerZoom={gateOf(token.id)}
                zoomMax={sizable && tokenHasZoom(token.id) ? settings.icons.zoomMaxes[token.id] ?? null : undefined}
                onZoomChange={(value) => actions.setTokenZoom(token.id, value)}
                onZoomMaxChange={(value) => actions.setTokenZoomMax(token.id, value)}
                glyph={settings.icons.glyphs[token.id] ?? null}
                glyphChoices={glyphChoicesFor(token.id)}
                onGlyphChange={(name) => actions.setTokenGlyph(token.id, name)}
              />
            ))}
          </>
        )}
        <PinTypesNote layerKey={layer.key} zooms={settings.icons.zooms} />
      </div>
    </details>
  );
}
