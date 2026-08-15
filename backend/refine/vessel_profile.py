"""What kind of ship this is, and whether it looks loaded -- both guesses.

AIS broadcasts a position, a speed and (sometimes) a static block a crew typed
in before sailing. It has never carried a cargo manifest and never will, so
everything this module writes is either arithmetic over a broadcast value
(**derived**) or a judgement from indirect evidence (**inferred**) -- never a
fact received from anyone. The card this feeds (Task 17) says so; this module's
job is to carry enough of the working that the words mean something rather
than just being attached.

Two independent guesses live in one record, because they come from two
different halves of the same static message and both want the hull's cargo
context:

  cargo class   AIS's own "ship type" code (aisstream forwards it verbatim as
                ShipStaticData.Type) sorted into seven broad buckets by
                ITU-R M.1371-5 Annex 8, Table 50 -- see cargo_class. This part
                is deterministic: the same code always sorts the same way, so
                it is labelled **derived**, not inferred.

  laden state   Read off the hull's own draught history, never off a fixed
                number -- a loaded Suezmax and an empty coaster both broadcast
                a draught, and only the ship's own shallowest and deepest
                readings say where "empty" and "full" are *for that hull*.
                Above VESSEL_DRAUGHT_LADEN_RATIO of the observed maximum is
                called laden, below VESSEL_DRAUGHT_BALLAST_RATIO is called
                ballast, and the wide gap between the two is left `unknown`
                rather than guessing which side a partial cargo falls on. This
                is a judgement, not arithmetic on a single broadcast value, so
                it is **inferred** -- and every number that went into it
                (current draught, observed max/min, sample count, both ratios)
                travels with the verdict so a reader can disagree with it.

**Why this reads entity_history incrementally, like port_calls.py.** Same
table, same 11 GB, same rule: a scheduled refine job may read it, but never in
one pass. A high-water mark -- the newest entity_history id this job has
already looked at -- is kept in reference_snapshots under
"vessel_profile_cursor", exactly as port_calls.py keeps its own. See
entity_history_since in backend/storage.py.

**Why the draught series lives in a persisted accumulator rather than a fresh
scan each pass.** entity_history only gains a row for "ais" when a hull's
*position* changes (see record_snapshot in backend/storage.py) -- draught is
carried on that row's payload, not on a row of its own. A hull sitting
alongside a quay taking on cargo can go hours without a qualifying movement, so
"the draught series" is necessarily sparser than "everything the crew ever
typed into MaximumStaticDraught" -- this module accepts that honestly rather
than pretending to a finer-grained series entity_history cannot supply. The
accumulator ("vessel_profile_state") carries, per hull: every *distinct*
draught value seen and when it was last seen, the most recent ship_type and
destination strings, and when the hull was last touched at all. Samples older
than config.HISTORY_RETENTION_SECONDS are dropped every pass (apply_history),
which is what keeps "observed max/min" answering "over the retained window"
rather than "ever, for as long as this container has been running" -- the
window this module reasons over is the same one entity_history itself keeps.

**Two rulings the brief left to this module, stated rather than left silent:**

  - A hull with plenty of position reports but no static draught ever decoded
    (common -- draught is broadcast far less often than a position) has zero
    entries in its own accumulator. That is indistinguishable, on purpose,
    from a hull with fewer than VESSEL_DRAUGHT_MIN_SAMPLES readings: both
    report laden_state "unknown", reason "insufficient_samples". Its cargo
    class is unaffected -- that comes from ship_type, not draught, and a hull
    that has decoded a static block at all usually has both.
  - The cap keeps the most recently *seen* 20,000 hulls, not the 20,000 with
    the most evidence: a hull is evicted by staleness (oldest `last_seen`
    first, see _evict_lru), not by how thin its draught series is. A
    thinly-sampled but currently-active hull stays; a well-sampled hull nobody
    has heard from in weeks does not -- matching what every other stale-entity
    rule in this codebase already does (see ENTITY_STALE_AFTER).

**Why the last port call is looked up per hull rather than in bulk.** Task 15's
storage.port_calls_for(mmsi, limit) is the only interface this codebase has for
"a hull's most recent port call", and there is no bulk equivalent -- see the
module docstring on backend/refine/port_calls.py. Fetched concurrently
(asyncio.gather) for every hull touched *this pass*, not the whole 20,000-hull
population, which is what keeps the fan-out proportional to genuinely new AIS
traffic. The result is cached on the accumulator entry itself
(last_port_label/last_port_country), not only on the built profile -- see the
next paragraph for why that cache has to survive a pass where the hull isn't
touched. VESSEL_PROFILE_INTERVAL is slower than port_calls' own 15 minutes for
the same reason the lookup is per-hull rather than bulk.

**Why build_profile reruns for every hull in the accumulator, not only the
ones a pass touched.** A hull that goes dark -- transponder off, sanctions
evasion, simply out of range -- stops appearing in `touched`, but
apply_history keeps pruning *its* samples on every later pass regardless (see
above): the evidence keeps eroding whether or not anyone is watching. Rerunning
build_profile for the whole accumulator each pass is what lets laden_state and
draught_current decay to insufficient_samples/None along with that evidence,
instead of freezing at the hull's last confident verdict for as long as it
survives the 20,000-hull cap -- which, on quiet unique-hull traffic, is not
bounded in time at all. This costs nothing beyond CPU: build_profile is pure,
the port-call lookup it needs is read from the cache the paragraph above
describes rather than re-fetched, and storage.record_reference below was
already writing the whole profiles document on every pass regardless of how
much of it actually changed.

**Why record_reference's writes are not verified before the cursor advances,
unlike port_calls.record_port_calls.** That distinction is deliberate, not an
oversight: port_calls' rows are unique historical events entity_history will
never offer twice (it is pruned at three days), so a lost write is a lost
fact. A vessel profile is a recomputed summary, not an event -- if this pass's
write is dropped by a Postgres hiccup, the next pass overwrites the same
document with fresher numbers anyway, the same trade-off port_calls.py itself
makes for *its own* state and cursor writes, as opposed to the
vessel_port_calls rows record_port_calls actually verifies.
"""

