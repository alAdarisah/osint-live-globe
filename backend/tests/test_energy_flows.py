"""Cross-border electricity exchange, parsed off a real Energy-Charts response.

The payloads below are trimmed copies of live `/v2/cbpf?country=ua` and
`/v2/cbet?country=ua` responses (2026-08-06) -- same keys, same sign convention,
same provenance block, fewer intervals.

Two things are being guarded. The first is the `sum` series, which is the
country's net position and not a neighbour: left among the counterparts,
anything adding the list up reports double the real exchange. The second is the
distinction between the two endpoints -- `cbpf` is metered, `cbet` is a
day-ahead schedule -- which must survive all the way into the stored record,
because a card that quoted the schedule as a measurement would be inventing a
reading the meters have not yet produced.
"""

import asyncio

import httpx
import pytest

from backend.sources import energy_flows as ef

LICENSE = "CC BY 4.0 (creativecommons.org/licenses/by/4.0), attribution: energy-charts.info"
SIGN_CONVENTION = "positive = import, negative = export"

SERIES = [
    {"id": "belarus", "name": "Belarus", "description": "Exchange with Belarus"},
    {"id": "hungary", "name": "Hungary", "description": "Exchange with Hungary"},
    {"id": "moldova", "name": "Moldova", "description": "Exchange with Moldova"},
    {"id": "poland", "name": "Poland", "description": "Exchange with Poland"},
    {"id": "romania", "name": "Romania", "description": "Exchange with Romania"},
    {"id": "russia", "name": "Russia", "description": "Exchange with Russia"},
    {"id": "slovakia", "name": "Slovakia", "description": "Exchange with Slovakia"},
    {"id": "sum", "name": "sum", "description": "Net sum over all borders"},
]

CBPF_UA = {
    "schema_version": "2.0",
    "endpoint": "cbpf",
    "country": "ua",
    "bidding_zone": None,
    "timezone": "Europe/Kiev",
    "resolution": "PT15M",
    "interval_minutes": 15,
    "unit": "GW",
    "generated_at": "2026-08-06T21:46:54+03:00",
    "available_from": "2026-08-06T00:00:00+03:00",
    "available_until": "2026-08-06T19:15:00+03:00",
    "series": SERIES,
    "data": [
        {"timestamp": "2026-08-06T00:00:00+03:00", "values": {
            "belarus": 0.0, "hungary": -0.036, "moldova": 0.052, "poland": 0.13,
            "romania": -0.242, "russia": 0.0, "slovakia": 0.4, "sum": 0.304}},
        {"timestamp": "2026-08-06T00:15:00+03:00", "values": {
            "belarus": 0.0, "hungary": -0.036, "moldova": 0.052, "poland": 0.129,
            "romania": -0.242, "russia": 0.0, "slovakia": 0.4, "sum": 0.302}},
        {"timestamp": "2026-08-06T19:15:00+03:00", "values": {
            "belarus": 0.0, "hungary": 0.0, "moldova": 0.0, "poland": 0.178,
            "romania": 0.0, "russia": 0.0, "slovakia": 0.0, "sum": 0.178}},
    ],
    "attributes": {"sign_convention": SIGN_CONVENTION},
    "license": LICENSE,
    "deprecated": False,
}

CBET_UA = {
    "schema_version": "2.0",
    "endpoint": "cbet",
    "country": "ua",
    "bidding_zone": None,
    "timezone": "Europe/Kiev",
    "resolution": "PT1H",
    "interval_minutes": 60,
    "unit": "GW",
    "generated_at": "2026-08-06T21:46:57+03:00",
    "available_from": "2026-08-06T00:00:00+03:00",
    # Past the physical half's 19:15: the day-ahead schedule publishes ahead of
    # wall clock while the meters lag behind it.
    "available_until": "2026-08-06T23:00:00+03:00",
    "series": SERIES,
    "data": [
        {"timestamp": "2026-08-06T00:00:00+03:00", "values": {
            "belarus": 0.0, "hungary": 0.124, "moldova": -0.078, "poland": 0.0,
            "romania": 0.087, "russia": 0.0, "slovakia": 0.211, "sum": 0.344}},
        {"timestamp": "2026-08-06T23:00:00+03:00", "values": {
            "belarus": 0.0, "hungary": 0.284, "moldova": 0.0, "poland": 0.0,
            "romania": 0.164, "russia": 0.0, "slovakia": 0.131, "sum": 0.579}},
    ],
    "attributes": {"sign_convention": SIGN_CONVENTION},
    "license": LICENSE,
    "deprecated": False,
}


