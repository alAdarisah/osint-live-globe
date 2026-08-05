"""Military role inference from an aircraft type description.

The failure this pins: role came only from a list of famous nicknames, so 216
of 311 military aircraft in a live window (69%) matched nothing and drew one
generic plane glyph -- including 73 T-6 Texans and 14 C-12 Hurons. The
designator itself says what the aircraft is for, and it was being ignored.
"""

from backend.sources.adsb import _infer_military_role as role


# --- the Mission Design Series designator ----------------------------------

def test_the_basic_mission_letter_names_the_role():
    assert role("Raytheon T-6A Texan II") == "trainer"
    assert role("Northrop F-5N Tiger II") == "fighter"
    assert role("Beech C-12U Huron") == "transport"
    assert role("Boeing B-52H Stratofortress") == "bomber"
    assert role("Lockheed P-3C Orion") == "patrol"
    assert role("Grumman E-2D Hawkeye") == "awacs"


def test_a_modifier_letter_beats_the_basic_mission():
    """A KC-46 is a tanker first and a cargo airframe second, and that is the
    fact a reader wants off the glyph."""
    assert role("Boeing KC-46A Pegasus") == "tanker"
    assert role("Boeing RC-135S Cobra Ball") == "recon"
    assert role("Gulfstream Aerospace C-37B") == "transport"


def test_the_vehicle_type_letter_wins_outright():
    """It describes the airframe rather than the job: an MH-60 is a helicopter
    whichever mission the M stands for."""
    assert role("Sikorsky MH-60R Seahawk") == "helicopter"
    assert role("Boeing CH-47F Chinook") == "helicopter"
    assert role("General Atomics MQ-9 Reaper") == "drone"


def test_a_search_and_rescue_modifier_falls_through_to_the_airframe():
    """An HC-130J is a C-130 doing rescue work, and there is no rescue glyph --
    "transport" is what a reader actually sees."""
    assert role("Lockheed Martin HC-130J Combat King II") == "transport"


# --- what must NOT parse ----------------------------------------------------

def test_airliner_model_numbers_are_never_read_as_designators():
    """The regression this exists to prevent: "AIRBUS A-320" parsed as an
    attack aircraft and drew an airliner as a fighter. The A prefix is in
    neither MDS table for exactly this reason."""
    assert role("AIRBUS A-320") is None
    assert role("AIRBUS A-321") is None
    assert role("AIRBUS A-350-900") is None


def test_ambiguous_nicknames_do_not_override_the_airframe():
    """"Falcon" is an F-16 and a Dassault business jet; "Viper" is an F-16 and
    an attack helicopter. A name match runs before the designator parser, so an
    ambiguous one silently overrules the letter that would have been right."""
    assert role("DASSAULT Falcon 900") is None
    assert role("DASSAULT Falcon 2000") is None
    assert role("Bell AH-1Z Viper") == "helicopter"
    # The fighters those names were added for are unaffected -- the designator
    # carries them on its own.
    assert role("Lockheed Martin F-16C Fighting Falcon") == "fighter"
    assert role("Lockheed Martin F-35A Lightning II") == "fighter"


def test_civil_designators_that_merely_look_like_mds_are_rejected():
    """AW-119, BD-700, CL-415 and MD-900 all have the shape of a designator and
    none of them are one. Reading them would be worse than saying nothing."""
    assert role("BOMBARDIER BD-700 Global 5000/5500") is None
    assert role("CANADAIR CL-415 SuperScooper") is None
    assert role("LEARJET 35") is None
    assert role("CESSNA 560 Citation Ultra") is None


def test_no_description_yields_no_role():
    assert role(None) is None
    assert role("") is None


# --- names still win, and they cover what the parser cannot ----------------

def test_a_known_name_is_matched_before_the_designator_is_parsed():
    # A-10's designator letter is deliberately unparseable, so the name is the
    # only route -- and it has to work.
    assert role("Fairchild A-10C Thunderbolt II") == "fighter"
    assert role("AIRBUS A-400M") == "transport"


def test_rotorcraft_families_with_no_mds_designator_are_still_helicopters():
    assert role("AGUSTA AW-119 Koala") == "helicopter"
    assert role("AGUSTAWESTLAND AW-159 Super Lynx") == "helicopter"
    assert role("MCDONNELL-DOUGLAS MD-900 Explorer") == "helicopter"


def test_trainers_are_recognised_by_name_as_well_as_by_designator():
    assert role("EMBRAER EMB-312 Tucano") == "trainer"
    assert role("BRITISH AEROSPACE T-45 Goshawk") == "trainer"


# --- the ADS-B category fallback -------------------------------------------

def test_emitter_category_8_is_a_helicopter_when_nothing_else_is_known():
    """Broadcast by the aircraft itself. Last rather than first because it is
    coarse -- it separates rotorcraft from everything else and says no more."""
    assert role(None, 8) == "helicopter"
    assert role("", 8) == "helicopter"


def test_the_category_never_overrides_a_described_type():
    assert role("Boeing KC-46A Pegasus", 8) == "tanker"


def test_other_categories_add_nothing():
    assert role(None, 4) is None
    assert role(None, 0) is None
    assert role(None, None) is None
