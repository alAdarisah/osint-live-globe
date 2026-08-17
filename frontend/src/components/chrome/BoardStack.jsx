import ChokepointPanel from "../ChokepointPanel";
import AirfieldActivityPanel from "../AirfieldActivityPanel";
import InfraRiskPanel from "../InfraRiskPanel";
import CableOutagePanel from "../CableOutagePanel";
import { openBoards } from "./boardRegistry";

const PANELS = {
  chokepoints: ChokepointPanel,
  airfields: AirfieldActivityPanel,
  infraRisk: InfraRiskPanel,
  cables: CableOutagePanel,
};

/**
 * The instrument boards, stacked against the right edge.
 *
 * They used to be four independently draggable cards pinned to the bottom-left
 * corner at 52px intervals -- an arrangement that worked because each was
 * collapsed to a header bar most of the time, and fell apart the moment two
 * were open at once. Stacking them means the column decides the geometry and
 * each board is just as tall as it needs to be.
 *
 * `column-reverse` so a board added to the set grows the stack upward from the
 * HUD rather than pushing the others down past the bottom of the screen: the
 * bottom of this column is anchored and the top is what moves.
 *
 * The panels themselves are unchanged. They keep their own fetch, their own
 * cadence, their own sort controls and their own LOADING / ERROR / MISSING
 * states -- `docked` only tells them not to be draggable, because a card inside
 * a flex column has nowhere to drag to.
 */
export default function BoardStack({ open, onLocate, isMobile }) {
  const boards = openBoards(open);
  if (!boards.length) return null;

  return (
    <div id="boardStack">
      {boards.map((board) => {
        const Panel = PANELS[board.id];
        return Panel ? <Panel key={board.id} onLocate={onLocate} isMobile={isMobile} docked /> : null;
      })}
    </div>
  );
}