def counterpart(parsed, name):
    return next(c for c in parsed["counterparts"] if c["id"] == name)


# --- the net series is not a neighbour --------------------------------------


def test_the_sum_series_is_the_net_position_not_a_counterpart():
    parsed = ef.parse_exchange(CBPF_UA, "measured")
    assert "sum" not in [c["id"] for c in parsed["counterparts"]]
    assert parsed["net"] == 0.178
    assert len(parsed["counterparts"]) == 7


def test_the_net_position_is_kept_for_the_whole_window():
    parsed = ef.parse_exchange(CBPF_UA, "measured")
    assert parsed["net_series"] == [
        {"t": "2026-08-06T00:00:00+03:00", "net": 0.304},
        {"t": "2026-08-06T00:15:00+03:00", "net": 0.302},
        {"t": "2026-08-06T19:15:00+03:00", "net": 0.178},
    ]


# --- sign convention --------------------------------------------------------


def test_the_publishers_sign_convention_is_carried_not_reinterpreted():
    """Negative is export. Nothing here takes an absolute value or flips it."""
    parsed = ef.parse_exchange(CBPF_UA, "measured")
    assert parsed["sign_convention"] == SIGN_CONVENTION
    romania = counterpart(parsed, "romania")
    assert romania["min"] == -0.242, "an export must stay negative"
    assert romania["max"] == 0.0
    slovakia = counterpart(parsed, "slovakia")
    assert slovakia["max"] == 0.4, "an import must stay positive"


def test_counterparts_are_ordered_by_size_in_either_direction():
    """A 3 GW export is as much the headline as a 3 GW import, so the ordering
    is on magnitude -- otherwise every exporting border sorts to the bottom."""
    parsed = ef.parse_exchange(
        {**CBPF_UA, "data": [{"timestamp": "t", "values": {
            "belarus": 0.1, "hungary": -0.9, "moldova": 0.5, "sum": -0.3}}]},
        "measured",
    )
    assert [c["id"] for c in parsed["counterparts"]] == ["hungary", "moldova", "belarus"]


# --- provenance -------------------------------------------------------------


def test_every_provenance_field_the_publisher_ships_survives_the_parse():
    """The card is meant to say "physical flows, 15-minute, current to 19:15
    local" and quote the licence -- on the publisher's authority, not ours, so
    none of this may be a constant in the module."""
    parsed = ef.parse_exchange(CBPF_UA, "measured")
    assert parsed["license"] == LICENSE
    assert parsed["resolution"] == "PT15M"
    assert parsed["interval_minutes"] == 15
    assert parsed["unit"] == "GW"
    assert parsed["timezone"] == "Europe/Kiev"
    assert parsed["generated_at"] == "2026-08-06T21:46:54+03:00"
    assert parsed["available_from"] == "2026-08-06T00:00:00+03:00"
    assert parsed["available_until"] == "2026-08-06T19:15:00+03:00"
    assert parsed["latest_timestamp"] == "2026-08-06T19:15:00+03:00"


def test_counterpart_labels_come_from_the_publishers_own_series_metadata():
    """The subject country is never named in the payload, only coded -- these
    are the only country names the API supplies, so they are not invented."""
    poland = counterpart(ef.parse_exchange(CBPF_UA, "measured"), "poland")
    assert poland["name"] == "Poland"
    assert poland["description"] == "Exchange with Poland"


