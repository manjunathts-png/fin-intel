"""
Regression tests for the 2026-11-12 incident: label_stock_targets.py's
load_unlabeled() crashed the whole "stocks" job with
postgrest.exceptions.APIError (code 57014, statement timeout) while
keyset-paginating stock_features, which skipped every downstream step
(training, backfills) for the day — the same cascade pattern as the
2026-09-19 numpy.bool_ incident.

Two independent fixes went in:
  1. migrate_017_unlabeled_lookup_indexes.sql — partial indexes so the
     query itself stays cheap regardless of table size (not unit-testable
     here; this file covers the application-level fallback).
  2. load_unlabeled() (both label_targets.py and label_stock_targets.py)
     and label_targets.py's load_sharpe_unlabeled() now catch a 57014
     mid-pagination and return whatever rows were already collected
     instead of raising — the remaining backlog is picked up next run.
     label_targets.py's load_unlabeled()/load_sharpe_unlabeled() were also
     converted from OFFSET to keyset pagination, mirroring the fix
     label_stock_targets.py already had, since OFFSET pagination has the
     same page-depth-grows-with-table-size problem one level worse.

These tests pin the resilience behavior with a fake Supabase client that
raises on a chosen page, independent of the real query-filtering logic.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
import label_targets
import label_stock_targets
from postgrest.exceptions import APIError


def _timeout_error() -> APIError:
    return APIError({
        "message": "canceling statement due to statement timeout",
        "code": "57014",
        "hint": None,
        "details": None,
    })


def _other_error() -> APIError:
    return APIError({
        "message": "relation \"stock_features\" does not exist",
        "code": "42P01",
        "hint": None,
        "details": None,
    })


class FakeExecResult:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    """Hands back canned pages in order; optionally raises on one page."""

    def __init__(self, pages, calls, raise_at, error_factory):
        self._pages = pages
        self._calls = calls
        self._raise_at = raise_at
        self._error_factory = error_factory

    def select(self, *_a, **_kw):
        return self

    def is_(self, *_a, **_kw):
        return self

    def lte(self, *_a, **_kw):
        return self

    def or_(self, *_a, **_kw):
        return self

    def order(self, *_a, **_kw):
        return self

    def limit(self, *_a, **_kw):
        return self

    def execute(self):
        idx = len(self._calls)
        self._calls.append(1)
        if self._raise_at is not None and idx == self._raise_at:
            raise self._error_factory()
        return FakeExecResult(self._pages[idx])


class _NotProxy:
    """Mimics postgrest-py's `.not_` property, which returns a filter
    builder bound to the same underlying query."""

    def __init__(self, query):
        self._query = query

    def is_(self, *a, **kw):
        return self._query


class FakeQueryWithNot(FakeQuery):
    @property
    def not_(self):
        return _NotProxy(self)


class FakeSupabase:
    def __init__(self, pages, raise_at=None, error_factory=_timeout_error, query_cls=FakeQuery):
        self._pages = pages
        self._raise_at = raise_at
        self._error_factory = error_factory
        self._query_cls = query_cls
        self.calls = []

    def table(self, _name):
        return self._query_cls(self._pages, self.calls, self._raise_at, self._error_factory)


PAGE_SIZE = 1000


def _page(n, start=0):
    return [
        {"symbol": f"S{i:04d}", "as_of_date": "2026-01-01", "sector": "IT"}
        for i in range(start, start + n)
    ]


def test_stock_load_unlabeled_returns_partial_rows_on_timeout():
    pages = [_page(PAGE_SIZE), _page(PAGE_SIZE), _page(400)]
    fake = FakeSupabase(pages, raise_at=1)  # times out on the 2nd page
    df = label_stock_targets.load_unlabeled(fake, cutoff=__import__("datetime").date(2026, 1, 1), top_q_col="fwd_top_q_3m")
    assert len(df) == PAGE_SIZE  # only the first (successful) page
    assert len(fake.calls) == 2


def test_stock_load_unlabeled_reraises_non_timeout_errors():
    pages = [_page(PAGE_SIZE), _page(400)]
    fake = FakeSupabase(pages, raise_at=1, error_factory=_other_error)
    with pytest.raises(APIError):
        label_stock_targets.load_unlabeled(fake, cutoff=__import__("datetime").date(2026, 1, 1), top_q_col="fwd_top_q_3m")


def test_stock_load_unlabeled_full_pagination_without_errors():
    pages = [_page(PAGE_SIZE), _page(400)]
    fake = FakeSupabase(pages, raise_at=None)
    df = label_stock_targets.load_unlabeled(fake, cutoff=__import__("datetime").date(2026, 1, 1), top_q_col="fwd_top_q_3m")
    assert len(df) == PAGE_SIZE + 400
    assert len(fake.calls) == 2


def test_mf_load_unlabeled_uses_keyset_and_returns_partial_rows_on_timeout():
    def _mf_page(n, start=0):
        return [
            {"scheme_code": f"{i:06d}", "as_of_date": "2026-01-01", "category": "Large Cap", "ret1y": 10.0}
            for i in range(start, start + n)
        ]
    pages = [_mf_page(PAGE_SIZE), _mf_page(PAGE_SIZE), _mf_page(200)]
    fake = FakeSupabase(pages, raise_at=1)
    df = label_targets.load_unlabeled(fake, cutoff=__import__("datetime").date(2026, 1, 1), top_q_col="fwd_top_q_3m")
    assert len(df) == PAGE_SIZE
    assert len(fake.calls) == 2


def test_mf_load_sharpe_unlabeled_returns_partial_rows_on_timeout():
    def _mf_page(n, start=0):
        return [
            {"scheme_code": f"{i:06d}", "as_of_date": "2026-01-01", "category": "Large Cap", "ret1y": 10.0}
            for i in range(start, start + n)
        ]
    pages = [_mf_page(PAGE_SIZE), _mf_page(300)]
    fake = FakeSupabase(pages, raise_at=0, query_cls=FakeQueryWithNot)
    df = label_targets.load_sharpe_unlabeled(fake, cutoff=__import__("datetime").date(2026, 1, 1))
    assert len(df) == 0
    assert len(fake.calls) == 1


def test_is_statement_timeout_helper_matches_only_57014():
    assert label_stock_targets._is_statement_timeout(_timeout_error())
    assert not label_stock_targets._is_statement_timeout(_other_error())
    assert label_targets._is_statement_timeout(_timeout_error())
    assert not label_targets._is_statement_timeout(_other_error())
