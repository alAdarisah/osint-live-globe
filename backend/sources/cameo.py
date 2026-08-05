"""CAMEO: the coding scheme GDELT applies to every article, rendered readable.

GDELT does not publish headlines -- it publishes a verb code and two actor
slots. Turning "1831 / ISRAELI / JOURNALIST" into a sentence a reader can parse
is what this module does, and it now has two callers rather than one:
event_fusion.py renders the violent codes (roots 18-20) onto conflict pins, and
officials.py renders the diplomatic ones (roots 01-17) onto the Officials &
Diplomacy layer. Keeping the tables inside event_fusion would mean a sibling
poller importing the fusion pipeline for a lookup dict.

Everything here is a *rendering* of structured fields, never a new claim. The
phrasing is deliberately plain and hedged nowhere: the hedging belongs in the
provenance line the frontend prints underneath, which states that the whole
thing is machine-coded from one article. Softening every verb here instead
would make thirty pins unreadable to express one fact once.
"""

# CAMEO's 20 top-level event root codes. The coarsest available description,
# and the only one guaranteed present -- a row with no scraped headline still
# has this.
ROOT_LABEL = {
    1: "Public statement",
    2: "Appeal",
    3: "Expressed intent to cooperate",
    4: "Consultation",
    5: "Diplomatic cooperation",
    6: "Material cooperation",
    7: "Provided aid",
    8: "Yield / de-escalation",
    9: "Investigation",
    10: "Demand",
    11: "Disapproval",
    12: "Rejection",
    13: "Threat",
    14: "Protest",
    15: "Military mobilization / force posture",
    16: "Reduced relations",
    17: "Coercion",
    18: "Assault",
    19: "Fighting",
    20: "Unconventional mass violence",
}

