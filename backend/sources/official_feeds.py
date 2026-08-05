"""Governments and international bodies, in their own words.

GDELT tells us what newsrooms reported an official said. This module reads what
the official actually published -- the press feeds ministries and leaders' own
offices maintain. The two are different kinds of evidence and the map labels
them differently: a wire report has been through an editor, a press release has
not. What a primary source gives instead is certainty about attribution, which
is the thing GDELT's machine coding is weakest at.

Deliberately kept small and hand-curated. Every URL in FEEDS below was fetched
and confirmed to return parseable RSS or Atom before being added; a feed that
starts 404ing is logged and skipped, never silently retried forever, because a
diplomacy layer quietly missing one government is worse than one that says so.

No new dependency: RSS 2.0 and Atom are both parsed with the standard library's
ElementTree. feedparser would be one more thing to pin for two element names.
"""

import asyncio
import html
import logging
import re
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree

import httpx

from backend import storage
from backend.cache import registry

log = logging.getLogger("osint-globe.official_feeds")

# Matched against the same 24h window the news layer uses, so the two layers
# agree about what "recent" means.
RETENTION_SECONDS = 24 * 3600
REFRESH_INTERVAL = 600  # 10 minutes; press offices publish in bursts, not continuously
FAILURE_RETRY_INTERVAL = 60  # scaled by consecutive failures, capped at REFRESH_INTERVAL

# Per-feed item cap. These feeds are already short (10-30 entries); the cap only
# guards against one of them changing shape upstream.
MAX_ITEMS_PER_FEED = 40

# Where each publisher's statements are plotted. A press release has no
# location of its own, so this is the seat of the institution issuing it --
# which is the honest placement: "this was said in Moscow", not "this happened
# in Moscow". The frontend labels these pins accordingly.
#
# `government` is what the popup prints as the publisher. `country` matches the
# country-card matcher's vocabulary (see event_fusion._country_from_location).
FEEDS = [
    {
        "key": "white_house",
        "government": "The White House",
        "country": "United States",
        "url": "https://www.whitehouse.gov/news/feed/",
        "lat": 38.8977, "lon": -77.0365,
    },
    {
        "key": "us_dod",
        "government": "US Department of Defense",
        "country": "United States",
        "url": "https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945&max=20",
        "lat": 38.8719, "lon": -77.0563,
    },
    {
        "key": "uk_fcdo",
        "government": "UK Foreign, Commonwealth & Development Office",
        "country": "United Kingdom",
        "url": (
            "https://www.gov.uk/search/news-and-communications.atom"
            "?organisations%5B%5D=foreign-commonwealth-development-office"
        ),
        "lat": 51.5029, "lon": -0.1281,
    },
    {
        "key": "kremlin",
        "government": "Office of the President of Russia",
        "country": "Russia",
        "url": "http://en.kremlin.ru/events/president/news/feed",
        "lat": 55.7520, "lon": 37.6175,
    },
    {
        "key": "ec_presscorner",
        "government": "European Commission",
        "country": "Belgium",
        "url": "https://ec.europa.eu/commission/presscorner/api/rss?language=en&pagesize=20",
        "lat": 50.8443, "lon": 4.3826,
    },
    {
        "key": "un_news",
        "government": "United Nations",
        "country": "United States",
        "url": "https://news.un.org/feed/subscribe/en/news/all/rss.xml",
        "lat": 40.7489, "lon": -73.9680,
    },
    {
        "key": "un_press",
        "government": "UN Office of the Spokesperson",
        "country": "United States",
        "url": "https://press.un.org/en/rss.xml",
        "lat": 40.7489, "lon": -73.9680,
    },
    {
        "key": "iaea",
        "government": "International Atomic Energy Agency",
        "country": "Austria",
        "url": "https://www.iaea.org/feeds/topnews",
        "lat": 48.2345, "lon": 16.4165,
    },
]

# Browsers-only feeds are common; several of these 403 a bare httpx UA.
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
}

_ATOM = "{http://www.w3.org/2005/Atom}"
_DC = "{http://purl.org/dc/elements/1.1/}"

