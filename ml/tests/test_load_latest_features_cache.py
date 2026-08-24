"""
Tests for train.py/train_stock.py's load_latest_features caching.

Both scripts run 3x per pipeline invocation (raw-return, Sharpe-target, 1m
horizon), and each call load_latest_features(supabase, pred_date) with the
same pred_date every time — before this fix, that was 3 separate identical
Supabase queries for a single day's feature snapshot, the same redundancy
already fixed for load_labeled(). These tests pin: repeated calls with the
same prediction_date hit Supabase once, and a different prediction_date
(e.g. a backfill script iterating multiple dates) is not served stale data
from another date's cache.
"""

import shutil
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
import train
import train_stock


class FakeExecResult:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    def __init__(self, rows, calls):
        self._rows = rows
        self._calls = calls

    def select(self, *_a, **_kw):
        return self

    def eq(self, _col, _val):
        self._calls.append(1)
        return self

    def execute(self):
        return FakeExecResult(self._rows)


class FakeSupabase:
    def __init__(self, rows):
        self._rows = rows
        self.calls = []

    def table(self, _name):
        return FakeQuery(self._rows, self.calls)


@pytest.fixture(autouse=True)
def cleanup_cache_files():
    yield
    for p in Path(__file__).parent.parent.glob(".cache_mf_latest_features_*.parquet"):
        p.unlink()
    for p in Path(__file__).parent.parent.glob(".cache_stock_latest_features_*.parquet"):
        p.unlink()


def test_train_mf_load_latest_features_hits_supabase_once_per_date():
    rows = [{"scheme_code": "123", "as_of_date": "2026-08-18", "ret1m": 1.0}]
    fake = FakeSupabase(rows)
    d = date(2026, 8, 18)

    train.load_latest_features(fake, d)
    train.load_latest_features(fake, d)
    train.load_latest_features(fake, d)

    assert len(fake.calls) == 1, "3 calls with the same prediction_date should hit Supabase once"


def test_train_stock_load_latest_features_hits_supabase_once_per_date():
    rows = [{"symbol": "TCS.NS", "as_of_date": "2026-08-18", "ret1m": 1.0}]
    fake = FakeSupabase(rows)
    d = date(2026, 8, 18)

    train_stock.load_latest_features(fake, d)
    train_stock.load_latest_features(fake, d)
    train_stock.load_latest_features(fake, d)

    assert len(fake.calls) == 1, "3 calls with the same prediction_date should hit Supabase once"


def test_different_prediction_dates_do_not_share_a_cache():
    rows = [{"scheme_code": "123", "as_of_date": "2026-08-18", "ret1m": 1.0}]
    fake = FakeSupabase(rows)

    train.load_latest_features(fake, date(2026, 8, 18))
    train.load_latest_features(fake, date(2026, 8, 19))

    assert len(fake.calls) == 2, "a different prediction_date must not be served from another date's cache"
