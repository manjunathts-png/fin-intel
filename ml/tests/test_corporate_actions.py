"""
Since Stooq stopped serving GitHub runners, OHLCV comes from NSE bhavcopy
closes, which are not adjusted for splits or bonuses (nor is bhavcopy's
PREV_CLOSE on the ex-date, as a first fix wrongly assumed). On 2026-11-25
CUPID showed max_dd_1y = -85.5% while only 31% below its 52-week high, and
the 3M model scored it exactly 0. 31 Nifty 500 stocks had such cliffs, e.g.
BAJFINANCE -90% on 2025-06-16 (1:2 split + 4:1 bonus) and HDFCBANK -50% on
2025-08-26 (1:1 bonus). The factor is read from the ex-date open.
"""

import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
import extract_stock_features as esf


def _series(closes, opens=None, start="2026-01-01"):
    idx = pd.bdate_range(start, periods=len(closes))
    opens = opens if opens is not None else closes
    return pd.DataFrame({
        "open": opens, "high": closes, "low": closes, "close": closes,
        "volume": [1000.0] * len(closes),
    }, index=idx)


def test_split_plus_bonus_snaps_to_exact_factor():
    # BAJFINANCE-style: ~1000 -> ~100 with a small gap and an intraday move on the ex-date
    df = _series([1000.0, 1010.0, 1000.0, 104.0, 105.0], opens=[1000, 1010, 1000, 101.5, 104])
    out, n = esf.adjust_for_corporate_actions("BAJFINANCE", df)
    assert n == 1
    assert out["close"].iloc[:3].tolist() == pytest.approx([100.0, 101.0, 100.0])   # factor snapped to 0.1
    assert out["volume"].iloc[0] == pytest.approx(10000.0)
    assert out["close"].iloc[3:].tolist() == [104.0, 105.0]
    assert (out["close"] / out["close"].shift(1)).dropna().between(0.8, 1.2).all()


def test_bonus_one_for_one():
    df = _series([2000.0, 1990.0, 1002.0, 1010.0], opens=[2000, 1990, 990, 1002])
    out, n = esf.adjust_for_corporate_actions("HDFCBANK", df)
    assert n == 1
    assert out["close"].iloc[:2].tolist() == pytest.approx([1000.0, 995.0])          # factor 0.5


def test_intraday_crash_is_genuine():
    df = _series([100.0, 101.0, 40.0, 41.0], opens=[100, 101, 98, 40])  # opened normal, fell during the day
    out, n = esf.adjust_for_corporate_actions("X", df)
    assert n == 0
    assert out["close"].tolist() == [100.0, 101.0, 40.0, 41.0]


def test_unusual_ratio_uses_raw_open_ratio():
    df = _series([300.0, 300.0, 70.0, 71.0], opens=[300, 300, 69.0, 70])  # 0.23: no common ratio within 6%
    out, n = esf.adjust_for_corporate_actions("Y", df)
    assert n == 1
    assert out["close"].iloc[0] == pytest.approx(300.0 * 69.0 / 300.0)


def test_missing_open_falls_back_to_close_ratio():
    df = _series([200.0, 200.0, 100.0, 101.0])
    df.loc[df.index[2], "open"] = float("nan")
    out, n = esf.adjust_for_corporate_actions("Z", df)
    assert n == 1
    assert out["close"].iloc[:2].tolist() == pytest.approx([100.0, 100.0])


def test_multiple_actions_compound():
    df = _series([400.0, 200.0, 201.0, 40.2, 40.0], opens=[400, 200, 201, 40.2, 40.0])  # bonus 1:1, then split 1:5
    out, n = esf.adjust_for_corporate_actions("W", df)
    assert n == 2
    assert out["close"].round(2).tolist() == [40.0, 40.0, 40.2, 40.2, 40.0]


def test_clean_series_untouched():
    df = _series([100.0, 103.0, 98.0, 99.0])
    out, n = esf.adjust_for_corporate_actions("C", df)
    assert n == 0 and out is df


def test_fetch_ohlcv_repairs_and_persists_cached_series(monkeypatch, tmp_path):
    df = _series([100.0, 100.0, 50.0, 51.0])
    monkeypatch.setattr(esf, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(esf, "_fetch_ohlcv_raw", lambda sym, start: df)
    out = esf.fetch_ohlcv("BONUS")
    assert out["close"].tolist() == [50.0, 50.0, 50.0, 51.0]
    saved = pd.read_parquet(tmp_path / "BONUS.parquet")
    assert saved["close"].tolist() == [50.0, 50.0, 50.0, 51.0]
