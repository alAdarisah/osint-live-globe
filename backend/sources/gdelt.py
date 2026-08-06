import asyncio
import csv
import html
import io
import logging
import os
import re
import time
import zipfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx

from backend import config, storage
from backend.cache import registry
# The CAMEO taxonomy, shared with event_fusion.py and officials.py. Only the
# routing constants are needed here -- which roots and actor types make a row
# diplomacy rather than violence.
from backend.sources import cameo
# The domain allowlist and the outlet-name helpers moved to their own module:
# acled.py needs the same labelling for the sources ACLED and UCDP publish, and
# importing a sibling poller for a string helper would be backwards. Bound to
# the private names this module has always used so its call sites are unchanged.
from backend.sources.outlets import (  # noqa: F401 - VERIFIED_NEWS_DOMAINS is re-exported for callers
    VERIFIED_LABELS as _VERIFIED_LABELS,
    VERIFIED_NEWS_DOMAINS,
    agency_name as _agency_name,
    is_non_news_url,
    label_for_url,
    matched_domain as _matched_domain,
    outlet_label,
    rank_outlets,
    url_age_months,
)

log = logging.getLogger("osint-globe.gdelt")

LASTUPDATE_URL = "http://data.gdeltproject.org/gdeltv2/lastupdate.txt"
GDELT_BASE_URL = "http://data.gdeltproject.org/gdeltv2/"

# GDELT publishes a new export file every 15 minutes. Fetching only the
# latest one (the old behavior) meant a quiet 15-minute window could leave
# the news layer nearly empty, and every poll wholesale-replaced the list so
# still-relevant items vanished the moment the next poll landed. Instead we
# roll up a trailing window of files into a persistent accumulator (see
# _ACCUMULATED below) that items age out of gradually.
WINDOW_MINUTES = 120  # how much history each poll re-reads
FILE_STEP_MINUTES = 15  # GDELT's export cadence

# --- how long a row stays in the accumulator ------------------------------
#
# Two consumers, two answers, which is why this is not one number.
#
# event_fusion re-reads the whole accumulator every poll and keeps its own
# 3-day copy of anything violent (_VIOLENT_RETENTION_SECONDS), rehydrating it
# from Postgres after a restart. A poll happens every 15 minutes and the window
# below is 135 minutes, so fusion sees every row roughly nine times before it
# expires here -- it loses nothing to a short retention.
#
# The news layer is the opposite: a headline is worth showing for the rest of
# the day, and 2h15m meant the map went quiet on any story more than one lunch
# break old. Trusted-domain rows therefore stay for a full day.
#
# Untrusted rows keep the short window. They can never become News pins
# (app.py's _gdelt_filter requires a real_title, and titles are only ever
# scraped from VERIFIED_NEWS_DOMAINS -- see _title_url_for), so retaining them
# for 24h would multiply the accumulator by roughly ten to serve nobody.
FUSION_RETENTION_MINUTES = WINDOW_MINUTES + FILE_STEP_MINUTES  # 135
NEWS_RETENTION_MINUTES = 24 * 60

# Served/returned count. Raised alongside NEWS_RETENTION_MINUTES: 400 was sized
# for a two-hour window, and keeping it while widening to 24h would have meant
# the feed silently became "the biggest stories of the day" -- the cut, not the
# window, deciding what a live map shows.
NEWS_MAX_ITEMS = 1200

# Half-life of a story's rank, in hours. Reach alone is the wrong sort key over
# a 24-hour window: a wire story picked up by 40 outlets overnight would
# permanently outrank everything that broke in the last hour, so the map's most
# recent news would be the news it never showed. Six hours means a 12-hour-old
# story needs 4x the mentions of a fresh one to sit above it, which keeps big
# ongoing stories visible without letting them own the whole feed.
NEWS_HALF_LIFE_HOURS = 6.0

# Safety valve only -- deliberately far above observed volume. Raised with the
# retention split: a 12-hour live window yields ~4,700 conflict rows after
# (article, place) dedup, of which the trusted-domain minority now persists for
# 24h. If the warning it logs ever fires, the volume assumption was wrong and
# that needs to be visible rather than silently truncating the conflict layer.
_ACCUMULATED_HARD_CAP = 40000

# Column indices in the GDELT 2.0 Event export CSV (tab-separated, no header).
# Verified empirically against live data by backend/scripts/probe_gdelt.py --
# these are read by position out of a headerless file, so a wrong index does
# not raise, it silently returns a neighbouring field.
COL_GLOBAL_EVENT_ID = 0
COL_SQLDATE = 1
COL_ACTOR1_NAME = 6
COL_ACTOR1_COUNTRY = 7
COL_ACTOR1_KNOWN_GROUP = 8
COL_ACTOR1_TYPE1 = 12
COL_ACTOR2_NAME = 16
COL_ACTOR2_COUNTRY = 17
COL_ACTOR2_KNOWN_GROUP = 18
COL_ACTOR2_TYPE1 = 22
COL_IS_ROOT_EVENT = 25
COL_EVENT_CODE = 26
COL_EVENT_BASE_CODE = 27
COL_EVENT_ROOT_CODE = 28
COL_QUAD_CLASS = 29
COL_GOLDSTEIN = 30
COL_NUM_MENTIONS = 31
COL_NUM_SOURCES = 32
COL_NUM_ARTICLES = 33
COL_AVG_TONE = 34
COL_ACTION_GEO_TYPE = 51
COL_ACTION_GEO_FULLNAME = 52
COL_ACTION_GEO_COUNTRY = 53
COL_ACTION_GEO_LAT = 56
COL_ACTION_GEO_LONG = 57
COL_ACTION_GEO_FEATURE_ID = 58
COL_DATE_ADDED = 59
COL_SOURCE_URL = 60

# GDELT's ActionGeo_Type, translated once here into the precision vocabulary
# the rest of the pipeline speaks. Nothing downstream should ever see the raw
# integer.
#
# This distinction was previously not made at all, which meant a row geocoded
# only to "Sudan" was drawn as a pin at Sudan's geometric centre and was
# indistinguishable from a pin on a named street in Kherson. Roughly a fifth
# of conflict rows are country-level (measured: 17.8%), so this was not a
# corner case -- it was the map asserting a precision it never had.
GEO_PRECISION = {
    1: "country",    # COUNTRY  -- centroid, the true location is unknown
    2: "region",     # USSTATE
    5: "region",     # WORLDSTATE (ADM1)
    3: "locality",   # USCITY
    4: "locality",   # WORLDCITY -- a real place
}
GEO_PRECISION_UNKNOWN = "unknown"  # ActionGeo_Type 0 (no geocode match) or blank

# The values that mean "we do not actually know where in this country". Named
# here because this module defines the vocabulary; officials.py imports it
# rather than restating the literals. Backend twin of severity.js's
# IMPRECISE_PRECISIONS, which asks the same question of the frontend.
IMPRECISE_PRECISIONS = frozenset({"country", "region", GEO_PRECISION_UNKNOWN})

# Snapping an imprecise diplomacy pin onto the capital is a strict improvement
# for "country" and "unknown": both mean the geocoder placed the event nowhere
# in particular, and a government's seat is where diplomacy happens.
#
# "region" is deliberately not in the default set. It means GDELT *did* match an
# ADM1, and "Khersons'ka Oblast'" moved to Kyiv is worse than the oblast
# centroid -- the centroid is at least inside the place the reporting named. The
# counter-argument is real (many ADM1 matches are Laender or US states standing
# in for a national act), so this is a flag to be flipped after measuring, not a
# guess to be argued about. Same env-flag pattern as COUNTRY_CENTROID_POLICY.
SNAPPABLE_PRECISIONS = frozenset(
    {"country", GEO_PRECISION_UNKNOWN}
    | ({"region"} if os.getenv("OFFICIALS_SNAP_REGION", "").lower() in ("1", "true", "on", "yes") else set())
)


def _geo_precision(raw: str) -> str:
    try:
        return GEO_PRECISION.get(int(raw), GEO_PRECISION_UNKNOWN)
    except (ValueError, TypeError):
        return GEO_PRECISION_UNKNOWN

_TS_RE = re.compile(r"(\d{14})\.export\.CSV\.zip")


async def _latest_export_url(client: httpx.AsyncClient) -> str:
    resp = await client.get(LASTUPDATE_URL)
    resp.raise_for_status()
    for line in resp.text.splitlines():
        if "export.CSV.zip" in line:
            return line.strip().split(" ")[-1]
    raise RuntimeError("Could not find export.CSV.zip in GDELT lastupdate.txt")


def _parse_latest_ts(export_url: str) -> datetime:
    match = _TS_RE.search(export_url)
    if not match:
        raise RuntimeError(f"Unexpected GDELT lastupdate URL format: {export_url}")
    return datetime.strptime(match.group(1), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)


