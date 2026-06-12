"""
Tests for the pre-flight source probe (ml/probe_sources.py).

The probe is stdlib-only (runs before pip install) and must never block CI —
these tests cover the pure classification logic and probe-set integrity.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from probe_sources import build_probes, classify


class TestClassify:

    def test_http_200_is_ok(self):
        assert classify(200, None) == "ok"

    def test_network_error_is_down(self):
        assert classify(None, "timed out") == "down"
        assert classify(None, "Name or service not known") == "down"

    def test_http_errors_are_degraded(self):
        # Reachable-but-not-serving: rate limit, bot block, late publication.
        # The real fetchers' session handling can sometimes work around these,
        # so they're "degraded" rather than "down".
        for code in (403, 404, 429, 500, 503):
            assert classify(code, None) == "degraded"


class TestBuildProbes:

    def test_all_critical_sources_probed(self):
        probes = build_probes()
        for source in ("stooq", "nse_bhavcopy", "yahoo", "mfapi", "nse_api"):
            assert source in probes, f"critical source '{source}' missing from probe set"

    def test_bhavcopy_url_targets_a_weekday(self):
        from datetime import datetime
        url = build_probes()["nse_bhavcopy"]
        ddmmyyyy = url.rsplit("_", 1)[1].removesuffix(".csv")
        d = datetime.strptime(ddmmyyyy, "%d%m%Y")
        assert d.weekday() < 5, "bhavcopy is only published on trading days"