# CAMEO's full event codes. The root table above collapses roughly 200 codes
# into 20 buckets, which means every airstrike, artillery barrage, siege and
# suicide bombing reads as the single word "Fighting" -- and every summit,
# state visit and signed treaty reads as "Consultation".
#
# Looked up longest-prefix-first, so a 4-digit code falls back to its 3-digit
# parent and then to the root label.
CODE_LABEL = {
    # 01x -- public statement
    "010": "Public statement",
    "011": "Declined to comment",
    "012": "Pessimistic comment",
    "013": "Optimistic comment",
    "014": "Considered policy option",
    "015": "Acknowledged responsibility",
    "016": "Denied responsibility",
    "017": "Engaged in symbolic act",
    "018": "Made an empathetic comment",
    "019": "Expressed accord",
    # 02x -- appeal
    "020": "Appeal",
    "023": "Appeal for material aid",
    "024": "Appeal for political reform",
    "025": "Appeal to yield",
    "026": "Appeal to meet",
    "027": "Appeal to settle a dispute",
    "028": "Appeal for mediation",
    # 03x -- intent to cooperate
    "030": "Expressed intent to cooperate",
    "031": "Intent to engage in material cooperation",
    "033": "Intent to provide aid",
    "035": "Intent to yield",
    "036": "Intent to meet or negotiate",
    "037": "Intent to settle a dispute",
    "038": "Intent to accept mediation",
    "039": "Intent to mediate",
    # 04x -- consultation. The meeting family, and the reason this table exists.
    "040": "Consultation",
    "041": "Phone call",
    "042": "State visit",
    "043": "Hosted a visit",
    "044": "Talks at a third location",
    "045": "Mediation",
    "046": "Negotiations",
    "047": "Diplomatic delegation",
    # 05x -- diplomatic cooperation
    "050": "Diplomatic cooperation",
    "051": "Praise or endorsement",
    "052": "Defended verbally",
    "053": "Rallied support",
    "054": "Granted diplomatic recognition",
    "055": "Apology",
    "056": "Forgave",
    "057": "Signed a formal agreement",
    # 06x/07x -- material cooperation and aid
    "060": "Material cooperation",
    "061": "Economic cooperation",
    "062": "Military cooperation",
    "063": "Judicial cooperation",
    "064": "Intelligence sharing",
    "070": "Provided aid",
    "071": "Provided economic aid",
    "072": "Provided military aid",
    "073": "Provided humanitarian aid",
    "075": "Granted asylum",
    # 08x -- yield / de-escalation
    "080": "Yielded",
    "081": "Eased administrative sanctions",
    "0833": "Lifted economic sanctions",
    "084": "Returned or released",
    "085": "Eased economic sanctions",
    "086": "Allowed international involvement",
    "087": "De-escalated military engagement",
    "0871": "Declared a ceasefire",
    "0874": "Retreated militarily",
    # 09x -- investigation
    "090": "Investigation",
    "092": "Investigated human-rights abuses",
    "093": "Investigated military action",
    # 10x -- demand
    "100": "Demand",
    "101": "Demanded material cooperation",
    "103": "Demanded aid",
    "104": "Demanded political reform",
    "105": "Demanded a yield",
    "106": "Demanded a meeting",
    "107": "Demanded a settlement",
    "108": "Demanded mediation",
    # 11x/12x -- disapproval and rejection
    "110": "Disapproval",
    "111": "Criticised or denounced",
    "112": "Accused",
    "1123": "Accused of war crimes",
    "113": "Rallied opposition against",
    "114": "Complained officially",
    "115": "Brought a lawsuit against",
    "116": "Found guilty",
    "120": "Rejection",
    "121": "Rejected material cooperation",
    "1233": "Rejected aid",
    "125": "Refused to yield",
    "128": "Refused mediation",
    "129": "Vetoed",
    # 13x -- threat
    "130": "Threat",
    "131": "Threatened non-force action",
    "1312": "Threatened economic sanctions",
    "132": "Threatened administrative sanctions",
    "133": "Threatened political dissent",
    "134": "Threatened to halt negotiations",
    "135": "Threatened to halt mediation",
    "137": "Ultimatum",
    "138": "Threatened use of force",
    "1382": "Threatened attack",
    "1385": "Threatened use of unconventional violence",
    # 14x -- protest
    "140": "Protest",
    "141": "Demonstration",
    "143": "Hunger strike",
    "144": "Strike or boycott",
    "145": "Obstruction or blockade",
    "1451": "Violent protest",
    # 15x -- force posture
    "150": "Force posture",
    "151": "Increased police alert",
    "152": "Increased military alert",
    "153": "Mobilised armed forces",
    "154": "Increased military readiness",
    # 16x -- reduced relations
    "160": "Reduced relations",
    "161": "Reduced diplomatic relations",
    "1621": "Reduced or stopped economic aid",
    "1623": "Reduced or stopped humanitarian aid",
    "163": "Imposed an embargo or sanctions",
    "164": "Halted negotiations",
    "165": "Halted mediation",
    "166": "Expelled or deported",
    "1661": "Expelled aid agencies",
    "1663": "Expelled diplomats",
    # 17x -- coercion
    "170": "Coercion",
    "171": "Seized or damaged property",
    "172": "Imposed administrative sanctions",
    "1721": "Imposed a curfew",
    "1722": "Imposed a state of emergency",
    "173": "Arrested or detained",
    "174": "Expelled or deported individuals",
    "175": "Repression",
    # 18x -- assault
    "180": "Unconventional violence",
    "181": "Abduction or hostage-taking",
    "182": "Physical assault",
    "1821": "Sexual assault",
    "1822": "Torture",
    "1823": "Killing",
    "183": "Bombing",
    "1831": "Suicide bombing",
    "1832": "Vehicle bombing",
    "1833": "Roadside bombing",
    "184": "Assassination attempt",
    "185": "Attempted assassination",
    "186": "Assassination",
    # 19x -- conventional force
    "190": "Use of conventional force",
    "191": "Blockade or siege",
    "192": "Occupation of territory",
    "193": "Small-arms fighting",
    "194": "Artillery or armour",
    "195": "Aerial bombardment",
    "196": "Ceasefire violation",
    # 20x -- mass violence
    "200": "Mass violence",
    "201": "Mass expulsion",
    "202": "Mass killing",
    "203": "Ethnic cleansing",
    "204": "Weapons of mass destruction",
}

