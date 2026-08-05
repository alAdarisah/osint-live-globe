// A small colored glyph for a layer-ticker row, replacing the old plain
// colored dot -- reuses the exact same SVG glyph strings the map's own
// markers are built from (see map/svgIcons.js/map/decorators.js), so a
// ticker's icon actually matches what you see on the map for that layer,
// not just its color.
//
// `token` is how that stays true once Admin Mode can recolour a layer: pass the
// palette token and the swatch resolves to whatever colour the map is currently
// drawing that thing in, with `color` as the shipped fallback. A row with no
// token (a glyph that stands for a shape rather than a layer) just uses
// `color`.
import { paletteColor } from "../../map/iconTheme";

export default function LayerIcon({ svg, color, token }) {
  return (
    <svg
      className="layer-icon"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      style={{ color: token ? paletteColor(token, color) : color }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
