"""Who published a story: the domain allowlist, and how outlet names are
labelled, ranked and capped before they reach the map.

This lives outside gdelt.py because three modules need it now, not one. GDELT
learns who carried an event from the Mentions table (bare domains); ACLED and
UCDP ship their own sources as a semicolon-separated string; event_fusion
merges both kinds into one record. Keeping the table and the label rules in the
GDELT poller would mean acled.py importing a sibling poller for a string
helper.

The cap matters: /api/events serves up to 2500 events in one response
(EVENTS_MAX_ITEMS in app.py), so a per-event outlet list has to be bounded. The
true total always stays in outlet_count -- this is only the "who", and a popup
that names eight outlets and says "+31 more" tells the reader everything a full
list would.
"""

import re
from datetime import datetime, timezone
from urllib.parse import urlparse

# GDELT's crawler indexes anything -- wire services, national papers, but also
# SEO blogs, content farms and unlabeled AI-generated aggregator sites. Rather
# than trying to detect "AI-generated" after the fact, we only accept
# source_urls from domains of known, editorially-staffed news organizations,
# and the display name doubles as the on-map "which outlet is this" label.
# Subdomains of these (e.g. edition.cnn.com) match too.
VERIFIED_NEWS_DOMAINS = {
    "reuters.com": "Reuters", "apnews.com": "AP News", "afp.com": "AFP",
    "bbc.com": "BBC News", "bbc.co.uk": "BBC News",
    "aljazeera.com": "Al Jazeera", "npr.org": "NPR", "pbs.org": "PBS",
    "theguardian.com": "The Guardian", "nytimes.com": "The New York Times",
    "washingtonpost.com": "The Washington Post", "wsj.com": "The Wall Street Journal",
    "ft.com": "Financial Times", "economist.com": "The Economist",
    "bloomberg.com": "Bloomberg", "cnbc.com": "CNBC", "cnn.com": "CNN",
    "cbsnews.com": "CBS News", "nbcnews.com": "NBC News",
    "abcnews.go.com": "ABC News", "usatoday.com": "USA Today",
    "time.com": "TIME", "newsweek.com": "Newsweek", "politico.com": "Politico",
    "axios.com": "Axios", "thehill.com": "The Hill", "dw.com": "DW",
    "france24.com": "France 24", "euronews.com": "Euronews",
    "skynews.com": "Sky News", "independent.co.uk": "The Independent",
    "telegraph.co.uk": "The Telegraph", "spiegel.de": "Der Spiegel",
    "lemonde.fr": "Le Monde", "elpais.com": "El País", "corriere.it": "Corriere della Sera",
    "asahi.com": "The Asahi Shimbun", "japantimes.co.jp": "The Japan Times",
    "scmp.com": "South China Morning Post", "straitstimes.com": "The Straits Times",
    "timesofindia.indiatimes.com": "The Times of India", "hindustantimes.com": "Hindustan Times",
    "ndtv.com": "NDTV", "haaretz.com": "Haaretz", "timesofisrael.com": "The Times of Israel",
    "jpost.com": "The Jerusalem Post", "arabnews.com": "Arab News",
    "middleeasteye.net": "Middle East Eye", "kyivindependent.com": "The Kyiv Independent",
    "themoscowtimes.com": "The Moscow Times", "abc.net.au": "ABC News (Australia)",
    "cbc.ca": "CBC News", "globalnews.ca": "Global News", "rnz.co.nz": "RNZ",
    "voanews.com": "Voice of America", "csmonitor.com": "The Christian Science Monitor",
    "foreignpolicy.com": "Foreign Policy", "defensenews.com": "Defense News",
    "military.com": "Military.com", "janes.com": "Janes",
    "understandingwar.org": "Institute for the Study of War",
}

# The display names above, as a set -- what rank_outlets sorts on to put a
# masthead ahead of a bare domain, and how a caller holding labels (rather than
# domains) tells the two apart.
VERIFIED_LABELS = frozenset(VERIFIED_NEWS_DOMAINS.values())


