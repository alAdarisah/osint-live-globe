import asyncio
import csv
import html
import io
import logging
import re
import time
import zipfile
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import httpx

from backend import config, storage
from backend.cache import registry

log = logging.getLogger("osint-globe.gdelt")

LASTUPDATE_URL = "http://data.gdeltproject.org/gdeltv2/lastupdate.txt"
GDELT_BASE_URL = "http://data.gdeltproject.org/gdeltv2/"

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


def _matched_domain(url: str) -> str | None:
    try:
        host = urlparse(url).hostname or ""
    except ValueError:
        return None
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    for domain in VERIFIED_NEWS_DOMAINS:
        if host == domain or host.endswith("." + domain):
            return domain
    return None


def _agency_name(url: str) -> str | None:
    domain = _matched_domain(url)
    return VERIFIED_NEWS_DOMAINS.get(domain) if domain else None

# GDELT publishes a new export file every 15 minutes. Fetching only the
# latest one (the old behavior) meant a quiet 15-minute window could leave
# the news layer nearly empty, and every poll wholesale-replaced the list so
# still-relevant items vanished the moment the next poll landed. Instead we
# roll up a trailing window of files into a persistent accumulator (see
# _ACCUMULATED below) that items age out of gradually.
WINDOW_MINUTES = 120  # roughly 2 hours of rolling history
FILE_STEP_MINUTES = 15  # GDELT's export cadence

# Served/returned count. Raised from the old 150 (tuned for a single 15-min
# file) since the rolling window can surface several times that many
# candidates, and title-scraping is no longer on the blocking serve path
# (see _backfill_titles) so a larger cap doesn't cost first-paint latency.
MAX_ITEMS = 400
_ACCUMULATED_HARD_CAP = MAX_ITEMS * 4  # safety valve for an unusually newsy window

# Column indices in the GDELT 2.0 Event export CSV (tab-separated, no header).
COL_GLOBAL_EVENT_ID = 0
COL_ACTOR1_NAME = 6
COL_ACTOR1_KNOWN_GROUP = 8
COL_ACTOR1_TYPE1 = 12
COL_ACTOR2_NAME = 16
COL_ACTOR2_KNOWN_GROUP = 18
COL_ACTOR2_TYPE1 = 22
COL_EVENT_CODE = 26
COL_EVENT_ROOT_CODE = 28
COL_QUAD_CLASS = 29
COL_GOLDSTEIN = 30
COL_NUM_MENTIONS = 31
COL_AVG_TONE = 34
COL_ACTION_GEO_FULLNAME = 52
COL_ACTION_GEO_LAT = 56
COL_ACTION_GEO_LONG = 57
COL_DATE_ADDED = 59
COL_SOURCE_URL = 60

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


def _window_urls(latest_dt: datetime) -> list[str]:
    n_files = WINDOW_MINUTES // FILE_STEP_MINUTES
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
        # Verbal (3) *and* material (4) conflict are both kept here on
        # purpose. This feed backs /api/news, which wants the broad political
        # picture -- accusations and demands are news even when nobody was
        # hurt. The conflict *map* needs the opposite, so the violence-only
        # gate lives in event_fusion.py (VIOLENCE_ROOT_CODES) rather than
        # here. Don't "simplify" by narrowing this: it would silently strip
        # the news layer down to shootings.
        if quad_class not in (3, 4):
            continue
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
                "quad_class": quad_class,
                "goldstein": float(row[COL_GOLDSTEIN]) if row[COL_GOLDSTEIN] else None,
                "mentions": mentions,
                "avg_tone": float(row[COL_AVG_TONE]) if row[COL_AVG_TONE] else None,
                "date_added": row[COL_DATE_ADDED],
                "source_url": row[COL_SOURCE_URL],
                "source_name": agency,
            }
        )
    return candidates


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
# ~MAX_ITEMS sequential-ish HTTP scrapes. It's now kicked off as a detached
# background task from start() so events appear immediately with the CAMEO
# fallback sentence and get their real headline filled in moments later.

_TITLE_CACHE: dict[str, str | None] = {}
_backfill_task = None  # strong reference to the in-flight backfill -- see start()
_TITLE_FETCH_SEM = asyncio.Semaphore(15)
_OGTITLE_RE = re.compile(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']*)["\']', re.IGNORECASE)
_TITLE_TAG_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
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


