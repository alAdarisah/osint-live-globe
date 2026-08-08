"""What the proxy pool accepts off a free list, and what it prefers.

The records below are trimmed copies of live Proxifly responses (2026-08-07) --
same keys, same typing, same `geolocation` nesting.

Two of these tests are about a trap in the source data rather than about our
code. Proxifly reports `https: false` on almost every SOCKS entry, and files an
HTTP proxy under `protocols/https` when it will CONNECT to a TLS origin. Read
those two facts the obvious way round and you get a pool that is empty of SOCKS
and full of HTTP nodes that cannot tunnel -- which is a pool of zero usable
proxies that looks like several hundred.
"""

import asyncio

import httpx
import pytest

from backend import config, proxypool


def entry(url, protocol, https=False, score=1, country="US", anonymity="transparent"):
    ip, _, port = url.split("://", 1)[1].partition(":")
    return {
        "proxy": url,
        "protocol": protocol,
        "ip": ip,
        "port": int(port),
        "https": https,
        "anonymity": anonymity,
        "score": score,
        "geolocation": {"country": country, "city": "Unknown"},
    }


class _Response:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("boom", request=None, response=None)

    def json(self):
        return self._payload


class _Client:
    """Answers by list filename -- 'socks5', 'socks4', 'https'."""

    def __init__(self, answers):
        self._answers = answers
        self.urls = []

    async def get(self, url):
        self.urls.append(url)
        for name, answer in self._answers.items():
            if f"/{name}/" in url:
                if isinstance(answer, Exception):
                    raise answer
                return _Response(answer)
        return _Response([], status=404)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.fixture(autouse=True)
def _clean_pool(monkeypatch):
    proxypool.reset()
    monkeypatch.setattr(config, "PROXY_PROTOCOLS", ["socks5", "socks4", "http"])
    monkeypatch.setattr(config, "PROXY_POOL_MAX", 400)
    monkeypatch.setattr(config, "PROXY_LIST_TTL", 900)
    monkeypatch.setattr(config, "PROXY_FAILURE_COOLDOWN", 1800)
    monkeypatch.setattr(config, "PROXY_SUCCESS_MEMORY", 6 * 3600)
    # The pool shuffles before ranking so that repeated failures walk the list
    # instead of retrying its head. Ordering assertions want the ranking, not
    # the shuffle.
    monkeypatch.setattr(proxypool.random, "shuffle", lambda seq: None)
    yield
    proxypool.reset()


def _serve(monkeypatch, answers):
    client = _Client(answers)
    monkeypatch.setattr(proxypool.httpx, "AsyncClient", lambda **kwargs: client)
    return client


def test_an_http_proxy_that_will_not_tunnel_tls_is_no_use_to_us(monkeypatch):
    """Everything routed through this pool is wss:// or https://, so an HTTP
    node that won't CONNECT fails at the tunnel every time."""
    _serve(monkeypatch, {"https": [
        entry("http://1.1.1.1:8080", "http", https=True),
        entry("http://2.2.2.2:8080", "http", https=False),
    ]})
    urls = [p.url for p in asyncio.run(proxypool.candidates())]
    assert urls == ["http://1.1.1.1:8080"]


def test_socks_nodes_survive_the_https_flag_being_false(monkeypatch):
    """The trap: Proxifly reports https: false on nearly every SOCKS entry, and
    reading that as 'cannot carry TLS' empties the SOCKS list. SOCKS carries
    whatever bytes it is handed -- the flag is only meaningful for HTTP."""
    _serve(monkeypatch, {
        "socks5": [entry("socks5://3.3.3.3:1080", "socks5", https=False)],
        "socks4": [entry("socks4://4.4.4.4:1080", "socks4", https=False)],
    })
    urls = {p.url for p in asyncio.run(proxypool.candidates())}
    assert urls == {"socks5://3.3.3.3:1080", "socks4://4.4.4.4:1080"}


def test_a_malformed_record_costs_us_that_record_and_nothing_else(monkeypatch):
    """A scraped list rebuilt every five minutes will contain junk. One bad
    entry is not a reason to have no proxies."""
    _serve(monkeypatch, {"socks5": [
        "not-a-dict",
        {"proxy": None, "protocol": "socks5"},
        {"protocol": "socks5"},
        entry("socks5://5.5.5.5:1080", "socks5"),
        {"proxy": "socks5://6.6.6.6:1080", "protocol": "http"},   # mislabelled
        {"proxy": "http://7.7.7.7:1080", "protocol": "socks5"},   # scheme disagrees
    ]})
    urls = [p.url for p in asyncio.run(proxypool.candidates())]
    assert urls == ["socks5://5.5.5.5:1080"]