import asyncio
import copy
import logging

from backend import config, infrastructure, storage
from backend.refine import _cursor

log = logging.getLogger("osint-globe.vessel_profile")

CURSOR_NAME = "vessel_profile_cursor"
STATE_NAME = "vessel_profile_state"
PROFILES_NAME = "vessel_profiles"
HEALTH_NAME = "vessel_profiles"

# Bump this whenever vessel_profile_state's own on-disk shape changes -- see
# backend/refine/_cursor.py's load_state and port_calls.py's own identical
# comment (Task 52), which this mirrors exactly: every vessel_profile_state
# document on disk before this change is a bare {mmsi: entry} map with no
# "schema_version" key, which _cursor.load_state treats as version 1 by
# default. This change wraps that map under its own "entities" key alongside
# the version stamp -- a bare top-level "schema_version" key would otherwise
# collide with a real mmsi, since every other top-level key in this document
# is read as one (see apply_history/_evict_lru). Version 2 is deliberately
# the *first* version this deploy expects, so that wrapping change is itself
# what this guard visibly (logged, not silent) recovers from on rollout.
# Bump again, past 2, whenever a *later* shape change happens to the
# per-hull accumulator entry shape inside "entities".
STATE_SCHEMA_VERSION = 2

# Rows read from entity_history per pass. Same figure and the same reasoning as
# port_calls.BATCH_LIMIT: bounded so a job that has fallen behind (a restart, a
# first run against pre-existing history) catches up over several passes
# instead of one pass turning into a scan of whatever backlog piled up.
BATCH_LIMIT = 200_000

# The most recently seen hulls this module keeps a profile for. Bounded
# because a hull AIS has ever reported through would otherwise sit in this
# document forever -- global AIS traffic runs to hundreds of thousands of
# distinct MMSIs over any long enough window, and the ones nobody has heard
# from in weeks are not "profiles" a reader can act on, they are dead weight.
# Evicted by staleness (oldest last_seen first), not by sample count -- see
# the module docstring's second ruling.
HULL_CAP = 20_000


