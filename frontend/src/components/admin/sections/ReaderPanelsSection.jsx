// Which of the reader's own panels this deployment carries.
//
// Everything else in this directory configures the map or the instruments
// around it. This section is the one that decides what a reader who never opens
// Admin Mode is shown -- the intel panel's four tabs, and the conflict briefing
// card that a theatre pick opens.
//
// Per tab rather than per panel for the intel panel, because the four tabs are
// four readings of four different feeds behind one header: "carry the news wire
// but not the officials one" is a real editorial decision about a deployment,
// and one on/off for the whole panel could not say it. With all four off the
// panel is not rendered at all (see App.jsx).
import { PanelGroup } from "../../controlPanel/Collapsible";
import { CheckField } from "../fields";

export const SEARCH_TERMS = [
  "Reader panels",
  "Intel panel: Escalation",
  "Intel panel: Activity",
  "Intel panel: Events",
  "Intel panel: News",
  "Intel panel: Officials",
  "Intel panel: Sanctions",
  "Conflict briefing card",
];

// Keyed by the same names settings/defaults.js gives them, which are the same
// names IntelPanel.jsx gives its tabs -- see INTEL_TAB_KEYS on why the three
// files agree on a key rather than translating between three vocabularies.
const TAB_ROWS = [
  {
    key: "escalation",
    label: "Intel panel: Escalation",
    note: "Which theatres are spiking, ranked. The one tab that is about regions rather than records.",
  },
  {
    key: "activity",
    label: "Intel panel: Activity",
    note: "Conflict records, statements and headlines on one timeline, newest first. The stream — as against Events, which is the same records ranked by significance.",
  },
  {
    key: "events",
    label: "Intel panel: Events",
    note: "The same /api/events rows the map draws, through the same filter — so the list and the pins cannot disagree.",
  },
  {
    key: "news",
    label: "Intel panel: News",
    note: "Live headlines for whatever is in view, or for the selected country. Names its outlet and its age on every line.",
  },
  {
    key: "officials",
    label: "Intel panel: Officials",
    note: "Statements and diplomatic movements. The slowest of the feeds, and the one a quiet day empties.",
  },
  {
    key: "sanctions",
    label: "Intel panel: Sanctions",
    note: "Every OFAC- or OpenSanctions-matched hull and airframe in the live feed. Covers the whole feed, not only what is on screen.",
  },
];

export default function ReaderPanelsSection({ settings, actions, isOpen, onToggle }) {
  return (
    <PanelGroup id="adm-public" title="Reader panels" open={isOpen("adm-public")} onToggle={onToggle}>
      <div className="admin-note">
        The panels that are the reader&rsquo;s rather than the operator&rsquo;s: they render outside
        Admin Mode, because each answers a question about the world rather than about the map.
        Switch one off and this deployment stops carrying it.
        <b> Off means off here too</b> &mdash; Admin Mode is this page plus instruments, not a
        different page, so an operator who has taken a tab away from readers sees the page readers
        get. Ticking it back is how you look at it again.
      </div>
      {TAB_ROWS.map((row) => (
        <CheckField
          key={row.key}
          label={row.label}
          note={row.note}
          checked={settings.publicPanels[row.key]}
          onChange={(value) => actions.setPublicPanels({ [row.key]: value })}
        />
      ))}
      <div className="admin-note">
        With all four off the intel panel is not drawn at all &mdash; an empty tab bar over an
        empty list is worse than no panel.
      </div>
      <CheckField
        label="Conflict briefing card"
        note="Opened by picking a theatre in the region bar. Switching it off leaves that click with nothing to show."
        checked={settings.publicPanels.briefingCard}
        onChange={(value) => actions.setPublicPanels({ briefingCard: value })}
      />
    </PanelGroup>
  );
}
