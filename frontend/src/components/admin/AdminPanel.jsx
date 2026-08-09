// Admin Mode: everything that used to require editing source.
//
// One draggable panel, folded into the same accordion sections the control
// panel uses, and rendered *only* while Admin Mode is on -- which is the whole
// safety model. There is no editable control anywhere else in the app, so a
// reader who has not deliberately turned Admin Mode on cannot change an icon
// size or a record by any sequence of clicks.
//
// What each section owns:
//   Icons    the one global size multiplier, and the reset buttons
//   Layers   everything else about how a layer draws -- its size, its opacity,
//            its zoom gate, and the colour of every kind of pin in it. Grouped
//            by layer rather than split across two sections, because split is
//            how the same dial ended up offered twice (see LayerBlock)
//   Data     the records themselves (see DataEditor.jsx)
//   Display  panel opacity, accent, text size, motion, leader lines
//   Config   export / import / reset, and the panel layout
//
// Every change is live and saved as it is made -- there is no Apply button,
// because a settings panel with unsaved state is a settings panel that loses
// work when it is closed.

import { useRef, useState } from "react";
import { PALETTE_GROUPS, DEFAULT_COLORS, TOKEN_LAYER, tokenHasSize, tokenHasZoom, glyphChoicesFor } from "../../map/iconTheme";
import { shippedDrawZoom } from "../../map/scene";
import { SETTINGS_LAYERS, defaultSettings } from "../../settings/defaults";
import { borderStats } from "../../settings/borderOverrides";
import { useAccordion } from "../../hooks/useAccordion";
import { useDraggablePanel, clearAllPanelPositions } from "../../hooks/useDraggablePanel";
import { useIsMobileViewport } from "../../hooks/useIsMobileViewport";
import { PanelGroup } from "../controlPanel/Collapsible";
import { SliderField, ColorField, IconField, CheckField } from "./fields";
import DataEditor from "./DataEditor";

const DEFAULT_OPEN = { "adm-icons": true };
const STORAGE_KEY = "osint-admin-accordion";
const DEFAULTS = defaultSettings();

