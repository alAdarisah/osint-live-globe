// Grouping conflict reports by the city zone they fall in, instead of leaving
// every report as its own pin.
import { PanelGroup } from "../../controlPanel/Collapsible";
import { SliderField, CheckField } from "../fields";

export const SEARCH_TERMS = [
  "City zones",
  "Group conflict reports by city",
  "Draw the zone rings",
  "Zone size",
];

export default function CityZonesSection({ settings, actions, isOpen, onToggle }) {
  return (
    <PanelGroup id="adm-zones" title="City zones" open={isOpen("adm-zones")} onToggle={onToggle}>
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
  );
}
