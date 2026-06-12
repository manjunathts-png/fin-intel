"""
Stock Signal Backtest — Information Coefficient & Bucket Analysis
=================================================================

Measures whether the ingredients of the momentum composite score (stock_signals.js)
actually predict FORWARD returns, or whether they predict pullbacks.

This is the "is the score buying the right things?" check. It uses the
stock_features table, which already stores BOTH:
  • the signal ingredients at each as_of_date  (rsi_14, high52w_pct, ret1m, …)
  • the realized forward returns               (fwd_ret_1m, fwd_ret_3m)

For each signal it computes the cross-sectional Information Coefficient (IC):
the per-date Spearman rank correlation between the signal and the forward
return, averaged across dates. This is the standard quant measure of predictive
power and — crucially — it is computed WITHIN each date, so it is not confounded
by whole-market up/down moves (beta).

Interpretation:
  IC > 0  → higher signal value predicts HIGHER forward return  (weight it UP)
  IC < 0  → higher signal value predicts LOWER  forward return  (weight it DOWN / penalize)
  |IC| ≳ 0.03 is a usable edge cross-sectionally; ≳ 0.05 is strong for daily equity data.

It also prints quintile bucket tables (mean forward return per signal quintile)
so you can see non-linear effects — e.g. "RSI 70+ stocks underperform over 1M".

Usage:
    python backtest_stock_signals.py                 # 1M and 3M horizons
    python backtest_stock_signals.py --horizon 1m
    python backtest_stock_signals.py --min-date 2025-01-01
    python backtest_stock_signals.py --min-per-date 20

Env:
    SUPABASE_URL
    SUPABASE_SERVICE_KEY
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from scipy.stats import spearmanr
from supabase import create_client

load_dotenv()
load_dotenv(Path(__file__).parent.parent / "backend" / ".env", override=False)
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("backtest_stock_signals")


# Signals that feed the composite score in stock_signals.js, paired with how
# the current score treats them. "dir" is the SIGN the current score assumes:
#   +1 → score rewards a HIGHER value (treats high value as bullish)
#   -1 → score rewards a LOWER value
# The backtest tells us whether realized forward returns agree with that sign.
SIGNALS: dict[str, dict] = {
    # ── Momentum / trend (score rewards strength) ──────────────────────────
    "ret1w":            {"dir": +1, "note": "1-week return (score: +10 if ≥8%)"},
    "ret1m":            {"dir": +1, "note": "1-month return"},
    "ret3m":            {"dir": +1, "note": "3-month return"},
    "ret6m":            {"dir": +1, "note": "6-month return"},
    "z1w":              {"dir": +1, "note": "1-week return z-score (spike detector)"},
    "high52w_pct":      {"dir": +1, "note": "distance from 52w high (score: +22 near high)"},
    "vol_ratio":        {"dir": +1, "note": "volume vs avg (score: +16..28 on shock)"},
    "macd_hist":        {"dir": +1, "note": "MACD histogram (score: +12 bullish)"},
    # ── Overbought / mean-reversion candidates (score barely penalizes) ────
    "rsi_14":           {"dir": +1, "note": "RSI(14) (score: only -4 when ≥70)"},
    "bb_pct":           {"dir": +1, "note": "Bollinger %B (1.0 = upper band = overbought)"},
    # ── Relative strength (score rewards) ──────────────────────────────────
    "sector_rel_ret3m": {"dir": +1, "note": "3M return vs sector"},
    "univ_rel_ret3m":   {"dir": +1, "note": "3M return vs universe"},
    "sector_rel_ret1m": {"dir": +1, "note": "1M return vs sector"},
    # ── Risk (NOT in score directly, but model leans on these) ─────────────
    "vol_90d":          {"dir": 0,  "note": "90d volatility"},
    "beta_nifty":       {"dir": 0,  "note": "beta vs Nifty"},
    "max_dd_1y":        {"dir": 0,  "note": "max drawdown 1y"},
    # ── Quality / value ────────────────────────────────────────────────────
    "pe_ratio":         {"dir": 0,  "note": "P/E ratio"},
    "earnings_growth":  {"dir": 0,  "note": "earnings growth"},
    "roe":              {"dir": 0,  "note": "return on equity"},
}


def load_labeled(supabase, ret_col: str) -> pd.DataFrame:
    log.info("Loading stock_features where %s IS NOT NULL …", ret_col)
    rows, page_size, offset = [], 1000, 0
    while True:
        resp = (
            supabase.table("stock_features")
            .select("*")
            .not_.is_(ret_col, "null")
            .order("as_of_date")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    df = pd.DataFrame(rows)
    if not df.empty:
        df["as_of_date"] = pd.to_datetime(df["as_of_date"])
    return df


def cross_sectional_ic(
    df: pd.DataFrame, signal: str, ret_col: str, min_per_date: int
) -> dict | None:
    """Mean per-date Spearman IC between signal and forward return."""
    if signal not in df.columns:
        return None
    ics, ns = [], []
    for _, g in df.groupby("as_of_date"):
        sub = g[[signal, ret_col]].dropna()
        if len(sub) < min_per_date:
            continue
        if sub[signal].nunique() < 3 or sub[ret_col].nunique() < 3:
            continue
        ic, _ = spearmanr(sub[signal], sub[ret_col])
        if not np.isnan(ic):
            ics.append(ic)
            ns.append(len(sub))
    if len(ics) < 3:
        return None
    ics = np.array(ics)
    mean_ic = float(ics.mean())
    std_ic = float(ics.std(ddof=1)) if len(ics) > 1 else 0.0
    # IR (information ratio of the IC): mean / std × sqrt(n_periods) ~ t-stat
    ir = mean_ic / std_ic * np.sqrt(len(ics)) if std_ic > 0 else 0.0
    return {
        "ic": mean_ic,
        "ic_std": std_ic,
        "t_stat": float(ir),
        "hit_rate": float((ics > 0).mean()),  # fraction of dates with positive IC
        "n_dates": len(ics),
        "avg_n": int(np.mean(ns)),
    }


def quintile_table(
    df: pd.DataFrame, signal: str, ret_col: str, min_per_date: int, q: int = 5
) -> pd.DataFrame | None:
    """Per-date quintile the signal, average each quintile's forward return across dates."""
    if signal not in df.columns:
        return None
    bucket_rets: dict[int, list[float]] = {i: [] for i in range(q)}
    for _, g in df.groupby("as_of_date"):
        sub = g[[signal, ret_col]].dropna()
        if len(sub) < max(min_per_date, q * 2):
            continue
        try:
            labels = pd.qcut(sub[signal].rank(method="first"), q=q, labels=False)
        except Exception:
            continue
        for b in range(q):
            vals = sub[ret_col][labels == b]
            if len(vals):
                bucket_rets[b].append(float(vals.mean()))
    rows = []
    for b in range(q):
        if bucket_rets[b]:
            rows.append({"quintile": f"Q{b+1}", "mean_fwd_ret_%": round(np.mean(bucket_rets[b]), 2),
                         "n_dates": len(bucket_rets[b])})
    if not rows:
        return None
    return pd.DataFrame(rows)


