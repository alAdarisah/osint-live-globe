"""Shared plumbing for refine jobs that walk entity_history through an
ever-advancing id cursor, and/or persist a shape-versioned accumulator across
passes.

**The incident this exists to prevent.** A refine job's persisted state
document changed shape mid-plan. The rows already on disk had no matching
key, so the job's own apply_* function -- a plain dict setdefault -- handed
back the *old-shaped* entry, and the very next mutation of it raised
KeyError. backend/refine/__init__.py's run_job caught the exception -- the
process survived, source_health went red honestly -- but the cursor never
advanced and no document was ever written again: a silent, permanent
crash-loop with no automatic recovery. It was caught only because someone
happened to be running that job by hand.

backend/refine/jam_crosscheck.py's own STATE_SCHEMA_VERSION (see that
module's "State-shape tolerance" docstring section) is the worked example
this module generalises: an integer stamped on every state write, checked on
load, and a mismatch discards the stored state and rebuilds rather than
raising. jam_crosscheck.py keeps its own local, hand-rolled copy rather than
being migrated onto this module -- its state document is a fixed set of
named top-level fields ("schema_version" sits alongside "tracking_since",
"last", "cells" with no risk of colliding with anything else in the
document), already shipped, already reviewed, and every document currently
in production already carries that stamp. Touching working, already-reviewed
code for no functional gain is exactly the kind of risk Task 52's own brief
warns against.

port_calls.py, flight_legs.py, vessel_profile.py and lane_density.py's own
chokepoint_state had no such guard at all before this change -- this module
gives all four the identical protection jam_crosscheck.py already has,
without re-deriving it a fourth and fifth time. See each of those modules'
own STATE_SCHEMA_VERSION comment for why its starting version number is 1 or
2 -- that is a per-job judgement about whether adopting this guard is itself
a breaking change to what is already on disk, not a fact this module can
know on a caller's behalf.

**What is NOT here, on purpose.** Each job's own run_once decides *when* to
advance its cursor -- which writes have to land first, durably, and in what
order, before it is safe to move the high-water mark past a batch. That
ordering is bespoke per job, not shared: port_calls.py/flight_legs.py gate
the cursor on a state write that is itself gated on a durable event-row
write; lane_density.py gates it on two writes ordered idempotent-first,
non-idempotent-last (see that module's own run_once docstring); vessel_profile
advances unconditionally because its accumulator is safe to replay under a
retry. Three of those five orderings exist *because* an earlier review caught
this codebase getting the naive version wrong (pre-merge review, Critical, in
both port_calls.py and flight_legs.py) -- lane_density.py's own run_once
docstring notes explicitly that extracting a shared cursor module was
considered and ruled out of scope for that earlier fix, for exactly this
reason. Collapsing that already-hard-won, per-job ordering into one shared
"advance past this batch, gated on ..." call would either have to reduce to
the same bool-gating each job already writes out longhand at its own call
site, or hide a decision a future reader has to be able to see to reason
about correctly. So this module only extracts the two pieces that are
byte-for-byte identical across every job with no job-specific reasoning
attached at all: reading a cursor back, and writing one down. *Where* to call
them from, and what has to be true first, stays each job's own run_once --
unchanged by this module.

**Why every function here takes the storage module as its first argument,
rather than importing `backend.storage` itself.** Every job's own test suite
drives run_once() against a small in-memory fake by doing
`monkeypatch.setattr(pc, "storage", fake)` -- rebinding *that module's own*
"storage" name, not the real backend.storage module. If this module imported
`backend.storage` directly, a job's run_once calling into it would silently
bypass every test's fake and hit the real (unconfigured, poolless) module
instead. Accepting the caller's own already-monkeypatchable `storage`
reference as a parameter keeps every existing test's patching style working
unchanged.
"""

import logging

log = logging.getLogger("osint-globe.refine")

# The version an accumulator predating this mechanism entirely -- one written
# before its own job ever stamped a "schema_version" field at all -- is
# treated as. Whether that is safe for a given caller (i.e. whether whatever
# shape is already on disk really *is* equivalent to that caller's own
# version 1) is that caller's own judgement, made once, in its own
# STATE_SCHEMA_VERSION comment -- see the module docstring.
_UNVERSIONED = 1


async def load_cursor(storage_mod, name: str) -> int:
    """The entity_history id this job's cursor (`name`, a reference_snapshots
    key) has already advanced past -- 0 if there is no cursor yet, which is
    this job's very first pass ever. Identical across every refine job that
    walks entity_history incrementally; see port_calls.py's own module
    docstring for the fullest statement of why (~11GB table, never scanned
    whole on a schedule)."""
    doc = await storage_mod.reference(name)
    return int(doc["last_id"]) if isinstance(doc, dict) and isinstance(doc.get("last_id"), (int, float)) else 0


async def advance_cursor(storage_mod, name: str, last_id) -> bool:
    """Durably persist `last_id` as this job's new high-water mark. Returns
    whether the write landed (storage.record_reference's own bool) --
    callers decide for themselves whether, and when, it is safe to call this
    at all; see this module's own docstring on why that gating stays at each
    job's own call site rather than living here."""
    return await storage_mod.record_reference(name, {"last_id": last_id})


async def load_state(storage_mod, name: str, schema_version: int, *, job_name: str) -> dict:
    """The last durably-written state document under `name` (a
    reference_snapshots key), or {} if there is none yet -- or if the one
    stored there does not match `schema_version`.

    A document with no "schema_version" field at all is treated as version 1
    (see _UNVERSIONED). Checked by integer equality against a version each
    caller stamps onto its own state on every write, not by sniffing for one
    particular key a future shape might not even have -- the point of the
    constant, not the key, is that the same guard keeps working after the
    *next* shape change too, not just whichever one motivated adding it.

    A mismatch is discarded and rebuilt from {} instead, exactly like
    jam_crosscheck.py's own _load_state (see the module docstring): logged at
    warning level, a visible reset, never a silent one, and never a raise.
    What is on disk after a reset is treated exactly like "no state at all
    yet", which every one of this module's callers already knows how to
    rebuild from -- a rolling window plus whatever new rows this and future
    passes supply, not a full replay: this function never touches the job's
    own cursor, so nothing already durably-processed through entity_history
    is re-read (see the module docstring on why that ordering is not this
    module's to make -- but every caller's run_once already keeps the
    cursor and the state write it gates on separate, so a reset here cannot
    rewind one).
    """
    doc = await storage_mod.reference(name)
    if not isinstance(doc, dict):
        return {}
    stored_version = doc.get("schema_version", _UNVERSIONED)
    if stored_version != schema_version:
        log.warning(
            "%s: stored %r is schema_version=%r, this build expects %r -- discarding it and "
            "rebuilding from an empty state rather than crash on an incompatible shape. The "
            "job's own cursor is untouched, so nothing already durably processed is replayed "
            "-- only this state document's own accumulated window is lost, and every job this "
            "guard protects is designed to rebuild that cheaply from here.",
            job_name, name, stored_version, schema_version,
        )
        return {}
    return doc