# --- measured and scheduled stay apart --------------------------------------


def test_physical_flows_and_commercial_schedules_are_never_merged():
    merged = ef.merge({"ua": {
        "physical": ef.parse_exchange(CBPF_UA, "measured"),
        "commercial": ef.parse_exchange(CBET_UA, "scheduled"),
    }})
    record = merged["UA"]
    assert record["physical"]["endpoint"] == "cbpf"
    assert record["physical"]["measurement"] == "measured"
    assert record["commercial"]["endpoint"] == "cbet"
    assert record["commercial"]["measurement"] == "scheduled"
    # Same border, same day, two different numbers -- and the record keeps both.
    assert record["physical"]["net"] == 0.178
    assert record["commercial"]["net"] == 0.579
    # The lag is the point: the meters reach 19:15, the schedule runs to 23:00.
    assert record["physical"]["available_until"] < record["commercial"]["available_until"]
    assert record["physical"]["resolution"] != record["commercial"]["resolution"]


def test_a_country_with_only_one_half_still_gets_a_record():
    """cbpf lags hours behind, so early in the day the schedule can be the only
    half there is -- and that is worth showing, labelled as a schedule."""
    merged = ef.merge({"ua": {"commercial": ef.parse_exchange(CBET_UA, "scheduled")}})
    assert "physical" not in merged["UA"]
    assert merged["UA"]["commercial"]["measurement"] == "scheduled"


# --- keying -----------------------------------------------------------------


def test_countries_are_keyed_on_iso2_so_the_country_shapes_join_without_names():
    merged = ef.merge({"ua": {"physical": ef.parse_exchange(CBPF_UA, "measured")}})
    assert list(merged) == ["UA"]
    assert merged["UA"]["country_code"] == "UA"
    assert merged["UA"]["aggregate"] is False


def test_the_apis_uk_becomes_the_iso_code_gb():
    """`uk` is the ccTLD. The country shapes carry ISO_A2, where it is GB, and a
    record keyed "UK" is one no country card can ever find."""
    merged = ef.merge({"uk": {"physical": ef.parse_exchange(CBPF_UA, "measured")}})
    assert list(merged) == ["GB"]
    assert merged["GB"]["api_code"] == "uk"


def test_the_eu_row_is_marked_as_an_aggregate_rather_than_a_country():
    merged = ef.merge({"eu": {"physical": ef.parse_exchange(CBPF_UA, "measured")}})
    assert merged["EU"]["aggregate"] is True


def test_a_country_with_no_data_at_all_is_dropped_rather_than_stored_empty():
    assert ef.merge({"cy": {}}) == {}
    assert ef.merge({"cy": {"physical": None}}) == {}


# --- defensive parsing ------------------------------------------------------


def test_a_trailing_row_of_nulls_is_not_reported_as_the_current_state():
    """The publisher writes "not yet measured" as nulls. Taking the last row
    regardless would draw every border at zero the moment it appears."""
    payload = {**CBPF_UA, "data": CBPF_UA["data"] + [
        {"timestamp": "2026-08-06T19:30:00+03:00", "values": {
            "belarus": None, "hungary": None, "moldova": None, "poland": None,
            "romania": None, "russia": None, "slovakia": None, "sum": None}},
    ]}
    parsed = ef.parse_exchange(payload, "measured")
    assert parsed["latest_timestamp"] == "2026-08-06T19:15:00+03:00"
    assert parsed["net"] == 0.178
    # The null interval is still counted as part of the window the API returned.
    assert parsed["intervals"] == 4


def test_an_empty_or_malformed_payload_yields_nothing_rather_than_a_blank_record():
    assert ef.parse_exchange({**CBPF_UA, "data": []}, "measured") is None
    assert ef.parse_exchange(None, "measured") is None
    assert ef.parse_exchange({}, "measured") is None


