"""
Coverage report for stock_fundamentals_history (daily Yahoo snapshots).

Answers "is there enough point-in-time history to build a value/quality
score on?": date range, snapshot days vs expected weekdays (gaps), symbols
per day over time, per-column fill rate on the latest day, and whether
values actually move over time for a few sample symbols (a series that
never changes is a stale field, not history).

Uses only exact-count HEAD-style requests plus a few tiny reads, so egress
stays in the kilobytes. Read-only.

Usage:
    python fundamentals_coverage.py
Env:
    SUPABASE_URL, SUPABASE_SERVICE_KEY
"""

from __future__ import annotations

import os
import sys
from datetime import date, timedelta

import httpx

TABLE = "stock_fundamentals_history"
VALUE_COLS = ["pe_ratio", "pb_ratio", "roe", "revenue_growth", "earnings_growth",
              "profit_margins", "debt_to_equity", "dividend_yield"]
SAMPLE_SYMBOLS = ["HDFCBANK", "TCS", "RELIANCE", "DIXON", "TATASTEEL"]


def parse_total(content_range: str | None) -> int:
    """'0-0/1234' or '*/0' -> total row count."""
    if not content_range or "/" not in content_range:
        return 0
    total = content_range.rsplit("/", 1)[1]
    return int(total) if total.isdigit() else 0


def weekdays_between(start: date, end: date) -> list[date]:
    days, d = [], start
    while d <= end:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    return days


def distinct_values(series: list) -> int:
    return len({round(v, 4) for v in series if isinstance(v, (int, float))})


class Rest:
    def __init__(self, url: str, key: str):
        self._base = f"{url.rstrip('/')}/rest/v1/{TABLE}"
        self._client = httpx.Client(timeout=30.0, headers={
            "apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json",
        })

    def count(self, params: dict) -> int:
        r = self._client.get(self._base, params={"select": "symbol", "limit": 1, **params},
                             headers={"Prefer": "count=exact"})
        r.raise_for_status()
        return parse_total(r.headers.get("content-range"))

    def rows(self, params: dict) -> list[dict]:
        r = self._client.get(self._base, params=params)
        r.raise_for_status()
        return r.json()


def main() -> None:
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)
    db = Rest(url, key)
    lines = ["## Fundamentals history coverage (`stock_fundamentals_history`)", ""]

    total = db.count({})
    if total == 0:
        lines.append("**Table is empty** — snapshots have never been saved successfully.")
        _emit(lines)
        return

    first = date.fromisoformat(db.rows({"select": "snapshot_date", "order": "snapshot_date.asc", "limit": 1})[0]["snapshot_date"])
    last = date.fromisoformat(db.rows({"select": "snapshot_date", "order": "snapshot_date.desc", "limit": 1})[0]["snapshot_date"])

    per_day: dict[date, int] = {}
    for d in weekdays_between(first, last):
        n = db.count({"snapshot_date": f"eq.{d}"})
        if n:
            per_day[d] = n
    expected = weekdays_between(first, last)
    missing = [d for d in expected if d not in per_day]

    lines += [
        f"- **Rows:** {total:,}",
        f"- **Range:** {first} → {last} ({(last - first).days} calendar days)",
        f"- **Snapshot days:** {len(per_day)} of {len(expected)} weekdays ({len(missing)} weekdays missing)",
    ]
    if missing:
        runs, start, prev = [], missing[0], missing[0]
        for d in missing[1:]:
            if (d - prev).days > 3:
                runs.append((start, prev))
                start = d
            prev = d
        runs.append((start, prev))
        longest = sorted(runs, key=lambda r: (r[1] - r[0]).days, reverse=True)[:5]
        lines.append("- **Largest gaps:** " + "; ".join(f"{a} → {b}" for a, b in longest))

    lines += ["", "**Symbols per snapshot day (monthly):**", ""]
    by_month: dict[str, list[int]] = {}
    for d, n in sorted(per_day.items()):
        by_month.setdefault(d.strftime("%Y-%m"), []).append(n)
    for month, counts in by_month.items():
        lines.append(f"- {month}: {len(counts)} days, {min(counts)}–{max(counts)} symbols/day")

    latest_n = per_day.get(last, 0)
    lines += ["", f"**Column fill on latest day ({last}, {latest_n} symbols):**", ""]
    for col in VALUE_COLS:
        filled = db.count({"snapshot_date": f"eq.{last}", col: "not.is.null"})
        pct = (filled / latest_n * 100) if latest_n else 0
        lines.append(f"- {col}: {filled}/{latest_n} ({pct:.0f}%)")

    lines += ["", "**Do values move over time? (distinct values across all snapshots)**", ""]
    for sym in SAMPLE_SYMBOLS:
        series = db.rows({"select": ",".join(["snapshot_date"] + VALUE_COLS),
                          "symbol": f"eq.{sym}", "order": "snapshot_date.asc"})
        if not series:
            lines.append(f"- {sym}: no rows")
            continue
        parts = [f"{c} {distinct_values([r.get(c) for r in series])}" for c in ("pe_ratio", "pb_ratio", "roe", "earnings_growth")]
        lines.append(f"- {sym} ({len(series)} days): " + ", ".join(parts))

    _emit(lines)


def _emit(lines: list[str]) -> None:
    report = "\n".join(lines)
    print(report)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write(report + "\n")


if __name__ == "__main__":
    main()
