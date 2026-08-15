"""User-defined alert rules -- "tell me when X happens here" -- evaluated by
the cache worker's periodic loop and fired through the exact alerts table and
webhook backend/cacheworker already uses for source health (see
backend/cacheworker/__init__.py's own Alert dataclass and
backend/storage.py's record_alert/resolve_alerts/active_alerts). Nothing here
is a second notification system: reusing that de-duplication is what makes
"this rule has been true for six hours" one row and one webhook post rather
than one per poll -- the identical contract cacheworker already gives "Redis
is unreachable", extended from "is the infrastructure healthy" to "does this
reader-defined condition hold".

Where this runs, and why
-------------------------
A rule condition (entity enters a geofence, a layer's count in some area
exceeds N, an entity's numeric field is above X, an aircraft is squawking a
given code) needs live entity positions. entity_latest is the compact
current-state table built for exactly this; entity_history (the raw,
~11 GB, three-day movement log) must never be read on a request path, and
this module never touches it -- only entity_latest, through
storage.entity_latest_with_ids.

That leaves two candidate hosts for the evaluation itself: the backend (an
HTTP request path) or the cache worker (already a long-running, periodic,
off-request-path loop that evaluates conditions and fires them through this
exact alerts table). The backend is the wrong host for a periodic,
no-request-triggered loop -- FastAPI has no cron of its own, and building one
here would duplicate the cache worker's loop for no reason it can name. So
this is evaluated entirely inside the cache worker (see gather_and_evaluate
below, called from cacheworker/__main__.py's run_once), which already owns
"evaluate a condition, fire it through record_alert/resolve_alerts, notify a
webhook" once a minute.

The cache worker is a separate process from the API that serves the browser,
so firing an alert there cannot push a toast into an open tab directly --
there is no socket between them, and building one would be a second delivery
path for something the app already has one of. It does not need one: a fired
alert lands in the same `alerts` Postgres table /api/health already serves
(see app.py's health()), and the frontend's useHealth hook already polls
/api/health for every session, admin or not (frontend/src/hooks/useHealth.js,
15s in Admin Mode, 60s otherwise). A rule that starts firing shows up in that
poll's `alerts` array within one cycle, exactly like "Redis is unreachable"
does today, and AlertToast.jsx watches that array for rule-tagged entries it
has not shown yet. No new transport exists for this -- the toast rides the
delivery path the health alerts already have.

"Entity enters", without history
---------------------------------
Entering is normally a transition, and a transition needs a previous state to
compare against. This module keeps none. Instead, "enters" is treated as
level-triggered -- "this entity is currently inside the geofence" -- exactly
like "Redis is unreachable" is level-triggered: record_alert fires once when
a (rule, entity) pair starts being true and is silent for as long as it stays
true (its own de-duplication, not a second one built here), and
resolve_alerts closes it the moment a later pass no longer finds that entity
inside. A geofence exit followed by a later re-entry is therefore a fresh
alert -- the "resolves and re-fires" behaviour the brief requires -- for
free, because it is the identical mechanism cacheworker already uses for "the
cache stopped following this kind" recovering and breaking again.

There is deliberately no separate per-entity memo of "was this entity inside
last time". The active set handed to storage.resolve_alerts each pass *is*
that state: one row per currently-matching (rule, entity) pair, in Postgres,
cleared the moment it stops matching, and already correct across a worker
restart. An unbounded in-process dict tracking "every entity ever seen" is
exactly the defect this plan has produced twice elsewhere (see this task's
own brief); this design never needs one, because the alerts table already
*is* the bounded, durable record of "what is true right now".
"""

import logging
from dataclasses import dataclass

from backend import regions, storage
from backend.cacheworker import Alert

log = logging.getLogger("osint-globe.alert_rules")

# Every alert this module fires carries this prefix on `subject`, so a reader
# of the alerts table (or the frontend's AlertToast) can tell a user rule
# apart from a source-health condition without a second field -- the same way
# cacheworker's own SERVER constant marks conditions about the cache itself.
SUBJECT_PREFIX = "rule:"

