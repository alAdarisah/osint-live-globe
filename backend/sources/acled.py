import asyncio
import csv
import io
import logging
import time
from datetime import datetime, timedelta, timezone

import httpx

from backend import config, storage
from backend.cache import registry
from backend.sources.outlets import split_outlet_names

log = logging.getLogger("osint-globe.acled")

TOKEN_URL = "https://acleddata.com/oauth/token"
READ_URL = "https://acleddata.com/api/acled/read"

# UCDP's live API needs an emailed-and-approved access token (3-5 business
# days), same access friction as ACLED -- no fix for "I can't get in right
# now". Their GED Candidate dataset is UCDP's own keyless alternative for
# exactly this situation: a more-current (monthly, vs. the annual GED
# release), less-rigorously-reviewed cut of the same event data, published as
# a plain downloadable CSV. No auth, no approval wait.
UCDP_CANDIDATE_URL = "https://ucdp.uu.se/downloads/candidateged/GEDEvent_v{v:02d}_01_{v:02d}_{m:02d}.csv"
UCDP_VIOLENCE_TYPE = {
    "1": "State-based armed conflict",
    "2": "Non-state conflict",
    "3": "One-sided violence",
}

_token: dict = {"access_token": None, "expires_at": 0}
# The candidate file's month range only advances once/month -- remember the
# last URL that worked so most polls need just one request instead of
# walking back through several 404s.
_last_good_ucdp_url: str | None = None
# (url, csv text) for the most recent successful candidate download, so the
# live window and the full history parse share one fetch per poll.
_ucdp_text_cache: tuple[str, str] | None = None
# Research-tier myACLED accounts are embargoed from recent events (ACLED
# returns the cutoff itself in data_query_restrictions.date_recency, e.g.
# "12 Months old"). None means "not measured yet, try the live window
# first"; once known, cache it so most polls need one request, not two --
# but recheck daily in case the account's access level changes.
_acled_embargo_days: int | None = None
_acled_embargo_checked_at: float = 0
ACLED_LOOKBACK_DAYS = 3


async def _get_token(client: httpx.AsyncClient) -> str:
    if _token["access_token"] and time.time() < _token["expires_at"] - 60:
        return _token["access_token"]
    resp = await client.post(
        TOKEN_URL,
        data={
            "username": config.ACLED_EMAIL,
            "password": config.ACLED_PASSWORD,
            "grant_type": "password",
            "client_id": "acled",
            "scope": "authenticated",
        },
    )
    resp.raise_for_status()
    payload = resp.json()
    _token["access_token"] = payload["access_token"]
    _token["expires_at"] = time.time() + int(payload.get("expires_in", 86400))
    return _token["access_token"]


ACLED_PAGE_SIZE = 2000


async def _query_acled_page(client: httpx.AsyncClient, token: str, since, until, page: int) -> dict:
    params = {
        "_format": "json",
        "limit": str(ACLED_PAGE_SIZE),
        "page": str(page),
        "event_date": f"{since.isoformat()}|{until.isoformat()}",
        "event_date_where": "BETWEEN",
        # `source` is the semicolon-separated list of outlets ACLED coded the
        # event from. Requested so an ACLED-derived pin can name who reported
        # it, the same question GDELT's Mentions table answers for its own rows
        # -- without it, an ACLED-only event reaches the map with no reporting
        # provenance at all.
        "fields": "event_id_cnty|event_date|event_type|sub_event_type|actor1|actor2|fatalities|latitude|longitude|country|notes|source",
    }
    resp = await client.get(
        READ_URL, params=params, headers={"Authorization": f"Bearer {token}"}
    )
    resp.raise_for_status()
    return resp.json()


async def _query_acled(client: httpx.AsyncClient, token: str, since, until) -> dict:
    """Pages through ACLED's read API until a short page ends the window.

    ACLED caps every response at ACLED_PAGE_SIZE rows -- a window with more
    events than that (a busy multi-day pull, or the daily scrape script's
    wide catch-up runs) used to silently lose everything past the first
    page. `page` is ACLED's own 1-based paging param; a page shorter than
    the cap means there's nothing left to fetch.
    """
    first = await _query_acled_page(client, token, since, until, 1)
    rows = first.get("data", []) if isinstance(first, dict) else first
    all_rows = list(rows)
    page = 1
    while len(rows) == ACLED_PAGE_SIZE:
        page += 1
        payload = await _query_acled_page(client, token, since, until, page)
        rows = payload.get("data", []) if isinstance(payload, dict) else payload
        all_rows.extend(rows)
    merged = dict(first) if isinstance(first, dict) else {}
    merged["data"] = all_rows
    return merged