# --- how much weight does the masthead carry ------------------------------
#
# The allowlist above is a yes/no: do we vouch for this newsroom at all. That
# is the right question for "may this page move a pin", and the wrong one for
# "how much should a reader believe this happened". A wire service with a
# standards desk and a correction policy and a stringer in the country is not
# the same kind of evidence as a domain nobody has ever heard of, and until now
# the map treated the two identically once both passed the violence gate.
#
# Three tiers, because two is not enough and four is more precision than the
# evidence supports:
#
#   1 major        international wire services, and the newsrooms of record and
#                  public broadcasters that carry their own foreign desks. A
#                  report here is checked before it is published, and wrong
#                  ones get corrected in public.
#   2 established  the rest of the allowlist. Real, editorially staffed
#                  newsrooms -- national papers, regional heavyweights,
#                  specialist defence press -- but a narrower remit, a smaller
#                  desk, or a single national vantage point.
#   3 unknown      not on the allowlist. This is most of what GDELT indexes:
#                  local papers, aggregators, SEO farms and unlabelled
#                  AI-generated sites, with no way to tell them apart from the
#                  domain alone. Naming the outlet is still honest (see
#                  outlet_label); vouching for it is not.
#
# Tier 1 is deliberately short. Every addition dilutes what "a major newsroom
# reported this" is allowed to mean, and the whole point of the tier is that a
# reader can act on it.
TIER_MAJOR = 1
TIER_ESTABLISHED = 2
TIER_UNKNOWN = 3

MAJOR_OUTLET_DOMAINS = frozenset({
    # Wire services: the primary reporting almost everything else runs.
    "reuters.com", "apnews.com", "afp.com",
    # Public broadcasters with their own foreign desks.
    "bbc.com", "bbc.co.uk", "npr.org", "pbs.org", "dw.com", "france24.com",
    "abc.net.au", "cbc.ca", "aljazeera.com",
    # Newspapers of record and international business press.
    "theguardian.com", "nytimes.com", "washingtonpost.com", "wsj.com",
    "ft.com", "economist.com", "bloomberg.com",
    "lemonde.fr", "spiegel.de", "elpais.com",
    # US network news divisions.
    "cnn.com", "cbsnews.com", "nbcnews.com", "abcnews.go.com",
})

# The same set as display names, for the callers that hold labels rather than
# domains -- which is most of them, because outlet_count and `outlets` are
# assembled from labels well before anything asks how much to trust them.
MAJOR_LABELS = frozenset(
    name for domain, name in VERIFIED_NEWS_DOMAINS.items() if domain in MAJOR_OUTLET_DOMAINS
)


def outlet_tier(name: str | None) -> int:
    """TIER_MAJOR / TIER_ESTABLISHED / TIER_UNKNOWN for one outlet.

    Accepts either a display label ("BBC News") or a bare domain
    ("edition.bbc.co.uk"), because both forms are in circulation: GDELT's
    Mentions table yields domains, while a merged record carries the labels
    outlet_label already produced. Resolving the domain first means a caller
    never has to know which one it is holding.
    """
    if not name:
        return TIER_UNKNOWN
    label = name.strip()
    if not label:
        return TIER_UNKNOWN
    # A domain resolves to its masthead; a label that is already a masthead
    # resolves to itself, since no allowlisted name is also a hostname.
    known = _known_domain(_strip_host(label))
    if known:
        label = VERIFIED_NEWS_DOMAINS[known]
    if label in MAJOR_LABELS:
        return TIER_MAJOR
    if label in VERIFIED_LABELS:
        return TIER_ESTABLISHED
    return TIER_UNKNOWN


def best_tier(names) -> int:
    """The strongest tier among a set of outlets, TIER_UNKNOWN when empty.

    "Strongest" rather than an average on purpose: once Reuters has carried a
    story, the fact that thirty content farms also republished it says nothing
    against it. Coverage breadth is counted separately (outlet_count); this
    answers only "did anyone we vouch for report this".
    """
    return min((outlet_tier(name) for name in names or () if name), default=TIER_UNKNOWN)


def count_at_tier(names, tier: int) -> int:
    """How many distinct outlets sit at `tier` or better."""
    return sum(1 for name in {n for n in names or () if n} if outlet_tier(name) <= tier)

# How many outlet names travel with each event to the browser.
MAX_OUTLET_NAMES = 8

# UCDP's source_article is a citation, not a masthead ("Agence France Presse,
# 'Sudan army says...', 12 March"). Truncated rather than dropped: the first
# words are the outlet, which is the part being asked for.
_MAX_NAME_LENGTH = 60


