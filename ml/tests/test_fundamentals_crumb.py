"""
fetch_fundamentals() must send Yahoo's crumb: quoteSummary answers 401
("Invalid Crumb") without one, and every failure path used to return {}
silently, so stock_fundamentals_history stayed empty from day one.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
import extract_stock_features as esf


class FakeResponse:
    def __init__(self, status_code, text="", payload=None):
        self.status_code = status_code
        self.text = text
        self._payload = payload

    def json(self):
        return self._payload


SUMMARY = {"quoteSummary": {"result": [{
    "summaryDetail": {"trailingPE": {"raw": 21.5}, "dividendYield": {"raw": 0.012}},
    "financialData": {"returnOnEquity": {"raw": 0.18}},
    "defaultKeyStatistics": {"priceToBook": {"raw": 3.1}},
}]}}


class FakeSession:
    def __init__(self, crumbs, valid_crumb, summary_status=200):
        self._crumbs = list(crumbs)
        self._valid = valid_crumb
        self._summary_status = summary_status
        self.summary_calls = []

    def get(self, url, params=None, timeout=None):
        if url == esf._YF_CRUMB_URL:
            return FakeResponse(200, text=self._crumbs.pop(0))
        self.summary_calls.append(dict(params or {}))
        if (params or {}).get("crumb") != self._valid:
            return FakeResponse(401, payload={"finance": {"error": {"code": "Unauthorized"}}})
        if self._summary_status != 200:
            return FakeResponse(self._summary_status)
        return FakeResponse(200, payload=SUMMARY)


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    monkeypatch.setattr(esf, "FUND_CACHE_DIR", tmp_path)
    esf._FUND_FAILURES.clear()
    yield
    esf._FUND_FAILURES.clear()
    for attr in ("session", "crumb"):
        if hasattr(esf._FUND_LOCAL, attr):
            delattr(esf._FUND_LOCAL, attr)


def _use(fake):
    esf._FUND_LOCAL.session = fake
    esf._FUND_LOCAL.crumb = None


def test_sends_crumb_and_parses_fundamentals(monkeypatch):
    fake = FakeSession(crumbs=["good"], valid_crumb="good")
    _use(fake)

    fd = esf.fetch_fundamentals("TCS")

    assert fake.summary_calls[0]["crumb"] == "good"
    assert fd["pe_ratio"] == 21.5
    assert fd["roe"] == 18.0
    assert fd["pb_ratio"] == 3.1


def test_refreshes_stale_crumb_once_on_401(monkeypatch):
    fake = FakeSession(crumbs=["stale", "fresh"], valid_crumb="fresh")
    _use(fake)

    fd = esf.fetch_fundamentals("TCS")

    assert [c["crumb"] for c in fake.summary_calls] == ["stale", "fresh"]
    assert fd["pe_ratio"] == 21.5


def test_failures_are_counted_not_silent(monkeypatch):
    fake = FakeSession(crumbs=["good"], valid_crumb="good", summary_status=404)
    _use(fake)

    assert esf.fetch_fundamentals("NOPE") == {}
    assert esf._FUND_FAILURES["HTTP 404"] == 1


def test_html_crumb_response_is_rejected(monkeypatch):
    fake = FakeSession(crumbs=["<html>blocked</html>"], valid_crumb="x")
    _use(fake)

    assert esf._get_crumb() is None


def test_fund_session_uses_curl_cffi_chrome_impersonation(monkeypatch):
    from curl_cffi import requests as cffi_requests

    def no_network(self, *a, **kw):
        raise ConnectionError("offline")

    monkeypatch.setattr(cffi_requests.Session, "get", no_network)
    session = esf._fund_session()
    assert type(session).__module__.startswith("curl_cffi")
