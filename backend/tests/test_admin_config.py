"""Storing and serving Admin Mode's configuration.

This is the endpoint behind every setting a reader can change, and it had no
test at all. Two of the things it has to get right fail silently rather than
loudly, which is what earns them a file:

  * The route accepts POST as well as PUT, and only because
    ``navigator.sendBeacon`` exists. The frontend debounces its writes by 700ms,
    so a refresh inside that window drops the change -- a normal fetch issued
    from a document being torn down is cancelled with it, and sendBeacon is the
    one API that survives, at the cost of only being able to issue POST. Two
    decorators stacked on one handler is exactly the arrangement where one verb
    quietly does not get registered, and the symptom is a 405 nobody sees
    because the page is already gone.

  * ``load()`` never raises. It is called on a route every client hits at
    startup, so a corrupt or truncated file has to degrade to the shipped
    defaults rather than to a 500 that stops the map painting at all.
"""

import asyncio
import json

import pytest

from backend import admin_config
from backend import app as app_mod


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def config_path(tmp_path, monkeypatch):
    """Point the module at a throwaway file instead of the real one.

    The real path is the developer's own saved configuration; a test that wrote
    over it would be a genuinely annoying thing to run.
    """
    path = tmp_path / "admin_config.json"
    monkeypatch.setattr(admin_config, "CONFIG_PATH", path)
    return path


class _StubRequest:
    """Just enough of starlette's Request for the PUT handler."""

    def __init__(self, body):
        self._body = body

    async def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


# --- the sendBeacon route ---------------------------------------------------


def _methods_for(path):
    return {
        method
        for route in app_mod.app.routes
        if getattr(route, "path", None) == path
        for method in (getattr(route, "methods", None) or ())
    }


def test_the_save_route_accepts_both_verbs():
    """PUT for the ordinary debounced save, POST for the unload beacon.

    Asserted against the app's own route table rather than by calling the
    handler, because the handler is reachable either way -- what is in question
    is whether both decorators actually registered.
    """
    methods = _methods_for("/api/admin-config")
    assert "PUT" in methods, "the ordinary save path is gone"
    assert "POST" in methods, "sendBeacon can only POST, and it is how a save survives a refresh"


def test_the_read_route_is_a_get():
    assert "GET" in _methods_for("/api/admin-config")


# --- round trip -------------------------------------------------------------


def test_a_saved_configuration_reads_back(config_path):
    stamp = admin_config.save({"icons": {"scale": 1.5}})
    assert stamp > 0
    assert admin_config.load() == {"icons": {"scale": 1.5}}
    assert admin_config.saved_at() == pytest.approx(stamp, abs=2)


def test_the_handler_writes_what_it_was_given(config_path):
    payload = {"layerWish": {"firms": False}}
    response = _run(app_mod.admin_config_put(_StubRequest(payload)))
    assert response.status_code == 200
    assert admin_config.load() == payload


def test_a_second_save_replaces_the_first(config_path):
    """Whole-object writes, not merges -- see the handler's own docstring.

    Worth pinning because "false disappears" is the shape of the bug this
    endpoint was recently fixed for: a merge that skipped falsey values would
    make an unticked layer un-untickable.
    """
    admin_config.save({"layerWish": {"firms": True, "cities": True}})
    admin_config.save({"layerWish": {"firms": False}})
    assert admin_config.load() == {"layerWish": {"firms": False}}


# --- load() never raises ----------------------------------------------------


def test_a_missing_file_is_the_empty_configuration(config_path):
    assert not config_path.exists()
    assert admin_config.load() == {}
    assert admin_config.saved_at() is None


def test_a_corrupt_file_degrades_to_empty(config_path):
    config_path.write_text("{ this is not json", encoding="utf-8")
    assert admin_config.load() == {}


def test_a_json_file_that_is_not_an_object_degrades_to_empty(config_path):
    config_path.write_text("[1, 2, 3]", encoding="utf-8")
    assert admin_config.load() == {}


# --- what the handler refuses -----------------------------------------------


def test_a_body_that_is_not_json_is_rejected(config_path):
    with pytest.raises(Exception) as caught:
        _run(app_mod.admin_config_put(_StubRequest(ValueError("no"))))
    assert getattr(caught.value, "status_code", None) == 400
    assert not config_path.exists()


def test_a_body_that_is_not_an_object_is_rejected(config_path):
    with pytest.raises(Exception) as caught:
        _run(app_mod.admin_config_put(_StubRequest([1, 2, 3])))
    assert getattr(caught.value, "status_code", None) == 400
    assert not config_path.exists()


def test_an_oversized_configuration_is_refused(config_path):
    """The cap exists so a runaway client cannot fill the disk of a machine that
    is also writing a positions database."""
    huge = {"borders": {"x": "y" * (admin_config.MAX_BYTES + 1)}}
    with pytest.raises(Exception) as caught:
        _run(app_mod.admin_config_put(_StubRequest(huge)))
    assert getattr(caught.value, "status_code", None) == 413


def test_a_refused_write_leaves_the_previous_configuration_intact(config_path):
    """A rejected save must not be a destructive one.

    The write is atomic (os.replace over a temp file in the same directory), so
    the failure mode this guards against is the size check happening after the
    target had already been opened for writing.
    """
    admin_config.save({"icons": {"scale": 2}})
    huge = {"borders": {"x": "y" * (admin_config.MAX_BYTES + 1)}}
    with pytest.raises(ValueError):
        admin_config.save(huge)
    assert admin_config.load() == {"icons": {"scale": 2}}


def test_the_file_on_disk_is_readable_json(config_path):
    """Written indented and as UTF-8 text: this file is meant to be hand-edited
    and diffed, which is the whole reason it lives in the project folder."""
    admin_config.save({"ui": {"accent": "#6fe3ff"}, "name": "Køge"})
    text = config_path.read_text(encoding="utf-8")
    assert "\n" in text, "not indented"
    assert "Køge" in text, "non-ASCII was escaped"
    assert json.loads(text) == {"ui": {"accent": "#6fe3ff"}, "name": "Køge"}
