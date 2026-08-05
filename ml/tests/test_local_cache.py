"""
Tests for the same-run disk cache (ml/local_cache.py).

This cache exists to stop train.py / train_stock.py from re-downloading the
full mf_features / stock_features table from Supabase 3x per pipeline run
(once per horizon/target variant) — the dominant driver of this project's
Supabase egress for a low-traffic site. These tests lock in: a cache hit
skips fetch_fn entirely, a stale/missing/corrupt cache falls back to
fetch_fn, and an empty result is never cached (so a transient "no data yet"
response can't poison later calls in the same run).
"""

import sys
import time
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from local_cache import cached_or_fetch


def make_df():
    return pd.DataFrame({"symbol": ["A.NS", "B.NS"], "as_of_date": pd.to_datetime(["2026-01-01", "2026-01-02"])})


def test_first_call_fetches_and_caches(tmp_path):
    cache_path = tmp_path / "cache.parquet"
    calls = []

    def fetch():
        calls.append(1)
        return make_df()

    df = cached_or_fetch(cache_path, fetch)
    assert len(calls) == 1
    assert len(df) == 2
    assert cache_path.exists()


def test_second_call_within_ttl_skips_fetch(tmp_path):
    cache_path = tmp_path / "cache.parquet"
    calls = []

    def fetch():
        calls.append(1)
        return make_df()

    cached_or_fetch(cache_path, fetch)
    df2 = cached_or_fetch(cache_path, fetch)
    assert len(calls) == 1, "second call should reuse the cached parquet, not re-fetch"
    assert len(df2) == 2


def test_stale_cache_refetches(tmp_path):
    cache_path = tmp_path / "cache.parquet"
    calls = []

    def fetch():
        calls.append(1)
        return make_df()

    cached_or_fetch(cache_path, fetch, max_age_seconds=1)
    time.sleep(1.1)
    cached_or_fetch(cache_path, fetch, max_age_seconds=1)
    assert len(calls) == 2, "an expired cache must trigger a fresh fetch"


def test_missing_cache_fetches(tmp_path):
    cache_path = tmp_path / "does_not_exist.parquet"
    calls = []

    def fetch():
        calls.append(1)
        return make_df()

    cached_or_fetch(cache_path, fetch)
    assert len(calls) == 1


def test_empty_result_is_not_cached(tmp_path):
    cache_path = tmp_path / "cache.parquet"
    calls = []

    def fetch():
        calls.append(1)
        return pd.DataFrame()

    cached_or_fetch(cache_path, fetch)
    assert not cache_path.exists(), "an empty result must not poison the cache for later calls"
    cached_or_fetch(cache_path, fetch)
    assert len(calls) == 2, "a second call should re-fetch since nothing valid was cached"


def test_corrupt_cache_file_falls_back_to_fetch(tmp_path):
    cache_path = tmp_path / "cache.parquet"
    cache_path.write_text("not actually parquet")
    calls = []

    def fetch():
        calls.append(1)
        return make_df()

    df = cached_or_fetch(cache_path, fetch)
    assert len(calls) == 1
    assert len(df) == 2