# The verb phrase that goes between the two actors, keyed the same
# longest-prefix way CODE_LABEL resolves its nouns. This is what turns
#
#     Consultation / Actor 1: RUSSIA / Actor 2: CHINA
#
# -- a taxonomy label and two bare CAMEO actor strings, which says nothing about
# who did what to whom -- into a sentence a reader can actually parse.
CODE_SENTENCE = {
    # 01x
    "010": "issued a statement about",
    "011": "declined to comment on",
    "012": "commented pessimistically on",
    "013": "commented optimistically on",
    "014": "said it was weighing options regarding",
    "015": "accepted responsibility towards",
    "016": "denied responsibility towards",
    "017": "made a symbolic gesture towards",
    "019": "expressed agreement with",
    # 02x
    "020": "appealed to",
    "023": "appealed for material aid from",
    "025": "appealed to yield to",
    "026": "appealed to meet",
    "027": "appealed to settle a dispute with",
    "028": "appealed for mediation with",
    # 03x
    "030": "signalled intent to cooperate with",
    "031": "signalled intent to work materially with",
    "033": "signalled intent to provide aid to",
    "036": "signalled intent to meet",
    "037": "signalled intent to settle a dispute with",
    "039": "offered to mediate between",
    # 04x -- the meeting family
    "040": "consulted with",
    "041": "spoke by phone with",
    "042": "visited",
    "043": "hosted a visit by",
    "044": "held talks at a third location with",
    "045": "mediated between",
    "046": "held negotiations with",
    "047": "sent a diplomatic delegation to",
    # 05x
    "050": "cooperated diplomatically with",
    "051": "praised",
    "052": "defended",
    "053": "rallied support for",
    "054": "granted diplomatic recognition to",
    "055": "apologised to",
    "057": "signed a formal agreement with",
    # 06x/07x
    "060": "cooperated materially with",
    "061": "agreed economic cooperation with",
    "062": "agreed military cooperation with",
    "064": "shared intelligence with",
    "070": "provided aid to",
    "071": "provided economic aid to",
    "072": "provided military aid to",
    "073": "provided humanitarian aid to",
    # 08x
    "080": "yielded to",
    "084": "returned or released",
    "085": "eased economic sanctions on",
    "087": "de-escalated militarily with",
    "0871": "declared a ceasefire with",
    "0874": "withdrew forces facing",
    # 09x
    "090": "opened an investigation into",
    "092": "investigated human-rights abuses by",
    # 10x
    "100": "demanded action from",
    "101": "demanded material cooperation from",
    "103": "demanded aid from",
    "104": "demanded political reform from",
    "105": "demanded concessions from",
    "106": "demanded a meeting with",
    "107": "demanded a settlement with",
    # 11x/12x
    "110": "criticised",
    "111": "denounced",
    "112": "accused",
    "1123": "accused of war crimes",
    "114": "lodged an official complaint against",
    "116": "found guilty",
    "120": "rejected",
    "125": "refused to yield to",
    "129": "vetoed a measure by",
    # 13x
    "130": "threatened",
    "131": "threatened non-military action against",
    "1312": "threatened economic sanctions on",
    "134": "threatened to halt negotiations with",
    "137": "issued an ultimatum to",
    "138": "threatened the use of force against",
    "1382": "threatened to attack",
    # 14x
    "140": "protested against",
    "141": "demonstrated against",
    "144": "struck or boycotted",
    "145": "blockaded",
    # 15x
    "150": "changed its force posture towards",
    "152": "raised its military alert level towards",
    "153": "mobilised forces facing",
    "154": "raised military readiness towards",
    # 16x
    "160": "reduced relations with",
    "161": "downgraded diplomatic relations with",
    "163": "imposed sanctions on",
    "164": "halted negotiations with",
    "166": "expelled",
    "1663": "expelled diplomats of",
    # 17x
    "170": "coerced",
    "171": "seized property belonging to",
    "172": "imposed administrative sanctions on",
    "173": "arrested or detained",
    "175": "repressed",
    # 18x
    "180": "used violence against",
    "181": "abducted or took hostage",
    "182": "physically assaulted",
    "1821": "sexually assaulted",
    "1822": "tortured",
    "1823": "killed",
    "183": "bombed",
    "1831": "carried out a suicide bombing against",
    "1832": "carried out a vehicle bombing against",
    "1833": "carried out a roadside bombing against",
    "184": "attempted to assassinate",
    "185": "attempted to assassinate",
    "186": "assassinated",
    # 19x
    "190": "used armed force against",
    "191": "blockaded or besieged",
    "192": "took control of territory held by",
    "193": "exchanged small-arms fire with",
    "194": "shelled",
    "195": "carried out an air strike on",
    "196": "violated a ceasefire with",
    # 20x
    "200": "carried out mass violence against",
    "201": "forcibly expelled",
    "202": "carried out a mass killing of",
    "203": "carried out ethnic cleansing against",
    "204": "used weapons of mass destruction against",
}

