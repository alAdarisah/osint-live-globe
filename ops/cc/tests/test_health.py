"""Reading /api/health, whose shape has one trap and one rule worth pinning.

The trap: sources and the `alerts` list share one dict, so a naive walk turns
the alert list into a source named "alerts".

The rule: staleness is decided by backend/mirror.py from each job's
expected_every, and arrives here as last_error. Recomputing it locally would
disagree with the map the first time a six-hourly source polled on schedule.
"""

import asyncio

import httpx

from ops.cc.collectors import health

PAYLOAD = {
    "acled": {"name": "acled", "key_configured": True, "item_count": 4201, "version": 12,
              "last_success": 1000.0, "seconds_since_success": 720, "last_error": None},
    "ais": {"name": "ais", "key_configured": True, "item_count": 0, "version": 3,
            "last_success": 900.0, "seconds_since_success": 2820,
            "last_error": "ingest: aisstream closed the socket"},
    "firms": {"name": "firms", "key_configured": True, "item_count": 9133, "version": 40,
              "last_success": 1700.0, "seconds_since_success": 120, "last_error": None},
    "gfw_gaps": {"name": "gfw_gaps", "key_configured": False, "item_count": 12, "version": 2,
                 "last_success": 800.0, "seconds_since_success": 9000,
                 "last_error": "ingest: no token configured"},
    "cables": {"name": "cables", "key_configured": True, "item_count": 0, "version": 0,
               "last_success": None, "seconds_since_success": None, "last_error": None},
    "alerts": [
        {"subject": "redis", "condition": "evicting", "severity": "critical",
         "detail": "maxmemory reached", "first_seen": 1.0, "last_seen": 2.0, "occurrences": 9},
        {"subject": "refine", "condition": "not producing", "severity": "warning",
         "detail": "no rows in 2h", "first_seen": 1.0, "last_seen": 2.0, "occurrences": 1},
    ],
}


def _by_name(snapshot):
    return {s.name: s for s in snapshot.sources}


def test_alerts_are_not_parsed_as_a_source():
    assert "alerts" not in _by_name(health.parse_health(PAYLOAD))


def test_every_real_source_is_kept():
    assert set(_by_name(health.parse_health(PAYLOAD))) == {
        "acled", "ais", "firms", "gfw_gaps", "cables"
    }


def test_a_source_with_no_error_is_healthy_however_old_it_is():
    """acled polls every six hours; 720 seconds of silence is not a problem,
    and only the backend knows that."""
    assert _by_name(health.parse_health(PAYLOAD))["acled"].severity == "ok"


def test_an_erroring_source_still_serving_rows_is_degraded_not_down():
    assert _by_name(health.parse_health(PAYLOAD))["gfw_gaps"].severity == "warn"


def test_an_erroring_source_serving_nothing_is_down():
    assert _by_name(health.parse_health(PAYLOAD))["ais"].severity == "down"


def test_a_source_that_has_never_polled_is_starting_not_broken():
    """On a cold start every source looks like this for a minute."""
    assert _by_name(health.parse_health(PAYLOAD))["cables"].severity == "starting"


def test_alerts_are_parsed_worst_first():
    snapshot = health.parse_health(PAYLOAD)
    assert [a.severity for a in snapshot.alerts] == ["critical", "warning"]
    assert snapshot.worst_alert_severity == "critical"


def test_no_alerts_means_no_worst():
    assert health.parse_health({"acled": PAYLOAD["acled"]}).worst_alert_severity is None


def test_a_payload_without_an_alerts_key_still_parses():
    """/api/health serves alerts as [] when the table is unreachable, but an
    older backend may not send the key at all."""
    snapshot = health.parse_health({"acled": PAYLOAD["acled"]})
    assert snapshot.alerts == ()
    assert len(snapshot.sources) == 1


def test_collect_reads_the_api():
    def handler(request):
        assert request.url.path == "/api/health"
        return httpx.Response(200, json=PAYLOAD)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    snapshot = asyncio.run(health.collect(client, "http://localhost:8080"))
    assert len(snapshot.sources) == 5


def test_collect_raises_on_a_non_200():
    """A 502 from nginx means the backend is not up. The pane must dim and say
    so, not show an empty source list."""
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(502, text="bad gateway"))
    )
    try:
        asyncio.run(health.collect(client, "http://localhost:8080"))
    except health.CollectorError as exc:
        assert "502" in str(exc)
    else:
        raise AssertionError("a 502 must not read as zero sources")
