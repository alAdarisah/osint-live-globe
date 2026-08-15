"""The refine process: `python -m backend.refine`.

Reads what ingest and the backend stored, derives from it, writes the result
back. Makes no outbound call of any kind -- it holds no credentials and talks to
nothing but Postgres, which is what lets it be restarted, starved or killed
without costing quota.

Its inputs arrive the same way the backend's do: mirrored from Postgres, woken
by NOTIFY. So the fusion pass reads registry states exactly as it did when
everything lived in one process, and does not know or care that two of those
states are now filled by another container.
"""

import asyncio
import logging
import signal

from backend import mirror, storage
from backend.refine import INPUTS, all_jobs, run_job

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("osint-globe.refine")

logging.getLogger("httpx").setLevel(logging.WARNING)


async def main() -> None:
    # Awaited, unlike app.py's fire-and-forget task: every job here reads from
    # Postgres and writes back to it, so a refine process without a pool has
    # nothing to do but produce empty results over real data.
    await storage.init_pool()
    # Optional read replica for the heavy, lag-tolerant reads this process makes.
    # No-ops unless READ_REPLICA_URL is set; get_read_pool() falls back to the
    # primary until it opens. Writes, and any read this process depends on being
    # current, stay on the primary.
    #
    # Not awaited, unlike init_pool: on a cold stack the standby is still running
    # pg_basebackup when refine starts, so opening the pool now retries for
    # minutes (see storage.init_read_pool). Waiting for that would delay every
    # job for an optimisation they are all designed to run without.
    tasks = [asyncio.create_task(storage.init_read_pool())]

    # Inputs first, and given a moment to land: fusion's own _wait_for_inputs
    # blocks up to 60s on the acled and gdelt_conflict states this fills, so
    # starting them together merely means fusion spends that budget waiting on a
    # read that is already in flight.
    tasks.append(asyncio.create_task(mirror.follow(INPUTS)))
    tasks += [asyncio.create_task(run_job(job)) for job in all_jobs()]
    log.info(
        "Refine running: %d jobs, %d mirrored inputs",
        len(all_jobs()), len(INPUTS),
    )

    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stopping.set)
        except NotImplementedError:
            # Windows has no add_signal_handler for SIGTERM; local runs there
            # stop with Ctrl-C, and the deployed container is Linux.
            pass

    await stopping.wait()
    log.info("Shutting down")
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await storage.close_pool()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