def _parse_acled_rows(payload: dict) -> list[dict]:
    rows = payload.get("data", []) if isinstance(payload, dict) else payload
    items = []
    for row in rows:
        try:
            lat = float(row["latitude"])
            lon = float(row["longitude"])
        except (KeyError, ValueError, TypeError):
            continue
        items.append(
            {
                "id": row.get("event_id_cnty"),
                "lat": lat,
                "lon": lon,
                "date": row.get("event_date"),
                "event_type": row.get("event_type"),
                "sub_event_type": row.get("sub_event_type"),
                "actor1": row.get("actor1"),
                "actor2": row.get("actor2"),
                "fatalities": int(row.get("fatalities") or 0),
                "country": row.get("country"),
                "notes": (row.get("notes") or "")[:400],
                # Two different things that both want to be called "source":
                # this key is the *dataset* marker every downstream module keys
                # off, while `outlets` holds ACLED's own `source` column -- the
                # newsrooms it coded the event from.
                "source": "acled",
                "outlets": split_outlet_names(row.get("source")),
            }
        )
    return items


async def _fetch_acled() -> list[dict]:
    global _acled_embargo_days, _acled_embargo_checked_at
    today = datetime.now(timezone.utc).date()
    recheck_live = _acled_embargo_days is None or time.time() - _acled_embargo_checked_at > 86400

    async with httpx.AsyncClient(timeout=30) as client:
        token = await _get_token(client)

        offset = 0 if recheck_live else _acled_embargo_days
        until = today - timedelta(days=offset)
        since = until - timedelta(days=ACLED_LOOKBACK_DAYS)
        payload = await _query_acled(client, token, since, until)
        restriction = (payload.get("data_query_restrictions") or {}).get("date_recency") or {}
        cutoff_str = restriction.get("date")

        if cutoff_str:
            cutoff = datetime.fromisoformat(cutoff_str).date()
            new_offset = max((today - cutoff).days, 0)
            if new_offset != offset:
                # Account is embargoed (or the embargo shifted) -- requery the
                # window ACLED actually allows instead of the live one.
                _acled_embargo_days = new_offset
                until = today - timedelta(days=new_offset)
                since = until - timedelta(days=ACLED_LOOKBACK_DAYS)
                payload = await _query_acled(client, token, since, until)
            else:
                _acled_embargo_days = new_offset
        else:
            _acled_embargo_days = 0
        _acled_embargo_checked_at = time.time()

    return _parse_acled_rows(payload)


def _ucdp_candidate_urls() -> list[str]:
    # The cumulative Jan-to-date file's own name embeds its end month, so
    # there's no stable "latest" alias -- walk back from the current month
    # (covering a year rollover too, since a new year's file isn't published
    # until ~3 weeks after its first month ends).
    now = datetime.now(timezone.utc)
    year, month = now.year, now.month
    urls = []
    for _ in range(15):
        urls.append(UCDP_CANDIDATE_URL.format(v=year - 2000, m=month))
        month -= 1
        if month == 0:
            month, year = 12, year - 1
    return urls


UCDP_LOOKBACK_DAYS = 3


