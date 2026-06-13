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
    embargo_for_target,
    evaluate_oos,
    evaluate_oos_windows,
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

    def test_no_rows_lost_without_embargo(self):
        df = _labeled_df(n_days=150)
        fit, hold = time_holdout_split(df)
        assert len(fit) + len(hold) == len(df)

    def test_embargo_drops_gap_rows(self):
        # With a 90d embargo, fit must end ≥90d before the holdout starts —
        # rows in the gap carry labels computed from holdout-period prices.
        df = _labeled_df(n_days=400)
        fit, hold = time_holdout_split(df, holdout_days=90, embargo_days=90)
        gap = (hold["as_of_date"].min() - fit["as_of_date"].max()).days
        assert gap >= 90, f"embargo gap is {gap}d, expected ≥90d"
        assert len(fit) + len(hold) < len(df), "embargo must drop the gap rows"

    def test_embargo_inferred_from_target_horizon(self):
        assert embargo_for_target("fwd_top_q_3m") == 90
        assert embargo_for_target("fwd_top_sharpe_q_3m") == 90
        assert embargo_for_target("fwd_top_q_1m") == 30


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


class TestEvaluateOosWindows:

    def test_multi_window_scores_and_aggregates(self):
        # 700 days supports 2+ embargoed 90d windows; window 2's fit set
        # (≤ max−360) still has plenty of rows here.
        df = _labeled_df(n_days=700, signal_strength=2.0)
        m = evaluate_oos_windows(df, "target", PARAMS, _prepare_X, embargo_days=90)
        scored = [w for w in m["oos_windows"] if w["oos_auc"] is not None]
        assert len(scored) >= 2, "700 days should score at least 2 windows"
        assert m["oos_auc"] is not None and m["oos_auc"] > 0.80
        # Aggregate is the mean of the scored windows
        expected = sum(w["oos_auc"] for w in scored) / len(scored)
        assert abs(m["oos_auc"] - expected) < 1e-9

    def test_windows_do_not_overlap(self):
        df = _labeled_df(n_days=700, signal_strength=2.0)
        m = evaluate_oos_windows(df, "target", PARAMS, _prepare_X, embargo_days=90)
        spans = [(w["hold_start"], w["hold_end"]) for w in m["oos_windows"]]
        for (s1, e1), (s2, e2) in zip(spans, spans[1:]):
            assert e2 <= s1, f"window ({s2},{e2}) overlaps newer window ({s1},{e1})"

    def test_short_history_scores_fewer_windows(self):
        # ~10 months: window 0 (fit ≤ max−180) works; window 2 (fit ≤ max−360)
        # has no fit rows at all and must be skipped, not scored on noise.
        df = _labeled_df(n_days=300, signal_strength=2.0)
        m = evaluate_oos_windows(df, "target", PARAMS, _prepare_X,
                                 n_windows=3, embargo_days=90)
        assert m["oos_auc"] is not None, "at least the newest window must score"
        assert len(m["oos_windows"]) < 3

    def test_no_data_returns_none(self):
        df = _labeled_df(n_days=60)
        m = evaluate_oos_windows(df, "target", PARAMS, _prepare_X, embargo_days=90)
        assert m["oos_auc"] is None
        assert m["oos_windows"] == []
