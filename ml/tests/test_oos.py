"""
Tests for the walk-forward out-of-sample evaluation (ml/oos.py).

The OOS holdout is the honest estimate of live model performance; these tests
lock in that the split is strictly temporal, that degenerate cases return None
instead of a misleading number, and that a genuinely separable signal scores
high while pure noise scores ~0.5.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from oos import (
    HOLDOUT_DAYS,
    MIN_HOLDOUT_ROWS,
    evaluate_oos,
    oos_metrics,
    time_holdout_split,
)

PARAMS = {
    "n_estimators": 50, "learning_rate": 0.1, "max_depth": 3,
    "num_leaves": 7, "class_weight": "balanced",
    "random_state": 42, "verbose": -1,
}


def _labeled_df(n_days=400, rows_per_day=10, signal_strength=1.0, seed=0):
    """Synthetic labeled panel: feature x predicts the binary target when
    signal_strength > 0, pure noise when 0."""
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2024-01-01", periods=n_days, freq="D")
    rows = []
    for d in dates:
        for i in range(rows_per_day):
            x = rng.normal()
            noise = rng.normal()
            y = (signal_strength * x + noise) > 0.6
            rows.append({"as_of_date": d, "x": x, "z": rng.normal(), "target": bool(y)})
    return pd.DataFrame(rows)


def _prepare_X(df, fit_medians=None):
    X = df[["x", "z"]].copy().astype(float)
    medians = {}
    for col in X.columns:
        med = fit_medians[col] if (fit_medians and col in fit_medians) else float(X[col].median())
        medians[col] = med
        X[col] = X[col].fillna(med)
    return X, medians


class TestTimeHoldoutSplit:

    def test_split_is_strictly_temporal(self):
        df = _labeled_df(n_days=200)
        fit, hold = time_holdout_split(df)
        assert fit["as_of_date"].max() < hold["as_of_date"].min(), \
            "fit set must end before the holdout begins — no date overlap"

    def test_holdout_covers_requested_days(self):
        df = _labeled_df(n_days=200)
        fit, hold = time_holdout_split(df, holdout_days=90)
        span = (hold["as_of_date"].max() - hold["as_of_date"].min()).days
        assert span <= 90
        assert span >= 85, f"holdout span {span}d should be close to 90d"

    def test_no_rows_lost(self):
        df = _labeled_df(n_days=150)
        fit, hold = time_holdout_split(df)
        assert len(fit) + len(hold) == len(df)


class TestOosMetrics:

    def test_separable_signal_scores_high(self):
        df = _labeled_df(signal_strength=2.0)
        fit, hold = time_holdout_split(df)
        m = oos_metrics(PARAMS, fit[["x", "z"]], fit["target"].astype(int),
                        hold[["x", "z"]], hold["target"].astype(int))
        assert m["oos_auc"] is not None
        assert m["oos_auc"] > 0.80, f"separable signal should score >0.80, got {m['oos_auc']}"

    def test_noise_scores_near_chance(self):
        df = _labeled_df(signal_strength=0.0)
        fit, hold = time_holdout_split(df)
        m = oos_metrics(PARAMS, fit[["x", "z"]], fit["target"].astype(int),
                        hold[["x", "z"]], hold["target"].astype(int))
        assert m["oos_auc"] is not None
        assert 0.40 < m["oos_auc"] < 0.60, \
            f"pure noise should score near 0.5, got {m['oos_auc']} — a high value here means leakage"

    def test_tiny_holdout_returns_none(self):
        df = _labeled_df(n_days=200)
        fit, hold = time_holdout_split(df)
        hold_small = hold.head(MIN_HOLDOUT_ROWS - 1)
        m = oos_metrics(PARAMS, fit[["x", "z"]], fit["target"].astype(int),
                        hold_small[["x", "z"]], hold_small["target"].astype(int))
        assert m["oos_auc"] is None, "too-small holdout must report None, not a noisy number"

    def test_single_class_holdout_returns_none(self):
        df = _labeled_df(n_days=200)
        fit, hold = time_holdout_split(df)
        y_hold = pd.Series(np.ones(len(hold), dtype=int))
        m = oos_metrics(PARAMS, fit[["x", "z"]], fit["target"].astype(int),
                        hold[["x", "z"]], y_hold)
        assert m["oos_auc"] is None


class TestEvaluateOos:

    def test_end_to_end_with_trainer_prepare_x(self):
        df = _labeled_df(signal_strength=2.0)
        m = evaluate_oos(df, "target", PARAMS, _prepare_X)
        assert m["oos_auc"] is not None and m["oos_auc"] > 0.80
        assert m["oos_samples"] > MIN_HOLDOUT_ROWS
        assert 0.0 <= m["oos_precision_top_q"] <= 1.0

    def test_short_history_degrades_to_none(self):
        # Only 60 days of history → holdout split leaves an empty fit set
        df = _labeled_df(n_days=60)
        m = evaluate_oos(df, "target", PARAMS, _prepare_X)
        assert m["oos_auc"] is None
