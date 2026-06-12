"""
Feature safety tests — guard against data leakage and forward-label contamination.

These tests run in CI on every push and catch the class of bug where a forward
label (fwd_quartile_3m, fwd_ret_3m, etc.) slips through the blocklist and gets
used as a model feature, causing all inference scores to collapse to 0.

Run locally:
    cd ml && python -m pytest tests/test_feature_safety.py -v
"""

import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from config import get_mf_feature_cols, get_stock_feature_cols


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _stock_df(**extra_cols) -> pd.DataFrame:
    """Minimal stock_features-like DataFrame for testing."""
    base = {
        "symbol":               ["RELIANCE", "TCS"],
        "as_of_date":           ["2024-01-01", "2024-01-01"],
        "sector":               ["Energy", "IT"],
        "stock_name":           ["Reliance Industries", "TCS"],
        "id":                   [1, 2],
        "created_at":           ["2024-01-01", "2024-01-01"],
        "updated_at":           ["2024-01-01", "2024-01-01"],
        # Real features
        "ret1m":                [5.2, -1.3],
        "ret3m":                [12.1, 3.4],
        "sharpe_1y":            [1.2, 0.8],
        "vol_30d":              [0.18, 0.15],
        "rsi_14":               [55.0, 48.0],
        # Forward labels that MUST NOT be features
        "fwd_ret_3m":           [8.1, 2.3],
        "fwd_ret_1m":           [3.2, 1.1],
        "fwd_top_q_3m":         [True, False],
        "fwd_top_q_1m":         [True, False],
        "fwd_quartile_3m":      [1, 3],       # ← the bug that caused all scores = 0
        "fwd_quartile_1m":      [2, 4],
        "fwd_sharpe_3m":        [1.5, 0.5],
        "fwd_sharpe_q_3m":      [1, 3],
        "fwd_sharpe_q_1m":      [2, 4],
        "fwd_top_sharpe_q_3m":  [True, False],
        "fwd_top_sharpe_q_1m":  [False, True],
    }
    base.update(extra_cols)
    return pd.DataFrame(base)


def _mf_df(**extra_cols) -> pd.DataFrame:
    """Minimal mf_features-like DataFrame for testing."""
    base = {
        "scheme_code":          [100001, 100002],
        "as_of_date":           ["2024-01-01", "2024-01-01"],
        "category":             ["Large Cap", "Mid Cap"],
        "fund_name":            ["Fund A", "Fund B"],
        "id":                   [1, 2],
        "created_at":           ["2024-01-01", "2024-01-01"],
        "updated_at":           ["2024-01-01", "2024-01-01"],
        # Real features
        "ret1m":                [3.1, -0.5],
        "ret3m":                [9.2, 2.1],
        "sharpe_1y":            [1.1, 0.7],
        "vol_30d":              [0.14, 0.20],
        # Forward labels that MUST NOT be features
        "fwd_ret_3m":           [7.2, 1.8],
        "fwd_ret_1m":           [2.9, 0.9],
        "fwd_top_q_3m":         [True, False],
        "fwd_top_q_1m":         [False, True],
        "fwd_quartile_3m":      [1, 3],
        "fwd_quartile_1m":      [2, 4],
        "fwd_sharpe_3m":        [1.3, 0.4],
        "fwd_sharpe_q_3m":      [1, 3],
        "fwd_sharpe_q_1m":      [2, 4],
        "fwd_top_sharpe_q_3m":  [True, False],
        "fwd_top_sharpe_q_1m":  [False, True],
    }
    base.update(extra_cols)
    return pd.DataFrame(base)


# ─── Stock feature safety tests ───────────────────────────────────────────────