# --- cargo class: deterministic, from the AIS ship-type code alone ----------
#
# ITU-R M.1371-5, Annex 8, Table 50 ("Ship type"), the same code aisstream
# forwards verbatim as ShipStaticData.Type (see backend/sources/ais.py). The
# table's own last digit distinguishes hazard/pollutant category within a
# range (x1..x4 = IMO hazard categories X-OS, x9 = "carrying dangerous goods,
# no further detail") -- nothing this module reads, because that digit says
# whether *something* dangerous is aboard, never what: turning it into "crude"
# vs "chemical" vs "LNG" would be exactly the invented commodity this module
# exists not to produce. Only the leading range is used.
_TUG_CODES = frozenset({31, 32, 52})  # 31/32 = towing, 52 = tug: the same function, different tonnage


def cargo_class(ship_type) -> str | None:
    """One of tanker/cargo/fishing/passenger/tug/naval/other, or None if
    `ship_type` was never decoded for this hull at all -- which is a different
    claim from "other" (a code AIS *did* send that this table has no sharper
    bucket for, e.g. 0 "not available", 36 "sailing", 51 "search and rescue")."""
    if not isinstance(ship_type, int) or isinstance(ship_type, bool):
        return None
    if ship_type in _TUG_CODES:
        return "tug"
    if ship_type == 30:
        return "fishing"
    if ship_type == 35:  # "Military ops"
        return "naval"
    if 60 <= ship_type <= 69:
        return "passenger"
    if 70 <= ship_type <= 79:
        return "cargo"
    if 80 <= ship_type <= 89:
        return "tanker"
    return "other"


# --- laden / ballast: inferred, from this hull's own draught history --------


def laden_state(current: float | None, max_seen: float | None, sample_count: int) -> tuple[str, str | None]:
    """(verdict, reason). verdict is laden/ballast/unknown; reason is only set
    for the one case the brief names explicitly, so a card can print it
    verbatim rather than reconstruct it from the numbers."""
    if sample_count < config.VESSEL_DRAUGHT_MIN_SAMPLES or current is None or not max_seen:
        return "unknown", "insufficient_samples"
    ratio = current / max_seen
    if ratio > config.VESSEL_DRAUGHT_LADEN_RATIO:
        return "laden", None
    if ratio < config.VESSEL_DRAUGHT_BALLAST_RATIO:
        return "ballast", None
    return "unknown", None


# --- implied trade: a sentence, never a commodity ----------------------------


def implied_trade_sentence(destination: str | None, last_port_label: str | None, last_port_country: str | None) -> str:
    """Every input the sentence rests on is visible in the sentence itself --
    a reader should never have to trust a verdict they cannot see the working
    for. Deliberately says "no commodity is asserted" in the sentence itself,
    not only in the surrounding card, so this claim holds even read on its own."""
    if last_port_label:
        port_part = f"last port call was {last_port_label}"
        if last_port_country:
            port_part += f", {last_port_country}"
    else:
        port_part = "no recorded port call"
    dest_part = f'declared destination is "{destination}"' if destination else "no declared destination broadcast"
    return (
        f"Implied only from AIS, not a cargo manifest: {port_part}; {dest_part}. "
        f"No commodity is asserted."
    )


# --- the draught/ship-type accumulator ---------------------------------------


def _draught_m(payload: dict) -> float | None:
    draught = payload.get("draught")
    return float(draught) if isinstance(draught, (int, float)) and not isinstance(draught, bool) else None


def _ship_type_code(payload: dict) -> int | None:
    value = payload.get("ship_type")
    return int(value) if isinstance(value, int) and not isinstance(value, bool) else None


def _destination(payload: dict) -> str | None:
    value = payload.get("destination")
    return value if isinstance(value, str) and value.strip() else None


def _draught_key(value: float) -> str:
    # entity_history's draught arrives already rounded to ais.py's own 0.1m
    # resolution, so this key formatting doesn't invent precision -- it only
    # guarantees samples that were already the same reading collapse to the
    # same dict key, however JSON round-tripped the float.
    return f"{value:.1f}"


