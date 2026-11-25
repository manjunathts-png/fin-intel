"""
On 2026-11-25 train_stock.py's full stock_features read (OFFSET pagination)
hit a 57014 statement timeout, so the 3M raw model skipped predicting and
the previous run's p_top_quartile_3m (with CUPID scored 0) stayed live.
fetch_all_features() now uses keyset pagination and retries a timed-out
page with a smaller page size instead of failing or truncating.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
import train_stock
from postgrest.exceptions import APIError


def _err(code):
    return APIError({"message": "x", "code": code, "hint": None, "details": None})


ROWS = [{"as_of_date": f"2026-01-0{d}", "symbol": s, "f": d}
        for d in range(1, 4) for s in ("AAA", "BBB", "CCC")]


class FakeClient:
    """Applies the keyset cursor parsed from or_() to ROWS; can fail on chosen calls."""

    def __init__(self, fail_calls=(), code="57014"):
        self.fail_calls, self.code = set(fail_calls), code
        self.calls, self.page_sizes, self.cursors = 0, [], []

    def table(self, _name):
        self._cursor, self._limit = None, None
        return self

    def select(self, *_a):
        return self

    def or_(self, expr):
        # "as_of_date.gt.D,and(as_of_date.eq.D,symbol.gt.S)"
        d = expr.split(",")[0].split(".gt.")[1]
        s = expr.rsplit("symbol.gt.", 1)[1].rstrip(")")
        self._cursor = (d, s)
        return self

    def order(self, *_a):
        return self

    def limit(self, n):
        self._limit = n
        return self

    def execute(self):
        self.calls += 1
        self.page_sizes.append(self._limit)
        self.cursors.append(self._cursor)
        if self.calls in self.fail_calls:
            raise _err(self.code)
        rows = sorted(ROWS, key=lambda r: (r["as_of_date"], r["symbol"]))
        if self._cursor:
            rows = [r for r in rows if (r["as_of_date"], r["symbol"]) > self._cursor]
        return type("R", (), {"data": rows[: self._limit]})()


def test_keyset_pages_read_every_row_once():
    c = FakeClient()
    df = train_stock.fetch_all_features(c, page_size=4, min_page_size=1)
    assert len(df) == 9
    assert not df.duplicated(["as_of_date", "symbol"]).any()
    assert c.cursors == [None, ("2026-01-02", "AAA"), ("2026-01-03", "BBB")]


def test_timeout_retries_same_page_smaller():
    c = FakeClient(fail_calls={2})
    df = train_stock.fetch_all_features(c, page_size=4, min_page_size=1)
    assert len(df) == 9
    assert c.page_sizes[:3] == [4, 4, 2]
    assert c.cursors[1] == c.cursors[2]          # same page retried


def test_persistent_timeout_raises_instead_of_truncating():
    c = FakeClient(fail_calls=set(range(2, 50)))
    with pytest.raises(APIError):
        train_stock.fetch_all_features(c, page_size=4, min_page_size=1, max_timeouts=3)


def test_other_errors_raise_immediately():
    c = FakeClient(fail_calls={1}, code="42P01")
    with pytest.raises(APIError):
        train_stock.fetch_all_features(c, page_size=4)
    assert c.calls == 1
