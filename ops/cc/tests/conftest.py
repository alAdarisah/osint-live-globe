"""Keep `pytest` at the repository root working without the command center's venv.

ops/cc has its own virtualenv and its own requirements -- Textual and psutil are
deliberately not in the root requirements.txt, because they would then be in the
backend, ingest, refine and cache-worker images. The consequence is that a plain
`pytest` run from the backend's environment can import most of these tests and
not the rest, and an ImportError during collection fails the whole run rather
than the three files it affects.

So the files that need those packages are skipped when they are absent. Running
the suite the documented way -- `ops/cc/.venv/bin/python -m pytest ops/cc/tests`
-- collects everything, because there the imports resolve.
"""

from importlib.util import find_spec

collect_ignore = []

if find_spec("textual") is None:
    collect_ignore += ["test_theme.py", "test_app.py"]
if find_spec("psutil") is None:
    collect_ignore += ["test_host.py"]
