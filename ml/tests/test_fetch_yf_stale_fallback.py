"""
Tests for fetch_yf's stale-cache carry-forward (ml/macro_features.py).

2026-08-10/11 incident: mfapi.in timed out and Yahoo 429'd on every fallback
ticker for Nifty, USDINR, and US10Y in the same run. Nifty emptiness is fatal
(main() calls sys.exit(1)), so a transient outage on all live sources took
down the whole day's MF feature extraction. Fixed by falling back to the last
cached parquet (however stale) rather than aborting — these tests pin: the
fallback fires only when every live source is exhausted, it doesn't refresh
the cache file's mtime (so the next run still retries live sources), and a
missing cache still surfaces as a genuine failure.
"""

import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
import macro_features


def make_df(dates, closes):
    return pd.DataFrame({"close": closes}, index=pd.to_datetime(dates))


def test_stale_cache_used_when_all_live_sources_fail(tmp_path, monkeypatch):
    cache_file = tmp_path / "nifty_daily.parquet"
    stale = make_df(["2026-08-08"], [24500.0])
    stale.to_parquet(cache_file)
    # Backdate the cache well past the 12h freshness window.
    old_mtime = cache_file.stat().st_mtime - 48 * 3600
    import os
    os.utime(cache_file, (old_mtime, old_mtime))

    monkeypatch.setattr(macro_features, "_fetch_nifty_via_mfapi", lambda start: pd.DataFrame())
    monkeypatch.setattr(macro_features, "_fetch_yahoo_direct", lambda ticker, start: pd.DataFrame())

    df = macro_features.fetch_yf(["^NSEI", "NIFTYBEES.NS"], cache_file)
    assert not df.empty
    assert df["close"].iloc[-1] == 24500.0


def test_stale_fallback_does_not_refresh_cache_mtime(tmp_path, monkeypatch):
    cache_file = tmp_path / "nifty_daily.parquet"
    stale = make_df(["2026-08-08"], [24500.0])
    stale.to_parquet(cache_file)
    old_mtime = cache_file.stat().st_mtime - 48 * 3600
    import os
    os.utime(cache_file, (old_mtime, old_mtime))
    mtime_before = cache_file.stat().st_mtime

    monkeypatch.setattr(macro_features, "_fetch_nifty_via_mfapi", lambda start: pd.DataFrame())
    monkeypatch.setattr(macro_features, "_fetch_yahoo_direct", lambda ticker, start: pd.DataFrame())

    macro_features.fetch_yf(["^NSEI", "NIFTYBEES.NS"], cache_file)
    assert cache_file.stat().st_mtime == mtime_before, (
        "serving a stale-fallback result must not reset the cache's mtime — "
        "otherwise the next run would stop retrying live sources entirely"
    )


def test_live_fetch_success_refreshes_cache_normally(tmp_path, monkeypatch):
    cache_file = tmp_path / "nifty_daily.parquet"
    fresh = make_df(["2026-08-11"], [24800.0])

    monkeypatch.setattr(macro_features, "_fetch_nifty_via_mfapi", lambda start: fresh)

    df = macro_features.fetch_yf(["^NSEI", "NIFTYBEES.NS"], cache_file)
    assert not df.empty
    assert cache_file.exists(), "a genuine live fetch should still populate the cache"


def test_no_cache_and_all_sources_fail_returns_empty(tmp_path, monkeypatch):
    cache_file = tmp_path / "nifty_daily.parquet"  # never created

    monkeypatch.setattr(macro_features, "_fetch_nifty_via_mfapi", lambda start: pd.DataFrame())
    monkeypatch.setattr(macro_features, "_fetch_yahoo_direct", lambda ticker, start: pd.DataFrame())

    df = macro_features.fetch_yf(["^NSEI", "NIFTYBEES.NS"], cache_file)
    assert df.empty, "with no live source and no cache at all, emptiness must still surface"
