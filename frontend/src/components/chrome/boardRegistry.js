// The four instrument boards, and which of them are open.
//
// Each is a self-contained panel that fetches its own endpoint on its own
// cadence and owns its own LOADING / ERROR / MISSING / READY states through
// components/refinePanelStatus.js. None of that changes here: this table only
// decides which of them the board stack currently shows, and gives the Boards
// menu its labels. The panels themselves are untouched apart from learning to
// sit in a stack rather than float (see their `docked` prop).
//
// `logic` names the sibling module each panel's row-building lives in, and
// tests/boardRegistry.test.js asserts every one of those files exists. That is
// the anti-reimplementation guard: the temptation with a redesign like this is
// to rebuild a board's rows inside the new chrome and quietly leave the tested
// module behind, and this makes that fail rather than pass.

export const BOARDS = [
  {
    id: "chokepoints",
    label: "Chokepoints",
    note: "Distinct hulls through eight watched straits, and the 30-day trend.",
    logic: "chokepointPanelLogic.js",
  },
  {
    id: "airfields",
    label: "Airfield activity",
    note: "Airfields ranked by movements in the last 24 hours. Not NOTAMs.",
    logic: "airfieldPanelLogic.js",
  },
  {
    id: "infraRisk",
    label: "Infrastructure risk",
    note: "Sites with conflict events inside their own uncertainty radius.",
    logic: "infraRiskPanelLogic.js",
  },
  {
    id: "cables",
    label: "Cable outages",
    note: "Where a cable landing and a national outage coincide.",
    logic: "cableOutagePanelLogic.js",
  },
];

/**
 * Which boards a session starts with.
 *
 * One, not none and not four. None makes the stack invisible and so makes the
 * Boards menu the only evidence it exists; four fills the right-hand third of
 * the map with instruments before the reader has asked a question. Chokepoints
 * is the one that reads as a standing situation rather than an investigation.
 */
export const DEFAULT_OPEN_BOARDS = ["chokepoints"];

export const OPEN_BOARDS_KEY = "osint-open-boards";

export function toggleBoard(open, id) {
  const current = new Set(open || []);
  if (current.has(id)) current.delete(id);
  else current.add(id);
  // Back through BOARDS, so the stack's order is this table's order rather
  // than the order a reader happened to switch things on in -- otherwise the
  // same set of boards can be arranged two ways and the stack appears to
  // shuffle itself.
  return BOARDS.filter((board) => current.has(board.id)).map((board) => board.id);
}

export function isBoardOpen(open, id) {
  return (open || []).includes(id);
}

/** The open boards, in table order, as entries rather than ids. */
export function openBoards(open) {
  return BOARDS.filter((board) => isBoardOpen(open, board.id));
}

export function loadOpenBoards(storage) {
  try {
    const raw = storage?.getItem(OPEN_BOARDS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [...DEFAULT_OPEN_BOARDS];
    // Filtered through the table on the way in: a stored id from a board that
    // no longer exists would otherwise sit in the set forever, counted by the
    // menu and rendered by nothing.
    return BOARDS.filter((board) => parsed.includes(board.id)).map((board) => board.id);
  } catch {
    return [...DEFAULT_OPEN_BOARDS];
  }
}

export function saveOpenBoards(open, storage) {
  try {
    storage?.setItem(OPEN_BOARDS_KEY, JSON.stringify(open));
    return true;
  } catch {
    return false;
  }
}
