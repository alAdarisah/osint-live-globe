// The Layers section's search terms, in a plain .js module rather than beside
// the component.
//
// LayerDialsSection.jsx is JSX, which plain `node --test` cannot import (see
// tokenSearchTerms.js and adminSearch.js, both here for the same reason). The
// terms are what the admin search box actually matches against, so they are
// worth a test; the component that renders them is not importable, so they
// move to where a test can reach them.

import { SETTINGS_LAYERS } from "../../../settings/defaults.js";
import { LAYER_GROUPS } from "../../../settings/layerGroups.js";
import { ALL_TOKEN_LABELS } from "./tokenSearchTerms.js";

/** The section title, the six group headings, the four generic dial names,
 *  every layer's own name, and every pin type's own label -- a heading, a
 *  layer row and a pin type are all real controls a search should find. */
export const SEARCH_TERMS = [
  "Layers",
  ...LAYER_GROUPS.map((g) => g.title),
  "Size",
  "Opacity",
  "Shows from zoom",
  "Hides past zoom",
  "Only with a country selected",
  "Shared colours",
  ...SETTINGS_LAYERS.map((l) => l.label),
  ...ALL_TOKEN_LABELS,
];