async def _fetch_title(client: httpx.AsyncClient, url: str) -> str | None:
    if url in _TITLE_CACHE:
        return _TITLE_CACHE[url]
    title = None
    async with _TITLE_FETCH_SEM:
        try:
            resp = await client.get(url, headers=_FETCH_HEADERS, timeout=6, follow_redirects=True)
            if resp.status_code == 200:
                head = resp.text[:30000]  # title tags are always near the top of <head>
                match = _OGTITLE_RE.search(head) or _TITLE_TAG_RE.search(head)
                if match and match.group(1).strip():
                    title = _clean_title(match.group(1))
        except Exception:  # noqa: BLE001 - a slow/broken site just means no title
            pass
    _TITLE_CACHE[url] = title
    if len(_TITLE_CACHE) > 20000:  # crude cap for a long-running session
        _TITLE_CACHE.clear()
    return title


async def _attach_titles(candidates: list[dict]) -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        titles = await asyncio.gather(
            *(_fetch_title(client, c["source_url"]) for c in candidates)
        )
    for candidate, title in zip(candidates, titles):
        candidate["real_title"] = title


async def _backfill_titles(candidates: list[dict]) -> None:
    try:
        await _attach_titles(candidates)
    except Exception as exc:  # noqa: BLE001 - keep the poller alive
        log.warning("GDELT title backfill failed: %s", exc)


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


async def _fetch_window() -> list[dict]:
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        latest_url = await _latest_export_url(client)
        latest_dt = _parse_latest_ts(latest_url)
        results = await asyncio.gather(*(_fetch_one_export(client, u) for u in _window_urls(latest_dt)))
    merged: dict[str, dict] = {}
    for file_events in results:
        for ev in file_events:
            key = _dedup_key(ev)
            existing = merged.get(key)
            if not existing or ev["mentions"] > existing["mentions"]:
                merged[key] = ev
    return list(merged.values())


def _parse_date_added(s: str | None) -> datetime | None:
    try:
        return datetime.strptime(s, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


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


async def _fetch() -> list[dict]:
    new_items = await _fetch_window()
    for ev in new_items:
        key = _dedup_key(ev)
        prior = _ACCUMULATED.get(key)
        if prior and prior.get("real_title") and not ev.get("real_title"):
            ev["real_title"] = prior["real_title"]  # carry an already-backfilled title forward
        _ACCUMULATED[key] = ev

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=WINDOW_MINUTES + FILE_STEP_MINUTES)
    for key in list(_ACCUMULATED):
        added = _parse_date_added(_ACCUMULATED[key].get("date_added"))
        if added and added < cutoff:
            del _ACCUMULATED[key]

    if len(_ACCUMULATED) > _ACCUMULATED_HARD_CAP:
        overflow = sorted(_ACCUMULATED.items(), key=lambda kv: kv[1]["mentions"])[: len(_ACCUMULATED) - _ACCUMULATED_HARD_CAP]
        for key, _ in overflow:
            del _ACCUMULATED[key]

    result = sorted(_ACCUMULATED.values(), key=lambda d: d["mentions"], reverse=True)[:MAX_ITEMS]

    # Recomputed fresh every poll (never accumulated/stale) since ACLED/UCDP
    # data moves independently of GDELT's own window.
    acled_rows = (registry.get("acled").data if registry.has("acled") else []) or []
    for ev in result:
        matches = _corroborated_by(ev, acled_rows)
        ev["corroborated"] = bool(matches)
        ev["corroborated_by"] = matches

    return result


async def start():
    state = registry.register("gdelt", key_configured=True)  # no key required
    while True:
        try:
            candidates = await _fetch()
            state.data = candidates
            state.last_success = time.time()
            state.last_error = None
            with_titles = sum(1 for d in candidates if d.get("real_title"))
            log.info("GDELT: %d events (%d with a real title, rest backfilling)", len(candidates), with_titles)
            await storage.record_snapshot("gdelt", candidates, "event_id")
            await storage.record_source_health("gdelt", len(candidates), True)
            to_fetch = [c for c in candidates if c.get("source_name") and "real_title" not in c]
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
