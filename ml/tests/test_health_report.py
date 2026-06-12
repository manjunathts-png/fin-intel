"""
Tests for the nightly health digest (ml/health_report.py) and the
cost-adjusted outcome helper (track_pick_outcomes.net_of_cost).

The collectors that need a live Supabase client are exercised at their pure
seams: source-probe classification from a JSON file, status aggregation, and
markdown rendering.
"""

import json
import sys
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from health_report import (
    build_markdown,
    check_sources,
    overall_status,
    section,
)
from track_pick_outcomes import COST_PCT, net_of_cost


class TestCheckSources:

    def _write(self, tmp_path, sources):
        p = tmp_path / "source_status.json"
        p.write_text(json.dumps({"checked_at": "2026-06-12", "sources": sources}))
        return p

    def test_all_ok(self, tmp_path):
        p = self._write(tmp_path, {"stooq": "ok", "yahoo": "ok", "mfapi": "ok"})
        s = check_sources(p)
        assert s["status"] == "ok"
        assert "3 sources" in s["detail"]

    def test_one_down_is_warn(self, tmp_path):
        p = self._write(tmp_path, {"stooq": "down", "yahoo": "ok"})
        s = check_sources(p)
        assert s["status"] == "warn"
        assert "stooq" in s["detail"]

    def test_two_down_is_critical(self, tmp_path):
        p = self._write(tmp_path, {"stooq": "down", "mfapi": "down", "yahoo": "ok"})
        s = check_sources(p)
        assert s["status"] == "critical"

    def test_degraded_only_is_warn(self, tmp_path):
        p = self._write(tmp_path, {"nse_api": "degraded", "yahoo": "ok"})
        s = check_sources(p)
        assert s["status"] == "warn"
        assert "degraded" in s["detail"]

    def test_missing_file_is_unknown_not_crash(self, tmp_path):
        s = check_sources(tmp_path / "nope.json")
        assert s["status"] == "unknown"


class TestOverallStatus:

    def test_worst_status_wins(self):
        sections = [section("a", "ok", ""), section("b", "warn", ""), section("c", "ok", "")]
        assert overall_status(sections) == "warn"

    def test_critical_beats_warn(self):
        sections = [section("a", "warn", ""), section("b", "critical", "")]
        assert overall_status(sections) == "critical"

    def test_unknown_does_not_escalate_past_warn(self):
        # unknown means "couldn't check", not "broken" — warn must outrank it
        sections = [section("a", "unknown", ""), section("b", "warn", "")]
        assert overall_status(sections) == "warn"

    def test_all_ok(self):
        assert overall_status([section("a", "ok", "")]) == "ok"


class TestBuildMarkdown:

    def test_renders_table_with_all_components(self):
        sections = [
            section("sources", "ok", "all 5 sources reachable"),
            section("outcomes", "warn", "hit-rate=42%"),
        ]
        md = build_markdown(sections, run_date=date(2026, 6, 12))
        assert "2026-06-12" in md
        assert "WARN" in md, "overall status must be in the heading"
        assert "| sources |" in md
        assert "| outcomes |" in md
        assert "hit-rate=42%" in md


class TestNetOfCost:

    def test_subtracts_round_trip_cost(self):
        rets = pd.Series([1.0, 0.2, -0.5])
        net = net_of_cost(rets, cost_pct=0.30)
        assert net.tolist() == pytest.approx([0.70, -0.10, -0.80])

    def test_marginal_winners_become_losers(self):
        # The whole point: gross hit rate flatters the system
        rets = pd.Series([0.25, 0.10, 2.0])
        gross_hits = (rets > 0).mean()
        net_hits = (net_of_cost(rets) > 0).mean()
        assert gross_hits == 1.0
        assert net_hits == pytest.approx(1 / 3)

    def test_default_cost_is_realistic(self):
        assert 0.1 <= COST_PCT <= 1.0, "round-trip cost should be a sane % for liquid NSE names"
