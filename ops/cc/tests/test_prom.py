"""The half-dozen numbers worth glancing at, and the ways Prometheus says no.

Every metric name queried here already appears in monitoring/grafana/dashboards
or monitoring/postgres-exporter/queries.yaml -- the test at the bottom is what
keeps that true, because a renamed metric is invisible until the pane is blank.
"""

import asyncio
import pathlib

import httpx

from ops.cc.collectors import prom

ROOT = pathlib.Path(__file__).resolve().parents[3]

INSTANT_OK = {"status": "success",
              "data": {"resultType": "vector",
                       "result": [{"metric": {}, "value": [1754800000, "8123456789"]}]}}
INSTANT_EMPTY = {"status": "success", "data": {"resultType": "vector", "result": []}}
INSTANT_ERROR = {"status": "error", "errorType": "bad_data", "error": "parse error"}
RANGE_OK = {"status": "success",
            "data": {"resultType": "matrix",
                     "result": [{"metric": {},
                                 "values": [[1, "0.5"], [2, "1.5"], [3, "2.0"]]}]}}


def test_reads_the_scalar_out_of_a_vector():
    assert prom.parse_instant(INSTANT_OK) == 8123456789.0


def test_an_empty_result_is_none_not_zero():
    """postgres-exporter briefly has no samples after a restart. Zero
    connections and "not measured yet" must not render identically."""
    assert prom.parse_instant(INSTANT_EMPTY) is None


def test_a_query_error_is_none():
    assert prom.parse_instant(INSTANT_ERROR) is None


def test_a_nan_sample_is_none():
    payload = {"status": "success", "data": {"resultType": "vector",
               "result": [{"metric": {}, "value": [1, "NaN"]}]}}
    assert prom.parse_instant(payload) is None


def test_range_returns_the_samples_in_order():
    assert prom.parse_range(RANGE_OK) == (0.5, 1.5, 2.0)


def test_an_empty_range_is_an_empty_tuple():
    assert prom.parse_range({"status": "success",
                             "data": {"resultType": "matrix", "result": []}}) == ()


def test_collect_queries_every_documented_metric():
    asked = []

    def handler(request):
        asked.append(request.url.params.get("query"))
        if request.url.path.endswith("query_range"):
            return httpx.Response(200, json=RANGE_OK)
        return httpx.Response(200, json=INSTANT_OK)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    snapshot = asyncio.run(prom.collect(client, "http://localhost:9090"))

    assert set(snapshot.values) == set(prom.INSTANT)
    assert set(snapshot.series) == set(prom.RANGE)
    assert set(asked) == set(prom.INSTANT.values()) | set(prom.RANGE.values())


def test_collect_raises_when_prometheus_is_unreachable():
    """Prometheus being down is an expected state -- it is the normal one before
    `s` is pressed -- but it is the supervisor that turns it into `unreachable`,
    not a snapshot full of Nones that reads like a measured stack at rest."""
    def handler(request):
        raise httpx.ConnectError("connection refused")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        asyncio.run(prom.collect(client, "http://localhost:9090"))
    except prom.CollectorError:
        pass
    else:
        raise AssertionError("an unreachable Prometheus must not read as measured zeros")


def test_one_failing_query_does_not_lose_the_others():
    def handler(request):
        if "pg_database_size_bytes" in (request.url.params.get("query") or ""):
            return httpx.Response(422, json=INSTANT_ERROR)
        if request.url.path.endswith("query_range"):
            return httpx.Response(200, json=RANGE_OK)
        return httpx.Response(200, json=INSTANT_OK)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    snapshot = asyncio.run(prom.collect(client, "http://localhost:9090"))
    assert snapshot.values["db_size"] is None
    assert snapshot.values["connections"] == 8123456789.0


def test_every_queried_metric_name_exists_in_the_monitoring_config():
    """A metric this pane invents is one that silently never renders."""
    corpus = "\n".join(
        path.read_text(encoding="utf-8")
        for path in [
            *(ROOT / "monitoring" / "grafana" / "dashboards").glob("*.json"),
            ROOT / "monitoring" / "postgres-exporter" / "queries.yaml",
        ]
    )
    for name in prom.METRIC_NAMES:
        assert name in corpus, f"{name} is not produced by anything in monitoring/"