def test_a_country_whose_series_metadata_is_missing_still_parses():
    """Read by key, never by position: a series the metadata block forgot is
    still a border with a number on it."""
    parsed = ef.parse_exchange({**CBPF_UA, "series": []}, "measured")
    assert counterpart(parsed, "poland")["name"] == "poland"
    assert counterpart(parsed, "poland")["value"] == 0.178


# --- the rate limiter -------------------------------------------------------
#
# Observed live: at 3 seconds between requests roughly one in four still comes
# back 429 with a `retry-after` of 1-6 seconds, and the odd connection is
# dropped outright. Both are recoverable and neither may be recorded as a gap --
# a country missing from the sweep is indistinguishable from Cyprus, which has
# no interconnectors and legitimately returns nothing at all.


REQUEST = httpx.Request("GET", "https://api.energy-charts.info/v2/cbpf")


def response(status, **kwargs):
    # httpx refuses raise_for_status() on a response with no request attached.
    return httpx.Response(status, request=REQUEST, **kwargs)


class _StubClient:
    """Replays a scripted list of responses (or exceptions) for each get()."""

    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    async def get(self, url, params=None):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


@pytest.fixture
def no_waiting(monkeypatch):
    """Retries are asserted here, not their duration."""
    slept = []

    async def fake_sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(ef.asyncio, "sleep", fake_sleep)
    return slept


def ok(payload=None):
    return response(200, json=payload if payload is not None else CBPF_UA)


def test_a_429_is_obeyed_and_retried_rather_than_recorded_as_a_gap(no_waiting):
    client = _StubClient(
        response(429, headers={"retry-after": "6"}),
        response(429, headers={"retry-after": "5"}),
        ok(),
    )
    payload, _ = asyncio.run(ef._get(client, "cbpf", "de"))
    assert payload["country"] == "ua"
    assert client.calls == 3
    assert no_waiting == [6.0, 5.0], "the service's own retry-after, not a guess"


def test_a_dropped_connection_is_retried_too(no_waiting):
    client = _StubClient(httpx.ConnectError("All connection attempts failed"), ok())
    payload, _ = asyncio.run(ef._get(client, "cbet", "uk"))
    assert payload is not None
    assert client.calls == 2


def test_a_request_that_never_recovers_finally_fails(no_waiting):
    """So it lands in the sweep's failure list with its status, rather than
    looking like a country with no interconnectors."""
    client = _StubClient(*[response(429, headers={"retry-after": "3"})] * ef.REQUEST_ATTEMPTS)
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(ef._get(client, "cbpf", "de"))
    assert client.calls == ef.REQUEST_ATTEMPTS


def test_a_404_means_no_interconnectors_and_is_not_a_failure(no_waiting):
    """Cyprus answers 404 on both endpoints, permanently and correctly."""
    client = _StubClient(response(404, text="no content available"))
    payload, _ = asyncio.run(ef._get(client, "cbpf", "cy"))
    assert payload is None
    assert client.calls == 1


def test_pacing_falls_back_to_the_floor_when_the_service_says_nothing():
    assert ef._retry_after(response(200)) == ef.REQUEST_SPACING
    assert ef._retry_after(response(429, headers={"retry-after": "9"})) == 9.0
    assert ef._retry_after(response(429, headers={"retry-after": "soon"})) == ef.REQUEST_SPACING
    # Never faster than the floor, however eager the header is.
    assert ef._retry_after(response(200, headers={"retry-after": "0"})) == ef.REQUEST_SPACING


# --- one endpoint down, the other still serving -----------------------------
#
# Observed live on 2026-08-07: /v2/cbpf answered 500 for every country while
# /v2/cbet served normally. Pooled across both endpoints, that is half of every
# request the sweep makes, so it exceeded any tolerance below 50% and the whole
# poll was discarded -- including 37 countries of perfectly good cbet data.
# The two endpoints are independent claims (see the module docstring), so they
# have to be allowed to fail independently too.


