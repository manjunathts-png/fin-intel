"""
Tests for FII/DII flow parsing (ml/macro_features.py).

The NSE fiidiiTradeReact endpoint serves one row per (category, date) with
comma-formatted string values — the July 2026 nightly run returned 2 such
records and the old parser dropped both ("2 records returned but none
parsed"). These tests pin the parser to both payload shapes.
"""

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent.parent))
from macro_features import _parse_fiidii_records


class TestParseFiidiiRecords:

    def test_category_shape_current_nse_payload(self):
        # Exactly what /api/fiidiiTradeReact returns today: one FII row and
        # one DII row for the latest trading day.
        data = [
            {"category": "DII **", "date": "03-Jul-2026",
             "buyValue": "12,345.67", "sellValue": "11,000.00", "netValue": "1,345.67"},
            {"category": "FII/FPI *", "date": "03-Jul-2026",
             "buyValue": "9,876.54", "sellValue": "10,500.00", "netValue": "-623.46"},
        ]
        df = _parse_fiidii_records(data)
        assert len(df) == 1
        assert df.index[0] == pd.Timestamp("2026-07-03")
        assert df.loc[df.index[0], "fii_net_cr"] == -623.46
        assert df.loc[df.index[0], "dii_net_cr"] == 1345.67

    def test_legacy_combined_shape(self):
        data = [
            {"date": "02-Jul-2026", "fiiNet": "-1,200.50", "diiNet": "900.25"},
            {"date": "03-Jul-2026", "fiiNet": "500.00", "diiNet": "-100.00"},
        ]
        df = _parse_fiidii_records(data)
        assert len(df) == 2
        assert df.loc[pd.Timestamp("2026-07-02"), "fii_net_cr"] == -1200.50
        assert df.loc[pd.Timestamp("2026-07-03"), "dii_net_cr"] == -100.00

    def test_missing_category_leaves_nan_column(self):
        # Only a DII row published (e.g. FII row delayed) — the FII column
        # must still exist so downstream rolling-sum code doesn't KeyError.
        data = [{"category": "DII **", "date": "03-Jul-2026", "netValue": "250.00"}]
        df = _parse_fiidii_records(data)
        assert list(df.columns) == ["fii_net_cr", "dii_net_cr"]
        assert pd.isna(df.iloc[0]["fii_net_cr"])
        assert df.iloc[0]["dii_net_cr"] == 250.00

    def test_garbage_records_skipped(self):
        data = [
            "not a dict",
            {"category": "FII/FPI *", "date": "bad-date", "netValue": "1.00"},
            {"category": "FII/FPI *", "date": "03-Jul-2026", "netValue": "n/a"},
            {"category": "FII/FPI *", "date": "03-Jul-2026", "netValue": "42.00"},
        ]
        df = _parse_fiidii_records(data)
        assert len(df) == 1
        assert df.iloc[0]["fii_net_cr"] == 42.00

    def test_empty_and_all_garbage_return_empty(self):
        assert _parse_fiidii_records([]).empty
        assert _parse_fiidii_records([{"foo": "bar"}]).empty