# What kind of act the headline describes, for the map glyph. Same vocabulary
# cameo.diplomatic_kind produces, so one layer can render both origins.
#
# Ordered: first match wins, most consequential first. A release titled
# "Sanctions imposed after talks collapse" is a rupture, not a meeting.
_KIND_PATTERNS = (
    ("rupture", re.compile(
        r"\b(sanction|sanctions|expel|expels|expelled|expulsion|recall(?:s|ed)? (?:its |the )?ambassador"
        r"|sever(?:s|ed)? (?:diplomatic )?(?:ties|relations)|suspend(?:s|ed)? (?:diplomatic )?relations"
        r"|embargo|withdraw(?:s|n|al) from)\b", re.I)),
    ("threat", re.compile(
        r"\b(threat|threaten(?:s|ed|ing)?|ultimatum|warns? of|retaliat\w*|consequences)\b", re.I)),
    ("agreement", re.compile(
        r"\b(agreement|accord|treaty|memorandum|sign(?:s|ed|ing)|ratif\w+|ceasefire|truce|deal)\b", re.I)),
    ("meeting", re.compile(
        r"\b(meet(?:s|ing|ings)?|talks|summit|visit(?:s|ed|ing)?|delegation|call with|phone call"
        # Kremlin and several ministries write "Telephone conversation with X"
        # rather than "call", and that is the single most common form a
        # head-of-state contact takes in these feeds.
        r"|telephone conversation|conversation with|spoke (?:by phone )?with|received"
        r"|hosts?|hosted|negotiation\w*|consultations?)\b", re.I)),
    ("demand", re.compile(
        r"\b(demand\w*|condemn\w*|calls? on|calls? for|urges?|deplor\w+|denounc\w+|reject\w+|protest\w*)\b", re.I)),
    ("aid", re.compile(
        r"\b(aid|assistance|humanitarian|funding|donat\w+|relief package|support package)\b", re.I)),
)

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")

# Non-standard timestamps, tried only after RFC 822 and ISO 8601 both fail.
# "%y-%m-%d %H:%M" is the IAEA's; see _parse_when for why it earns a line here.
_EXTRA_DATE_FORMATS = ("%y-%m-%d %H:%M", "%Y-%m-%d %H:%M", "%d %B %Y")


def classify_kind(title: str) -> str:
    """One of the Officials layer's glyph categories.

    Keyword matching, and it is worth being explicit that this is weaker than
    the CAMEO coding on the GDELT side: a press office writes prose, not a
    taxonomy. It only ever picks the icon -- the headline itself is always
    shown verbatim, so a mis-picked glyph costs a reader a glance, not a fact.

    Title only. Including the description was tried and measurably reversed the
    accuracy: a press-release body runs several paragraphs, so something
    matches nearly always, and "Presidential Message on the Birthday of the US
    Coast Guard" and "Executive Order appointing military personnel" both came
    back as diplomatic meetings on the strength of their body text. The title
    is the claim being made; the body is context for it.
    """
    for kind, pattern in _KIND_PATTERNS:
        if title and pattern.search(title):
            return kind
    return "statement"


def _text(raw: str | None) -> str | None:
    """Feed prose -> one clean line. Descriptions routinely carry HTML."""
    if not raw:
        return None
    return _WS_RE.sub(" ", html.unescape(_TAG_RE.sub(" ", raw))).strip() or None


def _first(item: ElementTree.Element, *paths: str) -> str | None:
    for path in paths:
        el = item.find(path)
        if el is None:
            continue
        value = (el.text or "").strip()
        if value:
            return value
    return None


def _link(item: ElementTree.Element) -> str | None:
    # RSS puts the URL in <link>'s text; Atom puts it in a href attribute, and
    # a single entry can carry several <link>s of which only one is the article.
    direct = _first(item, "link")
    if direct:
        return direct
    best = None
    for el in item.findall(f"{_ATOM}link"):
        rel = el.get("rel") or "alternate"
        href = (el.get("href") or "").strip()
        if not href:
            continue
        if rel == "alternate":
            return href
        best = best or href
    return best