def _parse_ucdp_csv(text: str, lookback_days: int | None = UCDP_LOOKBACK_DAYS) -> list[dict]:
    # The candidate file's own publication lags real time by a month or
    # more (it's only cut once UCDP has done enough review to call a month
    # "candidate"-quality) -- a cutoff measured from wall-clock *today* was
    # always older than every row in the freshest file that exists, so this
    # layer was structurally guaranteed to return nothing. Instead, take the
    # window relative to the newest date_start actually present in the file
    # -- "the last few days of whatever data exists" instead of "the last
    # few days of real time," which is what the file can actually deliver.
    rows = []
    for row in csv.DictReader(io.StringIO(text)):
        try:
            lat = float(row["latitude"])
            lon = float(row["longitude"])
        except (KeyError, ValueError, TypeError):
            continue
        date = (row.get("date_start") or "").split(" ")[0]  # "YYYY-MM-DD HH:MM:SS.000" -> date only
        if not date:
            continue
        rows.append((date, lat, lon, row))
    if not rows:
        return []

    latest_date = max(d for d, _, _, _ in rows)
    # lookback_days=None keeps the whole file. The candidate file is a
    # cumulative January-to-date cut, so the 3-day window is right for the live
    # feed and throws away ~99% of a reviewed dataset for the history feed --
    # which is the one place that history is exactly what's wanted.
    cutoff_date = None
    if lookback_days is not None:
        cutoff_date = (
            datetime.strptime(latest_date, "%Y-%m-%d").date() - timedelta(days=lookback_days)
        ).isoformat()
    lag_days = (datetime.now(timezone.utc).date() - datetime.strptime(latest_date, "%Y-%m-%d").date()).days

    items = []
    for date, lat, lon, row in rows:
        if cutoff_date is not None and date < cutoff_date:
            continue
        try:
            fatalities = int(row.get("best") or 0)
        except ValueError:
            fatalities = 0
        items.append(
            {
                "id": f"ucdp-{row.get('id')}",  # prefixed so it can never collide with an ACLED event_id_cnty
                "lat": lat,
                "lon": lon,
                "date": date,
                "event_type": UCDP_VIOLENCE_TYPE.get(row.get("type_of_violence"), "Conflict event"),
                "sub_event_type": row.get("dyad_name") or row.get("conflict_name"),
                "actor1": row.get("side_a"),
                "actor2": row.get("side_b"),
                "fatalities": fatalities,
                "country": row.get("country"),
                "notes": (row.get("source_headline") or row.get("where_description") or "")[:400],
                "source": "ucdp",
                # Who UCDP read this off. source_article is a citation rather
                # than a bare masthead, so split_outlet_names truncates each
                # entry; source_office (the news agency) is the fallback when
                # the article field is empty.
                "outlets": split_outlet_names(
                    row.get("source_article") or row.get("source_office")
                ),
                # How stale this dataset is, as data rather than as a footnote
                # someone downstream might drop. Anything rendering these rows
                # is expected to show it.
                "as_of": latest_date,
                "lag_days": lag_days,
            }
        )
    return items


async def _fetch_ucdp_text() -> str | None:
    """The freshest available candidate CSV, cached by URL across polls."""
    global _last_good_ucdp_url, _ucdp_text_cache
    candidates = _ucdp_candidate_urls()
    if _last_good_ucdp_url and _last_good_ucdp_url in candidates:
        candidates.remove(_last_good_ucdp_url)
        candidates.insert(0, _last_good_ucdp_url)
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        for url in candidates:
            try:
                resp = await client.get(url)
                if resp.status_code == 404:
                    continue
                resp.raise_for_status()
                _last_good_ucdp_url = url
                # Held so the live and history parses share one download
                # rather than pulling a multi-megabyte file twice per poll.
                _ucdp_text_cache = (url, resp.text)
                return resp.text
            except httpx.HTTPStatusError:
                continue
            except Exception as exc:  # noqa: BLE001 - one bad file shouldn't sink the whole poll
                log.debug("UCDP candidate fetch failed (%s): %s", url, exc)
                continue
    log.warning("UCDP: no candidate dataset file found in the last 15 months")
    return None


async def _fetch_ucdp() -> list[dict]:
    text = await _fetch_ucdp_text()
    return _parse_ucdp_csv(text) if text else []


async def _fetch_ucdp_history() -> list[dict]:
    """The whole reviewed record in the current candidate file, not a window."""
    if _ucdp_text_cache is None:
        text = await _fetch_ucdp_text()
    else:
        text = _ucdp_text_cache[1]
    return _parse_ucdp_csv(text, lookback_days=None) if text else []


def _within_real_lookback(items: list[dict]) -> list[dict]:
    # Both _fetch_acled (embargo re-query) and _parse_ucdp_csv (window
    # relative to the newest row *in the file*) pick their window relative
    # to something other than actual wall-clock now -- an embargoed ACLED
    # account or a stale UCDP candidate file can otherwise hand back a
    # perfectly well-formed "last 3 days" window that's really from a year
    # ago, which reads as current on the map. This is the one true recency
    # gate: drop anything whose own event date isn't in the real last-N-days
    # window, no matter which upstream quirk produced it.
    cutoff = (datetime.now(timezone.utc).date() - timedelta(days=max(ACLED_LOOKBACK_DAYS, UCDP_LOOKBACK_DAYS))).isoformat()
    return [d for d in items if d.get("date") and d["date"] >= cutoff]


