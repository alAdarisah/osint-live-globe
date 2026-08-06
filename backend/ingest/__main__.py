"""The ingest process: `python -m backend.ingest`.

Runs the scheduled jobs and the self-paced streams in backend/ingest's table,
and nothing else. No HTTP server, no registry served to anyone -- everything it
collects leaves through Postgres, and the backend picks it up from there (see
backend/mirror.py).

This is the only process in the stack that holds the paid and metered
credentials. Running a second copy of it doubles the quota spend, which is the
failure this whole split exists to prevent, so it is deliberately a single
container with no replicas.
"""

import asyncio
import logging
import signal

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from backend import config, storage
from backend.ingest import jobs, run_job, streams
from backend.sources import airports, sanctions

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("osint-globe.ingest")

# Same reason as app.py: httpx logs every request URL at INFO, and FIRMS takes
# its API key as a path segment, so leaving this at INFO writes the key into the
# container logs on every poll.
logging.getLogger("httpx").setLevel(logging.WARNING)


async def _refresh_reference_indexes() -> None:
    """Keep the airports and sanctions lookups filled, from Postgres only.

    adsb annotates each aircraft with its nearest airfield and any OFAC listing;
    ais does the same for vessels. Both read module-level indexes that are built
    by the *backend's* pollers -- so in this process they start empty, and every
    aircraft would quietly lose `nearest_airfield` and `sanctions` while looking
    perfectly healthy otherwise.

    Both datasets are already in Postgres, so this fills them by reading rather
    than by fetching: no OurAirports download, no OFAC download, no second
    consumer of either. It runs on a slow loop because the backend refreshes
    both roughly daily and there is nothing to gain from noticing sooner.

    One known gap: the stored airfield rows are the *served* slice, so the index
    built here omits the heliports and seaplane bases the backend's full index
    holds. `nearest` answers "no opinion" rather than wrongly for those.
    """
    while True:
        try:
            stored_airports = await storage.entity_latest("airports")
            if stored_airports:
                airports.install(stored_airports)
            listings = await storage.reference("sanctions")
            if listings:
                sanctions.install(listings)
            log.info(
                "Reference indexes: %d airfields, %s sanctions listings",
                len(stored_airports), len(listings) if listings else 0,
            )
        except Exception as exc:  # noqa: BLE001 - annotation is enrichment, not the payload
            log.warning("Could not refresh reference indexes: %s", exc)
        await asyncio.sleep(config.INGEST_REFERENCE_REFRESH)


async def main() -> None:
    # Awaited, unlike app.py's fire-and-forget task. The backend starts without
    # a database because it still has an API to serve; this process has no
    # reason to exist before Postgres does, and starting the jobs first would
    # burn a poll of every metered source into a storage layer that silently
    # drops writes while the pool is None.
    await storage.init_pool()

    scheduler = AsyncIOScheduler()
    for job in jobs():
        interval = job.interval()
        scheduler.add_job(
            run_job,
            "interval",
            seconds=interval,
            args=[job],
            id=job.module,
            # A job that overruns its interval must not be started again
            # alongside itself: two concurrent ACLED polls means two OAuth
            # logins and twice the paginated read, for one set of rows.
            max_instances=1,
        )
        log.info("Scheduled %s every %ds", job.module, interval)

    scheduler.start()

    tasks = [asyncio.create_task(_refresh_reference_indexes())]
    # The first run of each scheduled job, immediately, instead of waiting out
    # one interval. Run through run_job like any other invocation so a failure
    # here is recorded as a failed poll rather than taking the process down.
    tasks += [asyncio.create_task(run_job(job)) for job in jobs()]
    tasks += [asyncio.create_task(run_job(job)) for job in streams()]
    log.info(
        "Ingest running: %d scheduled jobs, %d streams",
        len(jobs()), len(streams()),
    )

    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stopping.set)
        except NotImplementedError:
            # Windows has no add_signal_handler for SIGTERM. Local runs there
            # stop with Ctrl-C (KeyboardInterrupt) instead, and the container
            # this is actually deployed in is Linux.
            pass

    await stopping.wait()
    log.info("Shutting down")
    scheduler.shutdown(wait=False)
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await storage.close_pool()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
