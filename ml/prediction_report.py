"""
Read-only diagnostic for the latest stock_predictions date: per model_version,
row counts and min/mean/max of each probability column, plus every row with a
probability below LOW (the ML Quality health check fails below 0.01).

Usage:
    python prediction_report.py
Env:
    SUPABASE_URL, SUPABASE_SERVICE_KEY
"""

from __future__ import annotations

import os
import statistics
import sys

import httpx

PROB_COLS = ["p_top_quartile_3m", "p_top_sharpe_q_3m", "p_top_quartile_1m"]
LOW = 0.01
FEATURE_COLS = ["ret1w", "ret1m", "ret3m", "vol_30d", "max_dd_1y", "high52w_pct"]


def summarize(rows: list[dict]) -> tuple[list[str], list[dict]]:
    by_version: dict[str, list[dict]] = {}
    for r in rows:
        by_version.setdefault(r.get("model_version") or "?", []).append(r)
    lines = []
    for version, vrows in sorted(by_version.items()):
        lines.append(f"- `{version}`: {len(vrows)} rows")
        for col in PROB_COLS:
            vals = [r[col] for r in vrows if r.get(col) is not None]
            if vals:
                lines.append(f"  - {col}: n={len(vals)} min={min(vals):.4f} "
                             f"mean={statistics.mean(vals):.4f} max={max(vals):.4f}")
    low = [r for r in rows if any(r.get(c) is not None and r[c] < LOW for c in PROB_COLS)]
    return lines, low


def main() -> None:
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)
    base = f"{url.rstrip('/')}/rest/v1/stock_predictions"
    hdr = {"apikey": key, "Authorization": f"Bearer {key}"}
    with httpx.Client(timeout=30.0, headers=hdr) as c:
        latest = c.get(base, params={"select": "prediction_date", "order": "prediction_date.desc", "limit": 1}).json()
        if not latest:
            print("No predictions.")
            return
        date = latest[0]["prediction_date"]
        cols = "symbol,model_version,pred_rank," + ",".join(PROB_COLS)
        rows, offset = [], 0
        while True:
            page = c.get(base, params={"select": cols, "prediction_date": f"eq.{date}",
                                       "order": "symbol", "limit": 1000, "offset": offset}).json()
            rows.extend(page)
            if len(page) < 1000:
                break
            offset += 1000

        lines, low = summarize(rows)
        feature_dumps = {}
        for sym in sorted({r["symbol"] for r in low})[:5]:
            feature_dumps[sym] = c.get(
                f"{url.rstrip('/')}/rest/v1/stock_features",
                params={"select": "as_of_date," + ",".join(FEATURE_COLS), "symbol": f"eq.{sym}",
                        "order": "as_of_date.desc", "limit": 12},
            ).json()

    out = [f"## Stock predictions for {date}", "", f"{len(rows)} rows", ""] + lines + [""]
    out.append(f"**Rows with any probability < {LOW}: {len(low)}**")
    for r in low[:50]:
        vals = ", ".join(f"{c}={r[c]}" for c in PROB_COLS if r.get(c) is not None)
        out.append(f"- {r['symbol']} ({r.get('model_version')}): {vals}, pred_rank={r.get('pred_rank')}")
    for sym, frows in feature_dumps.items():
        out += ["", f"**{sym} — recent stock_features**", "",
                "| date | " + " | ".join(FEATURE_COLS) + " |",
                "|---|" + "---|" * len(FEATURE_COLS)]
        for fr in frows:
            out.append(f"| {fr['as_of_date']} | " + " | ".join(
                "—" if fr.get(col) is None else f"{fr[col]:.3g}" for col in FEATURE_COLS) + " |")
    report = "\n".join(out)
    print(report)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write(report + "\n")


if __name__ == "__main__":
    main()
