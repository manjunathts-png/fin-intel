"""
Pre-flight Data Source Probe
=============================

Fast (~10s) connectivity check on every external data source, run at the START
of the CI workflow — before any feature extraction — so a source outage is
visible at the top of the run log instead of being inferred from a wall of
fetch errors 20 minutes in.

stdlib-only (urllib) on purpose: it runs before `pip install`, on the bare
runner Python. Always exits 0 — it reports, never blocks.

Writes ml/source_status.json:
    {"checked_at": "...", "sources": {"stooq": "ok", "nse_bhavcopy": "down", ...}}

Usage:
    python3 ml/probe_sources.py
"""

from __future__ import annotations

import json
import socket
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

TIMEOUT_S = 6
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def _last_weekday(d: date) -> date:
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def build_probes() -> dict[str, str]:
    """Source name → URL. Each is a cheap GET that exercises the real endpoint."""
    bhav_date = _last_weekday(date.today() - timedelta(days=1))
    return {
        "stooq":        "https://stooq.com/q/l/?s=reliance.in&f=sd2t2ohlcv&h&e=csv",
        "nse_bhavcopy": ("https://nsearchives.nseindia.com/products/content/"
                         f"sec_bhavdata_full_{bhav_date.strftime('%d%m%Y')}.csv"),
        "yahoo":        "https://query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS?range=5d&interval=1d",
        "mfapi":        "https://api.mfapi.in/mf/119598/latest",
        "nse_api":      "https://www.nseindia.com/api/marketStatus",
    }


def classify(status_code: int | None, err: str | None) -> str:
    """Map an HTTP result to ok / degraded / down.

    down     — network-level failure (DNS, timeout, refused): source unreachable
    degraded — reachable but not serving (4xx/5xx — may be rate limit, late
               publication, or bot-blocking that the real fetcher's session
               handling can sometimes work around)
    ok       — HTTP 200
    """
    if err is not None:
        return "down"
    if status_code == 200:
        return "ok"
    return "degraded"


def probe(url: str) -> tuple[int | None, str | None]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            resp.read(512)   # confirm body actually streams
            return resp.status, None
    except urllib.error.HTTPError as e:
        return e.code, None
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        return None, str(e)


def main() -> None:
    results: dict[str, str] = {}
    details: dict[str, str] = {}
    for name, url in build_probes().items():
        code, err = probe(url)
        state = classify(code, err)
        results[name] = state
        details[name] = f"HTTP {code}" if code is not None else (err or "?")[:80]
        icon = {"ok": "✓", "degraded": "△", "down": "✗"}[state]
        print(f"  {icon} {name:<14} {state:<9} {details[name]}")

    out = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "sources": results,
        "details": details,
    }
    out_path = Path(__file__).parent / "source_status.json"
    out_path.write_text(json.dumps(out, indent=2))

    n_down = sum(1 for s in results.values() if s == "down")
    n_deg  = sum(1 for s in results.values() if s == "degraded")
    if n_down:
        print(f"\n⚠ {n_down} source(s) DOWN, {n_deg} degraded — expect fallbacks or partial data this run")
    elif n_deg:
        print(f"\n△ {n_deg} source(s) degraded — fallback chain may engage")
    else:
        print("\n✓ all sources reachable")
    # Always exit 0 — this is a report, not a gate.


if __name__ == "__main__":
    main()
    sys.exit(0)
