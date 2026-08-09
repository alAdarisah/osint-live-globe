// Every pin type's own label, flattened out of the palette.
//
// LayerDialsSection.jsx renders one IconField per palette token -- either
// under the layer row that owns it (TOKENS_BY_LAYER in shared.jsx) or under
// Shared colours if nothing owns it (SHARED_TOKENS) -- and every one of those
// rows is a real, visible control with a real label: "Helicopter",
// "Capital city", "OFAC-designated". A user typing one of those into the
// admin search box should find the Layers section the same way they would by
// typing "Opacity" or "Cities".
//
// Kept in a plain .js file, importing only from map/iconTheme.js, so this --
// and the search box's coverage of it -- can be asserted under plain
// `node --test` (LayerDialsSection.jsx itself cannot be: it is JSX, and
// settings/defaults.js's own imports are not extension-qualified, so even a
// data-only module that pulled SETTINGS_LAYERS in would fail to load under
// Node's ESM resolver). Every palette token ends up in exactly one of
// TOKENS_BY_LAYER or SHARED_TOKENS (see shared.jsx), so flattening the whole
// palette here is equivalent to -- and simpler than -- reconstructing that
// split just to concatenate the two halves.
import { PALETTE_GROUPS } from "../../../map/iconTheme.js";

export const ALL_TOKEN_LABELS = PALETTE_GROUPS.flatMap((group) => group.tokens.map((token) => token.label));
