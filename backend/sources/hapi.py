"""Shared HDX HAPI plumbing: who we say we are, and how to ask politely.

Two modules now read HAPI -- hapi_conflict.py for district-level ACLED counts
and humanitarian.py for displacement and food security -- and both need the same
two things: the caller identifier HAPI requires, and a fetch that survives the
429s a free public API returns under concurrent paging.

Extracted here rather than imported from hapi_conflict, because a poller
importing a sibling poller for a helper is exactly the coupling outlets.py and
cameo.py were both pulled out to avoid.
"""

import asyncio
import base64
import logging
import os

import httpx

log = logging.getLogger("osint-globe.hapi")

BASE_URL = "https://hapi.humdata.org/api/v2"
PAGE_SIZE = 10000  # HAPI's maximum
RETRIES = 3


def app_identifier() -> str | None:
    """HAPI's caller identifier: base64 of "appname:email".

    Not a credential -- nothing is issued or approved -- but HAPI does validate
    that the email is well-formed and rejects placeholders with
    403 "Invalid app identifier", so there is no usable built-in default. Set
    HAPI_CONTACT_EMAIL in .env (gitignored) rather than committing an address.
    """
    raw = os.getenv("HAPI_APP_IDENTIFIER", "").strip()
    if raw:
        return raw
    contact = os.getenv("HAPI_CONTACT_EMAIL", "").strip()
    if not contact:
        return None
    return base64.b64encode(f"osint-live-globe:{contact}".encode()).decode()


async def get_page(client: httpx.AsyncClient, url: str, params: dict) -> list[dict]:
    """One page, retrying the failures that are worth retrying.

    Several countries paged concurrently will occasionally draw a 429 or a
    transient 5xx from a free public API, and without a retry those countries
    silently vanish from the layer until the next poll -- which is exactly the
    sort of quiet partial failure that makes a map lie.
    """
    delay = 2.0
    for attempt in range(RETRIES):
        try:
            resp = await client.get(url, params=params)
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < RETRIES - 1:
                await asyncio.sleep(delay)
                delay *= 2
                continue
            resp.raise_for_status()
            return (resp.json() or {}).get("data") or []
        except (httpx.TimeoutException, httpx.TransportError):
            if attempt == RETRIES - 1:
                raise
            await asyncio.sleep(delay)
            delay *= 2
    return []


def month_key(value: str | None) -> str | None:
    """"2026-07-01T00:00:00" -> "2026-07"."""
    if not value:
        return None
    return value[:7] or None
