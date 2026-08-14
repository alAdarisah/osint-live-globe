"""The cache worker: `python -m backend.cacheworker`.

Reads Redis' counters, compares each cached kind against Postgres, checks that
the ingest and refine processes are still producing, and reports what is wrong
to three places: the log, the alerts table (which /api/health serves), and an
optional webhook.

It repairs nothing. Not the cache, not a stale key, not a stopped producer. The
one time that rule is tempting -- a kind with rows in Postgres and nothing
cached -- repopulating from here would hide the only symptom of a backend that
has lost its Redis connection, and would make this process a second writer of
keys the backend owns.
"""

import asyncio
import logging
import signal
import time

import httpx

from backend import admin_config, alert_rules, cachestore, config, ingest, mirror, refine, storage
from backend.cacheworker import SERVER, Probe, evaluate

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("osint-globe.cacheworker")
logging.getLogger("httpx").setLevel(logging.WARNING)


def _watched_specs():
    """Every kind the backend is expected to have cached, and who produces it."""
    return (
        mirror.from_jobs(ingest.all_jobs(), producer="the ingest service")
        + mirror.from_jobs(refine.all_jobs(), producer="the refine service")
    )


async def _probe(previous_evicted: int | None, uncached_streak: dict) -> Probe:
    client = cachestore.get_client()
    if client is None:
        return Probe(reachable=False)
    try:
        info = await client.info()
    except Exception as exc:  # noqa: BLE001 - an unreachable cache is a finding, not a crash
        log.debug("Redis INFO failed: %s", exc)
        return Probe(reachable=False)

    specs = _watched_specs()
    watermarks = {}
    producers = {}
    for spec in specs:
        try:
            stored = await storage.kind_watermark(spec.kind)
        except Exception as exc:  # noqa: BLE001
            log.warning("Could not read the %s watermark: %s", spec.kind, exc)
            continue
        try:
            raw = await client.get(cachestore.watermark_key(spec.kind))
        except Exception as exc:  # noqa: BLE001
            log.debug("Could not read the cached %s watermark: %s", spec.kind, exc)
            raw = None
        cached = raw.decode() if raw else None
        watermarks[spec.kind] = (cached, stored.isoformat() if stored else None)
        # Counted here rather than in evaluate() so that function stays pure.
        if stored is not None and cached is None:
            uncached_streak[spec.kind] = uncached_streak.get(spec.kind, 0) + 1
        else:
            uncached_streak.pop(spec.kind, None)

        # Reuses the backend's own verdict rather than a second opinion: if
        # /api/health calls a producer overdue, the alert says the same thing in
        # the same words, and there is only one definition of "overdue" to keep
        # right.
        try:
            newest, newest_ok = await storage.source_health_latest(spec.name)
        except Exception:  # noqa: BLE001
            continue
        _, error = mirror.health_verdict(
            newest, newest_ok, spec.expected_every, time.time(), spec.producer
        )
        producers[spec.name] = error

    return Probe(
        reachable=True,
        hits=info.get("keyspace_hits"),
        misses=info.get("keyspace_misses"),
        evicted_keys=info.get("evicted_keys"),
        used_memory=info.get("used_memory"),
        maxmemory=info.get("maxmemory") or None,
        watermarks=watermarks,
        producers=producers,
        previous_evicted=previous_evicted,
        uncached_streak=dict(uncached_streak),
    )


async def _notify(client: httpx.AsyncClient, text: str) -> None:
    if not config.ALERT_WEBHOOK_URL:
        return
    try:
        # "content" is Discord's field and "text" is Slack's; sending both means
        # one worker configuration works with either, and the unused key is
        # ignored rather than rejected by both.
        await client.post(
            config.ALERT_WEBHOOK_URL, json={"content": text, "text": text}, timeout=10,
        )
    except Exception as exc:  # noqa: BLE001 - a failed notification is not an outage
        log.warning("Could not deliver the alert webhook: %s", exc)


