// A small colored glyph for a layer-ticker row, replacing the old plain
// colored dot -- reuses the exact same SVG glyph strings the map's own
// markers are built from (see map/svgIcons.js/map/decorators.js), so a
// ticker's icon actually matches what you see on the map for that layer,
// not just its color.
export default function LayerIcon({ svg, color }) {
  return (
    <svg
      className="layer-icon"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      style={{ color }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