def test_the_same_node_on_two_lists_is_one_candidate(monkeypatch):
    _serve(monkeypatch, {
        "socks5": [entry("socks5://8.8.8.8:1080", "socks5")] * 3,
        "socks4": [entry("socks4://8.8.8.8:1080", "socks4")],
    })
    urls = [p.url for p in asyncio.run(proxypool.candidates())]
    assert sorted(urls) == ["socks4://8.8.8.8:1080", "socks5://8.8.8.8:1080"]


def test_fields_worth_logging_survive_the_parse(monkeypatch):
    _serve(monkeypatch, {"socks5": [
        entry("socks5://9.9.9.9:1080", "socks5", score=7, country="NL", anonymity="elite"),
    ]})
    proxy = asyncio.run(proxypool.candidates())[0]
    assert (proxy.country, proxy.anonymity, proxy.score) == ("NL", "elite", 7.0)
    assert "NL" in str(proxy)


def test_a_dead_list_leaves_the_one_we_had(monkeypatch):
    """The caller is already in a failure path when it gets here. A stale list
    of nodes that worked an hour ago beats no list."""
    _serve(monkeypatch, {"socks5": [entry("socks5://1.2.3.4:1080", "socks5")]})
    assert len(asyncio.run(proxypool.candidates())) == 1

    _serve(monkeypatch, {"socks5": httpx.ConnectError("cdn unreachable")})
    proxypool._fetched_at = 0.0  # force the refetch that is about to fail
    assert [p.url for p in asyncio.run(proxypool.candidates())] == ["socks5://1.2.3.4:1080"]


def test_the_list_is_not_refetched_inside_its_ttl(monkeypatch):
    """Proxifly rebuilds every 5 minutes and this is only ever called while
    something is already failing; re-reading faster than nodes die produces the
    same nodes and more traffic."""
    monkeypatch.setattr(config, "PROXY_PROTOCOLS", ["socks5"])  # one list, one request
    client = _serve(monkeypatch, {"socks5": [entry("socks5://1.2.3.4:1080", "socks5")]})
    asyncio.run(proxypool.candidates())
    asyncio.run(proxypool.candidates())
    assert len(client.urls) == 1

    proxypool._fetched_at -= config.PROXY_LIST_TTL + 1
    asyncio.run(proxypool.candidates())
    assert len(client.urls) == 2


def test_a_healthy_stack_never_asks_for_a_list_at_all(monkeypatch):
    """Nothing here runs on the happy path -- the fetch is lazy, behind a
    caller that has already failed several direct connections."""
    client = _serve(monkeypatch, {"socks5": [entry("socks5://1.2.3.4:1080", "socks5")]})
    assert client.urls == []


def test_a_node_that_carried_a_connection_is_tried_first(monkeypatch):
    """Recency beats the list's own score, which is 1 for nearly every free
    entry: a node that worked ten minutes ago is the best evidence available."""
    _serve(monkeypatch, {"socks5": [
        entry("socks5://1.1.1.1:1080", "socks5", score=9),
        entry("socks5://2.2.2.2:1080", "socks5", score=1),
    ]})
    proxypool.record("socks5://2.2.2.2:1080", ok=True)
    urls = [p.url for p in asyncio.run(proxypool.candidates())]
    assert urls[0] == "socks5://2.2.2.2:1080"


def test_untried_nodes_come_before_ones_already_known_to_fail(monkeypatch):
    _serve(monkeypatch, {"socks5": [
        entry("socks5://1.1.1.1:1080", "socks5"),
        entry("socks5://2.2.2.2:1080", "socks5"),
    ]})
    proxypool.record("socks5://1.1.1.1:1080", ok=False)
    proxypool._outcomes["socks5://1.1.1.1:1080"].last_fail -= config.PROXY_FAILURE_COOLDOWN + 1
    urls = [p.url for p in asyncio.run(proxypool.candidates())]
    assert urls == ["socks5://2.2.2.2:1080", "socks5://1.1.1.1:1080"]