# The condition types the rule builder offers, matching the brief's own list
# verbatim ("entity enters, count exceeds N, score above X, squawk equals
# Y"). Anything else in a stored rule is a hand-edited or stale file and is
# dropped by parse_rules rather than guessed at.
CONDITION_TYPES = {"enter", "count_exceeds", "score_above", "squawk_equals"}
GEOFENCE_TYPES = {"country", "region", "water", "rect"}


@dataclass(frozen=True)
class Rule:
    id: str
    name: str
    layer: str
    enabled: bool
    geofence: dict | None
    condition: dict


def _clean_str(value, max_len: int = 200) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:max_len] if value else None


def _clean_bbox(value):
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        nums = [float(v) for v in value]
    except (TypeError, ValueError):
        return None
    south, west, north, east = nums
    if not (-90.0 <= south <= 90.0 and -90.0 <= north <= 90.0):
        return None
    if not (-180.0 <= west <= 180.0 and -180.0 <= east <= 180.0):
        return None
    if south > north:
        return None
    return nums


def _parse_geofence(raw) -> dict | None:
    """A stored geofence -> a clean dict, or None (meaning "the whole
    world") for anything that doesn't parse. A rule whose geofence has gone
    bad is not the same thing as a rule with no geofence -- see parse_rules'
    own note -- but this function's job is only the shape; parse_rules is
    what decides whether an unparseable geofence sinks the whole rule.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        return None
    kind = raw.get("type")
    if kind == "country":
        iso2 = _clean_str(raw.get("iso2"), 2)
        if not iso2:
            return None
        return {"type": "country", "iso2": iso2.upper(), "name": _clean_str(raw.get("name"), 120)}
    if kind == "region":
        key = _clean_str(raw.get("key"), 60)
        if not key or regions.bounds_for(key) is None:
            return None
        return {"type": "region", "key": key, "name": _clean_str(raw.get("name"), 120)}
    if kind == "water":
        wid = _clean_str(raw.get("id"), 120)
        bbox = _clean_bbox(raw.get("bbox"))
        if not wid or bbox is None:
            return None
        return {"type": "water", "id": wid, "name": _clean_str(raw.get("name"), 120), "bbox": bbox}
    if kind == "rect":
        bbox = _clean_bbox(raw.get("bounds"))
        if bbox is None:
            return None
        return {"type": "rect", "bounds": bbox}
    return None


def _parse_condition(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    kind = raw.get("type")
    if kind == "enter":
        return {"type": "enter"}
    if kind == "count_exceeds":
        try:
            n = int(raw.get("n"))
        except (TypeError, ValueError):
            return None
        if n < 0:
            return None
        return {"type": "count_exceeds", "n": n}
    if kind == "score_above":
        field_name = _clean_str(raw.get("field"), 60)
        try:
            threshold = float(raw.get("threshold"))
        except (TypeError, ValueError):
            return None
        if not field_name:
            return None
        return {"type": "score_above", "field": field_name, "threshold": threshold}
    if kind == "squawk_equals":
        code = _clean_str(raw.get("code"), 4)
        if not code or not code.isdigit():
            return None
        return {"type": "squawk_equals", "code": code}
    return None


def parse_rules(raw_rules) -> list[Rule]:
    """A stored `alertRules` list (admin_config's own, deliberately-dumb
    JSON -- see backend/admin_config.py's module docstring) -> the Rules
    worth evaluating.

    Tolerant, the same way admin_config.load() is: this file is meant to be
    hand-editable, and one malformed entry must not take every other rule
    down with it. A rule that fails to parse is dropped and logged once per
    pass rather than raised -- the frontend's own rule builder only ever
    writes a well-formed shape (guarded selects and number inputs, never a
    free-text JSON field), so a drop here is expected to mean "stale/hand-
    edited file", not "the rule builder produced something wrong".
    """
    out = []
    if not isinstance(raw_rules, list):
        return out
    seen_ids = set()
    for entry in raw_rules:
        if not isinstance(entry, dict):
            continue
        rid = _clean_str(entry.get("id"), 80)
        name = _clean_str(entry.get("name"), 120)
        layer = _clean_str(entry.get("layer"), 40)
        condition = _parse_condition(entry.get("condition"))
        if not rid or rid in seen_ids or not name or not layer or condition is None:
            log.warning("Dropping an unparseable alert rule: %r", entry.get("id"))
            continue
        # squawk_equals only means anything against the ADS-B feed -- the
        # field it compares (payload["squawk"]) does not exist on any other
        # kind, so a rule of this type against another layer can never match
        # anything and would sit silently, indistinguishable from "correctly
        # evaluated, never met" (the honesty rule this plan keeps repeating).
        # Dropping it here instead is the same "found nothing must not look
        # like did not look" call applied one level up: a rule that cannot
        # possibly evaluate is not a rule, and the frontend never offers this
        # combination in the first place (see AlertRulesSection.jsx).
        if condition["type"] == "squawk_equals" and layer != "adsb":
            continue
        geofence_raw = entry.get("geofence")
        if geofence_raw is not None:
            geofence = _parse_geofence(geofence_raw)
            if geofence is None:
                # A geofence that fails to parse must drop the whole rule, not
                # silently widen it to "anywhere" -- a region key with a typo
                # or a country a hand-edit misspelled is a broken rule, and
                # firing it unbounded would be a *more* surprising failure
                # than not firing it at all.
                log.warning("Dropping alert rule %r: its geofence does not parse", rid)
                continue
        else:
            geofence = None
        seen_ids.add(rid)
        out.append(Rule(
            id=rid,
            name=name,
            layer=layer,
            enabled=entry.get("enabled") is not False,
            geofence=geofence,
            condition=condition,
        ))
    return out


def _entity_label(entity_id: str, payload: dict) -> str:
    """A human-readable name for one row: whatever this kind's own record
    calls itself, falling back to the one thing every row always has. Checked
    in this order because it is the same fallback chain
    squawkAlertsLogic.js's alertLabel already settled on for aircraft, and
    "name" is what ais.py's own ShipName field lands under (see
    backend/sources/ais.py's normalise_static)."""
    for field_name in ("name", "callsign", "registration"):
        value = payload.get(field_name)
        if value:
            return str(value)
    return entity_id


def _in_geofence(lat, lon, geofence: dict | None, country_index) -> bool:
    if geofence is None:
        return True
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return False
    kind = geofence["type"]
    if kind == "country":
        if country_index is None:
            return False
        found = country_index.country_at(lat, lon)
        return bool(found and found.get("iso2") == geofence["iso2"])
    if kind == "region":
        bounds = regions.bounds_for(geofence["key"])
        return bounds is not None and regions.bbox_contains_point(list(bounds), lat, lon)
    if kind == "water":
        return regions.bbox_contains_point(geofence["bbox"], lat, lon)
    if kind == "rect":
        return regions.bbox_contains_point(geofence["bounds"], lat, lon)
    return False


def _geofence_label(geofence: dict | None) -> str:
    if geofence is None:
        return "anywhere"
    kind = geofence["type"]
    if kind == "country":
        return geofence.get("name") or geofence["iso2"]
    if kind == "region":
        return geofence.get("name") or geofence["key"]
    if kind == "water":
        return geofence.get("name") or geofence["id"]
    if kind == "rect":
        return "the marked area"
    return "the marked area"


def _matching_rows(rule: Rule, rows: list[tuple[str, dict]], country_index) -> list[tuple[str, dict]]:
    """Every (entity_id, payload) in `rows` this rule's geofence admits, in
    the order storage handed them over. Shared by every per-entity condition
    below -- count_exceeds counts this list's length, enter/score_above/
    squawk_equals iterate it -- so the geofence test is written once."""
    out = []
    for entity_id, payload in rows:
        if _in_geofence(payload.get("lat"), payload.get("lon"), rule.geofence, country_index):
            out.append((entity_id, payload))
    return out


def evaluate_rules(rules: list[Rule], entities_by_layer: dict, *, country_index=None) -> list[Alert]:
    """Pure: every alert every enabled rule currently wants firing, computed
    from data already fetched. No I/O, no clock read, no persistence --
    record_alert/resolve_alerts (storage.py) are what turn this list into
    "newly firing" vs "still firing" vs "resolved"; this function only
    answers "is it true right now".

    `entities_by_layer` is {layer: [(entity_id, payload), ...]}, exactly
    storage.entity_latest_with_ids's own return shape, one call per distinct
    layer a rule references (see gather_and_evaluate). A layer no rule
    mentions is never fetched, and a layer that is missing from this dict
    (rather than merely empty) is treated as empty here -- both read as "no
    matches", which is correct: an unfetched layer contributes nothing to
    fire, and a genuinely empty one contributes nothing either.
    """
    alerts: list[Alert] = []
    for rule in rules:
        if not rule.enabled:
            continue
        rows = entities_by_layer.get(rule.layer) or []
        condition = rule.condition
        ctype = condition["type"]
        subject = f"{SUBJECT_PREFIX}{rule.id}"
        where = _geofence_label(rule.geofence)

        if ctype == "count_exceeds":
            matching = _matching_rows(rule, rows, country_index)
            count = len(matching)
            if count > condition["n"]:
                alerts.append(Alert(
                    subject, "count",
                    "warning",
                    f"\"{rule.name}\": {count} {rule.layer} in {where}, above the "
                    f"threshold of {condition['n']}.",
                ))
            continue

        if ctype == "enter":
            for entity_id, payload in _matching_rows(rule, rows, country_index):
                alerts.append(Alert(
                    subject, f"entity:{entity_id}",
                    "warning",
                    f"\"{rule.name}\": {_entity_label(entity_id, payload)} is in {where}.",
                ))
            continue

        if ctype == "score_above":
            field_name, threshold = condition["field"], condition["threshold"]
            for entity_id, payload in _matching_rows(rule, rows, country_index):
                value = payload.get(field_name)
                if not isinstance(value, (int, float)) or value <= threshold:
                    continue
                alerts.append(Alert(
                    subject, f"entity:{entity_id}",
                    "warning",
                    f"\"{rule.name}\": {_entity_label(entity_id, payload)} has {field_name} "
                    f"{value} in {where}, above {threshold}.",
                ))
            continue

        if ctype == "squawk_equals":
            code = condition["code"]
            for entity_id, payload in _matching_rows(rule, rows, country_index):
                if payload.get("squawk") != code:
                    continue
                alerts.append(Alert(
                    subject, f"entity:{entity_id}",
                    "warning",
                    f"\"{rule.name}\": {_entity_label(entity_id, payload)} is squawking "
                    f"{code} in {where}.",
                ))
            continue

    return alerts


async def gather_and_evaluate(rules_payload=None) -> list[Alert]:
    """The I/O half: read the stored rules and whatever entity_latest/country
    data they need, then hand it to the pure evaluate_rules above. Mirrors
    cacheworker/__main__.py's own split -- _probe does the I/O, evaluate() in
    cacheworker/__init__.py is pure -- one level higher, for the same reason:
    the part that decides what is wrong is the part that has to be right, and
    it is the part a test can reach without a Postgres.

    `rules_payload` is the parsed `alertRules` list from admin_config.load();
    the caller reads that (cacheworker/__main__.py) rather than this module
    doing it, so this stays a pure function of its arguments plus storage,
    the same testable shape the rest of this module keeps.
    """
    rules = parse_rules(rules_payload or [])
    enabled = [r for r in rules if r.enabled]
    if not enabled:
        return []

    layers = sorted({r.layer for r in enabled})
    entities_by_layer = {}
    for layer in layers:
        entities_by_layer[layer] = await storage.entity_latest_with_ids(layer)

    country_index = None
    if any(r.geofence and r.geofence["type"] == "country" for r in enabled):
        countries_geojson = await storage.reference("countries")
        country_index = regions.CountryIndex(countries_geojson or {})

    return evaluate_rules(enabled, entities_by_layer, country_index=country_index)