export default function AdminPanel({ settings, actions, recordsFor, sync, staleBorders, onClose }) {
  const { isOpen, setOpen } = useAccordion(DEFAULT_OPEN, STORAGE_KEY);
  // Resizable, and off on mobile where the panel is a full-width overlay whose
  // width the viewport already decides. A pin row here is a colour well, a
  // name, a size slider and three selects on one line: on a narrow panel the
  // name is the only part that can give, and it runs out.
  const isMobile = useIsMobileViewport();
  const { panelRef, style, handleProps, resizeProps } = useDraggablePanel("adminPanel", {
    enabled: !isMobile,
    resizable: true,
  });

  return (
    <aside id="adminPanel" ref={panelRef} style={style}>
      <div {...handleProps} className={`admin-header ${handleProps.className || ""}`}>
        <span className="admin-badge">ADMIN</span>
        <span className="admin-title">Configuration</span>
        <SyncBadge sync={sync} />
        <button type="button" className="admin-close" onClick={onClose} aria-label="Leave Admin Mode">
          &times;
        </button>
      </div>

      <div className="admin-body">
        <PanelGroup id="adm-icons" title="Global icon size" open={isOpen("adm-icons")} onToggle={setOpen}>
          <SliderField
            label="Icon size"
            value={settings.icons.scale}
            defaultValue={1}
            min={0.4}
            max={3}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={actions.setIconScale}
          />
          <div className="admin-note">
            Scales every marker, and the spacing the declutter pass reserves for it, so pins stay
            separated at any size. Everything narrower than this &mdash; a layer’s own size, its
            opacity, its zoom gate, and the colour of each kind of pin in it &mdash; lives under
            <b> Layers</b> below, beside the layer it belongs to.
          </div>
          <div className="admin-row">
            <button type="button" onClick={actions.resetColors}>Reset all colours</button>
            <button type="button" onClick={actions.resetSizes}>Reset all sizes</button>
            <button type="button" onClick={actions.resetZooms}>Reset all zooms</button>
          </div>
        </PanelGroup>

        <PanelGroup id="adm-stack" title="Layer order" open={isOpen("adm-stack")} onToggle={setOpen}>
          <StackSection settings={settings} actions={actions} />
        </PanelGroup>

        <PanelGroup id="adm-layers" title="Layers" open={isOpen("adm-layers")} onToggle={setOpen}>
          <SavedLayerStates wishes={settings.layerWish} onClear={actions.clearLayerWishes} />
          <div className="admin-note">
            One layer per row, expanded to show everything that layer has: how big it is drawn, how
            solid, the zoom it starts drawing at, and the colour of every kind of pin in it.
            <b> Any zoom</b> means no gate &mdash; where seven of these ship, because a navy hull, an
            aircraft squawking an emergency or a rescinded airspace warning is worth seeing from the
            world board.
          </div>
          {SETTINGS_LAYERS.map((layer) => (
            <LayerBlock
              key={layer.key}
              layer={layer}
              settings={settings}
              actions={actions}
              open={isOpen(`adm-layer-${layer.key}`)}
              onToggle={setOpen}
            />
          ))}
          <SharedColours settings={settings} actions={actions} />
        </PanelGroup>

        <PanelGroup id="adm-zones" title="City zones" open={isOpen("adm-zones")} onToggle={setOpen}>
          <div className="admin-note">
            A city is one coordinate, and almost every conflict report filed in a city is filed
            against the city rather than against a street &mdash; so they land on one point and read
            as one incident repeated. Grouping them by the city they are about, rather than by how
            close their pins happened to fall, turns that pile into one pin that says how many. Every
            report keeps its own coordinate and its own record; <b>Separate these pins</b> inside a
            grouped pin takes it apart again.
          </div>
          <CheckField
            label="Group conflict reports by city"
            note="Reports outside every city zone are never grouped — there is no place to group them on."
            checked={settings.cityZones.group}
            onChange={(value) => actions.setCityZones({ group: value })}
          />
          <CheckField
            label="Draw the zone rings"
            note="Only where the Cities layer is already drawing, which is what the ring explains."
            checked={settings.cityZones.show}
            onChange={(value) => actions.setCityZones({ show: value })}
          />
          <SliderField
            label="Zone size"
            value={settings.cityZones.radiusScale}
            defaultValue={1}
            min={0.25}
            max={4}
            step={0.25}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(value) => actions.setCityZones({ radiusScale: value })}
          />
          <div className="admin-note">
            Shipped radii are 25 / 15 / 8 / 5 km by population band, scaled by the above. They are a
            nominal urban footprint, not a boundary and not surveyed &mdash; widening them groups
            more, and eventually groups two towns that are genuinely two places.
          </div>
        </PanelGroup>

        <PanelGroup id="adm-data" title="OSINT data" open={isOpen("adm-data")} onToggle={setOpen}>
          <DataEditor recordsFor={recordsFor} settings={settings} actions={actions} />
          <button type="button" className="admin-wide-btn" onClick={actions.clearDataEdits}>
            Discard every data edit
          </button>
        </PanelGroup>

        <PanelGroup id="adm-borders" title="Country borders" open={isOpen("adm-borders")} onToggle={setOpen}>
          <BorderSection settings={settings} actions={actions} staleKeys={staleBorders} />
        </PanelGroup>

        <PanelGroup id="adm-ui" title="Interface" open={isOpen("adm-ui")} onToggle={setOpen}>
          <SliderField
            label="Text size"
            value={settings.ui.textScale}
            defaultValue={1}
            min={0.75}
            max={1.6}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(value) => actions.setUi({ textScale: value })}
          />
          <SliderField
            label="Panel opacity"
            value={settings.ui.panelOpacity}
            defaultValue={DEFAULTS.ui.panelOpacity}
            min={0.35}
            max={1}
            step={0.02}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(value) => actions.setUi({ panelOpacity: value })}
          />
          <ColorField
            label="Accent colour"
            value={settings.ui.accent || "#6fe3ff"}
            defaultValue="#6fe3ff"
            onChange={(value) => actions.setUi({ accent: value })}
          />
          {settings.ui.accent && (
            <button type="button" className="admin-wide-btn" onClick={() => actions.setUi({ accent: null })}>
              Use the theme's own accent
            </button>
          )}
          <CheckField
            label="Leader lines"
            note="The thin line from a nudged pin back to its true position."
            checked={settings.ui.showLeaderLines}
            onChange={(value) => actions.setUi({ showLeaderLines: value })}
          />
          <CheckField
            label="Reduce motion"
            note="Stops the pulsing flares, pings and live dots."
            checked={settings.ui.reduceMotion}
            onChange={(value) => actions.setUi({ reduceMotion: value })}
          />
          <CheckField
            label="Map cursor"
            note="Draws the map's own pointer. Off gives you the system cursor back."
            checked={settings.ui.cursorEnabled}
            onChange={(value) => actions.setUi({ cursorEnabled: value })}
          />
          {/* Only shown when there is a cursor to configure -- three controls
              that do nothing are worse than three controls that are absent. */}
          {settings.ui.cursorEnabled && (
            <>
              <label className="admin-select-row">
                <span>Cursor style</span>
                <select
                  value={settings.ui.cursorStyle}
                  onChange={(event) => actions.setUi({ cursorStyle: event.target.value })}
                >
                  <option value="reticle">Reticle</option>
                  <option value="dot">Dot and ring</option>
                  <option value="halo">Halo on the system cursor</option>
                </select>
              </label>
              <SliderField
                label="Cursor size"
                value={settings.ui.cursorScale}
                defaultValue={1}
                min={0.5}
                max={2.5}
                step={0.05}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(value) => actions.setUi({ cursorScale: value })}
              />
              <ColorField
                label="Cursor colour"
                value={settings.ui.cursorColor || settings.ui.accent || "#6fe3ff"}
                defaultValue="#6fe3ff"
                onChange={(value) => actions.setUi({ cursorColor: value })}
              />
              {settings.ui.cursorColor && (
                <button
                  type="button"
                  className="admin-wide-btn"
                  onClick={() => actions.setUi({ cursorColor: null })}
                >
                  Follow the accent colour
                </button>
              )}
            </>
          )}
        </PanelGroup>

        <PanelGroup id="adm-config" title="Configuration file" open={isOpen("adm-config")} onToggle={setOpen}>
          <ConfigSection actions={actions} sync={sync} />
        </PanelGroup>
      </div>

      {/* Last child so it paints over the body's scrollbar rather than under
          it, and absent entirely on mobile (see useDraggablePanel). */}
      {resizeProps && <div {...resizeProps} aria-hidden="true" />}
    </aside>
  );
}

