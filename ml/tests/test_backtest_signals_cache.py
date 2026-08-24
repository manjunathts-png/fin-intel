"""
Tests for backtest_stock_signals.py's load_labeled caching.

`--horizon both` (the default) calls load_labeled(supabase, ret_col) twice
in the same process — once for fwd_ret_1m, once for fwd_ret_3m — against
the identical stock_features table, differing only in which column's
not-null filter is applied. These tests pin: the underlying table is
fetched once per process (module-level cache) and reused across ret_cols,
each call still returns the correct ret_col-specific subset, and a later
call for a column that isn't in the fetched frame (e.g. run before any
labels exist) degrades to empty rather than raising.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
import backtest_stock_signals as bts


class FakeExecResult:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    def __init__(self, rows, calls):
        self._rows = rows
        self._calls = calls
        self._offset = 0

    def select(self, *_a, **_kw):
        return self

    def order(self, *_a, **_kw):
        return self

    def range(self, start, end):
        self._offset = start
        self._end = end
        return self

    def execute(self):
        self._calls.append(1)
        page = self._rows[self._offset:self._end + 1]
        return FakeExecResult(page)


class FakeSupabase:
    def __init__(self, rows):
        self._rows = rows
        self.calls = []

    def table(self, _name):
        return FakeQuery(self._rows, self.calls)


@pytest.fixture(autouse=True)
def reset_module_cache():
    bts._full_features_cache = None
    yield
    bts._full_features_cache = None


def test_two_ret_cols_fetch_supabase_once():
    rows = [
        {"symbol": "A.NS", "as_of_date": "2026-08-01", "fwd_ret_1m": 1.0, "fwd_ret_3m": None},
        {"symbol": "B.NS", "as_of_date": "2026-08-01", "fwd_ret_1m": None, "fwd_ret_3m": 2.0},
    ]
    fake = FakeSupabase(rows)

    df_1m = bts.load_labeled(fake, "fwd_ret_1m")
    df_3m = bts.load_labeled(fake, "fwd_ret_3m")

    assert len(fake.calls) == 1, "second ret_col should reuse the cached full table, not re-fetch"
    assert len(df_1m) == 1 and df_1m.iloc[0]["symbol"] == "A.NS"
    assert len(df_3m) == 1 and df_3m.iloc[0]["symbol"] == "B.NS"


def test_missing_column_returns_empty_not_error():
    rows = [{"symbol": "A.NS", "as_of_date": "2026-08-01", "fwd_ret_1m": 1.0}]
    fake = FakeSupabase(rows)

    df = bts.load_labeled(fake, "fwd_ret_3m")  # column not present at all
    assert df.empty