def _parse_when(raw: str | None) -> float | None:
    """Feed timestamp -> unix seconds, or None if it isn't one we understand.

    Three formats in the wild across the feeds above: RFC 822 ("Wed, 05 Aug
    2026 10:51:05 +0000"), ISO 8601 ("2026-08-04T11:01:15+01:00"), and the
    IAEA's own "26-07-30  12:15", which is not a standard at all.

    That last one is worth handling rather than falling through to the caller's
    fetch-time default: without it every IAEA item is stamped "now" on every
    poll, so a three-week-old explainer sorts above a statement issued this
    morning and never ages out of the 24h window at all.
    """
    if not raw:
        return None
    raw = _WS_RE.sub(" ", raw).strip()
    try:
        parsed = parsedate_to_datetime(raw)
        if parsed is not None:
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.timestamp()
    except (TypeError, ValueError):
        pass
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        parsed = None
    if parsed is None:
        for fmt in _EXTRA_DATE_FORMATS:
            try:
                parsed = datetime.strptime(raw, fmt)
                break
            except ValueError:
                continue
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def parse_feed(text: str, feed: dict, now: float | None = None) -> list[dict]:
    """One feed body -> records, newest first.

    RSS and Atom are handled by the same walk rather than by branching on the
    root element: several of these feeds declare one and use elements from the
    other, and `iter()` over both item and entry costs nothing.
    """
    now = time.time() if now is None else now
    root = ElementTree.fromstring(text.encode("utf-8") if isinstance(text, str) else text)
    out: list[dict] = []
    for item in root.iter():
        if item.tag.split("}")[-1] not in ("item", "entry"):
            continue
        title = _text(_first(item, "title", f"{_ATOM}title"))
        url = _link(item)
        if not title or not url:
            # Without both there is nothing to show and nothing to link to.
            continue
        summary = _text(_first(
            item, "description", f"{_ATOM}summary", f"{_ATOM}content", "content",
        ))
        # An unparseable timestamp becomes "when we fetched it" rather than
        # dropping the item: these are official statements, and the ordering
        # cost of a fetch-time date is smaller than the cost of not showing a
        # government's own announcement at all.
        published = _parse_when(_first(
            item, "pubDate", f"{_ATOM}published", f"{_ATOM}updated", "published", "updated", f"{_DC}date",
        )) or now
        out.append({
            # Keyed on the article URL, which is what makes a re-fetch idempotent
            # -- these feeds republish the same entries every poll.
            "id": f"{feed['key']}:{url}",
            "feed_key": feed["key"],
            "government": feed["government"],
            "country": feed["country"],
            "lat": feed["lat"],
            "lon": feed["lon"],
            "title": title,
            "summary": summary if summary and summary != title else None,
            "url": url,
            "kind": classify_kind(title),
            "published_at": published,
        })
    out.sort(key=lambda r: r["published_at"], reverse=True)
    return out[:MAX_ITEMS_PER_FEED]


async def _fetch_one(client: httpx.AsyncClient, feed: dict) -> list[dict]:
    """One feed. A failure here is logged and skipped, never raised.

    Same principle as gdelt._fetch_one_export: one press office reorganising
    its website must not empty the whole layer.
    """
    try:
        resp = await client.get(feed["url"])
        resp.raise_for_status()
        return parse_feed(resp.text, feed)
    except Exception as exc:  # noqa: BLE001 - one bad feed shouldn't sink the poll
        log.warning("Official feed %s failed: %s", feed["key"], exc)
        return []


async def _fetch() -> list[dict]:
    async with httpx.AsyncClient(timeout=25, follow_redirects=True, headers=_HEADERS) as client:
        results = await asyncio.gather(*(_fetch_one(client, f) for f in FEEDS))
    cutoff = time.time() - RETENTION_SECONDS
    items = [r for chunk in results for r in chunk if r["published_at"] >= cutoff]
    items.sort(key=lambda r: r["published_at"], reverse=True)
    return items


async def start():
    state = registry.register("official_feeds", key_configured=True)  # no key required
    consecutive_failures = 0
    while True:
        ok = False
        try:
            items = await _fetch()
            state.data = items
            state.last_success = time.time()
            state.last_error = None
            ok = True
            live = len({r["feed_key"] for r in items})
            log.info("Official feeds: %d statements in the last 24h from %d/%d publishers",
                     len(items), live, len(FEEDS))
            await storage.record_snapshot("official_feeds", items, "id")
            await storage.record_source_health("official_feeds", len(items), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Official feeds fetch failed: %s", exc)
            await storage.record_source_health("official_feeds", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok
            else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
