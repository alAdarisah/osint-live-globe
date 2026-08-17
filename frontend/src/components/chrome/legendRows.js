// What the glyphs on the map mean.
//
// Read from the same tables the markers themselves are built from -- the
// per-layer presentation table, the severity bands, and map/decorators.js's
// style objects -- rather than hand-listed here. A legend that is a second copy
// of the icon set is a legend that goes stale the first time a glyph changes,
// and does so invisibly: nothing about a wrong legend fails.
//
// Deliberately not every layer. Forty rows is a reference document, not a
// legend; these are the marks whose meaning a reader cannot guess from the
// shape, plus the severity scale, which is the one thing on the map encoded in
// colour rather than in form.

import { SVG } from "../../map/svgIcons.js";
import { SEVERITY_BANDS, CORROBORATED_COLOR } from "../../map/severity.js";
import { LAYER_ROW } from "../../settings/layerPresentation.js";

/** A row built from the layer table, so its glyph and colour follow the map. */
function fromLayer(key, label) {
  const row = LAYER_ROW[key];
  if (!row) return null;
  return { key, svg: row.svg, color: row.color, token: row.token, label: label || row.label };
}

/**
 * The severity scale, straight off map/severity.js.
 *
 * Colour, not shape: every conflict pin is the same glyph and the band is what
 * separates them, so this is the one part of the legend a reader genuinely
 * cannot work out by looking.
 */
export function severityLegend() {
  const bands = (SEVERITY_BANDS || []).map((band) => ({
    key: `sev-${band.key || band.name || band.label}`,
    color: band.color,
    label: band.label || band.name || band.key,
  }));
  return [
    ...bands,
    // Not a severity at all -- a second source agreeing -- and it shares the
    // scale's visual channel, so it belongs beside it rather than in a fold of
    // its own where the two would look unrelated.
    { key: "corroborated", color: CORROBORATED_COLOR, label: "Corroborated by a second source" },
  ];
}

/** The glyph rows, in the order a reader meets the things they stand for. */
export function glyphLegend() {
  return [
    fromLayer("events", "Conflict event"),
    fromLayer("conflictHistory", "Verified record (UCDP)"),
    fromLayer("officials", "Official statement"),
    fromLayer("aisNavy", "Navy or MSC vessel"),
    fromLayer("aisTanker", "Oil tanker"),
    fromLayer("aisCivilian", "Civilian vessel"),
    fromLayer("darkVessels", "Dark vessel (inferred)"),
    fromLayer("adsbMilitary", "Military aircraft"),
    fromLayer("adsbCivilian", "Civilian aircraft"),
    fromLayer("adsbFlagged", "Emergency or hidden aircraft"),
    fromLayer("infra", "Critical infrastructure"),
    fromLayer("cables", "Submarine cable landing"),
    fromLayer("firms", "Thermal anomaly"),
    fromLayer("jamming", "GPS interference"),
    fromLayer("czib", "Airspace warning"),
    fromLayer("hazards", "Earthquake or volcano"),
    fromLayer("satellites", "Satellite"),
  ].filter(Boolean);
}

/**
 * The marks that are not layers: the two ways this map says it is unsure.
 *
 * Both are load-bearing provenance, not decoration -- a dashed ring means the
 * position is approximate and a dimmed pin means the report is weakly sourced,
 * and a reader who does not know that reads both as ordinary pins.
 */
export const QUALIFIER_ROWS = [
  { key: "imprecise", kind: "ring", label: "Position is approximate" },
  { key: "dimmed", kind: "dim", label: "Single or weak source" },
];