ROOT_SENTENCE = {
    1: "issued a statement about",
    2: "appealed to",
    3: "signalled intent to cooperate with",
    4: "held talks with",
    5: "cooperated diplomatically with",
    6: "cooperated materially with",
    7: "provided aid to",
    8: "made concessions to",
    9: "opened an investigation into",
    10: "demanded action from",
    11: "criticised",
    12: "rejected",
    13: "threatened",
    14: "protested against",
    15: "changed its force posture towards",
    16: "reduced relations with",
    17: "coerced",
    18: "attacked",
    19: "fought",
    20: "carried out mass violence against",
}

# CAMEO Actor Type1 codes. Only used to add a role when the actor's own name
# doesn't already carry one -- "ISRAELI (armed forces)" is worth saying,
# "POLICE (police)" is not.
ACTOR_TYPE_LABEL = {
    "MIL": "armed forces",
    "REB": "rebel group",
    "INS": "insurgents",
    "SEP": "separatists",
    "UAF": "unidentified armed group",
    "COP": "police",
    "GOV": "government",
    "SPY": "intelligence services",
    "JUD": "judiciary",
    "LEG": "legislature",
    "OPP": "political opposition",
    "PTY": "political party",
    "CVL": "civilians",
    "MED": "media",
    "REF": "refugees",
    "IGO": "international organisation",
    "NGO": "non-governmental organisation",
    "UIS": "unidentified state actor",
    "CRM": "criminal group",
    "RAD": "radical group",
    "BUS": "business",
    "EDU": "education sector",
    "HLH": "health sector",
    "HRI": "human-rights group",
    "LAB": "labour group",
    "AGR": "agricultural sector",
    "ENV": "environmental group",
    "ELI": "elites",
}

# CAMEO actor names arrive as uppercase codes-turned-words ("ISRAELI",
# "JOURNALIST", "MILITARY"). Title-casing them is not cosmetic: SHOUTED text
# reads as a machine artifact and makes the whole popup look untrustworthy even
# where the underlying coding is fine. Acronyms have to survive that, though --
# "Uno used violence against Ukraine" is worse than either the raw code or the
# expansion.
ACTOR_KEEP_UPPER = {
    "US", "USA", "UK", "UN", "EU", "AU", "NATO", "OSCE", "OPEC", "ICC", "ICRC",
    "IAEA", "IMF", "WTO", "WHO", "OAS", "ASEAN", "ECOWAS", "IDF", "IRGC",
    "ISIS", "ISIL", "PKK", "PLO", "FARC", "HTS", "SDF", "RSF", "SAF", "PMF",
    "NGO", "IGO", "G7", "G20", "BRICS", "MFA", "PM", "MP",
}
# CAMEO's own organisation codes, expanded. Only the ones common enough on
# real rows to be worth a line each.
ACTOR_ALIAS = {
    "UNO": "UN",
    "IGOUNO": "UN",
    "WBK": "World Bank",
    "EEC": "EU",
    "NAT": "NATO",
    "IGONAT": "NATO",
    # Actor1KnownGroupCode values seen on live violent rows. Without these,
    # pretty_actor's preference for the group over the name rendered the bare
    # code -- an event coded TALIBAN / TAL / INS printed as "Tal (insurgents)",
    # which reads as a garbled name rather than as the Taliban.
    "TAL": "Taliban",
    "ALQ": "al-Qaeda",
}

# Length at or below which an unrecognised actor string is treated as an
# opaque CAMEO code rather than a name. KnownGroupCode is a 3-letter code by
# construction, so anything short that ACTOR_ALIAS cannot expand and
# ACTOR_KEEP_UPPER does not vouch for is a code we have no expansion for --
# and a code is not a name. See pretty_actor.
_OPAQUE_CODE_MAX_LENGTH = 3