def apply_history(rows: list[dict], state: dict, now_ts: float) -> tuple[dict, set[str]]:
    """One batch of entity_history rows (oldest first, as entity_history_since
    returns them) -> (the state to persist for next time, which hulls this
    batch actually touched).

    Pure and DB-free -- `state` is a plain {mmsi: entry} dict, not a live
    connection, which is what makes this testable without a database. This is
    the unwrapped shape "vessel_profile_state" actually persists under its
    own "entities" key alongside a "schema_version" stamp -- see _load_state
    and STATE_SCHEMA_VERSION's own comment -- so apply_history itself, and
    every existing test of it, never has to know that wrapper exists. The
    input `state` is never
    mutated, matching apply_positions in port_calls.py and for the same
    reason: a caller retrying a batch on `state` it already holds must get an
    independent result, not one built on an entry an earlier attempt already
    changed in place.
    """
    new_state = copy.deepcopy(state)
    touched: set[str] = set()
    for row in rows:
        mmsi = str(row["entity_id"])
        payload = row.get("payload") or {}
        ts = row["ts"]
        entry = new_state.setdefault(mmsi, {"samples": {}})
        entry["last_seen"] = ts
        draught = _draught_m(payload)
        if draught is not None:
            entry["samples"][_draught_key(draught)] = ts
            # The newest reading is "current" regardless of whether it also
            # widened the observed range -- a hull riding at its long-standing
            # maximum is still reporting a current draught, not a new one.
            entry["current_draught"] = draught
            entry["current_ts"] = ts
        ship_type = _ship_type_code(payload)
        if ship_type is not None:
            entry["ship_type"] = ship_type
        destination = _destination(payload)
        if destination is not None:
            entry["destination"] = destination
        touched.add(mmsi)

    # Age samples out of every hull's series, not only the ones this batch
    # touched -- a hull that has gone quiet still has its old extremes fall
    # out of "the retained window" as time passes, exactly as entity_history's
    # own retention sweep would if this module re-read it from scratch.
    cutoff = now_ts - config.HISTORY_RETENTION_SECONDS
    for entry in new_state.values():
        entry["samples"] = {value: ts for value, ts in entry["samples"].items() if ts >= cutoff}

    return new_state, touched


def _evict_lru(state: dict, cap: int) -> dict:
    """Keeps the `cap` most recently seen hulls -- see the module docstring's
    second ruling on why staleness, not sample count, decides who is dropped."""
    if len(state) <= cap:
        return state
    ranked = sorted(state.items(), key=lambda kv: kv[1].get("last_seen", 0.0), reverse=True)
    return dict(ranked[:cap])


def build_profile(
    mmsi: str,
    entry: dict,
    last_port_label: str | None,
    last_port_country: str | None,
    now: float,
) -> dict:
    """One hull's accumulator entry -> the record vessel_profiles stores for it.

    Pure -- takes the port lookup's answer rather than doing it, so this (and
    every branch of cargo_class/laden_state it calls) is testable without a
    database. See run_once for where the port lookup itself happens.
    """
    samples = entry.get("samples", {})
    sample_count = len(samples)
    values = [float(v) for v in samples]
    max_seen = max(values) if values else None
    min_seen = min(values) if values else None
    current = entry.get("current_draught")
    current_ts = entry.get("current_ts")
    # A reading older than the retained window is not "current" any more --
    # apply_history already ages it out of `samples`, and reporting the stale
    # number here anyway (even under an honest "insufficient_samples" verdict)
    # would still read as a live measurement to anyone who only looked at the
    # field, not the reason.
    if current is not None and (current_ts is None or now - current_ts > config.HISTORY_RETENTION_SECONDS):
        current = None
    verdict, reason = laden_state(current, max_seen, sample_count)
    ship_type = entry.get("ship_type")
    cclass = cargo_class(ship_type)
    return {
        "mmsi": mmsi,
        "ship_type": ship_type,
        "cargo_class": cclass,
        "cargo_class_basis": "derived" if cclass is not None else None,
        "laden_state": verdict,
        "laden_state_basis": "inferred",
        "laden_state_reason": reason,
        # Field names match the brief's own wording (draught_max_seen,
        # draught_min_seen, sample_count) rather than this module's usual "_m"
        # suffix, since this is the record Task 17's card reads directly.
        "draught_current": current,
        "draught_max_seen": max_seen,
        "draught_min_seen": min_seen,
        "sample_count": sample_count,
        "laden_threshold": config.VESSEL_DRAUGHT_LADEN_RATIO,
        "ballast_threshold": config.VESSEL_DRAUGHT_BALLAST_RATIO,
        "min_sample_threshold": config.VESSEL_DRAUGHT_MIN_SAMPLES,
        "implied_trade": implied_trade_sentence(entry.get("destination"), last_port_label, last_port_country),
        "inferred": True,
        "updated": now,
    }