# --- what kind of page is this --------------------------------------------
#
# The allowlist above answers "do we vouch for this newsroom". It cannot answer
# "is this page a report of something that just happened", and for a live map
# that is the question that matters. A 25-year retrospective in The Atlantic's
# print magazine is written by exactly the kind of newsroom the allowlist
# exists to admit -- and GDELT machine-codes every historical incident it
# mentions as a fresh event, stamped with today's SQLDATE so the report-lag
# gate in event_fusion cannot see it. One such essay produced a "suicide
# bombing in Tunisia" pin dated today, from a sentence about 2002.
#
# The URL's own section path is the cheap, honest signal: a publisher that
# files a piece under /magazine/, /opinion/ or /analysis/ is telling us it is
# commentary or retrospective rather than a dispatch. Measured over a 12-hour
# live window, 6 of 126 rows passing the conflict layer's violence gate came
# from one of these sections, and every one of the 6 was spurious -- the
# Atlantic essay (4 rows, including the Tunisia pin), a Kyiv Post op-ed
# geocoded to the middle of Poland, and a US gun-control column geocoded to
# Texas. No true positives were lost.
#
# Deliberately narrow. Sections that carry real breaking news under a topic
# label -- /world/, /politics/, /business/, /sport/ -- are NOT listed: a
# bombing reported on a business desk is still a bombing. Only sections whose
# whole purpose is that the piece is not a dispatch.
NON_NEWS_PATH_SEGMENTS = frozenset({
    "magazine", "opinion", "opinions", "op-ed", "oped", "commentary",
    # The Guardian's opinion section. Named, not labelled "opinion" anywhere in
    # the path, which is how a Peter Beinart column on Democratic strategy
    # reached the conflict layer coded INSURGENT/REB.
    "commentisfree",
    "editorial", "editorials", "column", "columns", "perspective",
    "perspectives", "analysis", "essay", "essays", "longread", "longreads",
    "review", "reviews", "book", "books", "obituary", "obituaries",
    "archive", "archives", "history", "blog", "blogs",
})


def _strip_host(host: str) -> str:
    host = (host or "").strip().lower()
    return host[4:] if host.startswith("www.") else host


def is_non_news_url(url: str | None) -> bool:
    """True when the URL's section path says the page is not a news dispatch.

    Matched on whole path segments only. A substring test would reject
    /news/kabul-review-of-security-posture for containing "review", and an
    article slug is where words like "history" and "opinion" legitimately
    appear -- so the last segment (the slug itself) is never matched.
    """
    if not url:
        return False
    try:
        path = urlparse(url).path
    except ValueError:
        return False
    segments = [s for s in path.lower().split("/") if s]
    return any(s in NON_NEWS_PATH_SEGMENTS for s in segments[:-1])


# --- when does the URL say it was published -------------------------------
#
# The section filter above catches a piece a publisher *labelled* as
# commentary. It cannot catch an ordinary news report from 2019 that GDELT
# re-crawled today -- and GDELT stamps those with today's SQLDATE, so the
# report-lag gate cannot see them either.
#
# Most newsrooms put the publication date in the URL. That is a claim the
# publisher made at publication time, independent of anything GDELT did to the
# row afterwards, which makes it the only genuinely independent age signal
# available on a row with no scraped article text.
#
# This function reads the date and nothing else. Deciding what counts as too
# old belongs to gdelt.py, which owns GDELT's date semantics -- this module
# owns URL shape.
_URL_DATE_PATH_RE = re.compile(r"/((?:19|20)\d{2})/(\d{1,2})(?:/|$)")
_URL_DATE_ISO_RE = re.compile(r"(?<!\d)((?:19|20)\d{2})-(\d{2})-(\d{2})(?!\d)")

# Below this, a four-digit number in a URL is far more likely to be an id or a
# section than a publication year. Nothing this pipeline shows is from the
# 1990s anyway; the point of the floor is to make a false read impossible
# rather than merely unlikely.
_MIN_URL_YEAR = 1990