def test_a_node_that_just_failed_is_benched_and_then_comes_back(monkeypatch):
    """Benched, not deleted. Free proxies recover, and the list is the same
    list five minutes later -- a permanent ban would empty the pool in a day."""
    _serve(monkeypatch, {"socks5": [entry("socks5://1.1.1.1:1080", "socks5")]})
    proxypool.record("socks5://1.1.1.1:1080", ok=False)
    assert asyncio.run(proxypool.candidates()) == []

    proxypool._outcomes["socks5://1.1.1.1:1080"].last_fail -= config.PROXY_FAILURE_COOLDOWN + 1
    assert [p.url for p in asyncio.run(proxypool.candidates())] == ["socks5://1.1.1.1:1080"]


def test_the_cooldown_lengthens_with_the_failure_streak(monkeypatch):
    _serve(monkeypatch, {"socks5": [entry("socks5://1.1.1.1:1080", "socks5")]})
    for _ in range(3):
        proxypool.record("socks5://1.1.1.1:1080", ok=False)
    outcome = proxypool._outcomes["socks5://1.1.1.1:1080"]

    outcome.last_fail -= config.PROXY_FAILURE_COOLDOWN + 1
    assert asyncio.run(proxypool.candidates()) == []  # one cooldown is not enough now

    outcome.last_fail -= config.PROXY_FAILURE_COOLDOWN * 2
    assert len(asyncio.run(proxypool.candidates())) == 1


def test_a_success_clears_the_streak(monkeypatch):
    _serve(monkeypatch, {"socks5": [entry("socks5://1.1.1.1:1080", "socks5")]})
    for _ in range(4):
        proxypool.record("socks5://1.1.1.1:1080", ok=False)
    proxypool.record("socks5://1.1.1.1:1080", ok=True)
    assert len(asyncio.run(proxypool.candidates())) == 1


def test_the_pool_is_capped(monkeypatch):
    monkeypatch.setattr(config, "PROXY_POOL_MAX", 10)
    _serve(monkeypatch, {"socks5": [
        entry(f"socks5://10.0.0.{i}:1080", "socks5") for i in range(1, 60)
    ]})
    assert len(asyncio.run(proxypool.candidates())) == 10


def test_only_the_configured_protocols_are_fetched(monkeypatch):
    monkeypatch.setattr(config, "PROXY_PROTOCOLS", ["socks5"])
    client = _serve(monkeypatch, {"socks5": [entry("socks5://1.1.1.1:1080", "socks5")]})
    asyncio.run(proxypool.candidates())
    assert len(client.urls) == 1 and "/socks5/" in client.urls[0]


def test_a_protocol_with_no_list_behind_it_is_skipped_not_fatal(monkeypatch):
    monkeypatch.setattr(config, "PROXY_PROTOCOLS", ["carrier-pigeon", "socks5"])
    _serve(monkeypatch, {"socks5": [entry("socks5://1.1.1.1:1080", "socks5")]})
    assert len(asyncio.run(proxypool.candidates())) == 1


def test_candidates_can_be_limited_to_what_one_cycle_will_use(monkeypatch):
    _serve(monkeypatch, {"socks5": [
        entry(f"socks5://10.0.0.{i}:1080", "socks5") for i in range(1, 20)
    ]})
    assert len(asyncio.run(proxypool.candidates(limit=3))) == 3


def test_outcomes_do_not_accumulate_for_nodes_that_left_the_list(monkeypatch):
    """This dict is keyed by ip:port off a list that turns over every few
    minutes, in a process that runs for months."""
    _serve(monkeypatch, {"socks5": [entry("socks5://1.1.1.1:1080", "socks5")]})
    asyncio.run(proxypool.candidates())
    proxypool.record("socks5://1.1.1.1:1080", ok=False)

    _serve(monkeypatch, {"socks5": [entry("socks5://2.2.2.2:1080", "socks5")]})
    proxypool._fetched_at = 0.0
    asyncio.run(proxypool.candidates())
    assert list(proxypool._outcomes) == []


def test_stats_describe_the_pool_without_touching_the_network(monkeypatch):
    _serve(monkeypatch, {
        "socks5": [entry("socks5://1.1.1.1:1080", "socks5")],
        "socks4": [entry("socks4://2.2.2.2:1080", "socks4")],
    })
    asyncio.run(proxypool.candidates())
    proxypool.record("socks5://1.1.1.1:1080", ok=True)
    stats = proxypool.stats()
    assert stats["size"] == 2
    assert stats["known_good"] == 1
    assert stats["by_protocol"]["socks4"] == 1