async def _rule_alerts() -> tuple[list, int]:
    """Task 42's reader-defined rules, evaluated once per worker tick.

    Rules live in admin_config (see backend/alert_rules.py's own module
    docstring for why they are evaluated here rather than on the backend's
    request path), so this is a plain synchronous file read -- the same
    admin_config.load() the backend's own /api/admin-config GET makes --
    followed by whatever entity_latest reads the enabled rules actually need.
    A rule alert is an ordinary cacheworker.Alert, tagged with
    alert_rules.SUBJECT_PREFIX on its subject, so run_once below folds it into
    the exact same record_alert/resolve_alerts/_notify pipeline source-health
    alerts already go through -- no second dedup, no second webhook path.

    Returns the alerts plus how many enabled rules were actually evaluated,
    the second half of what run_once records as this engine's own heartbeat.
    """
    try:
        payload = admin_config.load()
        rules = payload.get("alertRules")
        enabled_count = sum(
            1 for r in alert_rules.parse_rules(rules or []) if r.enabled
        )
        return await alert_rules.gather_and_evaluate(rules), enabled_count
    except Exception:  # noqa: BLE001 - a bad rule must not take the health probe down with it
        log.exception("Alert rule evaluation failed")
        return [], 0


async def run_once(
    http: httpx.AsyncClient, previous_evicted: int | None, uncached_streak: dict
) -> int | None:
    probe = await _probe(previous_evicted, uncached_streak)
    rule_alerts, enabled_rule_count = await _rule_alerts()
    alerts = evaluate(probe) + rule_alerts
    # A heartbeat for the rule engine itself, read back by /api/health's own
    # alert_rules block (see app.py) -- the signal that lets the frontend
    # distinguish "this rule has never been evaluated" (no row at all, or a
    # stale one) from "it was evaluated and nothing matched" (a fresh row,
    # nothing in `alerts` for it). Recorded even when there are zero rules,
    # so the light stays green while the engine itself is running with an
    # empty rule set, and only goes stale if the worker itself stops.
    # item_count is how many *enabled* rules this pass actually evaluated, the
    # same "what did the last successful run see" reading item_count carries
    # for every polled source.
    await storage.record_source_health("alert_rules", enabled_rule_count, True)

    for alert in alerts:
        level = logging.ERROR if alert.severity == "critical" else logging.WARNING
        log.log(level, "[%s] %s: %s", alert.severity, alert.subject, alert.detail)
        newly_firing = await storage.record_alert(
            alert.subject, alert.condition, alert.severity, alert.detail
        )
        if newly_firing:
            await _notify(http, f"**{alert.subject} / {alert.condition}** — {alert.detail}")

    cleared = await storage.resolve_alerts({alert.key() for alert in alerts})
    for subject, condition in cleared:
        log.info("Resolved: %s / %s", subject, condition)
        await _notify(http, f"Resolved: **{subject} / {condition}**")

    if not alerts:
        log.info("Cache healthy (%s)", "unreachable" if not probe.reachable else "all checks passed")
    return probe.evicted_keys


async def main() -> None:
    await storage.init_pool()
    await cachestore.connect()

    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stopping.set)
        except NotImplementedError:
            pass

    log.info("Cache worker watching every %ds", config.CACHE_WORKER_INTERVAL)
    previous_evicted = None
    uncached_streak: dict[str, int] = {}
    async with httpx.AsyncClient() as http:
        while not stopping.is_set():
            try:
                previous_evicted = await run_once(http, previous_evicted, uncached_streak)
            except Exception:  # noqa: BLE001 - the watcher must outlive what it watches
                log.exception("Cache probe failed")
            try:
                await asyncio.wait_for(stopping.wait(), timeout=config.CACHE_WORKER_INTERVAL)
            except asyncio.TimeoutError:
                pass

    log.info("Shutting down")
    await cachestore.close()
    await storage.close_pool()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
