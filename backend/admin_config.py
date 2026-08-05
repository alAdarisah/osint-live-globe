"""Admin Mode's configuration, stored in the project folder.

The frontend's Admin Mode (icon colours and sizes, layer appearance, interface
settings, per-record data edits) used to live only in the browser's
localStorage, which meant a configuration was tied to one browser profile on one
machine: another browser, another device, or a cleared cache and the map was
back to its shipped defaults.

This keeps the authoritative copy in ``data/admin_config.json`` next to the rest
of the deployment's state, so a configuration made once applies to every client
this backend serves, from the moment it is saved onwards.

Deliberately dumb about the contents. The shape belongs to the frontend
(frontend/src/settings/defaults.js), which already validates and range-checks
every field on load through mergeSettings -- restating that here would create a
second, slightly different idea of what a valid configuration is, and the
frontend's would still have to run anyway. This module's job is that the file on
disk is always either absent or a readable JSON object.
"""

import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path

from backend import config

log = logging.getLogger("osint-globe.admin_config")

CONFIG_PATH: Path = config.BASE_DIR / "data" / "admin_config.json"

# A configuration is settings plus per-record edits -- kilobytes in normal use.
# The cap is there so a runaway client (or a paste of something that is not a
# configuration at all) cannot fill the disk of a machine that is also writing
# a positions database.
MAX_BYTES = 2 * 1024 * 1024

# Writes are rare (a debounced save while someone drags a slider) but can
# overlap with a read from another client, and a half-written file is exactly
# the failure this module exists to prevent. The lock covers the swap; the swap
# itself is atomic (see save()).
_lock = threading.Lock()


def load() -> dict:
    """The stored configuration, or ``{}`` when there isn't one.

    Never raises. A missing file is the normal first-run state, and a corrupt
    one is worth a log line and the shipped defaults -- not a 500 on a route
    every client calls at startup.
    """
    try:
        raw = CONFIG_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as err:
        log.warning("Could not read %s: %s", CONFIG_PATH.name, err)
        return {}

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as err:
        log.warning("%s is not valid JSON (%s) -- ignoring it", CONFIG_PATH.name, err)
        return {}

    if not isinstance(parsed, dict):
        log.warning("%s does not contain a JSON object -- ignoring it", CONFIG_PATH.name)
        return {}
    return parsed


def saved_at() -> float | None:
    """When the configuration was last written, as a unix timestamp."""
    try:
        return CONFIG_PATH.stat().st_mtime
    except OSError:
        return None


def save(payload: dict) -> float:
    """Write the configuration, atomically. Returns the new save time.

    Written to a temporary file in the same directory and then renamed over the
    target: ``os.replace`` is atomic on both POSIX and Windows, so a reader
    either sees the whole previous configuration or the whole new one, never a
    truncated file. Writing in place would leave exactly that window open, and
    the window is wide enough to matter here because the client saves on a
    debounce while a slider is still moving.
    """
    encoded = json.dumps(payload, indent=2, ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_BYTES:
        raise ValueError(f"configuration is larger than {MAX_BYTES} bytes")

    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock:
        handle, tmp_path = tempfile.mkstemp(dir=CONFIG_PATH.parent, prefix=".admin_config-", suffix=".tmp")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as fh:
                fh.write(encoded)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp_path, CONFIG_PATH)
        except BaseException:
            # Leaving a stray .tmp behind on a failed write would accumulate one
            # file per failure in a directory the app also reads from.
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
    return saved_at() or time.time()


# No deletion path on purpose: Admin Mode's "reset all settings" writes the
# shipped defaults back through save(), so the file always describes what the
# deployment is currently showing rather than sometimes being absent and
# sometimes meaning "defaults".