# When the actor's own name already *is* the role, appending the role label
# produces "Military (armed forces)" -- noise dressed up as detail.
ROLE_REDUNDANT = {
    "MIL": {"military", "army", "armed forces", "navy", "air force", "soldier", "soldiers"},
    "COP": {"police", "policeman", "policemen"},
    "GOV": {"government", "state", "sovereign", "official", "officials"},
    "CVL": {"civilian", "civilians", "citizen", "citizens"},
    "REB": {"rebel", "rebels"},
    "INS": {"insurgent", "insurgents"},
    "SEP": {"separatist", "separatists"},
    "MED": {"media", "press", "journalist", "journalists", "reporter", "reporters"},
    "REF": {"refugee", "refugees"},
    "CRM": {"criminal", "criminals"},
    "LEG": {"legislature", "parliament", "congress", "senate"},
    "JUD": {"judiciary", "court", "courts", "judge"},
    "OPP": {"opposition"},
    "PTY": {"party"},
    "ELI": {"elite", "elites"},
    # No IGO entry on purpose: "UN (international organisation)" is worth
    # saying, because the bare acronym does not tell a reader what the UN is
    # acting *as* here. That is the opposite of the "Military (armed forces)"
    # case this table exists to suppress.
}


def _longest_prefix(table: dict, event_code, base_code):
    """Most specific table hit for a CAMEO code, walking 1831 -> 183 -> 18."""
    for code in (event_code, base_code):
        code = (str(code or "")).strip()
        while code:
            if code in table:
                return table[code]
            code = code[:-1]
    return None


def cameo_label(event_code, base_code, root_code) -> str | None:
    """Most specific available CAMEO label, or None to fall through."""
    return _longest_prefix(CODE_LABEL, event_code, base_code) or ROOT_LABEL.get(root_code)


def cameo_sentence(event_code, base_code, root_code) -> str | None:
    """Most specific available verb phrase, or None to fall through."""
    return _longest_prefix(CODE_SENTENCE, event_code, base_code) or ROOT_SENTENCE.get(root_code)


def _is_opaque_code(raw: str) -> bool:
    """A short token we have no expansion for -- a CAMEO code, not a name.

    Title-casing one produces a word-shaped string that looks like a name and
    is not: "TAL" became "Tal", which read as somebody called Tal rather than
    as the Taliban. Better to fall back to the actor's own name, which GDELT
    fills in readably ("TALIBAN") even where we cannot decode the group code.
    """
    return (
        len(raw) <= _OPAQUE_CODE_MAX_LENGTH
        and raw.upper() not in ACTOR_ALIAS
        and raw.upper() not in ACTOR_KEEP_UPPER
    )


def pretty_actor(name: str | None, group: str | None, type_code: str | None) -> str | None:
    """One readable actor phrase, or None when CAMEO coded no actor at all.

    A named group (Actor1KnownGroupCode -- HAMAS, HEZBOLLAH, NATO) is preferred
    over the generic name, because "Hamas" is a fact about the world while
    "PALESTINIAN" is a coder's bucket -- but only when the group is something a
    reader can read. GDELT ships that column as a bare three-letter CAMEO code,
    so preferring it unconditionally (the old behaviour) put "Tal (insurgents)"
    and "Alq (rebel group)" on live conflict pins in place of the perfectly
    legible names sitting in the very next column.
    """
    group = (group or "").strip()
    if group and _is_opaque_code(group):
        group = ""
    raw = (group or name or "").strip()
    if not raw:
        return None
    # An expansion is already written the way the name is written -- running it
    # back through the title-caser turns "al-Qaeda" into "Al-qaeda", undoing
    # the reason the table has an entry at all.
    expanded = ACTOR_ALIAS.get(raw.upper())
    if expanded:
        label = expanded
    else:
        label = " ".join(
            word if word.upper() in ACTOR_KEEP_UPPER else word.capitalize()
            for word in raw.replace("_", " ").split()
        )

    code = (type_code or "").strip().upper()
    role = ACTOR_TYPE_LABEL.get(code)
    if role and label.lower() not in ROLE_REDUNDANT.get(code, ()) and role.split()[0].lower() not in label.lower():
        label = f"{label} ({role})"
    return label