# --- storage plumbing ---------------------------------------------------------


async def _load_state() -> dict:
    """vessel_profile_state's own {mmsi: entry} accumulator, or {} if there
    is none yet or the stored shape does not match STATE_SCHEMA_VERSION --
    see _cursor.load_state and this module's own STATE_SCHEMA_VERSION
    comment. The document on disk wraps that flat map under its own
    "entities" key, alongside the version stamp; unwrapped back here so
    apply_history/_evict_lru/build_profile (and every existing test of them)
    keep operating on the same plain {mmsi: entry} dict they always have."""
    doc = await _cursor.load_state(storage, STATE_NAME, STATE_SCHEMA_VERSION, job_name="vessel_profile")
    entities = doc.get("entities")
    return entities if isinstance(entities, dict) else {}


async def _load_port_labels() -> dict:
    """Every port this map knows of, keyed by id, for turning a
    vessel_port_calls row's bare port_id back into a name and (for a World
    Port Index entry) a country.

    Deliberately not dark_vessels.port_index: that helper builds a
    ProximityIndex for nearest-point search, and all this needs is a dict
    lookup by the id port_calls.py already resolved -- building a second
    spatial index just to throw the lookup-by-distance half of it away would
    be wasted work every pass. The two source lists are the same ones that
    function combines (see its own docstring): the curated harbours in
    backend/infrastructure.py, which carry no country field, and the World
    Port Index rows backend/sources/ports.py stores, which do.
    """
    wpi_ports = await storage.entity_latest("ports")
    curated = [s for s in infrastructure.INFRA_SITES if s.get("type") == "port"]
    by_id = {}
    for port in curated + list(wpi_ports or []):
        port_id = str(port.get("id") or port.get("name") or "")
        if port_id:
            by_id[port_id] = port
    return by_id


async def _refresh_port_label(mmsi: str, entry: dict, port_labels: dict) -> None:
    """Mutates `entry` in place with the freshest last-port name/country this
    pass can resolve, cached on the accumulator entry itself (not just the
    built profile) so a later pass can rebuild a full profile for this hull
    -- see run_once -- without re-querying storage.port_calls_for for a hull
    it did not touch this time. Only ever called for hulls touched this pass;
    see the module docstring on why the lookup itself is bounded that way.
    """
    last_calls = await storage.port_calls_for(mmsi, limit=1)
    last_call = last_calls[0] if last_calls else None
    label, country = None, None
    if last_call:
        port = port_labels.get(str(last_call.get("port_id")))
        label = (port or {}).get("name") or (port or {}).get("id") or last_call.get("port_id")
        country = (port or {}).get("country")
    entry["last_port_label"] = label
    entry["last_port_country"] = country


