"""The five keys that change something, and the guards on the two that cost.

`D` re-polls every metered source (ACLED, FIRMS, ADS-B, AIS, Overpass, GFW), so
it is the one key in the program that spends money. Everything here exists to
make that key hard to press by accident and every other key easy.
"""

import asyncio

import pytest

from ops.cc import actions
from ops.cc.run import CommandResult


def _recorder():
    seen = []

    async def fake_run(argv):
        seen.append(list(argv))
        return CommandResult(tuple(argv), 0, "", "")

    return fake_run, seen


def test_the_argv_for_every_key():
    assert actions.argv_for("s", None) == ["docker", "compose", "up", "-d"]
    assert actions.argv_for("x", None) == ["docker", "compose", "stop"]
    assert actions.argv_for("r", "backend") == ["docker", "compose", "restart", "backend"]
    assert actions.argv_for("d", None) == ["./deploy.sh"]
    assert actions.argv_for("D", None) == ["./deploy.sh", "--ingest"]


def test_rebuilds_shell_out_rather_than_reimplementing_staleness():
    """deploy.sh decides which images are behind their source. A second
    implementation here would be a second answer to that question."""
    assert actions.argv_for("d", None)[0].endswith("deploy.sh")


def test_restart_without_a_selection_is_refused():
    with pytest.raises(ValueError):
        actions.argv_for("r", None)


def test_stopping_asks_first():
    prompt, word = actions.confirm_for("x", None)
    assert prompt and word is None


def test_restarting_ingest_asks_where_restarting_refine_does_not():
    assert actions.confirm_for("r", "refine") == (None, None)
    prompt, word = actions.confirm_for("r", "ingest")
    assert prompt and "ingest" in prompt


def test_rebuilding_ingest_demands_a_typed_word():
    prompt, word = actions.confirm_for("D", None)
    assert word == "INGEST"
    assert "metered" in prompt.lower() or "quota" in prompt.lower()


def test_a_plain_rebuild_does_not_ask():
    assert actions.confirm_for("d", None) == (None, None)


def test_read_only_refuses_every_mutating_key():
    for key in ("s", "x", "r", "d", "D"):
        assert actions.is_allowed(key, read_only=True) is False
        assert actions.is_allowed(key, read_only=False) is True


def test_execute_runs_nothing_at_all_in_read_only():
    fake_run, seen = _recorder()
    with pytest.raises(PermissionError):
        asyncio.run(actions.execute("D", selected=None, read_only=True, run=fake_run))
    assert seen == [], "read-only must refuse before the subprocess, not after"


def test_execute_returns_the_exit_code():
    async def failing(argv):
        return CommandResult(tuple(argv), 2, "", "compose said no")

    assert asyncio.run(
        actions.execute("s", selected=None, read_only=False, run=failing)
    ) == 2


def test_every_action_has_a_footer_label():
    assert set(actions.ACTIONS) == {"s", "x", "r", "d", "D"}
    for action in actions.ACTIONS.values():
        assert action.label
