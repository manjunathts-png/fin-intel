"""
Tests for the rolling signal IC monitor (ml/ic_monitor.py).

These lock in the drift-detection semantics: a signal whose rolling IC is
significantly opposite to its calibration sign must be flagged, while noise
and insufficient data must not raise false alarms.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from ic_monitor import EXPECTED_SIGNS, ic_summary, per_date_spearman_ic


def _panel(n_dates=30, n_stocks=50, rho=0.0, seed=0):
    """Synthetic panel where signal correlates with fwd_ret at strength rho."""
    rng = np.random.default_rng(seed)
    rows = []
    dates = pd.date_range("2025-01-01", periods=n_dates, freq="B")
    for d in dates:
        sig = rng.normal(size=n_stocks)
        ret = rho * sig + np.sqrt(max(0.0, 1 - rho**2)) * rng.normal(size=n_stocks)
        for s, r in zip(sig, ret):
            rows.append({"as_of_date": str(d.date()), "signal": s, "fwd_ret_1m": r})
    return pd.DataFrame(rows)


class TestPerDateIC:

    def test_positive_relation_gives_positive_ics(self):
        df = _panel(rho=0.8)
        ics = per_date_spearman_ic(df, "signal", "fwd_ret_1m")
        assert len(ics) == 30
        assert np.mean(ics) > 0.6

    def test_negative_relation_gives_negative_ics(self):
        df = _panel(rho=-0.8)
        ics = per_date_spearman_ic(df, "signal", "fwd_ret_1m")
        assert np.mean(ics) < -0.6

    def test_dates_with_too_few_pairs_are_skipped(self):
        df = _panel(n_dates=5, n_stocks=10)   # below MIN_PAIRS=20
        ics = per_date_spearman_ic(df, "signal", "fwd_ret_1m")
        assert ics == []

    def test_nulls_dropped_per_date(self):
        df = _panel(n_dates=10, n_stocks=40)
        df.loc[df.sample(frac=0.3, random_state=1).index, "signal"] = np.nan
        ics = per_date_spearman_ic(df, "signal", "fwd_ret_1m")
        assert len(ics) == 10   # 28 valid pairs per date still clears MIN_PAIRS


class TestICSummary:

    def test_significant_wrong_sign_is_flagged(self):
        # Expected negative, observed strongly positive → flip
        ics = list(np.full(30, 0.10) + np.random.default_rng(0).normal(0, 0.02, 30))
        s = ic_summary(ics, expected_sign=-1)
        assert s["sign_flipped"] is True
        assert s["ic_tstat"] > 2

    def test_correct_sign_is_not_flagged(self):
        ics = list(np.full(30, -0.05) + np.random.default_rng(0).normal(0, 0.02, 30))
        s = ic_summary(ics, expected_sign=-1)
        assert s["sign_flipped"] is False

    def test_insignificant_wrong_sign_is_not_flagged(self):
        # Mean slightly positive but |t| < 2 → noise, not drift
        rng = np.random.default_rng(3)
        ics = list(rng.normal(0.01, 0.15, 30))
        s = ic_summary(ics, expected_sign=-1)
        if s["ic_tstat"] is not None and abs(s["ic_tstat"]) < 2:
            assert s["sign_flipped"] is False

    def test_too_few_dates_returns_none_metrics(self):
        s = ic_summary([0.1, -0.2, 0.05], expected_sign=-1)
        assert s["ic_mean"] is None
        assert s["sign_flipped"] is False


class TestExpectedSigns:

    def test_monitored_signals_match_calibration_backtest(self):
        """All six calibrated reversal signals must be monitored with sign -1.
        If a signal is re-calibrated to a different sign, update BOTH the
        penalty in stock_signals.js AND this map."""
        for sig in ("ret1w", "ret1m", "ret3m", "ret6m", "rsi_14", "bb_pct"):
            assert EXPECTED_SIGNS.get(sig) == -1, f"{sig} should be monitored with expected sign -1"