def clean_location(location: str | None) -> str | None:
    """"Jerusalem, Israel (general), Israel" -> "Jerusalem, Israel".

    GDELT's ActionGeo_FullName repeats the country as its own last segment and
    tags an ADM1 that shares the country's name with "(general)". Printed raw it
    reads like a transcription error, which undermines everything else in the
    popup.
    """
    if not location:
        return None
    seen: list[str] = []
    for part in location.split(","):
        part = part.strip()
        if part.endswith("(general)"):
            part = part[: -len("(general)")].strip()
        if not part:
            continue
        # Case-insensitive, so "Israel" after "Israel (general)" is dropped.
        if any(part.lower() == existing.lower() for existing in seen):
            continue
        seen.append(part)
    return ", ".join(seen) or None


def country_from_location(location: str | None) -> str | None:
    """"Kherson, Khersons'ka Oblast', Ukraine" -> "Ukraine".

    GDELT's ActionGeo_FullName is "City, ADM1, Country" for a precise geocode
    and bare "Ukraine" for a country-level one, so the last comma-segment is
    the country either way -- the same rule popups.js already applies to raw
    news items.
    """
    if not location:
        return None
    return location.rsplit(",", 1)[-1].strip() or None


# --- what kind of diplomatic act is this ----------------------------------
#
# The Officials & Diplomacy layer needs one glyph per event, which means
# collapsing ~120 diplomatic codes into a handful of shapes a reader can learn
# in one sitting. Keyed on the CAMEO root, since that is the level at which the
# distinction is stable.
#
# Ordered most-specific-first where a root spans two kinds: root 04 is entirely
# meetings, root 05 is mostly warm words but 057 is a signed treaty, which is a
# materially different thing and gets its own kind.
KIND_BY_ROOT = {
    1: "statement",
    2: "statement",
    3: "meeting",     # intent to meet/negotiate -- the "planning to meet" case
    4: "meeting",
    5: "agreement",
    6: "agreement",
    7: "aid",
    8: "agreement",   # yields and ceasefires read as de-escalation
    9: "statement",
    10: "demand",
    11: "demand",
    12: "demand",
    13: "threat",
    14: "protest",
    15: "posture",
    16: "rupture",
    17: "rupture",
}

# Codes whose kind differs from their root's default.
KIND_BY_CODE = {
    "036": "meeting",
    "026": "meeting",
    "106": "meeting",
    "057": "agreement",
    "0871": "agreement",
    "041": "meeting",
    "042": "meeting",
    "043": "meeting",
    "163": "rupture",
    "166": "rupture",
    "1663": "rupture",
}

# Roots this layer covers at all. Everything else (18/19/20) is violence and
# belongs to the Conflict & Violence layer -- an event must be in exactly one.
DIPLOMATIC_ROOT_CODES = frozenset(KIND_BY_ROOT)

# Actor types that make someone "an official" for this layer's purposes: the
# ones that act *for a state*. GOV and ELI carry heads of state and ministers,
# MIL a defence ministry, IGO the UN and NATO.
#
# LEG, JUD, OPP and PTY were included at first and measured badly. CAMEO fills
# an actor country code for domestic actors just as readily as for foreign
# ones, so admitting parties and legislatures filled a diplomacy layer with
# national party politics -- "Democratic Party consulted Michigan (government)"
# was a real row from a live window. That is the same way the conflict layer
# ended up 42% inside the United States (see event_fusion's ARMED_ACTOR_TYPES
# note); the fix is the same, and it is to narrow the actor types rather than
# to filter by country afterwards.
#
# COP is absent for the same reason it is absent there: a police spokesman is
# not a country official in this sense.
OFFICIAL_ACTOR_TYPES = frozenset({"GOV", "ELI", "MIL", "IGO"})

# Which kinds read as cooperative rather than hostile. Drives the layer's
# two-colour scheme; it is not a judgement about whether the act is good.
COOPERATIVE_KINDS = frozenset({"meeting", "agreement", "aid"})


def diplomatic_kind(event_code, base_code, root_code) -> str | None:
    """One of the layer's glyph categories, or None if this isn't diplomacy."""
    specific = _longest_prefix(KIND_BY_CODE, event_code, base_code)
    if specific:
        return specific
    return KIND_BY_ROOT.get(root_code)