class _SweepClient:
    """Answers by endpoint, so a sweep can run with one half of the API down."""

    def __init__(self, **by_endpoint):
        self.by_endpoint = by_endpoint
        self.calls = []

    async def get(self, url, params=None):
        endpoint = url.rsplit("/", 1)[-1]
        self.calls.append((endpoint, (params or {}).get("country")))
        outcome = self.by_endpoint[endpoint]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def count(self, endpoint):
        return sum(1 for name, _country in self.calls if name == endpoint)


@pytest.fixture
def sweep_client(monkeypatch, no_waiting):
    def install(**by_endpoint):
        client = _SweepClient(**by_endpoint)
        monkeypatch.setattr(ef.httpx, "AsyncClient", lambda **kwargs: client)
        return client

    return install


def test_a_dead_endpoint_does_not_discard_the_live_ones_data(sweep_client):
    client = sweep_client(cbpf=response(500, text="Internal Server Error"), cbet=ok(CBET_UA))
    merged, failures, abandoned = asyncio.run(ef._sweep())

    assert abandoned == {"cbpf"}
    assert len(merged) == len(ef.COUNTRIES), "every country still has its schedule"
    assert all("physical" not in record for record in merged.values())
    assert all(record["commercial"]["measurement"] == "scheduled" for record in merged.values())
    assert not failures["cbet"]


def test_a_dead_endpoint_is_asked_a_bounded_number_of_times(sweep_client):
    """It is a free service with a live rate limiter, and re-confirming a 500
    once per country spends 38 slots to learn one thing."""
    client = sweep_client(cbpf=response(500, text="Internal Server Error"), cbet=ok(CBET_UA))
    asyncio.run(ef._sweep())

    assert client.count("cbpf") == ef.ENDPOINT_DEAD_AFTER
    assert client.count("cbet") == len(ef.COUNTRIES), "the healthy endpoint is not throttled"


def test_an_endpoint_that_answers_404_is_working_not_dying(sweep_client):
    """Cyprus has no interconnectors and says so. A sweep of nothing but that
    must not be mistaken for an outage and abandoned."""
    client = sweep_client(cbpf=response(404, text="no content available"), cbet=ok(CBET_UA))
    merged, failures, abandoned = asyncio.run(ef._sweep())

    assert abandoned == set()
    assert not failures["cbpf"]
    assert client.count("cbpf") == len(ef.COUNTRIES)


def test_the_verdict_names_the_dead_endpoint_and_what_is_still_served():
    live, degraded, note = ef.sweep_verdict(
        {"cbpf": [f"cbpf/{c}: Server error '500'" for c in ("eu", "at", "ba", "be", "bg")],
         "cbet": []},
        {"cbpf"},
    )
    assert live == ["cbet"]
    assert degraded == ["cbpf"]
    assert "cbpf" in note and "skipped" in note
    assert "serving cbet only" in note


def test_the_verdict_refuses_to_publish_when_every_endpoint_is_down():
    live, degraded, note = ef.sweep_verdict(
        {"cbpf": ["cbpf/eu: boom"], "cbet": ["cbet/eu: boom"]}, {"cbpf", "cbet"}
    )
    assert live == []
    assert degraded == ["cbpf", "cbet"]
    assert "serving" not in note, "there is nothing to serve"


def test_a_handful_of_failed_borders_is_reported_without_condemning_the_endpoint():
    """A few countries going quiet is normal and must stay a green light with a
    footnote, not a degraded endpoint."""
    live, degraded, note = ef.sweep_verdict({"cbpf": ["cbpf/ua: timeout"], "cbet": []}, set())
    assert live == ["cbpf", "cbet"]
    assert degraded == []
    assert note == "1 of 76 requests failed: cbpf/ua: timeout"


def test_a_clean_sweep_says_nothing():
    assert ef.sweep_verdict({"cbpf": [], "cbet": []}, set()) == (["cbpf", "cbet"], [], None)