// Every key that can appear in the stack, in the words the rest of the panel
// uses. `vehicles` and `cables` are the two that stand for more than themselves
// (see STACK_ALIAS in map/iconTheme.js), and both say so.
const STACK_LABEL = {
  ...Object.fromEntries(SETTINGS_LAYERS.map((l) => [l.key, l.label])),
  vehicles: "Ships & aircraft (one canvas)",
  cables: "Submarine cables & landings",
  outagePoints: "Internet disruption (IODA)",
  firms: "Fires / thermal anomalies (FIRMS)",
  jamming: "GPS/radio jamming (GPSJam)",
};

/**
 * The stack, as two ordered lists.
 *
 * Arrows rather than drag-and-drop. A drag needs pointer capture, an autoscroll
 * and a drop indicator to be usable at all, and this list lives inside a panel
 * that is itself draggable by its header -- two nested drag gestures is a bug
 * report waiting to be filed. Two buttons per row are unambiguous, work from the
 * keyboard, and are one click each for the only move anyone makes.
 */
function StackSection({ settings, actions }) {
  const floor = settings.ui.stackFadeFloor;
  return (
    <>
      <div className="admin-note">
        What draws over what, top of the list first. Position also sets how much a layer is faded:
        the top of a group is drawn at full strength and the bottom at the depth below, so pushing
        reference material down makes it recede behind the layers it is context for. That fade is a
        multiplier on each layer&apos;s own opacity, not a replacement for it.
      </div>
      <SliderField
        label="Depth fade"
        value={floor}
        defaultValue={DEFAULTS.ui.stackFadeFloor}
        min={0.1}
        max={1}
        step={0.05}
        format={(v) => (v >= 1 ? "off" : `${Math.round(v * 100)}% at the bottom`)}
        onChange={(value) => actions.setUi({ stackFadeFloor: value })}
      />

      <StackList
        group="pins"
        title="Pins"
        order={settings.layerStack.pins}
        floor={floor}
        onMove={actions.moveLayerInStack}
      />
      <StackList
        group="washes"
        title="Washes"
        order={settings.layerStack.washes}
        floor={1}
        onMove={actions.moveLayerInStack}
      />
      <div className="admin-note">
        Two lists because the map draws in two ways, and they do not interleave. Every pin is an
        element in one Leaflet pane; the washes are canvases in the pane below it, so a wash is
        always beneath every pin however either list is ordered. Country shapes and the district
        choropleth are not here at all &mdash; they are the substrate the rest is drawn on.
      </div>
      <button type="button" className="admin-wide-btn" onClick={actions.resetLayerStack}>
        Back to the shipped order
      </button>
    </>
  );
}

