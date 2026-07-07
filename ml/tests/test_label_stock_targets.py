"""
Tests for load_unlabeled's pagination (ml/label_stock_targets.py).

Regression coverage for the 2026-07-07 production incident: OFFSET-based
pagination hit a Postgres statement timeout at offset=6000 while sweeping
the 1M-horizon backlog (its cutoff is more recent than 3M's, so it matches
a larger unlabeled set). Fixed with keyset (cursor) pagination on
(as_of_date, symbol) instead of OFFSET.

The fake client below re-implements the filter/order/limit contract that
real PostgREST applies server-side, so these tests exercise the actual
query-construction logic in load_unlabeled, not just Python-side looping.
"""

import re
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from label_stock_targets import load_unlabeled

OR_RE = re.compile(
    r"^as_of_date\.gt\.(?P<date>[^,]+),"
    r"and\(as_of_date\.eq\.(?P=date),symbol\.gt\.(?P<symbol>[^)]+)\)$"
)


class _FakeQuery:
    """Emulates the one chain load_unlabeled builds, applying filters against
    an in-memory row set exactly as PostgREST would apply them server-side."""

    def __init__(self, rows):
        self._rows = rows
        self._is_null_col = None
        self._cutoff = None
        self._cursor = None  # (last_date, last_symbol) or None
        self._order_cols = []
        self._limit = None

    def select(self, *_a, **_kw):
        return self

    def is_(self, col, val):
        assert val == "null"
        self._is_null_col = col
        return self

    def lte(self, col, val):
        assert col == "as_of_date"
        self._cutoff = val
        return self

    def or_(self, expr):
        m = OR_RE.match(expr)
        assert m, f"unexpected or_() expression shape: {expr}"
        self._cursor = (m.group("date"), m.group("symbol"))
        return self

    def range(self, *_a, **_kw):
        raise AssertionError("must not use OFFSET/.range() — that's the bug being fixed")

    def order(self, col):
        self._order_cols.append(col)
        return self

    def limit(self, n):
        self._limit = n
        return self

    def execute(self):
        rows = [r for r in self._rows if r.get(self._is_null_col) is None]
        rows = [r for r in rows if r["as_of_date"] <= self._cutoff]
        if self._cursor:
            last_date, last_symbol = self._cursor
            rows = [
                r for r in rows
                if r["as_of_date"] > last_date
                or (r["as_of_date"] == last_date and r["symbol"] > last_symbol)
            ]
        assert self._order_cols == ["as_of_date", "symbol"], \
            "must sort by (as_of_date, symbol) — as_of_date alone isn't a stable cursor"
        rows.sort(key=lambda r: (r["as_of_date"], r["symbol"]))
        page = rows[: self._limit]
        return type("Resp", (), {"data": page})()


class _FakeTable:
    def __init__(self, rows):
        self._rows = rows

    def table(self, _name):
        return self

    def select(self, *a, **kw):
        return _FakeQuery(self._rows).select(*a, **kw)


def _row(d, sym, labeled=False):
    return {"as_of_date": d, "symbol": sym, "sector": "IT", "fwd_top_q_1m": True if labeled else None}


def _many_symbols_on_one_date(d, n):
    return [_row(d, f"SYM{i:04d}") for i in range(n)]


def test_pages_past_a_single_page_boundary_without_offset():
    # 2500 rows spread across dates → 3 pages at page_size=1000, all via cursor
    rows = []
    for day in range(1, 6):
        rows += _many_symbols_on_one_date(f"2026-06-{day:02d}", 500)
    fake = _FakeTable(rows)
    df = load_unlabeled(fake, date(2026, 6, 30), "fwd_top_q_1m")
    assert len(df) == 2500
    assert set(df["symbol"]) == {f"SYM{i:04d}" for i in range(500)}


def test_many_rows_share_one_as_of_date_across_a_page_boundary():
    # 1500 symbols on the SAME date — as_of_date alone can't page this safely;
    # this is exactly the shape that motivated adding symbol to the cursor.
    rows = _many_symbols_on_one_date("2026-06-15", 1500)
    fake = _FakeTable(rows)
    df = load_unlabeled(fake, date(2026, 6, 30), "fwd_top_q_1m")
    assert len(df) == 1500, "no row should be skipped or duplicated within one as_of_date"
    assert df["symbol"].nunique() == 1500


def test_respects_the_is_null_filter():
    rows = _many_symbols_on_one_date("2026-06-01", 10)
    rows += [_row("2026-06-01", f"LABELED{i}", labeled=True) for i in range(5)]
    fake = _FakeTable(rows)
    df = load_unlabeled(fake, date(2026, 6, 30), "fwd_top_q_1m")
    assert len(df) == 10
    assert not any(s.startswith("LABELED") for s in df["symbol"])


def test_respects_the_cutoff_date():
    rows = _many_symbols_on_one_date("2026-06-01", 5) + _many_symbols_on_one_date("2026-07-01", 5)
    fake = _FakeTable(rows)
    df = load_unlabeled(fake, date(2026, 6, 15), "fwd_top_q_1m")
    assert len(df) == 5
    assert (df["as_of_date"] <= "2026-06-15").all()


def test_empty_result_returns_empty_dataframe():
    fake = _FakeTable([])
    df = load_unlabeled(fake, date(2026, 6, 30), "fwd_top_q_1m")
    assert df.empty