class TestStockFeatureSafety:

    def test_no_fwd_prefix_columns_in_features(self):
        """No column starting with 'fwd_' should ever be a feature."""
        df = _stock_df()
        features = get_stock_feature_cols(df)
        leaky = [c for c in features if c.startswith("fwd_")]
        assert not leaky, (
            f"Forward-label columns leaked into stock features: {leaky}\n"
            "These are future values — using them causes all inference scores = 0.\n"
            "Fix: ensure get_stock_feature_cols() filters out fwd_* columns."
        )

    def test_fwd_quartile_excluded(self):
        """fwd_quartile_3m and fwd_quartile_1m must never be features (caused the all-zeros bug)."""
        df = _stock_df()
        features = get_stock_feature_cols(df)
        assert "fwd_quartile_3m" not in features, "fwd_quartile_3m leaked into stock features"
        assert "fwd_quartile_1m" not in features, "fwd_quartile_1m leaked into stock features"

    def test_binary_targets_excluded(self):
        df = _stock_df()
        features = get_stock_feature_cols(df)
        assert "fwd_top_q_3m"        not in features
        assert "fwd_top_q_1m"        not in features
        assert "fwd_top_sharpe_q_3m" not in features
        assert "fwd_top_sharpe_q_1m" not in features

    def test_identifiers_excluded(self):
        df = _stock_df()
        features = get_stock_feature_cols(df)
        for col in ("symbol", "as_of_date", "sector", "stock_name", "id", "created_at", "updated_at"):
            assert col not in features, f"Identifier column '{col}' leaked into stock features"

    def test_real_features_included(self):
        """Legitimate feature columns must not be accidentally excluded."""
        df = _stock_df()
        features = get_stock_feature_cols(df)
        for col in ("ret1m", "ret3m", "sharpe_1y", "vol_30d", "rsi_14"):
            assert col in features, f"Legitimate feature '{col}' was incorrectly excluded"

    def test_new_fwd_column_auto_excluded(self):
        """Any future fwd_* column added by the labeler should be auto-excluded."""
        df = _stock_df(fwd_new_metric_6m=[1.5, 2.3])   # hypothetical new forward label
        features = get_stock_feature_cols(df)
        assert "fwd_new_metric_6m" not in features, (
            "A new fwd_* column was not auto-excluded. "
            "The fwd_ prefix rule should catch this automatically."
        )

    def test_snapshot_fundamentals_excluded_from_training(self):
        """Yahoo fundamentals are fetched TODAY and stamped on historical rows
        — a point-in-time violation. They must not be model features (they
        remain in the DB for the JS scoring layer, where today's value is
        correct)."""
        snapshot_cols = {
            "pe_ratio": [22.5, 30.1], "pb_ratio": [3.2, 8.1], "roe": [0.18, 0.42],
            "revenue_growth": [0.12, 0.08], "earnings_growth": [0.25, 0.15],
            "profit_margins": [0.09, 0.22], "debt_to_equity": [45.0, 2.0],
            "dividend_yield": [0.005, 0.012],
            "eps_beat_rate_4q": [0.75, 1.0], "eps_surprise_avg_4q": [4.2, 8.1],
            "eps_qoq_slope": [0.5, 1.2], "eps_rev_30d": [1.1, -0.4], "eps_rev_90d": [2.3, 0.8],
        }
        df = _stock_df(**snapshot_cols)
        features = get_stock_feature_cols(df)
        for col in snapshot_cols:
            assert col not in features, (
                f"Snapshot fundamental '{col}' leaked into training features — "
                "point-in-time violation (today's value stamped on historical rows)"
            )

    def test_delivery_z_is_a_feature(self):
        """delivery_z is computed point-in-time from bhavcopy history — it IS a
        legitimate feature and must auto-discover."""
        df = _stock_df(delivery_z=[2.1, -0.3])
        assert "delivery_z" in get_stock_feature_cols(df)


# ─── MF feature safety tests ──────────────────────────────────────────────────

class TestMFFeatureSafety:

    def test_no_fwd_prefix_columns_in_features(self):
        df = _mf_df()
        features = get_mf_feature_cols(df)
        leaky = [c for c in features if c.startswith("fwd_")]
        assert not leaky, f"Forward-label columns leaked into MF features: {leaky}"

    def test_fwd_quartile_excluded(self):
        df = _mf_df()
        features = get_mf_feature_cols(df)
        assert "fwd_quartile_3m" not in features, "fwd_quartile_3m leaked into MF features"
        assert "fwd_quartile_1m" not in features, "fwd_quartile_1m leaked into MF features"

    def test_binary_targets_excluded(self):
        df = _mf_df()
        features = get_mf_feature_cols(df)
        assert "fwd_top_q_3m"        not in features
        assert "fwd_top_q_1m"        not in features
        assert "fwd_top_sharpe_q_3m" not in features

    def test_identifiers_excluded(self):
        df = _mf_df()
        features = get_mf_feature_cols(df)
        for col in ("scheme_code", "as_of_date", "category", "fund_name", "id"):
            assert col not in features, f"Identifier '{col}' leaked into MF features"

    def test_real_features_included(self):
        df = _mf_df()
        features = get_mf_feature_cols(df)
        for col in ("ret1m", "ret3m", "sharpe_1y", "vol_30d"):
            assert col in features, f"Legitimate feature '{col}' was incorrectly excluded"

    def test_new_fwd_column_auto_excluded(self):
        df = _mf_df(fwd_new_metric_6m=[1.5, 2.3])
        features = get_mf_feature_cols(df)
        assert "fwd_new_metric_6m" not in features