def url_path_date(url: str | None) -> tuple[int, int] | None:
    """(year, month) the URL claims it was published, or None.

    Two shapes, because both are common and one of them is in this repo's own
    test fixtures:

        /2019/07/some-story          path segments
        /world/strike-on-kherson-2026-08-05/   ISO date inside the slug

    Note the second means is_non_news_url's "never match the final segment"
    rule does NOT transfer here: the date very often *is* in the slug, which is
    exactly where a section word would have been a false positive.

    Returns None rather than guessing whenever the match is not unambiguous --
    a caller that gets None simply learns nothing and applies no penalty, which
    is the correct behaviour for the majority of URLs that carry no date.
    """
    if not url:
        return None
    try:
        path = urlparse(url).path
    except ValueError:
        return None

    # ISO first: it carries a day as well, so it is the stronger signal, and a
    # path like /2026/08/05/ would otherwise be read by the looser pattern.
    match = _URL_DATE_ISO_RE.search(path)
    if not match:
        match = _URL_DATE_PATH_RE.search(path)
    if not match:
        return None

    year, month = int(match.group(1)), int(match.group(2))
    if month < 1 or month > 12:
        return None  # "/news/13/" is a section number, not a month
    now = datetime.now(timezone.utc)
    # Next year is allowed: a magazine dates its September issue in August, and
    # a caller must never read a *future* date as evidence of staleness.
    if year < _MIN_URL_YEAR or year > now.year + 1:
        return None
    return year, month


def url_age_months(url: str | None, reference: datetime | None = None) -> int | None:
    """How many months before `reference` the URL claims it was published.

    None when the URL carries no readable date. Negative values are clamped to
    0: a URL dated in the future is not evidence of anything, least of all
    staleness, and letting it go negative would make a caller's "> threshold"
    test accidentally true if the sign were ever flipped.
    """
    parsed = url_path_date(url)
    if not parsed:
        return None
    year, month = parsed
    reference = reference or datetime.now(timezone.utc)
    return max(0, (reference.year - year) * 12 + (reference.month - month))


def _known_domain(host: str) -> str | None:
    for domain in VERIFIED_NEWS_DOMAINS:
        if host == domain or host.endswith("." + domain):
            return domain
    return None


def matched_domain(url: str) -> str | None:
    try:
        host = urlparse(url).hostname or ""
    except ValueError:
        return None
    return _known_domain(_strip_host(host))


def agency_name(url: str) -> str | None:
    domain = matched_domain(url)
    return VERIFIED_NEWS_DOMAINS.get(domain) if domain else None


def outlet_label(domain: str) -> str:
    """A bare domain from GDELT's Mentions table -> what to show a reader.

    An allowlisted domain becomes its masthead ("edition.cnn.com" -> "CNN"),
    subdomains included -- the same suffix rule matched_domain applies to URLs.
    Anything else keeps its own hostname, which is the honest answer: naming
    "kyivpost.com" says who carried the story without implying we vouch for it,
    and most conflict reporting comes from outlets no allowlist will ever hold.
    """
    host = _strip_host(domain)
    known = _known_domain(host)
    return VERIFIED_NEWS_DOMAINS[known] if known else host


def label_for_url(url: str | None) -> str | None:
    """outlet_label for the outlet behind an article URL, or None."""
    if not url:
        return None
    try:
        host = urlparse(url).hostname or ""
    except ValueError:
        return None
    return outlet_label(host) or None


def rank_outlets(labels, preferred: str | None = None) -> list[str]:
    """Dedupe, order and cap a set of outlet labels for display.

    `preferred` (the outlet whose article the record itself cites) first, then
    mastheads, then everything else, alphabetical within each group.

    The ordering is what makes the cap safe: when only eight of forty names
    survive, the ones kept are the ones a reader can actually do something with.
    Plain alphabetical was not that -- measured on a live window, a widely
    syndicated story lists 35 near-identical local mastheads and the cut kept
    "asianimage.co.uk, bournemouthecho.co.uk, brentwoodlive.co.uk, ...", an
    artifact of the alphabet that also managed to omit the one outlet the
    popup's own "Open source article" link points at.

    Applied at every merge point (per poll, per accumulation, per fused
    cluster) so the cap can never be exceeded by unioning two already-capped
    lists.
    """
    return sorted(
        {name for name in labels if name},
        key=lambda name: (name != preferred, name not in VERIFIED_LABELS, name.lower()),
    )[:MAX_OUTLET_NAMES]


def split_outlet_names(value: str | None) -> list[str]:
    """ACLED/UCDP ship their sources as one delimited string -> a name list.

    ACLED separates with ";" and UCDP's candidate CSV mixes ";" and "|", so both
    are treated as delimiters. Order is preserved rather than ranked: these
    datasets list their primary source first, and that is information.
    """
    if not value:
        return []
    names: list[str] = []
    for part in str(value).replace("|", ";").split(";"):
        name = part.strip()[:_MAX_NAME_LENGTH].strip()
        if name and name not in names:
            names.append(name)
        if len(names) >= MAX_OUTLET_NAMES:
            break
    return names
