"""
Rolling Signal IC Monitor — drift detection for the composite score
====================================================================

The overextension penalties in backend/stock_signals.js were calibrated from a
one-shot IC backtest (backtest_stock_signals.py). Signal quality drifts as
regimes change — e.g. the mean-reversion edge on ret3m can weaken or flip in a
persistent trending market, silently turning a calibrated penalty into a tax.

This script recomputes the per-date cross-sectional Spearman IC of each
monitored signal vs the realized forward return over the most recent
WINDOW_DATES labeled dates, compares the sign against the calibration
expectation, and:

  • writes a row per signal into signal_ic_history (trend dashboard / audit)
  • logs a WARNING for any signal whose rolling IC is significantly opposite
    to its expected sign (|t| ≥ 2) — the cue to re-run the full backtest and
    re-calibrate the penalty weights.

Note the inherent lag: forward returns only exist for dates ≥ horizon days
old, so drift is detected ~1 month late on the 1M horizon. Unavoidable —
that's still far better than never.

Usage:
    python ic_monitor.py                 # 1M horizon (freshest labels)
    python ic_monitor.py --horizon 3m
    python ic_monitor.py --dry-run

Env:
    SUPABASE_URL
    SUPABASE_SERVICE_KEY
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()
load_dotenv(Path(__file__).parent.parent / "backend" / ".env", override=False)
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("ic_monitor")

WINDOW_DATES   = 30    # rolling window: most recent N labeled dates
MIN_PAIRS      = 20    # min valid (signal, fwd_ret) pairs per date for an IC
FLIP_T_THRESH  = 2.0   # |t| needed before a wrong-sign IC counts as a flip

# Expected IC sign per signal, from the calibration backtest (2026-06, Nifty
# 500, 156K rows / 507 dates). All six were significantly NEGATIVE — high
# momentum/overbought readings predicted LOWER forward returns:
#   ret3m IC=-0.033 t=-4.22 · rsi_14 IC=-0.028 t=-4.5 · bb_pct IC=-0.016 t=-2.84
EXPECTED_SIGNS: dict[str, int] = {
    "ret1w":  -1,
    "ret1m":  -1,
    "ret3m":  -1,
    "ret6m":  -1,
    "rsi_14": -1,
    "bb_pct": -1,
}


def per_date_spearman_ic(
    df: pd.DataFrame,
    signal_col: str,
    ret_col: str,
    date_col: str = "as_of_date",
    min_pairs: int = MIN_PAIRS,
) -> list[float]:
    """Cross-sectional Spearman IC of signal vs forward return, one per date."""
    from scipy.stats import spearmanr

    ics: list[float] = []
    for _, g in df.groupby(date_col):
        sub = g[[signal_col, ret_col]].dropna()
        if len(sub) < min_pairs:
            continue
        rho, _ = spearmanr(sub[signal_col], sub[ret_col])
        if np.isfinite(rho):
            ics.append(float(rho))
    return ics


def ic_summary(ics: list[float], expected_sign: int) -> dict:
    """Mean IC, t-stat, and whether the sign significantly flipped vs expectation."""
    n = len(ics)
    if n < 5:
        return {"ic_mean": None, "ic_tstat": None, "n_dates": n, "sign_flipped": False}
    arr  = np.asarray(ics)
    mean = float(arr.mean())
    sd   = float(arr.std(ddof=1))
    t    = mean / (sd / np.sqrt(n)) if sd > 0 else 0.0
    flipped = bool(mean * expected_sign < 0 and abs(t) >= FLIP_T_THRESH)
    return {
        "ic_mean":      round(mean, 5),
        "ic_tstat":     round(float(t), 3),
        "n_dates":      n,
        "sign_flipped": flipped,
    }


def load_recent_labeled(supabase, ret_col: str, n_dates: int = WINDOW_DATES) -> pd.DataFrame:
    """Load the most recent n_dates of labeled stock_features rows."""
    cols = "as_of_date," + ",".join(EXPECTED_SIGNS) + f",{ret_col}"
    rows, page_size, offset = [], 1000, 0
    dates_seen: set[str] = set()
    while True:
        resp = (
            supabase.table("stock_features")
            .select(cols)
            .not_.is_(ret_col, "null")
            .order("as_of_date", desc=True)
            .range(offset, offset + page_size - 1)
            .execute()
        )
        batch = resp.data or []
        rows.extend(batch)
        dates_seen.update(r["as_of_date"] for r in batch)
        # Stop once we've covered more than n_dates distinct dates (the extra
        # date may be partially fetched and is trimmed below).
        if len(batch) < page_size or len(dates_seen) > n_dates:
            break
        offset += page_size

    df = pd.DataFrame(rows)
    if df.empty:
        return df
    keep = sorted(dates_seen, reverse=True)[:n_dates]
    df = df[df["as_of_date"].isin(keep)]
    log.info("Loaded %d rows across %d labeled dates (%s → %s)",
             len(df), df["as_of_date"].nunique(), df["as_of_date"].min(), df["as_of_date"].max())
    return df


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--horizon", type=str, default="1m", choices=["1m", "3m"],
                   help="Forward-return horizon (1m = freshest labels, least lag)")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    ret_col = "fwd_ret_1m" if args.horizon == "1m" else "fwd_ret_3m"

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)
    supabase = create_client(url, key)

    df = load_recent_labeled(supabase, ret_col)
    if df.empty:
        log.info("No labeled rows available — nothing to monitor")
        return

    run_date = str(date.today())
    out_rows = []
    flips = []
    for signal, expected in EXPECTED_SIGNS.items():
        if signal not in df.columns:
            continue
        ics = per_date_spearman_ic(df, signal, ret_col)
        s = ic_summary(ics, expected)
        out_rows.append({
            "run_date": run_date, "horizon": args.horizon, "signal": signal,
            "expected_sign": expected, **s,
        })
        if s["sign_flipped"]:
            flips.append(signal)
        log.info("IC %-8s mean=%s t=%s n=%d expected=%+d%s",
                 signal, s["ic_mean"], s["ic_tstat"], s["n_dates"], expected,
                 "  ⚠ SIGN FLIPPED" if s["sign_flipped"] else "")

    if flips:
        log.warning("─── SIGNAL DRIFT DETECTED ───────────────────────────────")
        log.warning("Rolling %d-date IC significantly OPPOSITE to calibration for: %s",
                    WINDOW_DATES, ", ".join(flips))
        log.warning("The overextension penalties for these signals may now be "
                    "counterproductive. Re-run the full backtest "
                    "(dispatch target=signal_backtest) and re-calibrate.")
        log.warning("─────────────────────────────────────────────────────────")

    if args.dry_run:
        log.info("dry-run: skipping signal_ic_history write (%d rows)", len(out_rows))
        return
    try:
        supabase.table("signal_ic_history").upsert(
            out_rows, on_conflict="run_date,horizon,signal"
        ).execute()
        log.info("Wrote %d rows to signal_ic_history", len(out_rows))
    except Exception as e:
        log.warning("signal_ic_history write failed (%s) — run migrate_012", str(e)[:120])


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        os._exit(e.code if isinstance(e.code, int) else 1)
    except Exception:
        import traceback
        traceback.print_exc()
        os._exit(1)
    os._exit(0)
