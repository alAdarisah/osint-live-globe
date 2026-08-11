"""Everything the dashboard can change, and what it asks before changing it.

One table rather than five key handlers, so the guards cannot drift from the
commands they guard -- and so the read-only check happens in one place that is
impossible to route around.

Rebuilds shell out to deploy.sh. It decides which images are behind their source
by comparing image build times against file mtimes; a second implementation here
would be a second answer to the same question, and the two would disagree the
first time one of them was edited.
"""

from collections.abc import Sequence
from dataclasses import dataclass

from ops.cc.run import Runner

# Restarting ingest re-polls every metered source, so both keys that touch it
# ask first -- one plainly, one by making you type the word.
_INGEST_COST = (
    "Rebuilding ingest re-polls every metered source (ACLED, FIRMS, ADS-B, AIS, "
    "Overpass, GFW) and spends real quota."
)


@dataclass(frozen=True)
class Action:
    key: str
    label: str
    argv: tuple[str, ...]
    needs_selection: bool = False
    confirm: str | None = None
    confirm_word: str | None = None


ACTIONS = {
    "s": Action("s", "up", ("docker", "compose", "up", "-d")),
    "x": Action("x", "stop", ("docker", "compose", "stop"),
                confirm="Stop the whole stack? Collection pauses until it is started again."),
    "r": Action("r", "restart", ("docker", "compose", "restart"), needs_selection=True),
    "d": Action("d", "deploy", ("./deploy.sh",)),
    "D": Action("D", "deploy+ingest", ("./deploy.sh", "--ingest"),
                confirm=_INGEST_COST, confirm_word="INGEST"),
}


def argv_for(key: str, selected: str | None) -> list[str]:
    action = ACTIONS[key]
    if action.needs_selection:
        if not selected:
            raise ValueError(f"{action.label} needs a selected service")
        return [*action.argv, selected]
    return list(action.argv)


def confirm_for(key: str, selected: str | None) -> tuple[str | None, str | None]:
    """(prompt, required word). Both None when the key just runs."""
    action = ACTIONS[key]
    if key == "r" and selected == "ingest":
        # Not in the table, because it depends on what is selected: restarting
        # refine costs nothing, restarting ingest costs the quota.
        return (f"Restart ingest? {_INGEST_COST}", None)
    return (action.confirm, action.confirm_word)


def is_allowed(key: str, *, read_only: bool) -> bool:
    return key in ACTIONS and not read_only


async def execute(key: str, *, selected: str | None, read_only: bool, run: Runner) -> int:
    """Run the action and return its exit code.

    Raises PermissionError under --read-only before touching the runner: a
    read-only mode that refuses after spawning the process is not one.
    """
    if not is_allowed(key, read_only=read_only):
        raise PermissionError(f"{key} is disabled in read-only mode")
    result = await run(argv_for(key, selected))
    return result.returncode


def footer(read_only: bool) -> Sequence[tuple[str, str, bool]]:
    """(key, label, enabled) for the footer, in the documented order."""
    return [(a.key, a.label, not read_only) for a in ACTIONS.values()]