function StackList({ group, title, order, floor, onMove }) {
  return (
    <>
      <div className="admin-subhead">{title}</div>
      {order.map((key, index) => (
        <div className="admin-stack-row" key={key}>
          <span className="admin-stack-rank">{index + 1}</span>
          <span className="admin-stack-name">{STACK_LABEL[key] || key}</span>
          <span className="admin-stack-fade">
            {order.length < 2
              ? "100%"
              : `${Math.round((1 - (1 - floor) * (index / (order.length - 1))) * 100)}%`}
          </span>
          <button
            type="button"
            disabled={index === 0}
            onClick={() => onMove(group, key, -1)}
            aria-label={`Move ${STACK_LABEL[key] || key} up`}
            title="Draw this over the layer above it"
          >
            ↑
          </button>
          <button
            type="button"
            disabled={index === order.length - 1}
            onClick={() => onMove(group, key, 1)}
            aria-label={`Move ${STACK_LABEL[key] || key} down`}
            title="Draw this under the layer below it"
          >
            ↓
          </button>
        </div>
      ))}
    </>
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

// Which pin types belong to each layer, built once from the palette.
//
// Two tokens name a colour that is only ever drawn as part of another layer, so
// they are adopted by it rather than left to the shared group at the bottom: a
// corroborated conflict pin is a conflict pin recoloured, and a cable route is
// the line its landing points sit on. Everything else with no layer of its own
// is genuinely shared -- the OFAC ring is drawn on hulls *and* airframes, and
// the choropleth paints whole countries.
const ADOPTED_BY = { "event.corroborated": "events", "cable.route": "cables" };

const TOKENS_BY_LAYER = (() => {
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

// Cable landings have no row of their own in SETTINGS_LAYERS -- one checkbox
// covers the routes and the places they come ashore, because a cable and its
// landing are one fact -- so its pin types are shown under Submarine cables.
const EXTRA_TOKENS_UNDER = { cables: "cableLandings" };

const SHARED_TOKENS = PALETTE_GROUPS.flatMap((group) =>
  group.tokens.filter((token) => !TOKEN_LAYER[token.id] && !ADOPTED_BY[token.id])
);

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
  // The test that removes the duplication. `sizable` rather than `tokens`,
  // because a layer whose only extra token is a colour-only one (events, with
  // its four severity bands plus the corroborated recolour) still counts by its
  // real pin types.
  const sizable = tokens.filter((t) => tokenHasSize(t.id));
  const perPinDials = sizable.length > 1;
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

        {tokens.length > 0 && (
          <>
            <div className="admin-subhead">
              {tokens.length === 1 ? "Pin colour" : `Pin types (${tokens.length})`}
            </div>
            {perPinDials && (
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
                size={perPinDials && tokenHasSize(token.id) ? settings.icons.sizes[token.id] ?? 1 : null}
                onSizeChange={(value) => actions.setTokenSize(token.id, value)}
                zoom={perPinDials && tokenHasZoom(token.id) ? settings.icons.zooms[token.id] ?? null : undefined}
                layerZoom={gateOf(token.id)}
                zoomMax={perPinDials && tokenHasZoom(token.id) ? settings.icons.zoomMaxes[token.id] ?? null : undefined}
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

/**
 * The colours that are not one layer's to own.
 *
 * The OFAC ring is drawn on a hull and on an airframe, and the choropleth ramp
 * paints whole countries rather than pins -- so filing either under a single
 * layer would put the control somewhere it is only half true.
 */
function SharedColours({ settings, actions }) {
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

const TOKEN_LABEL = Object.fromEntries(
  PALETTE_GROUPS.flatMap((group) => group.tokens.map((token) => [token.id, token.label]))
);

/**
 * Which pin types in this layer are not following its gate.
 *
 * Without it the layer slider looks broken from here: it is moved, the map does
 * not change, and the reason is a number set two sections up on one kind of pin
 * inside it. Silent while nothing in the layer has been given its own zoom,
 * which is every layer until someone sets one.
 */
function PinTypesNote({ layerKey, zooms }) {
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

// The ledger for redrawn boundaries. Editing itself happens on the map (select
// a country, "Edit border" on its card); this is where you see what has been
// changed and take it back, which is the half a direct-manipulation gesture
// cannot show you.
function BorderSection({ settings, actions, staleKeys }) {
  const borders = settings.borders || {};
  const keys = Object.keys(borders).sort();
  const stats = borderStats(borders);
  const stale = new Set(staleKeys || []);

  return (
    <>
      <div className="admin-note">
        Boundaries come from Natural Earth at 1:50m, where the median country is drawn with about
        a hundred and eighty points &mdash; a generalisation for looking at the world, not a survey.
        It follows a coastline closely enough to zoom into; it is still not a cadastral line. An edit here
        redraws that line; it does not correct it. Every country whose border has been redrawn says so
        on its own card.
      </div>

      {keys.length === 0 ? (
        <div className="admin-note">
          Nothing redrawn. Click a country, then <b>Edit border</b> on its card.
        </div>
      ) : (
        <>
          {keys.map((key) => {
            const entry = borders[key];
            const rings = Object.keys(entry.rings || {}).length;
            const points = Object.values(entry.rings || {}).reduce((sum, r) => sum + r.length, 0);
            return (
              <div className={`admin-border-row${stale.has(key) ? " stale" : ""}`} key={key}>
                <span className="admin-border-name">{key}</span>
                <span className="admin-border-meta">
                  {stale.has(key)
                    ? "source geometry changed — not applied"
                    : `${rings} ${rings === 1 ? "ring" : "rings"}, ${points.toLocaleString()} points`}
                </span>
                <button type="button" onClick={() => actions.revertBorderCountry(key)}>
                  {stale.has(key) ? "Discard" : "Revert"}
                </button>
              </div>
            );
          })}
          {stale.size > 0 && (
            <div className="admin-note">
              A stale edit is one made against a different version of the source geometry &mdash; the
              points it names are no longer in the same places, so it is held rather than applied. It
              is kept in case the source comes back; discarding is the only thing that removes it.
            </div>
          )}
          <div className="admin-note">
            {stats.points.toLocaleString()} of {stats.limit.toLocaleString()} points used. The whole
            configuration is saved as one file, so this ceiling is what stops boundary geometry from
            crowding out every other setting in it.
          </div>
          <button type="button" className="admin-wide-btn" onClick={actions.clearBorderEdits}>
            Discard every border edit
          </button>
        </>
      )}
    </>
  );
}

// Where the configuration currently stands, in the header so it is visible from
// every section rather than only from the one that talks about files.
function SyncBadge({ sync }) {
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

// Export/import, for moving a configuration between deployments. Everyday
// saving is automatic and goes to data/admin_config.json (see
// hooks/useAppSettings.js) -- these two buttons are the manual copy, not the
// primary path.
function ConfigSection({ actions, sync }) {
  const fileRef = useRef(null);
  const [message, setMessage] = useState(null);

  function download() {
    const blob = new Blob([actions.exportSettings()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `osint-config-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setMessage("Saved to your downloads.");
  }

  async function onFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const error = actions.importSettings(await file.text());
    setMessage(error || `Loaded ${file.name}.`);
    // Clearing the input is what lets the same file be re-imported after an
    // edit -- an unchanged value fires no change event.
    event.target.value = "";
  }

  return (
    <>
      <div className="admin-note">
        {sync?.state === "local-only" ? (
          <>
            The backend is not answering, so changes are being kept in this browser only. They will be
            written to <code>data/admin_config.json</code> as soon as it is back and something changes.
          </>
        ) : (
          <>
            Changes save themselves to <code>data/admin_config.json</code> in the project folder, and
            every client reads that file at startup &mdash; so what you set here is what the map shows
            from now on, in every browser this backend serves.
            {sync?.savedAt && ` Last written ${new Date(sync.savedAt * 1000).toLocaleString()}.`}
          </>
        )}
      </div>
      <div className="admin-row">
        <button type="button" onClick={download}>Export a copy</button>
        <button type="button" onClick={() => fileRef.current?.click()}>Import a file</button>
        <input type="file" accept="application/json,.json" ref={fileRef} onChange={onFile} hidden />
      </div>
      <button
        type="button"
        className="admin-wide-btn"
        onClick={() => {
          clearAllPanelPositions();
          setMessage("Panels moved back to their default corners.");
        }}
      >
        Reset panel layout
      </button>
      <button
        type="button"
        className="admin-wide-btn danger"
        onClick={() => {
          actions.resetAll();
          setMessage("Everything is back to the shipped defaults.");
        }}
      >
        Reset all settings
      </button>
      {message && <div className="admin-note">{message}</div>}
      <div className="admin-note">
        A configuration holds icon colours and sizes, layer appearance, interface settings, every data
        edit and every redrawn boundary. It does not hold whether Admin Mode is on, so loading someone
        else's cannot put a reader into an editing mode.
      </div>
    </>
  );
}