async def _fetch() -> tuple[list[dict], list[dict]]:
    """Returns (live, history).

    `live` is the existing _within_real_lookback-gated list: rows whose own
    event date really does fall in the last few days. On an embargoed ACLED
    account, and with a UCDP candidate file that lags a month or more, that
    list is empty -- and empty is the honest answer, so the gate stays exactly
    as it is.

    `history` is the reviewed record, ungated, every row tagged with `as_of`
    and `lag_days`. UCDP is the only rigorously reviewed conflict dataset
    available without a paid key, and discarding it entirely (the previous
    behaviour) threw that away rather than presenting it for what it is.
    """
    acled_configured = bool(config.ACLED_EMAIL and config.ACLED_PASSWORD)
    tasks = [_fetch_ucdp(), _fetch_ucdp_history()]
    if acled_configured:
        tasks.append(_fetch_acled())
    results = await asyncio.gather(*tasks, return_exceptions=True)

    live_inputs, history = [], []
    for index, result in enumerate(results):
        if isinstance(result, Exception):
            log.warning("Conflict source fetch failed: %s", result)
            continue
        if index == 1:
            history = result
        else:
            live_inputs.extend(result)
    return _within_real_lookback(live_inputs), history


async def ingest_once():
    """One poll of both halves. Runs in the ingest process (see backend/ingest).

    Nothing is warmed from storage here: this process publishes to Postgres and
    serves no one, so filling its registry state from the previous run's rows
    would achieve nothing. The warm that used to happen here mattered because
    event_fusion._wait_for_inputs blocks on acled.version > 0 for up to 60
    seconds; that consumer runs in the backend, and the backend now fills the
    same state from Postgres on boot instead (see backend/mirror.py).
    """
    # UCDP's candidate dataset needs no key, so this layer is always usable
    # even without ACLED credentials -- key_configured reflects "the source
    # is usable", not "every possible sub-source is configured".
    state = registry.ensure("acled", key_configured=True)
    # The reviewed record, deliberately separate from the live feed so nothing
    # downstream can mistake a month-old verified dataset for current events.
    history_state = registry.ensure("conflict_history", key_configured=True)
    acled_configured = bool(config.ACLED_EMAIL and config.ACLED_PASSWORD)
    try:
        state.data, history = await _fetch()
        history_state.data = history
        history_state.last_success = time.time()
        history_state.last_error = None
        state.last_success = time.time()
        state.last_error = (
            None if acled_configured
            else "ACLED_EMAIL / ACLED_PASSWORD not set -- showing UCDP only"
        )
        ucdp_count = sum(1 for d in state.data if d.get("source") == "ucdp")
        as_of = next((h.get("as_of") for h in history if h.get("as_of")), None)
        log.info(
            "Conflict events: %d live (%d ACLED, %d UCDP); %d verified history rows"
            " through %s",
            len(state.data), len(state.data) - ucdp_count, ucdp_count,
            len(history), as_of or "?",
        )
        # Raw ACLED+UCDP rows, pre-fusion -- event_fusion.py archives the
        # merged view separately, so both the inputs and the result stay
        # queryable rather than only the result.
        await storage.record_snapshot("acled", state.data, "id")
        await storage.record_snapshot("conflict_history", history, "id")
        await storage.record_source_health("acled", len(state.data), True)
        await storage.record_source_health("conflict_history", len(history), True)
    except Exception as exc:  # noqa: BLE001 - one failed poll is not a dead source
        state.last_error = str(exc)
        log.warning("Conflict event fetch failed: %s", exc)
        await storage.record_source_health("acled", None, False, str(exc))
        # Recorded for both halves, not just the live feed. They are fetched
        # together and fail together, and leaving conflict_history's last row
        # successful would keep the verified-history layer green while the job
        # producing it was erroring.
        await storage.record_source_health("conflict_history", None, False, str(exc))
