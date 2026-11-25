"""
Since Stooq stopped serving GitHub runners, OHLCV comes from NSE bhavcopy
closes, which are not adjusted for splits or bonuses. On 2026-11-25 CUPID's
features showed max_dd_1y = -85.5% while it sat only 31% below its 52-week
high, and the 3M model scored it exactly 0 (failing the ML Quality health
check). adjust_for_corporate_actions() back-adjusts such cliffs using NSE's
own adjusted PREV_CLOSE on the ex-date.
"""

import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
import extract_stock_features as esf


def _series(closes, start="2026-01-01"):
    idx = pd.bdate_range(start, periods=len(closes))
    return pd.DataFrame({
        "open": closes, "high": closes, "low": closes, "close": closes,
        "volume": [1000.0] * len(closes),
    }, index=idx)


@pytest.fixture
def prev_closes(monkeypatch):
    """Map of date -> NSE PREV_CLOSE; dates not in the map are 'unavailable'."""
    table: dict = {}
    monkeypatch.setattr(esf, "_bhavcopy_prev_close", lambda sym, dt: table.get(pd.Timestamp(dt)))
    return table


def test_split_is_back_adjusted_with_nse_prev_close(prev_closes):
    df = _series([100.0, 102.0, 101.0, 10.3, 10.5])   # 1:10 split on day 4
    prev_closes[df.index[3]] = 10.1                    # NSE's adjusted prev close
    out, n = esf.adjust_for_corporate_actions("CUPID", df)
    assert n == 1
    assert out["close"].iloc[:3].round(2).tolist() == [10.0, 10.2, 10.1]  # × 10.1/101 = 0.1
    assert out["volume"].iloc[0] == pytest.approx(1000 / (10.1 / 101.0))
    assert out["close"].iloc[3:].tolist() == [10.3, 10.5]                 # post-split untouched
    ratio = out["close"] / out["close"].shift(1)
    assert ratio.dropna().between(0.8, 1.2).all()                          # no cliff remains


def test_genuine_crash_is_left_alone(prev_closes):
    df = _series([100.0, 101.0, 40.0, 41.0])
    prev_closes[df.index[2]] = 101.0                   # NSE didn't adjust: the drop was real
    out, n = esf.adjust_for_corporate_actions("X", df)
    assert n == 0
    assert out["close"].tolist() == [100.0, 101.0, 40.0, 41.0]


def test_falls_back_to_cliff_ratio_when_bhavcopy_unavailable(prev_closes):
    df = _series([200.0, 200.0, 100.0, 101.0])         # 1:1 bonus, no bhavcopy for that day
    out, n = esf.adjust_for_corporate_actions("Y", df)
    assert n == 1
    assert out["close"].iloc[:2].tolist() == [100.0, 100.0]


def test_multiple_actions_compound(prev_closes):
    df = _series([400.0, 200.0, 201.0, 40.2, 40.0])    # 1:1 bonus, then 1:5 split
    prev_closes[df.index[1]] = 200.0
    prev_closes[df.index[3]] = 40.2
    out, n = esf.adjust_for_corporate_actions("Z", df)
    assert n == 2
    assert out["close"].round(2).tolist() == [40.0, 40.0, 40.2, 40.2, 40.0]


def test_clean_series_untouched(prev_closes):
    df = _series([100.0, 103.0, 98.0, 99.0])
    out, n = esf.adjust_for_corporate_actions("C", df)
    assert n == 0 and out is df


def test_fetch_ohlcv_repairs_and_persists_cached_series(prev_closes, monkeypatch, tmp_path):
    df = _series([100.0, 100.0, 50.0, 51.0])
    prev_closes[df.index[2]] = 50.0
    monkeypatch.setattr(esf, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(esf, "_fetch_ohlcv_raw", lambda sym, start: df)
    out = esf.fetch_ohlcv("BONUS")
    assert out["close"].tolist() == [50.0, 50.0, 50.0, 51.0]
    saved = pd.read_parquet(tmp_path / "BONUS.parquet")
    assert saved["close"].tolist() == [50.0, 50.0, 50.0, 51.0]
