"""
Tests for the realized-P&L outcome computation (ml/track_pick_outcomes.py),
the label staleness guard (config.max_label_gap_days), and the delivery-spike
z-score (extract_stock_features.compute_delivery_z).
"""

import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from config import max_label_gap_days
from track_pick_outcomes import HORIZONS, compute_outcomes


def _closes(start="2026-01-01", n=40, base=100.0, step=1.0):
    """Business-day close series rising by `step` per day."""
    idx = pd.bdate_range(start, periods=n)
    return pd.Series(base + step * np.arange(n), index=idx)


class TestComputeOutcomes:

    def test_entry_is_next_trading_day_close(self):
        closes = _closes()                       # first close 100 on 2026-01-01
        out = compute_outcomes(closes, date(2026, 1, 1))
        # Pick on Jan 1 (close=100) → entry must be Jan 2's close (101), NOT 100
        assert out["entry_close"] == 101.0, "entry must be the NEXT day's close (no lookahead)"

    def test_forward_returns_measured_from_entry(self):
        closes = _closes()
        out = compute_outcomes(closes, date(2026, 1, 1))
        # entry=101; 5 trading days later close = 106 → +4.9505%
        assert out["ret_5d"] == pytest.approx((106 / 101 - 1) * 100, abs=1e-3)
        assert out["ret_21d"] == pytest.approx((122 / 101 - 1) * 100, abs=1e-3)

    def test_unresolved_horizons_are_none(self):
        closes = _closes(n=8)                    # only ~7 days after entry
        out = compute_outcomes(closes, date(2026, 1, 1))
        assert out["ret_5d"] is not None
        assert out["ret_10d"] is None, "10d horizon hasn't resolved yet"
        assert out["ret_21d"] is None

    def test_pick_after_last_close_returns_none(self):
        closes = _closes(n=10)
        out = compute_outcomes(closes, date(2026, 3, 1))
        assert out is None

    def test_empty_series_returns_none(self):
        assert compute_outcomes(pd.Series(dtype=float), date(2026, 1, 1)) is None

    def test_horizons_are_trading_days(self):
        # 21 trading days ≈ 1 calendar month — the horizon map is the contract
        assert HORIZONS == {"ret_5d": 5, "ret_10d": 10, "ret_21d": 21}


class TestLabelStalenessGuard:

    def test_3m_window_allows_14_days(self):
        assert max_label_gap_days(90) == 14

    def test_1m_window_allows_7_days(self):
        assert max_label_gap_days(30) == 7

    def test_boundary(self):
        assert max_label_gap_days(60) == 14
        assert max_label_gap_days(59) == 7

    def test_old_30d_tolerance_is_gone(self):
        """A 30d gap on a 30d label measured a near-zero-length window."""
        for fwd in (30, 90):
            assert max_label_gap_days(fwd) < 30


class TestDeliveryZ:

    @staticmethod
    def _import_compute_delivery_z():
        from extract_stock_features import compute_delivery_z
        return compute_delivery_z

    def _series(self, baseline_vals, recent_vals):
        vals = list(baseline_vals) + list(recent_vals)
        idx = pd.bdate_range("2026-01-01", periods=len(vals))
        return pd.Series(vals, index=idx)

    def test_spike_gives_positive_z(self):
        compute_delivery_z = self._import_compute_delivery_z()
        rng = np.random.default_rng(0)
        base = 15 + rng.normal(0, 2, 63)          # ~15% baseline
        recent = [30, 31, 29, 32, 30]              # jumps to ~30%
        z = compute_delivery_z(self._series(base, recent))
        assert z is not None and z > 4, f"15→30 jump should be a big spike, got {z}"

    def test_steady_level_gives_near_zero_z(self):
        compute_delivery_z = self._import_compute_delivery_z()
        rng = np.random.default_rng(1)
        base = 35 + rng.normal(0, 2, 63)
        recent = 35 + rng.normal(0, 2, 5)
        z = compute_delivery_z(self._series(base, recent))
        assert z is not None and abs(z) < 2, \
            f"a stock that always prints ~35% is NOT a spike, got z={z}"

    def test_short_history_returns_none(self):
        compute_delivery_z = self._import_compute_delivery_z()
        z = compute_delivery_z(self._series([20] * 10, [25] * 5))
        assert z is None

    def test_zero_variance_baseline_returns_none(self):
        compute_delivery_z = self._import_compute_delivery_z()
        z = compute_delivery_z(self._series([20.0] * 63, [25.0] * 5))
        assert z is None

    def test_none_input_returns_none(self):
        compute_delivery_z = self._import_compute_delivery_z()
        assert compute_delivery_z(None) is None
