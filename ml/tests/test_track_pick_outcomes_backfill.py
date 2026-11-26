import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent.parent))
import track_pick_outcomes as tpo


class FakeSupabase:
    def __init__(self):
        self.upserts = []

    def table(self, _name):
        return self

    def upsert(self, rows, **_kw):
        self.upserts.extend(rows)
        return self

    def execute(self):
        return None


def _write_cache(tmp_path, sym, n=40, start="2026-09-01"):
    idx = pd.bdate_range(start, periods=n)
    df = pd.DataFrame({"close": np.linspace(100, 139, n)}, index=idx)
    df.index.name = "date"
    df.to_parquet(tmp_path / f"{sym}.parquet")


def test_backfill_writes_all_horizons_for_fresh_rows(monkeypatch, tmp_path):
    monkeypatch.setattr(tpo, "CACHE_DIR", tmp_path)
    _write_cache(tmp_path, "AAA")
    pending = pd.DataFrame([{"pick_date": "2026-09-01", "symbol": "AAA",
                             "ret_5d": None, "ret_10d": None, "ret_21d": None}])
    sb = FakeSupabase()
    assert tpo.backfill(sb, pending) == 1
    row = sb.upserts[0]
    assert {"ret_5d", "ret_10d", "ret_21d", "entry_close"} <= row.keys()


def test_backfill_treats_nan_as_missing(monkeypatch, tmp_path):
    # Once some rows have ret_5d, pandas makes the column float and the
    # missing values are NaN, not None; those rows must still be filled.
    monkeypatch.setattr(tpo, "CACHE_DIR", tmp_path)
    _write_cache(tmp_path, "AAA")
    pending = pd.DataFrame([
        {"pick_date": "2026-09-01", "symbol": "AAA", "ret_5d": 1.0, "ret_10d": 2.0, "ret_21d": None},
        {"pick_date": "2026-09-02", "symbol": "AAA", "ret_5d": None, "ret_10d": None, "ret_21d": None},
    ])
    sb = FakeSupabase()
    assert tpo.backfill(sb, pending) == 2


def test_backfill_skips_symbols_without_cache(monkeypatch, tmp_path):
    monkeypatch.setattr(tpo, "CACHE_DIR", tmp_path)
    pending = pd.DataFrame([{"pick_date": "2026-09-01", "symbol": "MISSING",
                             "ret_5d": None, "ret_10d": None, "ret_21d": None}])
    sb = FakeSupabase()
    assert tpo.backfill(sb, pending) == 0
    assert sb.upserts == []
