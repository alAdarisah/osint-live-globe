"""The three distance thresholds that turn "how far from a charted port" into
a port_calls confidence tier -- exact / proximity / inferred.

A leaf module on purpose: refine/port_calls.py (the job that applies these)
imports backend.sources.dark_vessels and backend.sources.proximity for its
own detection work, and backend/app.py needs these same three numbers to
tell a reader what a stored `confidence` value actually means in kilometres
(vessel_port_calls keeps only the tier, never the distance that produced
it -- see port_calls.py's _classify). Importing port_calls.py itself from the
request-serving API process would drag that ingest-side machinery along for
the ride just to read three floats that do not change on their own. This
module imports nothing but the language itself, so both sides can import it
without either dragging the other's dependencies in, and a threshold changed
here is a threshold changed everywhere it is used -- no second copy to
remember, no drift between what the classifier scored and what a card claims
it means.
"""

# Inside this of a charted port point, the attribution is as good as AIS gets:
# not "confirmed alongside" (see port_calls.py's module docstring), but not a
# guess either.
PORT_EXACT_RADIUS_KM = 3.0

# Out to here still counts as "in port" -- an outer anchorage, an approach
# channel, a lightering area against the port's own works -- but the charted
# point is no longer where the dwell actually is, so a card has to say
# "near", not "at".
PORT_PROXIMITY_RADIUS_KM = 15.0

# Past the proximity radius, a dwell is still attributed to whichever port is
# nearest -- confidence "inferred" -- but only out to here.
#
# The brief that specified port_calls.py places no ceiling on "inferred": it
# treats recording the distance and leaving the card to state it as guard
# enough on its own. port_calls.py adds one anyway (a ruling, not an
# oversight -- flagged in that task's own report): unbounded attribution
# would record a vessel anchored mid-ocean as *calling* at a port hundreds of
# km away, which is a stronger and less honest claim than "we could not
# attribute this" would be.
#
# That makes the cap a real trade-off, not a formality, because the index
# behind `ports` is not exhaustive: dark_vessels.port_index carries 393 ports
# across the map's watched theatres (40 curated plus the NGA World Port
# Index, clipped -- see that function's own docstring), not every port on
# earth. A dwell can land outside this radius because the port it is actually
# near simply is not in either list -- not because nothing is there. That
# failure mode is made visible rather than silent in port_calls.py: every
# rejection is counted (see `rejected` in _advance/apply_positions) and
# carried into that job's own source_health row and log line, so "nothing
# happened near a port" and "we saw a dwell we could not attribute" stay
# distinguishable from outside that module.
PORT_SEARCH_RADIUS_KM = 50.0
