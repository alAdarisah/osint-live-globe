import { useEffect, useState } from "react";

/**
 * The wall clock, in UTC, ticking once a second.
 *
 * Returns both forms because the bar shows one and means the other: `time` is
 * the `14:07:32` the top bar renders beside its ZULU label, and `full` is the
 * complete `Sun, 16 Aug 2026 14:07:32 UTC` it carries as the title. The date is
 * not decoration on a map whose whole subject is when something happened -- a
 * reader checking whether a feed has rolled over midnight needs it -- so it
 * stays reachable rather than being formatted away.
 *
 * UTC, not local, for the same reason every timestamp on this map is: the
 * things being tracked are in a dozen time zones and none of them is the
 * reader's.
 */
export function useClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return {
    time: now.toISOString().slice(11, 19),
    full: now.toUTCString().replace("GMT", "UTC"),
  };
}
