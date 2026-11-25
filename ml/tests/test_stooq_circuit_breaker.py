"""
On 2026-11-25 Stooq started silently dropping connections from GitHub
runners instead of answering 403, so fetch_ohlcv() waited out the timeout
for every one of ~500 stocks before falling back to the NSE bhavcopy and
the extract step ran for hours. After a few consecutive failures Stooq
must be skipped for the rest of the run.
"""

import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
import extract_stock_features as esf


class DroppingSession:
    def __init__(self):
        self.stooq_calls = 0

    def get(self, url, **kw):
        if "stooq.com" in url:
            self.stooq_calls += 1
            raise ConnectionError("connect timeout")
        raise AssertionError(f"unexpected request {url}")


def _bhav_df(*_a, **_kw):
    idx = pd.to_datetime(["2026-11-20", "2026-11-21"])
    return pd.DataFrame({"open": [1, 2], "high": [1, 2], "low": [1, 2], "close": [1, 2], "volume": [10, 20]}, index=idx)


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    monkeypatch.setattr(esf, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(esf, "_stooq_fails", 0)
    monkeypatch.setattr(esf, "_fetch_ohlcv_bhavcopy", _bhav_df)


def test_stooq_skipped_after_consecutive_failures(monkeypatch):
    session = DroppingSession()
    monkeypatch.setattr(esf, "_SESSION", session)

    for sym in ["A", "B", "C", "D", "E", "F"]:
        df = esf.fetch_ohlcv(sym)
        assert not df.empty  # bhavcopy fallback still serves every stock

    assert session.stooq_calls == esf._STOOQ_MAX_FAILS
    assert esf._stooq_disabled()


def test_success_resets_the_failure_count():
    esf._note_stooq_result(False)
    esf._note_stooq_result(False)
    esf._note_stooq_result(True)
    esf._note_stooq_result(False)
    assert not esf._stooq_disabled()