async def run_once() -> dict:
    """One incremental pass. Returns a small summary for logging and health.

    See the module docstring for why the cursor advances unconditionally here,
    unlike port_calls.run_once's write-verified advance.
    """
    cursor = await _cursor.load_cursor(storage, CURSOR_NAME)
    rows = await storage.entity_history_since("ais", cursor, BATCH_LIMIT)
    if not rows:
        return {"read": 0, "touched": 0, "profiles": 0, "ok": True}

    state = await _load_state()
    # The newest row's own timestamp, not time.time(): apply_history's sample
    # pruning and build_profile's "is this reading still current" check both
    # have to reason about the same clock, or a job catching up on backlog
    # would prune samples against AIS time while separately expiring
    # `current` against wall-clock time -- two different windows agreeing by
    # coincidence on a live feed and disagreeing the moment this job falls
    # behind, which is exactly when a reader most needs the two to agree.
    now = rows[-1]["ts"]
    new_state, touched = apply_history(rows, state, now)
    new_state = _evict_lru(new_state, HULL_CAP)
    # A hull evicted the same pass it was touched gets no fresher port lookup
    # -- there is nowhere durable left on the accumulator to cache it.
    touched &= new_state.keys()

    port_labels = await _load_port_labels()
    await asyncio.gather(
        *(_refresh_port_label(mmsi, new_state[mmsi], port_labels) for mmsi in touched)
    )

    # Rebuilt for *every* hull the accumulator still holds, not only the ones
    # this pass touched. apply_history prunes every entry's samples on every
    # pass regardless of who reported this time (see its own comment), so a
    # hull that has gone dark keeps losing evidence pass after pass whether or
    # not build_profile ever runs again for it -- rerunning it here is what
    # lets a stale laden_state decay to insufficient_samples along with the
    # samples themselves, instead of freezing at its last confident verdict
    # for as long as the hull stays under the 20,000-hull cap. This is pure
    # dict-comprehension work over data already in memory -- no new I/O -- so
    # doing it for the full accumulator each pass costs nothing beyond what
    # storage.record_reference below was already going to write regardless.
    profiles = {
        mmsi: build_profile(mmsi, entry, entry.get("last_port_label"), entry.get("last_port_country"), now)
        for mmsi, entry in new_state.items()
    }

    await storage.record_reference(
        STATE_NAME, {"schema_version": STATE_SCHEMA_VERSION, "entities": new_state},
    )
    await storage.record_reference(PROFILES_NAME, profiles)
    # Unlike STATE_NAME/PROFILES_NAME above -- deliberately unverified, see
    # this function's own docstring -- the cursor write's bool is not safe to
    # discard (pre-merge review, Also fix 1). A dropped cursor write is
    # harmless to the *data* here (apply_history/build_profile are idempotent
    # under replay, so reprocessing the same rows next pass just recomputes
    # the same numbers), but reporting "ok": True regardless meant
    # source_health stayed green while this job silently reprocessed the same
    # backlog forever, never actually advancing -- a real defect even though
    # it is a health-reporting one rather than a data-loss one.
    cursor_ok = await _cursor.advance_cursor(storage, CURSOR_NAME, rows[-1]["id"])

    return {"read": len(rows), "touched": len(touched), "profiles": len(profiles), "ok": cursor_ok}


async def derive_forever():
    """The vessel-profile derivation, for the life of the refine process.

    A plain interval, like port_calls' own -- nothing about a draught-history
    inference is made more correct by retrying faster after a failure, so
    there is no shortened backoff to reach for.
    """
    while True:
        try:
            summary = await run_once()
            if summary["ok"]:
                log.info(
                    "Vessel profiles: read %d AIS movement rows, %d hull(s) reported this "
                    "pass, %d profile(s) held",
                    summary["read"], summary["touched"], summary["profiles"],
                )
                await storage.record_source_health(HEALTH_NAME, summary["profiles"], True)
            else:
                # run_once's data itself is fine here -- see its own docstring
                # on why STATE_NAME/PROFILES_NAME are unverified by design --
                # it is only the cursor write that failed (pre-merge review,
                # Also fix 1). Reported red anyway: a cursor that never
                # advances means this job silently reprocesses the same
                # backlog every pass, which source_health has to be able to
                # show rather than read as a quiet, healthy no-op.
                log.warning(
                    "Vessel profiles: read %d AIS movement rows but the cursor write "
                    "failed -- the same batch will be re-read next pass",
                    summary["read"],
                )
                await storage.record_source_health(
                    HEALTH_NAME, None, False,
                    "the cursor write failed; the same rows will be re-read next pass",
                )
        except Exception as exc:  # noqa: BLE001 - keep the loop alive
            log.warning("Vessel profile derivation failed: %s", exc)
            await storage.record_source_health(HEALTH_NAME, None, False, str(exc))
        await asyncio.sleep(config.VESSEL_PROFILE_INTERVAL)