def analyze_horizon(df: pd.DataFrame, ret_col: str, min_per_date: int) -> None:
    print(f"\n{'═'*78}")
    print(f"  HORIZON: {ret_col}   (rows={len(df)}, dates={df['as_of_date'].nunique()}, "
          f"span {df['as_of_date'].min().date()} → {df['as_of_date'].max().date()})")
    print(f"{'═'*78}")

    results = []
    for sig, meta in SIGNALS.items():
        r = cross_sectional_ic(df, sig, ret_col, min_per_date)
        if r is None:
            continue
        # Does the realized sign agree with what the score assumes?
        assumed = meta["dir"]
        verdict = ""
        if assumed != 0:
            agrees = (r["ic"] > 0) == (assumed > 0)
            if abs(r["t_stat"]) < 2:
                verdict = "weak (t<2)"
            elif agrees:
                verdict = "✓ score sign OK"
            else:
                verdict = "✗ SCORE HAS WRONG SIGN"
        results.append((sig, r, meta, verdict))

    # Sort by |t_stat| descending — strongest predictors first
    results.sort(key=lambda x: abs(x[1]["t_stat"]), reverse=True)

    print(f"\n  {'signal':<18}{'IC':>8}{'t-stat':>8}{'hit%':>7}{'dates':>7}  verdict / note")
    print(f"  {'-'*18}{'-'*8}{'-'*8}{'-'*7}{'-'*7}  {'-'*40}")
    for sig, r, meta, verdict in results:
        flag = verdict or meta["note"]
        print(f"  {sig:<18}{r['ic']:>+8.4f}{r['t_stat']:>+8.2f}"
              f"{r['hit_rate']*100:>6.0f}%{r['n_dates']:>7}  {flag}")

    # Focused overbought tests — the user's exact complaint
    print(f"\n  ── Entry-timing checks (mean {ret_col} by signal bucket) ──")
    for sig in ("rsi_14", "high52w_pct", "z1w", "ret1w", "bb_pct"):
        qt = quintile_table(df, sig, ret_col, min_per_date)
        if qt is None:
            continue
        top = qt.iloc[-1]["mean_fwd_ret_%"]
        bot = qt.iloc[0]["mean_fwd_ret_%"]
        spread = round(top - bot, 2)
        arrow = "Q5>Q1 (momentum)" if spread > 0 else "Q5<Q1 (reversal — buying the top loses)"
        print(f"    {sig:<14} Q1={bot:>+6.2f}%  Q5={top:>+6.2f}%  spread={spread:>+6.2f}%  {arrow}")


def main():
    p = argparse.ArgumentParser(description="Stock signal IC backtest")
    p.add_argument("--horizon", choices=["1m", "3m", "both"], default="both")
    p.add_argument("--min-date", type=str, default=None,
                   help="Ignore as_of_dates before this (YYYY-MM-DD)")
    p.add_argument("--min-per-date", type=int, default=15,
                   help="Min stocks per date to include that date's cross-section")
    args = p.parse_args()

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)
    supabase = create_client(url, key)

    horizons = ["fwd_ret_1m", "fwd_ret_3m"] if args.horizon == "both" else [f"fwd_ret_{args.horizon}"]

    for ret_col in horizons:
        df = load_labeled(supabase, ret_col)
        if df.empty:
            log.warning("No rows for %s — run label_stock_targets.py first", ret_col)
            continue
        if args.min_date:
            df = df[df["as_of_date"] >= pd.Timestamp(args.min_date)]
        analyze_horizon(df, ret_col, args.min_per_date)

    print(f"\n{'═'*78}")
    print("  How to read this:")
    print("   • IC>0 + |t|>2  → signal predicts higher forward return → weight it UP")
    print("   • IC<0 + |t|>2  → signal predicts LOWER  return → the score should PENALIZE it")
    print("   • 'Q5<Q1 (reversal)' on rsi_14/high52w_pct/z1w/ret1w means buying the")
    print("     hottest/most-overbought names loses over that horizon — the buy-high bias.")
    print(f"{'═'*78}\n")


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