def _window_urls(latest_dt: datetime, window_minutes: int = WINDOW_MINUTES) -> list[str]:
    """The export files covering `window_minutes` back from `latest_dt`.

    `window_minutes` is a parameter rather than the constant so an offline
    calibration run can read a wider slice than the live poller does --
    backend/scripts/eval_placement.py needs hours of history per sampled day to
    build a golden set, while the poller wants exactly the rolling window it
    re-reads every 15 minutes.
    """
    n_files = max(1, window_minutes // FILE_STEP_MINUTES)
    return [
        f"{GDELT_BASE_URL}{(latest_dt - timedelta(minutes=FILE_STEP_MINUTES * k)).strftime('%Y%m%d%H%M%S')}.export.CSV.zip"
        for k in range(n_files)
    ]


def _parse_events(text: str) -> list[dict]:
    candidates = []
    for row in csv.reader(io.StringIO(text), delimiter="\t"):
        if len(row) <= COL_SOURCE_URL:
            continue
        try:
            quad_class = int(row[COL_QUAD_CLASS])
            lat = float(row[COL_ACTION_GEO_LAT])
            lon = float(row[COL_ACTION_GEO_LONG])
            mentions = int(row[COL_NUM_MENTIONS])
        except (ValueError, IndexError):
            continue
        # Every quad class is parsed. This used to drop 1 and 2 (verbal and
        # material *cooperation*) outright, which is why the app had no view of
        # diplomacy at all: CAMEO root 04 -- a leader visiting, hosting or
        # meeting another leader -- is quad class 1, so summits and state visits
        # never entered the pipeline.
        #
        # Nothing downstream got wider as a result. _fetch routes each row by
        # class: quad 3/4 to the conflict accumulator exactly as before, and the
        # diplomatic subset to its own (see _is_officials_row). The narrowing
        # each consumer needs happens at that split, not here, so the three
        # layers can disagree about what is relevant to them.
        # Used to hard-require a verified-domain source_url here, which threw
        # away most raw CAMEO conflict events (anything only reported by a
        # regional/local outlet outside VERIFIED_NEWS_DOMAINS never made it
        # past this point). Verified domain is still required to display a
        # real headline (see _attach_titles below) and to serve as a News
        # pin (see app.py's _gdelt_filter), but event_fusion.py needs the
        # full, broader set of structured conflict events -- CAMEO
        # actor/geo/date data alone is enough to cross-reference against
        # ACLED/UCDP, no headline required.
        agency = _agency_name(row[COL_SOURCE_URL])
        try:
            event_root_code = int(row[COL_EVENT_ROOT_CODE])
        except (ValueError, IndexError):
            event_root_code = None
        candidates.append(
            {
                "event_id": row[COL_GLOBAL_EVENT_ID],
                "lat": lat,
                "lon": lon,
                "location": _fix_mojibake(row[COL_ACTION_GEO_FULLNAME]),
                "actor1": _fix_mojibake(row[COL_ACTOR1_NAME]) or None,
                "actor2": _fix_mojibake(row[COL_ACTOR2_NAME]) or None,
                # CAMEO actor *type* codes (MIL/REB/INS/SEP/...), as opposed
                # to the free-text names above. These are what distinguish an
                # armed-conflict event from an ordinary violent crime that
                # happens to be coded FIGHT -- see event_fusion.py's
                # ARMED_ACTOR_TYPES. KnownGroup is carried too: a named
                # organisation (a militia, a listed group) is itself a strong
                # signal even when the type code is blank.
                "actor1_type": row[COL_ACTOR1_TYPE1] or None,
                "actor2_type": row[COL_ACTOR2_TYPE1] or None,
                "actor1_group": row[COL_ACTOR1_KNOWN_GROUP] or None,
                "actor2_group": row[COL_ACTOR2_KNOWN_GROUP] or None,
                "event_code": row[COL_EVENT_CODE],
                "event_root_code": event_root_code,
                "event_base_code": row[COL_EVENT_BASE_CODE] or None,
                "quad_class": quad_class,
                "is_root_event": row[COL_IS_ROOT_EVENT] == "1",
                "goldstein": float(row[COL_GOLDSTEIN]) if row[COL_GOLDSTEIN] else None,
                "mentions": mentions,
                # NumSources/NumArticles are carried for completeness, but do
                # not mistake them for a corroboration signal: measured over a
                # 12h live window, 99% of violent rows report NumSources == 1
                # and NumMentions saturates at its per-file ceiling of 10.
                # Real distinct-outlet counts come from the Mentions table
                # (see _fetch_mentions), not from here.
                "num_sources": int(row[COL_NUM_SOURCES]) if row[COL_NUM_SOURCES].isdigit() else None,
                "num_articles": int(row[COL_NUM_ARTICLES]) if row[COL_NUM_ARTICLES].isdigit() else None,
                "avg_tone": float(row[COL_AVG_TONE]) if row[COL_AVG_TONE] else None,
                # How precisely this event is actually placed, and GDELT's own
                # stable identifier for that place. The latter is a far better
                # clustering key than a distance test: two rows sharing a
                # FeatureID are the same place by construction. 90% of violent
                # rows carry one.
                "geo_precision": _geo_precision(row[COL_ACTION_GEO_TYPE]),
                "geo_feature_id": row[COL_ACTION_GEO_FEATURE_ID] or None,
                "geo_country_code": row[COL_ACTION_GEO_COUNTRY] or None,
                "actor1_country": row[COL_ACTOR1_COUNTRY] or None,
                "actor2_country": row[COL_ACTOR2_COUNTRY] or None,
                # The date the event is reported to have happened, as distinct
                # from date_added, which is when GDELT ingested the article.
                # The pipeline used date_added as the event date for years,
                # which made every event look like it happened when we heard
                # about it.
                "event_date": row[COL_SQLDATE] or None,
                "date_added": row[COL_DATE_ADDED],
                "source_url": row[COL_SOURCE_URL],
                "source_name": agency,
            }
        )
    return candidates


# Two things deliberately NOT implemented here, both of which look obviously
# right until you check them against live data.
#
# 1. Upgrading a country-level ActionGeo using the Actor1Geo_*/Actor2Geo_*
#    columns (35-50). For "Russia struck Kyiv", Actor1Geo is Moscow while
#    ActionGeo is Kyiv -- the actor geocode is systematically the *wrong*
#    place, so using it as a fallback would move pins to the aggressor's
#    capital.
#
# 2. Rejecting rows where neither actor's geocoded country matches the action's
#    country, as a filter for articles geocoded to the publication's location
#    rather than the event's. Measured over a live window: 94% of violent rows
#    match, and every one of the mismatches was a genuine cross-border event --
#    Ukrainian forces striking Moscow, Russian servicemen in Kramatorsk,
#    Jordanian forces in Baghdad. The filter would have removed exactly the
#    cross-border strikes this map exists to show. Cross-border attack is the
#    normal case in war, not an anomaly.


# --- real article titles -----------------------------------------------
#
# GDELT's own event/GKG exports never include headline text -- only CAMEO
# codes and actor names, which is why the old auto-generated sentences
# ("X engaged in fighting with Y") were frequently a poor match for what an
# article actually said. Fetching each source_url's own <title>/og:title is
# the only way to show the real headline, so that's what this does, with a
# small persistent cache since the same big stories tend to reappear across
# consecutive 15-minute polls.
#
# This used to run synchronously inside the poll before state.data was set,
# which meant the news layer (and first page load generally) waited on up to
# ~NEWS_MAX_ITEMS sequential-ish HTTP scrapes. It's now kicked off as a detached
# background task from start() so events appear immediately with the CAMEO
# fallback sentence and get their real headline filled in moments later.

# What the scrape now keeps. It used to keep only the headline, which was
# enough to *label* a pin but not to check where the pin belongs -- and the
# placement check is the thing that decides whether the pin is a claim about
# Kherson or a claim about wherever the reporter was sitting.
#
# All four fields come out of the one response. A second fetch per article to
# read the body would double an already network-bound backfill for text the
# first fetch already had in hand.
@dataclass(frozen=True, slots=True)
class Article:
    title: str | None
    description: str | None   # og:description / <meta name="description">
    excerpt: str | None       # the opening of the body text
    dateline: str | None      # the place the piece was FILED from, not about


_EMPTY_ARTICLE = Article(None, None, None, None)

_ARTICLE_CACHE: dict[str, Article] = {}
_article_cache_bytes = 0
_backfill_task = None  # strong reference to the in-flight backfill -- see start()
_TITLE_FETCH_SEM = asyncio.Semaphore(15)
_OGTITLE_RE = re.compile(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']*)["\']', re.IGNORECASE)
_TITLE_TAG_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_OGDESC_RE = re.compile(
    r'<meta[^>]+(?:property|name)=["\'](?:og:)?description["\'][^>]+content=["\']([^"\']*)["\']',
    re.IGNORECASE,
)
_SCRIPT_STYLE_RE = re.compile(r"<(script|style|noscript|svg)\b.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
_PARAGRAPH_RE = re.compile(r"<p\b[^>]*>(.*?)</p>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")

# How much body text to keep. Enough to carry the first few paragraphs -- which
# is where a dispatch names where it happened -- and bounded because this is
# held in memory for every cached article.
MAX_EXCERPT_CHARS = 1200

# The excerpt cache is bounded by bytes rather than entries: entries vary by
# two orders of magnitude now that bodies are kept, so an entry cap that was
# right for headlines would be a memory leak for articles.
MAX_ARTICLE_CACHE_BYTES = 24 * 1024 * 1024

_FETCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}


def _clean_title(raw: str) -> str:
    # _fix_mojibake before unescaping: entity decoding can introduce the
    # very characters the repair keys on.
    return re.sub(r"\s+", " ", html.unescape(_fix_mojibake(raw) or "")).strip()


def extract_excerpt(html_text: str, limit: int = MAX_EXCERPT_CHARS) -> str | None:
    """The opening of the article body, as plain text.

    Paragraph tags only. Taking all text on the page instead would fill the
    excerpt with nav menus, cookie banners and related-story rails -- and those
    carry place names, which is exactly the kind of noise that would make a
    placement check confidently wrong.
    """
    if not html_text:
        return None
    body = _SCRIPT_STYLE_RE.sub(" ", html_text)
    chunks: list[str] = []
    total = 0
    for match in _PARAGRAPH_RE.finditer(body):
        text = _clean_title(_TAG_RE.sub(" ", match.group(1)))
        # One- and two-word paragraphs are bylines, timestamps and share
        # prompts, not prose.
        if len(text) < 25:
            continue
        chunks.append(text)
        total += len(text) + 1
        if total >= limit:
            break
    if not chunks:
        return None
    return " ".join(chunks)[:limit].strip() or None


# --- datelines -------------------------------------------------------------
#
# "KYIV, Aug 5 (Reuters) - Russian forces struck a market in Kherson."
#
# The dateline says where the piece was FILED, which is routinely not where the
# event happened -- and GDELT's geocoder has no way to tell the two apart, so a
# story filed from Kyiv about a strike in Kherson can land a pin on Kyiv. This
# is the single largest identifiable source of mis-placement in the measured
# baseline, and reading the dateline is what lets the placement check say "the
# only place this article names is the one it was written in, so do not trust
# that as the event location".
#
# Parsed in steps rather than with one regex: datelines are a typographic
# convention with a dozen house variants, and a single pattern covering them all
# is unreadable and impossible to reason about when it misfires.

# The separator between the dateline and the story. An ASCII hyphen only counts
# when it is spaced, or every hyphenated place name would split.
_DATELINE_SEP_RE = re.compile(r"\s[—–]\s|\s[—–]|[—–]\s|\s-{1,2}\s")

# A trailing "(Reuters)" / "(AP)" / "(Agence France-Presse)".
_DATELINE_AGENCY_RE = re.compile(r"\s*\(([^)]{2,40})\)\s*$")

# A trailing ", Aug 5" / ", August 5, 2026" / ", Aug. 5".
_DATELINE_DATE_RE = re.compile(
    r"\s*,?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}"
    r"(?:\s*,\s*\d{4})?\s*$",
    re.IGNORECASE,
)

# How far into the text a dateline can start. Datelines open the body; anything
# further in is a sentence that happens to contain a dash.
_DATELINE_SEARCH_CHARS = 90

# A dateline place is set in caps by convention. Requiring most of its letters
# to be uppercase is what stops an ordinary sentence opening -- "Officials said
# on Tuesday - according to..." -- from being read as one.
_DATELINE_MIN_UPPER_RATIO = 0.6
_DATELINE_MAX_WORDS = 4


def extract_dateline(text: str) -> str | None:
    """The place an article was filed from, or None when it carries no dateline.

    Returns the place only -- the agency and date are used to *recognise* a
    dateline and then discarded, because what a caller does with this is look
    the place up in the gazetteer.
    """
    if not text:
        return None
    head = text[:_DATELINE_SEARCH_CHARS]
    separator = _DATELINE_SEP_RE.search(head)
    if not separator:
        return None
    candidate = head[: separator.start()].strip().lstrip("\"'“‘")

    candidate = _DATELINE_AGENCY_RE.sub("", candidate)
    candidate = _DATELINE_DATE_RE.sub("", candidate)
    # "BEIRUT, Lebanon" and "CAIRO/BEIRUT" both mean the first one.
    place = re.split(r"\s*[,/]\s*", candidate)[0].strip().rstrip(".")
    if not (2 <= len(place) <= 40) or len(place.split()) > _DATELINE_MAX_WORDS:
        return None

    letters = [c for c in place if c.isalpha()]
    if not letters:
        return None
    upper_ratio = sum(1 for c in letters if c.isupper()) / len(letters)
    if upper_ratio < _DATELINE_MIN_UPPER_RATIO:
        return None
    return place


def _parse_article(html_text: str) -> Article:
    head = html_text[:30000]  # meta tags are always near the top of <head>
    title_match = _OGTITLE_RE.search(head) or _TITLE_TAG_RE.search(head)
    title = _clean_title(title_match.group(1)) if title_match and title_match.group(1).strip() else None

    desc_match = _OGDESC_RE.search(head)
    description = (
        _clean_title(desc_match.group(1)) if desc_match and desc_match.group(1).strip() else None
    )

    excerpt = extract_excerpt(html_text)
    # The dateline opens the body. The description is the fallback because many
    # sites set og:description to the article's own first sentence.
    dateline = extract_dateline(excerpt or "") or extract_dateline(description or "")
    return Article(title=title, description=description, excerpt=excerpt, dateline=dateline)


def _decode_page(resp: httpx.Response) -> str:
    """The page's text, retrying the decode when the declared charset was wrong.

    httpx decodes `resp.text` using the charset the server declares. A page that
    says UTF-8 while serving cp1252 punctuation -- curly quotes and apostrophes,
    which is most of what a headline contains besides letters -- produces U+FFFD
    for each one, and that is unrecoverable afterwards:

        FAA investigates air ?safety incident? involving Trump?s Marine One

    _fix_mojibake cannot help here and correctly declines to try. It repairs the
    opposite failure, text that survived the decode as the wrong characters
    ("â€™"), and its round-trip refuses any result still containing U+FFFD.
    The repair has to happen at the decode, from the original bytes.

    Only ever a fallback: the declared charset is right the overwhelming
    majority of the time, so this reruns only when the first decode actually
    produced replacement characters, and keeps the retry only when it produces
    none.

    latin-1 is deliberately *not* in the retry list, for the reason
    _decode_export spells out at length: it can decode any byte at all, so it
    never fails and would happily turn every legitimate multi-byte sequence on
    a genuinely UTF-8 page into mojibake on the strength of one bad byte.
    cp1252 has undefined bytes and can therefore say no, which is what makes it
    usable as evidence rather than just as a decoder of last resort.
    """
    text = resp.text
    if "�" not in text:
        return text
    # UTF-8 first: bytes that are valid UTF-8 came out wrong because the server
    # declared something else, and re-reading them as UTF-8 is the whole repair.
    # cp1252 second: bytes that are *not* valid UTF-8 on a page that claimed to
    # be are almost always Windows punctuation.
    for codec in ("utf-8", "cp1252"):
        try:
            retried = resp.content.decode(codec)
        except (UnicodeDecodeError, LookupError):
            continue
        if "�" not in retried:
            return retried
    return text


async def _fetch_article(client: httpx.AsyncClient, url: str) -> Article:
    global _article_cache_bytes
    cached = _ARTICLE_CACHE.get(url)
    if cached is not None:
        return cached
    article = _EMPTY_ARTICLE
    async with _TITLE_FETCH_SEM:
        try:
            resp = await client.get(url, headers=_FETCH_HEADERS, timeout=6, follow_redirects=True)
            if resp.status_code == 200:
                article = _parse_article(_decode_page(resp))
        except Exception:  # noqa: BLE001 - a slow/broken site just means no article
            pass
    _ARTICLE_CACHE[url] = article
    _article_cache_bytes += len(url) + sum(
        len(v) for v in (article.title, article.description, article.excerpt, article.dateline) if v
    )
    if _article_cache_bytes > MAX_ARTICLE_CACHE_BYTES:
        _ARTICLE_CACHE.clear()
        _article_cache_bytes = 0
    return article


def _title_url_for(candidate: dict) -> str | None:
    """Which URL to scrape a headline from.

    The row's own source_url when it comes from a newsroom we vouch for --
    otherwise any verified-domain URL from the Mentions table that reported the
    same event. GDELT keeps only one article per event row, and which one is
    essentially arbitrary, so an event covered by Reuters *and* a content farm
    would previously get no headline at all whenever the content farm's URL
    happened to be the one kept. That left most conflict events with no
    description beyond a CAMEO code, which is also what starves the keyword
    classifier and the casualty extractor in event_fusion.
    """
    if _matched_domain(candidate.get("source_url") or ""):
        return candidate["source_url"]
    for url in candidate.get("mention_urls") or ():
        if _matched_domain(url):
            return url
    return None


def _scrape_url_for(candidate: dict) -> str | None:
    """Which URL to read for *placement evidence*, which is a different question.

    _title_url_for above answers "whose reporting will we display and name" --
    an editorial question, and the allowlist is the right answer to it. This
    answers "may we read this page to check whether the pin is in the right
    place", and the allowlist is the wrong answer to that: measured over a live
    window, **zero** of the rows passing the violence gate had an allowlisted
    article attached. Conflict reporting comes from the Jamaica Observer, the
    Manila Times, Middle East Monitor -- regional outlets no masthead list will
    ever hold. Gating the placement check on the allowlist left it reading
    almost nothing, which is why 87% of rows came back unverified.

    A place name in a regional paper is good evidence about *location* even
    where we would not headline from it. What that evidence is allowed to do is
    limited instead: geoverify only ever *moves* a pin on the strength of an
    allowlisted article (`article_trusted` below), while lowering confidence --
    the safe direction -- may come from any newsroom.

    Section-path junk is still excluded: an opinion column or a listicle is not
    a dispatch whatever domain it is on.
    """
    trusted = _title_url_for(candidate)
    if trusted:
        return trusted
    url = candidate.get("source_url") or ""
    if url and not is_non_news_url(url):
        return url
    return None


# How many articles one poll may fetch. Widening the scrape past the allowlist
# turned this from "every eligible row" into a queue: the accumulator holds up
# to _ACCUMULATED_HARD_CAP rows and most of them are now eligible. Sized so a
# poll's scraping finishes well inside the 15-minute interval at 15 concurrent
# fetches, and so an unscraped row waits polls rather than hours -- it survives
# in _ACCUMULATED and is offered again next time.
MAX_SCRAPE_PER_POLL = 400


def _scrape_priority(candidate: dict) -> tuple:
    """Which articles to read first when there are more than the budget allows.

    Imprecisely-placed rows come first. They are the ones a placement check can
    actually improve -- a country-centroid pin has 400 km of uncertainty to
    remove, while a row GDELT already placed on a named town has almost none.
    Reach breaks ties after that: if two rows are equally unplaceable, read the
    one more outlets are carrying.
    """
    imprecise = (candidate.get("geo_precision") or "unknown") in IMPRECISE_PRECISIONS
    return (
        0 if imprecise else 1,
        -(candidate.get("outlet_count") or 0),
        -(candidate.get("mentions") or 0),
    )


def _is_trusted_row(candidate: dict) -> bool:
    """Can this row ever be published as a News pin?

    Only if a newsroom on the allowlist is attached to it -- its own
    source_url, or an article from the Mentions table covering the same event.
    That is the same condition a headline can be scraped under, which is what
    /api/news requires before it will serve anything.

    Deliberately not "has a real_title": a title is downstream evidence of this
    condition rather than a substitute for it, and testing the condition itself
    means a title arriving by any other route can never smuggle an
    unattributable story onto the map.
    """
    return _title_url_for(candidate) is not None


async def _attach_titles(candidates: list[dict]) -> None:
    targets = [(c, _scrape_url_for(c)) for c in candidates]
    targets = [(c, u) for c, u in targets if u]
    async with httpx.AsyncClient(timeout=10) as client:
        articles = await asyncio.gather(*(_fetch_article(client, u) for _, u in targets))
    for (candidate, url), article in zip(targets, articles):
        # Written unconditionally, including as None. "article_excerpt" being
        # present is what tells the placement layer this article was *looked
        # at* -- a row with no excerpt because the fetch failed and a row with
        # no excerpt because nobody tried are different states, and only the
        # first justifies concluding the text names no place.
        candidate["article_excerpt"] = article.excerpt or article.description
        candidate["dateline_place"] = article.dateline
        # Whether the page we just read is one we vouch for. geoverify uses it
        # to decide what this evidence may do: only a trusted article may move
        # a pin, while any article may cast doubt on one.
        trusted = _matched_domain(url) is not None
        candidate["article_trusted"] = trusted
        if trusted:
            # Headline and attribution stay allowlist-only. Reading a regional
            # outlet's page to check a coordinate is not the same as quoting it
            # on the map, and conflating the two is how an unvouched-for
            # newsroom would end up named as this record's source.
            candidate["real_title"] = article.title
            if article.title:
                # Point the record at the article the headline actually came
                # from, so "read the source" opens what is being quoted.
                candidate["source_url"] = url
                candidate["source_name"] = _agency_name(url)
        else:
            candidate.setdefault("real_title", None)


async def _backfill_titles(candidates: list[dict]) -> None:
    try:
        await _attach_titles(candidates)
    except Exception as exc:  # noqa: BLE001 - keep the poller alive
        log.warning("GDELT title backfill failed: %s", exc)
    finally:
        _republish()


# The three SourceStates start() owns, held here so the detached backfill task
# can publish what it scraped. See _republish.
_news_state = None
_conflict_state = None
_officials_state = None


def _republish() -> None:
    """Re-assign state.data so the freshly scraped titles actually reach clients.

    _attach_titles mutates candidate dicts in place, and it runs *after* start()
    has already assigned state.data. SourceState bumps its version only on
    assignment (backend/cache.py), and app.py builds its ETag from that version
    -- so without this the new headlines sat in memory while every client got a
    304 and kept showing the old payload until the next poll 15 minutes later.

    Cheap to be wrong about: re-slicing a few thousand dicts costs far less than
    the scrape that just finished, and a no-op re-assign is harmless.
    """
    if _news_state is None or _conflict_state is None or _officials_state is None:
        return  # backfill fired before start() finished registering
    rows = list(_ACCUMULATED.values())
    # Re-scored, not carried over: the scrape that just finished is exactly what
    # changes the answer -- it attaches the headline and can repoint source_url
    # at the Mentions-table article, which is the outlet the score is mostly
    # about.
    news = _news_slice(rows)
    _score_news(news)
    _news_state.data = news
    _conflict_state.data = rows
    _officials_state.data = list(_ACCUMULATED_OFFICIALS.values())


# --- rolling multi-file window -------------------------------------------


def _decode_export(raw: bytes) -> str:
    """Decodes an export file. UTF-8, replacing only the bytes that are bad.

    Do NOT "improve" this into a Latin-1 fallback. It looks tempting -- the
    files occasionally carry a stray non-UTF-8 byte, and Latin-1 can never
    raise -- but the fallback is all-or-nothing across the whole file: one
    bad byte in 100k lines re-decodes every legitimate multi-byte sequence
    as Latin-1, turning correct place names into "Ã¢â‚¬" mojibake. That was
    measured, not theorised.

    errors="replace" is the right trade: valid UTF-8 (the overwhelming
    majority) stays exact, and only the genuinely undecodable bytes become
    U+FFFD. Note that visible "?" characters in GDELT place names (e.g.
    "La?ij") are literal ASCII 0x3F in the upstream data, not a decoding
    artifact -- nothing here can recover those.
    """
    return raw.decode("utf-8", errors="replace")


# Signatures of text that was UTF-8, then encoded as UTF-8 a second time:
# "î" for "î", "â€™" for "'", "Â " for a non-breaking space. GDELT's exports
# carry this, and so do many of the pages scraped for headlines (a server
# declaring Latin-1 while serving UTF-8). Both land in place names and
# headlines, which is exactly the text that has to be readable here.
#
# Only the *lead* characters are listed. A UTF-8 lead byte misread as a
# single character is always one of these, whichever codec did the misreading
# -- keying on longer sequences like "â€" would match the cp1252 form and
# miss the latin-1 one. Over-matching is harmless: legitimate text like
# French "âme" fails the UTF-8 decode below and is returned untouched, so
# that round-trip, not this check, is what actually guarantees safety.
_MOJIBAKE_MARKERS = ("Ã", "â", "Â")


def _fix_mojibake(text: str | None) -> str | None:
    """Undoes one round of double-encoded UTF-8, when that's clearly what it is.

    Gated on the marker check rather than applied blindly: the round-trip
    below is lossy for legitimate text that merely happens to be Latin-1
    representable, so it must only run on strings showing the actual
    signature. If the repair fails or produces nothing better, the original
    is returned untouched.
    """
    if not text or not any(marker in text for marker in _MOJIBAKE_MARKERS):
        return text
    # cp1252 first, then latin-1. Which one applies depends on how the bytes
    # were misread upstream, and it's observable in the result: cp1252 maps
    # 0x80/0x99 to "EURO SIGN"/"TRADE MARK SIGN" (what the live GDELT data
    # actually shows), latin-1 maps them to C1 control characters. Trying
    # only one silently no-ops on half the cases, because the other half
    # contains characters that codec cannot encode.
    for codec in ("cp1252", "latin-1"):
        try:
            repaired = text.encode(codec).decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            continue
        if "�" not in repaired:
            return repaired
    return text  # not actually double-encoded, or not recoverable -- leave it alone


# --- the Mentions table ----------------------------------------------------
#
# GDELT publishes a second file alongside each export, listing every article
# that mentioned each event. It is the only place a real distinct-outlet count
# exists.
#
# The export file's own NumSources column looks like it should serve: it does
# not. Measured over a 12-hour live window, 99% of rows passing the violence
# gate report NumSources == 1 (max 2), and NumMentions saturates at its
# per-file ceiling of 10. Both are effectively constants on exactly the rows we
# care about, so severity built on them was scoring a lone blog and a story
# carried by forty newsrooms identically.
#
# Cost is small: ~98 KB per 15-minute file against the export's ~65 KB.
MENTIONS_COL_EVENT_ID = 0
MENTIONS_COL_SOURCE_NAME = 4     # the outlet's domain, e.g. "reuters.com"
MENTIONS_COL_IDENTIFIER = 5      # the article URL
MENTIONS_COL_CONFIDENCE = 11

# Guard against one viral story pinning thousands of domains in memory. Well
# above any real corroboration signal -- past a couple of dozen outlets the
# distinction stops carrying information.
_MAX_OUTLETS_TRACKED = 64


def _parse_mentions(text: str) -> dict[str, tuple[set[str], list[str]]]:
    """event id -> (distinct outlet domains, article URLs worth scraping).

    The URL list keeps only verified-domain articles: it exists so an event
    whose kept source_url is a content farm can still get a real headline from
    a newsroom that covered the same event (see _title_url_for).
    """
    out: dict[str, tuple[set[str], list[str]]] = {}
    for row in csv.reader(io.StringIO(text), delimiter="\t"):
        if len(row) <= MENTIONS_COL_CONFIDENCE:
            continue
        event_id = row[MENTIONS_COL_EVENT_ID]
        domain = (row[MENTIONS_COL_SOURCE_NAME] or "").strip().lower()
        if not event_id or not domain:
            continue
        outlets, urls = out.setdefault(event_id, (set(), []))
        if len(outlets) < _MAX_OUTLETS_TRACKED:
            outlets.add(domain)
        article = (row[MENTIONS_COL_IDENTIFIER] or "").strip()
        if article and len(urls) < 4 and _matched_domain(article):
            urls.append(article)
    return out


async def _fetch_one_mentions(client: httpx.AsyncClient, url: str) -> dict[str, tuple[set[str], list[str]]]:
    try:
        resp = await client.get(url)
        if resp.status_code == 404:
            return {}
        resp.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            text = _decode_export(zf.read(zf.namelist()[0]))
        return _parse_mentions(text)
    except Exception as exc:  # noqa: BLE001 - supplementary; never sink the poll
        log.debug("GDELT mentions fetch failed (%s): %s", url, exc)
        return {}


async def _fetch_one_export(client: httpx.AsyncClient, url: str) -> list[dict]:
    try:
        resp = await client.get(url)
        if resp.status_code == 404:
            return []  # slot not published / skipped -- not fatal
        resp.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            text = _decode_export(zf.read(zf.namelist()[0]))
        return _parse_events(text)
    except Exception as exc:  # noqa: BLE001 - one bad file shouldn't sink the whole window
        log.debug("GDELT window file fetch failed (%s): %s", url, exc)
        return []


def _dedup_key(ev: dict) -> str:
    # Two GDELT rows citing the same article (different actor pairs/CAMEO
    # codes) collapse to one marker, keeping the higher-mention row -- an
    # intentional declutter trade-off. Rows without a source_url fall back
    # to their own event id so they aren't accidentally merged together.
    return ev.get("source_url") or f"evt:{ev.get('event_id')}"


def _conflict_key(ev: dict) -> str:
    """Dedup key for the conflict feed: one row per (article, place).

    _dedup_key keeps exactly one row per article, which is right for a news
    list -- one headline, one pin. It is wrong for a conflict map: an article
    reporting strikes on three cities is coded by GDELT as three rows, and
    collapsing them to one discards two real events.

    Measured over a 12-hour live window, keying on (article, place) instead
    recovers 73% more rows that pass the violence gate -- 88 becomes 152.
    """
    return f"{_dedup_key(ev)}|{ev.get('geo_feature_id') or ''}"


async def _fetch_window(
    at: datetime | None = None, window_minutes: int = WINDOW_MINUTES
) -> list[dict]:
    """One rolling window of GDELT export files, rolled up and deduped.

    `at=None` (the poller's case) reads GDELT's own lastupdate.txt and takes the
    window ending at the newest published file. Passing an explicit `at` reads a
    historical window instead: GDELT keeps v2 files indefinitely, and
    backend/scripts/eval_placement.py needs windows aligned to the dates its
    ground-truth dataset actually covers, which are months behind live.
    """
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        if at is None:
            latest_url = await _latest_export_url(client)
            latest_dt = _parse_latest_ts(latest_url)
        else:
            # GDELT publishes on exact 15-minute boundaries; an arbitrary
            # timestamp would build URLs for files that do not exist and read
            # back an empty window rather than an error.
            latest_dt = at.replace(
                minute=(at.minute // FILE_STEP_MINUTES) * FILE_STEP_MINUTES,
                second=0,
                microsecond=0,
            )
        export_urls = _window_urls(latest_dt, window_minutes)
        mention_urls = [u.replace(".export.CSV.zip", ".mentions.CSV.zip") for u in export_urls]
        results, mention_maps = await asyncio.gather(
            asyncio.gather(*(_fetch_one_export(client, u) for u in export_urls)),
            asyncio.gather(*(_fetch_one_mentions(client, u) for u in mention_urls)),
        )

    outlets_by_event: dict[str, set[str]] = {}
    urls_by_event: dict[str, list[str]] = {}
    for chunk in mention_maps:
        for event_id, (domains, urls) in chunk.items():
            merged_set = outlets_by_event.setdefault(event_id, set())
            if len(merged_set) < _MAX_OUTLETS_TRACKED:
                merged_set.update(domains)
            bucket = urls_by_event.setdefault(event_id, [])
            for url in urls:
                if len(bucket) < 4 and url not in bucket:
                    bucket.append(url)

    merged: dict[str, dict] = {}
    for file_events in results:
        for ev in file_events:
            key = _conflict_key(ev)
            existing = merged.get(key)
            if not existing or ev["mentions"] > existing["mentions"]:
                merged[key] = ev

    for ev in merged.values():
        domains = outlets_by_event.get(ev["event_id"]) or set()
        ev["outlet_count"] = len(domains)
        ev["mention_urls"] = urls_by_event.get(ev["event_id"]) or []
        # *Who* carried it, not just how many did. The domains were already
        # being collected to produce outlet_count and then thrown away, which
        # left a popup saying "carried by 7 independent outlets" and unable to
        # name one of them. Capped and ranked by rank_outlets -- see outlets.py.
        labels = [outlet_label(d) for d in domains]
        # The row's own article leads the list -- it is the one the popup links
        # to and the one the headline was scraped from, so a list that omitted
        # it read as contradicting the link right below it.
        ev["outlets"] = rank_outlets(labels, preferred=label_for_url(ev.get("source_url")))
        # Which of them are editorially-staffed newsrooms we already vouch for.
        # This is the same allowlist check the single source_url gets, applied
        # across every outlet that carried the story instead -- so a
        # wire-service pickup counts even when the row we happened to keep
        # cites a content farm. Derived from the labels rather than from the
        # raw domains so a subdomain (edition.cnn.com) counts too.
        ev["verified_outlets"] = sorted(set(labels) & _VERIFIED_LABELS)
    return list(merged.values())


def _parse_date_added(s: str | None) -> datetime | None:
    try:
        return datetime.strptime(s, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _parse_event_date(s: str | None) -> datetime | None:
    """SQLDATE -- when the event is reported to have *happened*."""
    try:
        return datetime.strptime(str(s)[:8], "%Y%m%d").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


# --- is this a report of something recent ----------------------------------
#
# Every retention rule above is keyed on DATEADDED, which is when GDELT
# ingested the article -- not when anything happened. That is the right key for
# "how long do we keep this", and completely the wrong one for "is this news".
# An archival re-crawl and a magazine retrospective both arrive with DATEADDED
# = now, so the windows above see them as breaking.
#
# Three independent signals, because no one of them catches everything:
#
#   lag        SQLDATE far behind DATEADDED. Catches a correctly-dated
#              retrospective, and misses the ones GDELT dates today.
#   section    the publisher filed it under /magazine/, /opinion/, /analysis/.
#              Catches commentary the lag gate cannot see -- this is what the
#              Atlantic 9/11 retrospective tripped, SQLDATE and all.
#   URL date   the publication date in the URL path. The only signal that is
#              independent of GDELT entirely, and the only one that catches an
#              ordinary 2019 news report re-crawled today.
#
# Each keeps its own counter. A single fused counter would tell you the gate
# dropped 40 rows and nothing about which heuristic started over-matching,
# which is precisely the question worth asking when one of them drifts.

# Shared with event_fusion, which imports it -- one definition of how much
# reporting lag stops being lag and starts being history. Deliberately generous:
# this is a sanity gate, not the map's recency window. Measured over a 12h live
# window, 96.6% of violent rows are same-day and 2.3% exceed 30 days.
MAX_REPORT_LAG_DAYS = 30

# How stale a URL's own publication date may be before the row is treated as an
# archival re-crawl. Months, not days: a URL carries year and month reliably and
# the day only sometimes, and the cases this exists to catch are years old, not
# weeks. Only consulted when NEWS_URL_DATE_GATE is on.
MAX_URL_AGE_MONTHS = 3

# The URL-date gate ships off. It is the only one of the three whose
# false-positive rate has not been measured against live data, and the failure
# mode is silent deletion of real breaking news from a publisher whose URL
# scheme surprises us. backend/scripts/probe_gdelt.py prints every row it would
# reject; read that list against a fresh window before turning this on.
# Same env-flag pattern as event_fusion's COUNTRY_CENTROID_POLICY.
URL_DATE_GATE = os.getenv("NEWS_URL_DATE_GATE", "").lower() in ("1", "true", "on", "yes")

_dropped_retrospective = 0
_dropped_non_news = 0
_dropped_stale_url = 0


def report_lag_days(event_date: str | None, date_added: str | None) -> int | None:
    """Days between the event happening and GDELT ingesting the article."""
    occurred = _parse_event_date(event_date)
    added = _parse_date_added(date_added)
    if occurred is None or added is None:
        return None
    return (added - occurred).days


def _is_current_report(ev: dict) -> bool:
    """Does this row describe something that just happened?

    Applied to the News and Officials feeds. The Conflict layer runs its own
    equivalent in event_fusion (it needs the parsed date as well as the verdict,
    so it cannot simply call this), against the same MAX_REPORT_LAG_DAYS.
    """
    global _dropped_retrospective, _dropped_non_news, _dropped_stale_url

    lag = report_lag_days(ev.get("event_date"), ev.get("date_added"))
    if lag is not None and lag > MAX_REPORT_LAG_DAYS:
        _dropped_retrospective += 1
        return False

    # source_url, not any of the mention URLs: it is the one the reader clicks,
    # and _attach_titles may have repointed it since this row was stored --
    # which is a reason to re-run this check per poll rather than once at
    # accumulation. See where it is called from.
    url = ev.get("source_url")
    if is_non_news_url(url):
        _dropped_non_news += 1
        return False

    if URL_DATE_GATE:
        months = url_age_months(url)
        if months is not None and months > MAX_URL_AGE_MONTHS:
            _dropped_stale_url += 1
            return False

    return True


def recency_drop_counts() -> dict[str, int]:
    """Cumulative per-heuristic drop counts, for the poll log."""
    return {
        "retrospective": _dropped_retrospective,
        "commentary": _dropped_non_news,
        "stale_url": _dropped_stale_url,
    }


# --- cross-reference against ACLED/UCDP -----------------------------------
#
# A verified-domain headline is still just one outlet's report -- flagging
# which ones are independently corroborated by a ground-truth conflict
# record (ACLED and/or UCDP, already polled by backend/sources/acled.py)
# gives a reader a real confidence signal. Same thresholds as
# conflict_watch.py's own GDELT<->UCDP matching (duplicated rather than
# imported -- not worth coupling two sibling source modules over two
# numbers).
_MATCH_DAYS = 2
_MATCH_DEGREES = 0.5


def _parse_acled_date(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.strptime(s[:8], "%Y%m%d").replace(tzinfo=timezone.utc)
    except ValueError:
        try:
            return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
        except ValueError:
            return None


def _corroborated_by(ev: dict, acled_rows: list[dict]) -> list[str]:
    lat, lon = ev.get("lat"), ev.get("lon")
    added = _parse_date_added(ev.get("date_added"))
    if lat is None or lon is None or added is None:
        return []
    matched: set[str] = set()
    for row in acled_rows:
        row_date = _parse_acled_date(row.get("date"))
        if not row_date or abs((added - row_date).days) > _MATCH_DAYS:
            continue
        row_lat, row_lon = row.get("lat"), row.get("lon")
        if not isinstance(row_lat, (int, float)) or not isinstance(row_lon, (int, float)):
            continue
        if abs(row_lat - lat) > _MATCH_DEGREES or abs(row_lon - lon) > _MATCH_DEGREES:
            continue
        matched.add(row.get("source") or "acled")
    return sorted(matched)


# Persists across polls so items accumulate instead of being wholesale-
# replaced every 15 minutes; pruned by age (below) and by a hard cap so a
# very newsy window can't grow this unboundedly.
_ACCUMULATED: dict[str, dict] = {}

# The same, for the Officials & Diplomacy layer. A second store rather than a
# flag on the first: the two overlap only partially (most diplomacy is quad
# class 1, which is not conflict at all) and they are pruned and served
# independently.
_ACCUMULATED_OFFICIALS: dict[str, dict] = {}


def _is_officials_row(ev: dict) -> bool:
    """Gate for rows entering the Officials & Diplomacy layer.

    Four conditions, all required:

      1. A diplomatic CAMEO root (cameo.DIPLOMATIC_ROOT_CODES -- everything
         except the violence roots 18/19/20, which belong to the conflict
         layer; an event should appear in exactly one of the two).
      2. An official actor. CAMEO's own type codes carry this: GOV/ELI is a
         head of state or minister, LEG/JUD/OPP/PTY the rest of a political
         system, MIL a defence ministry, IGO the UN or NATO. A named known
         group counts too, since CAMEO frequently leaves the type blank for
         organisations it has a code for.
      3. A country on at least one actor. This is what makes it *country*
         officials rather than a mayor or a company.
      4. Not one country talking to itself -- see _is_cross_border.
      5. A verified-domain article, same rule the news feed applies. An
         unattributable claim about what a president said is worth less than
         nothing.
      6. A report of something recent rather than a retrospective or a
         commentary piece -- see _is_current_report.

    Unlike the news path, this gate runs at accumulation rather than at serve
    time, and that is safe here: _ACCUMULATED_OFFICIALS has exactly one
    consumer, so rejecting early keeps stale rows out of the cap and out of the
    archive as well as off the map.
    """
    if ev.get("event_root_code") not in cameo.DIPLOMATIC_ROOT_CODES:
        return False
    official = (
        ev.get("actor1_type") in cameo.OFFICIAL_ACTOR_TYPES
        or ev.get("actor2_type") in cameo.OFFICIAL_ACTOR_TYPES
        or bool(ev.get("actor1_group") or ev.get("actor2_group"))
    )
    if not official:
        return False
    return _is_cross_border(ev) and _is_trusted_row(ev) and _is_current_report(ev)


def _is_cross_border(ev: dict) -> bool:
    """Is this a country acting outward, rather than domestic politics?

    Narrowing the actor types is not enough on its own. CAMEO fills a country
    code for domestic actors exactly as readily as for foreign ones, and it
    codes US states and Canadian provinces as GOV -- so a live window still
    produced "Democratic Party praised Michigan (government)" and "Bangladesh
    cooperated diplomatically with Prime Minister (government)". Neither is
    what a reader opens a diplomacy layer to see.

    Two rules, matching the two shapes a real row takes:

      both actors carry a country  -- they must differ. This is the summit,
                                      the state visit, the demand made of a
                                      neighbour: the layer's core case.
      only one carries a country   -- the other slot must be empty, i.e. a
                                      national actor acting with no coded
                                      counterpart. "Israel (government)
                                      threatened the use of force" is exactly
                                      that, and is precisely what the layer is
                                      for; "X praised Michigan" is not.

    The known cost: a genuinely cross-border act whose counterpart is an
    individual CAMEO left uncoded (the US sanctioning a named Brazilian
    diplomat) is rejected. Accepted deliberately -- the alternative admits the
    entire domestic political blotter of whichever media market GDELT indexed
    most heavily, which is the failure the conflict layer already had to fix
    once.
    """
    country1, country2 = ev.get("actor1_country"), ev.get("actor2_country")
    if country1 and country2:
        return country1 != country2
    if not (country1 or country2):
        return False
    # Exactly one country. The uncoded side must also be unnamed.
    return not (ev.get("actor2") if country1 else ev.get("actor1"))


def _news_age_hours(ev: dict, now: datetime) -> float:
    added = _parse_date_added(ev.get("date_added"))
    if added is None:
        return 0.0  # undated: treat as fresh rather than burying it at the bottom
    return max((now - added).total_seconds() / 3600.0, 0.0)


def _news_rank(ev: dict, now: datetime) -> float:
    """Reach, decayed by age. See NEWS_HALF_LIFE_HOURS for why not raw reach.

    The +1 keeps a zero-mention row rankable: over a 24h window a story that
    has only just been ingested legitimately has no mention count yet, and
    multiplying by a flat zero would send every one of them to the bottom of the
    list regardless of how recent it is.
    """
    reach = (ev.get("mentions") or 0) + 1
    return reach * 0.5 ** (_news_age_hours(ev, now) / NEWS_HALF_LIFE_HOURS)


def _news_slice(rows: list[dict]) -> list[dict]:
    """The top-NEWS_MAX_ITEMS list /api/news serves, ranked by decayed reach.

    Collapsed back to one row per article first, because the accumulator is
    keyed per (article, place) for the conflict layer's benefit and a news list
    wants one entry per headline.

    Restricted to trusted rows -- same rule the retention split applies. Only a
    verified-domain row can ever be served (app.py requires a real_title, and
    titles come only from the allowlist), so letting untrusted rows compete for
    the cap would spend slots on items that can never be shown.

    The recency gate runs here rather than at accumulation, and the asymmetry
    with the officials path below is deliberate. _ACCUMULATED is shared with
    event_fusion, which applies its own already-correct gates; filtering rows
    out of the store would change the conflict layer's input as a side effect of
    a news fix. Running per-poll also re-tests source_url *after* _attach_titles
    has had a chance to repoint it at a Mentions-table article -- the URL the
    reader actually clicks is the one that has to pass.
    """
    now = datetime.now(timezone.utc)
    by_article: dict[str, dict] = {}
    for ev in rows:
        if not _is_trusted_row(ev) or not _is_current_report(ev):
            continue
        key = _dedup_key(ev)
        existing = by_article.get(key)
        if not existing or ev["mentions"] > existing["mentions"]:
            by_article[key] = ev
    return sorted(
        by_article.values(),
        # event_id breaks ties so two rows with identical reach and timestamp
        # can't swap places between polls and churn the marker layer.
        key=lambda d: (_news_rank(d, now), str(d.get("event_id") or "")),
        reverse=True,
    )[:NEWS_MAX_ITEMS]


def _score_news(items: list[dict]) -> None:
    """Attach the reliability fields the News popup reads.

    A news pin used to say who published a story and how long ago, and nothing
    at all about whether that publisher is a wire service or a domain registered
    last week -- while the conflict pin sitting next to it, often coded from the
    very same article, showed a scored "How much to trust this" panel. Same
    evidence, two different standards of disclosure.

    Scored by the same module the conflict layer uses, so the two bars are the
    same measurement. See reliability.assess_news for what it translates.

    Mutates in place. These dicts are the accumulator's own -- _news_slice hands
    back references, not copies -- which is deliberate and is how corroboration
    is already attached: the fields survive into the next poll and are simply
    recomputed over it.
    """
    # Imported here rather than at module scope: reliability.py reads
    # MAX_REPORT_LAG_DAYS out of this module, and a top-level import in both
    # directions cannot resolve -- whichever loads first sees the other half
    # built.
    from backend.sources import reliability

    for item in items:
        item.update(reliability.assess_news(item))


def _accumulate(store: dict[str, dict], rows: list[dict]) -> None:
    """Merge this poll's rows into a persistent accumulator.

    The windows overlap by design (a 120-minute read every 15 minutes), so most
    rows arriving here are already held. What survives from the prior copy is
    everything that was *earned* over time rather than published in the file:
    a scraped headline, the running outlet tally, and the first-seen stamp.
    """
    now = time.time()
    for ev in rows:
        key = _conflict_key(ev)
        prior = store.get(key)
        # When we first saw this row. Stamped here rather than downstream in
        # event_fusion so that it rides into the gdelt_conflict snapshot and
        # therefore survives a restart: rehydrating without it made every
        # restored row report an ingest time of "whenever the process booted",
        # which is not a fact about the event. Distinct from date_added (when
        # GDELT ingested the article) and from dt (when it happened) -- this is
        # the only sub-day timestamp that belongs to this application.
        ev["_seen_at"] = prior.get("_seen_at", now) if prior else now
        if prior:
            if prior.get("real_title") and not ev.get("real_title"):
                # Carry an already-backfilled title (and the URL it came from)
                # forward rather than re-scraping it.
                ev["real_title"] = prior["real_title"]
                ev["source_url"] = prior.get("source_url") or ev.get("source_url")
                ev["source_name"] = prior.get("source_name") or ev.get("source_name")
            # The scraped text carries forward on the same terms as the title:
            # it was earned by a network fetch, not published in the file, and
            # losing it every 15 minutes would re-scrape the whole accumulator
            # and leave the placement layer permanently working from nothing.
            # Keyed on presence rather than truthiness -- "fetched, found no
            # excerpt" must not be overwritten by "not fetched yet", since the
            # first is what licenses a dateline-only verdict.
            for field in ("article_excerpt", "dateline_place", "article_trusted"):
                if field in prior and field not in ev:
                    ev[field] = prior[field]
            # Outlet counts accumulate rather than reset. Each mentions file
            # covers one 15-minute slot, so a story picked up over six hours
            # appears in six of them with a handful of outlets each -- taking
            # only the latest window's count would permanently understate how
            # widely an event was actually reported, which is the single input
            # the severity score leans on hardest.
            ev["outlet_count"] = max(ev.get("outlet_count") or 0, prior.get("outlet_count") or 0)
            merged_verified = set(ev.get("verified_outlets") or []) | set(prior.get("verified_outlets") or [])
            ev["verified_outlets"] = sorted(merged_verified)
            # Same reasoning for the names: an outlet that carried the story two
            # windows ago still carried it. Re-ranked rather than concatenated,
            # so the union of two capped lists is itself capped and still leads
            # with the mastheads a reader recognises.
            ev["outlets"] = rank_outlets(
                (ev.get("outlets") or []) + (prior.get("outlets") or []),
                preferred=label_for_url(ev.get("source_url")),
            )
        store[key] = ev


def _prune(store: dict[str, dict], label: str) -> None:
    """Age rows out of an accumulator, then enforce the hard cap."""
    now = datetime.now(timezone.utc)
    news_cutoff = now - timedelta(minutes=NEWS_RETENTION_MINUTES)
    fusion_cutoff = now - timedelta(minutes=FUSION_RETENTION_MINUTES)
    for key in list(store):
        row = store[key]
        added = _parse_date_added(row.get("date_added"))
        if not added:
            continue  # undated rows are only ever evicted by the hard cap below
        # A row earns the long window by being publishable at all. Everything
        # else is fusion input only, and fusion keeps its own 3-day copy.
        if added < (news_cutoff if _is_trusted_row(row) else fusion_cutoff):
            del store[key]

    if len(store) > _ACCUMULATED_HARD_CAP:
        # Oldest first, NOT lowest-mentions first. The old rule made sense when
        # this list only backed /api/news, but event_fusion now reads the same
        # accumulator, and evicting by mention count deletes precisely the
        # low-profile local violence reports the conflict layer exists to
        # surface.
        overflow = sorted(
            store.items(),
            key=lambda kv: kv[1].get("date_added") or "",
        )[: len(store) - _ACCUMULATED_HARD_CAP]
        for key, _ in overflow:
            del store[key]
        log.warning("GDELT %s accumulator hit its cap (%d); evicted %d oldest rows",
                    label, _ACCUMULATED_HARD_CAP, len(overflow))


async def _fetch() -> tuple[list[dict], list[dict], list[dict]]:
    """Returns (news slice, full conflict window, officials window).

    Three consumers with different needs, one fetch. /api/news wants the most
    widely reported stories -- ranking is the whole point of a news feed. The
    conflict layer wants the opposite: a village massacre carried by two local
    outlets must not be deleted by a popularity cut before event_fusion's
    violence gate has even looked at it. Measured over a 12-hour window, the
    old top-400 cut was discarding 92% of the rows that pass that gate,
    including strikes on Kyiv, Kherson and Jerusalem, each reported by a single
    outlet. The officials window wants a third thing again -- statements and
    meetings, most of which are not conflict rows at all.
    """
    new_items = await _fetch_window()
    # Routed, not filtered: one row can legitimately belong to both windows (a
    # threat is quad 3 *and* diplomacy), and the duplicate marker that would
    # otherwise cause is resolved the same way merged news is -- the officials
    # record names the news id it owns, and the map suppresses that marker.
    _accumulate(_ACCUMULATED, [ev for ev in new_items if ev.get("quad_class") in (3, 4)])
    _accumulate(_ACCUMULATED_OFFICIALS, [ev for ev in new_items if _is_officials_row(ev)])
    _prune(_ACCUMULATED, "conflict")
    _prune(_ACCUMULATED_OFFICIALS, "officials")

    conflict_rows = list(_ACCUMULATED.values())
    officials_rows = list(_ACCUMULATED_OFFICIALS.values())
    result = _news_slice(conflict_rows)

    # Recomputed fresh every poll (never accumulated/stale) since ACLED/UCDP
    # data moves independently of GDELT's own window.
    acled_rows = (registry.get("acled").data if registry.has("acled") else []) or []
    for ev in result:
        matches = _corroborated_by(ev, acled_rows)
        ev["corroborated"] = bool(matches)
        ev["corroborated_by"] = matches
    # After the corroboration pass, not before: a matching ACLED record is one
    # of the things the score is made of.
    _score_news(result)

    return result, conflict_rows, officials_rows


async def _rehydrate() -> None:
    """Refill both accumulators from Postgres after a restart.

    Each poll only reads WINDOW_MINUTES of export files, so without this the
    news layer restarts at two hours deep and takes a full day to grow back
    into the 24-hour window the UI advertises -- and every deploy resets it.
    The same reasoning event_fusion._rehydrate_violent_gdelt already applies to
    its 3-day violence window; the entity table keeps `gdelt_conflict` for four
    days (config.ENTITY_STALE_AFTER), comfortably outliving both.

    Rows fetched live on the first poll overwrite these, so this only fills
    gaps. _prune runs immediately afterwards, so anything already past its own
    window is dropped rather than restored.
    """
    # app.py starts init_pool as a background task rather than awaiting it, so
    # without this the read below races the connection and returns [] -- which
    # is indistinguishable from "nothing stored" and left the window cold on
    # every restart while appearing to work.
    if not await storage.wait_for_pool():
        log.info("No storage available; the GDELT window starts from the live feed only")
        return
    try:
        conflict_rows = await storage.entity_latest("gdelt_conflict")
        officials_rows = await storage.entity_latest("gdelt_officials")
    except Exception as exc:  # noqa: BLE001 - a cold start is not a failure
        log.warning("Could not rehydrate the GDELT window: %s", exc)
        return
    for store, rows in ((_ACCUMULATED, conflict_rows), (_ACCUMULATED_OFFICIALS, officials_rows)):
        for row in rows:
            # Re-run the officials gate on restore. Rows were written to the
            # archive under whatever rules were in force when they were
            # accumulated, and this path writes straight into the store -- so
            # without this, every deploy resurrects a full retention window of
            # rows that the current gate would reject, and the fix looks
            # intermittently broken for a day afterwards. The conflict store
            # needs no equivalent: event_fusion re-gates everything it reads.
            if store is _ACCUMULATED_OFFICIALS and not _is_officials_row(row):
                continue
            key = _conflict_key(row)
            if key not in store:
                store[key] = row
    _prune(_ACCUMULATED, "conflict")
    _prune(_ACCUMULATED_OFFICIALS, "officials")
    if _ACCUMULATED or _ACCUMULATED_OFFICIALS:
        log.info("Rehydrated %d conflict and %d diplomatic rows from storage",
                 len(_ACCUMULATED), len(_ACCUMULATED_OFFICIALS))


async def start():
    global _news_state, _conflict_state, _officials_state
    state = registry.register("gdelt", key_configured=True)  # no key required
    # The unranked, untruncated window, for event_fusion. A second registry
    # entry rather than a module-level accessor: every cross-source read in
    # this app already goes through the registry (this module reads acled that
    # way, app.py reads event_fusion that way), and registry.has() is what lets
    # event_fusion tolerate startup ordering.
    conflict_state = registry.register("gdelt_conflict", key_configured=True)
    # The diplomatic window, read by officials.py the same way. Registered here
    # rather than there so it exists from the first poll and officials.py's own
    # _wait_for_inputs has something to wait on.
    officials_state = registry.register("gdelt_officials", key_configured=True)
    # Shared with the detached title backfill so it can publish what it scraped
    # instead of mutating already-served dicts -- see _republish.
    _news_state, _conflict_state, _officials_state = state, conflict_state, officials_state
    await _rehydrate()
    while True:
        try:
            candidates, conflict_rows, officials_rows = await _fetch()
            state.data = candidates
            conflict_state.data = conflict_rows
            officials_state.data = officials_rows
            state.last_success = conflict_state.last_success = time.time()
            officials_state.last_success = state.last_success
            state.last_error = conflict_state.last_error = None
            officials_state.last_error = None
            with_titles = sum(1 for d in candidates if d.get("real_title"))
            dropped = recency_drop_counts()
            log.info(
                "GDELT: %d news events (%d with a real title, rest backfilling); "
                "%d rows in the conflict window; %d in the diplomatic window. "
                "Recency gate (cumulative): %d retrospective, %d commentary, %d stale-URL",
                len(candidates), with_titles, len(conflict_rows), len(officials_rows),
                dropped["retrospective"], dropped["commentary"], dropped["stale_url"],
            )
            await storage.record_snapshot("gdelt", candidates, "event_id")
            # Persisted so event_fusion can rehydrate its 3-day violence
            # accumulator after a restart instead of starting from the last
            # two hours and taking three days to refill.
            await storage.record_snapshot("gdelt_conflict", conflict_rows, "event_id")
            await storage.record_snapshot("gdelt_officials", officials_rows, "event_id")
            await storage.record_source_health("gdelt", len(candidates), True)
            # Backfill across both windows, not just the news slice: a conflict
            # pin with no headline shows a bare CAMEO label and gives
            # event_fusion's classifier and casualty extractor nothing to work
            # with, and an officials pin with no headline cannot say what the
            # official actually said. _title_url_for finds a verified-domain
            # article for each, from the Mentions table when the row's own
            # source_url isn't one.
            #
            # Keyed by identity through a dict so a row in both windows (a
            # threat is conflict *and* diplomacy) is scraped once.
            # Either field missing means this row has not been through the
            # current scrape. Testing both rather than the title alone matters
            # across an upgrade: rows rehydrated from before the scrape started
            # keeping body text carry a title and no excerpt, and a title-only
            # test would leave the placement layer blind to them forever.
            to_fetch = list({
                id(c): c
                for c in conflict_rows + officials_rows
                if ("real_title" not in c or "article_excerpt" not in c) and _scrape_url_for(c)
            }.values())
            # _scrape_url_for admits far more rows than the allowlist did (that
            # is the point), and the accumulator can hold tens of thousands --
            # so this is now a queue to be drained across polls rather than a
            # list to be finished. Unscraped rows survive in _ACCUMULATED and
            # come back next poll, so the only decision here is what to do first.
            to_fetch.sort(key=_scrape_priority)
            to_fetch = to_fetch[:MAX_SCRAPE_PER_POLL]
            # Skipped while a previous backfill is still running: title
            # scraping is network-bound and can outlast a poll interval, and
            # launching a second pass over an overlapping candidate set would
            # just contend for the same semaphore. The next poll picks up
            # whatever is still missing anyway, since a scraped title is
            # carried forward in _ACCUMULATED.
            #
            # The task is also held in a module-level reference rather than
            # discarded -- asyncio only weakly references running tasks, so a
            # bare create_task() can be garbage collected mid-scrape.
            global _backfill_task
            if to_fetch and (_backfill_task is None or _backfill_task.done()):
                _backfill_task = asyncio.create_task(_backfill_titles(to_fetch))
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("GDELT fetch failed: %s", exc)
        await asyncio.sleep(config.GDELT_POLL_INTERVAL)
