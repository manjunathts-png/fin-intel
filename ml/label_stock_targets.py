"""
Stock Target Label Backfiller
==============================

Computes forward returns from the OHLCV cache and assigns universe-wide
quartile labels (all 84 stocks ranked together, not per-sector).

Universe-wide labels are far more stable than sector-level labels when
sectors contain only 6-7 stocks (sector top-quartile = 1-2 stocks = noisy).
Sector rank is already a *feature* in the model, so sector-relative strength
is captured there.

Supports two horizons (run separately):
  --window 90   → fwd_ret_3m, fwd_quartile_3m, fwd_top_q_3m  (default)
  --window 30   → fwd_ret_1m, fwd_quartile_1m, fwd_top_q_1m

Usage:
    python label_stock_targets.py              # 3M labels (universe-wide)
    python label_stock_targets.py --window 30  # 1M labels
    python label_stock_targets.py --dry-run
    python label_stock_targets.py --window 30 --dry-run

Env:
    SUPABASE_URL
    SUPABASE_SERVICE_KEY
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

from config import max_label_gap_days

load_dotenv()
load_dotenv(Path(__file__).parent.parent / "backend" / ".env", override=False)
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("label_stock_targets")

CACHE_DIR = Path(__file__).parent / ".cache_stock"
RISK_FREE_RATE = 0.07


def _col_names(fwd_days: int) -> tuple[str, str, str]:
    """Return (ret_col, quartile_col, top_q_col) for the given forward window."""
    if fwd_days <= 45:
        return "fwd_ret_1m", "fwd_quartile_1m", "fwd_top_q_1m"
    return "fwd_ret_3m", "fwd_quartile_3m", "fwd_top_q_3m"


def _fwd_sharpe_stock(
    ohlcv_df: pd.DataFrame,
    as_of: date,
    target_date: date,
    fwd_days: int,
) -> float | None:
    """Realized Sharpe over the forward window using daily OHLCV close returns."""
    window = ohlcv_df[
        (ohlcv_df.index > pd.Timestamp(as_of)) &
        (ohlcv_df.index <= pd.Timestamp(target_date))
    ]
    if len(window) < 5:
        return None
    daily_rets = window["close"].pct_change().dropna()
    if len(daily_rets) < 5 or daily_rets.std(ddof=1) == 0:
        return None
    past_sub = ohlcv_df[ohlcv_df.index <= pd.Timestamp(as_of)]
    if past_sub.empty:
        return None
    price_past = float(past_sub["close"].iloc[-1])
    price_fut  = float(window["close"].iloc[-1])
    total_ret_pct  = (price_fut / price_past - 1) * 100
    rf_period_pct  = RISK_FREE_RATE * (fwd_days / 365) * 100
    ann_vol_pct    = float(daily_rets.std(ddof=1) * np.sqrt(252) * 100)
    return (total_ret_pct - rf_period_pct) / ann_vol_pct


def load_unlabeled(supabase, cutoff: date, top_q_col: str) -> pd.DataFrame:
    log.info("Loading unlabeled stock_features rows (%s IS NULL, as_of_date <= %s)",
             top_q_col, cutoff)
    rows: list[dict] = []
    page_size = 1000
    offset = 0
    while True:
        resp = (
            supabase.table("stock_features")
            .select(f"symbol,as_of_date,sector")
            .is_(top_q_col, "null")
            .lte("as_of_date", str(cutoff))
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
    log.info("Found %d unlabeled rows", len(df))
    return df


def compute_labels(
    unlabeled: pd.DataFrame,
    fwd_days: int,
    ret_col: str,
    quartile_col: str,
    top_q_col: str,
    dry_run: bool = False,
    supabase=None,
) -> int:
    """
    Compute forward returns from OHLCV cache and assign UNIVERSE-WIDE quartiles.

    All stocks ranked together (not per sector):
      - Top 25%  → fwd_top_q = True  (target positive class)
      - Bottom 75% → fwd_top_q = False

    With 84 stocks: top quartile = top 21 stocks.  With sector-level ranking
    (6-7 per sector) it was 1-2 stocks — far too noisy.
    """
    total_labeled = 0
    max_gap = max_label_gap_days(fwd_days)
    stale_skipped = 0
    date_groups = unlabeled.groupby("as_of_date")
    log.info("Processing %d distinct as_of_dates (horizon=%dd)", len(date_groups), fwd_days)

    updates: list[dict[str, Any]] = []

    for as_of_ts, group in date_groups:
        as_of = as_of_ts.date()
        target_date = as_of + timedelta(days=fwd_days)

        # ── Fetch forward return + Sharpe for each symbol ─────────────────
        fund_fwd_rets:    dict[str, float | None] = {}
        fund_fwd_sharpes: dict[str, float | None] = {}
        for _, row in group.iterrows():
            sym = row["symbol"]
            cache_file = CACHE_DIR / f"{sym}.parquet"
            fwd_ret = None
            fwd_sharpe = None
            if cache_file.exists():
                try:
                    df = pd.read_parquet(cache_file)
                    df.index = pd.to_datetime(df.index)
                    past_sub = df[df.index <= pd.Timestamp(as_of)]
                    fut_sub  = df[df.index <= pd.Timestamp(target_date)]
                    if not past_sub.empty and not fut_sub.empty:
                        price_past = float(past_sub["close"].iloc[-1])
                        price_fut  = float(fut_sub["close"].iloc[-1])
                        actual_fut = fut_sub.index[-1]
                        gap_days   = abs((pd.Timestamp(target_date) - actual_fut).days)
                        if gap_days > max_gap:
                            stale_skipped += 1
                            log.debug(
                                "Stale label skipped %s %s: future close %s is %dd from target",
                                sym, as_of, actual_fut.date(), gap_days,
                            )
                        elif price_past > 0:
                            fwd_ret    = (price_fut - price_past) / price_past * 100.0
                            fwd_sharpe = _fwd_sharpe_stock(df, as_of, target_date, fwd_days)
                except Exception as e:
                    log.debug("OHLCV cache read failed for %s: %s", sym, e)
            fund_fwd_rets[sym]    = fwd_ret
            fund_fwd_sharpes[sym] = fwd_sharpe

        def _assign_univ_quartiles(valid_pairs: list[tuple[str, float]]) -> tuple[dict, dict]:
            q_map: dict[str, int | None]  = {}
            top_map: dict[str, bool | None] = {}
            if len(valid_pairs) >= 4:
                syms_arr = [x[0] for x in valid_pairs]
                vals_arr = np.array([x[1] for x in valid_pairs])
                try:
                    labels = pd.qcut(vals_arr, q=4, labels=[4, 3, 2, 1], duplicates="drop")
                    for sym, lbl in zip(syms_arr, labels):
                        q = int(lbl) if not pd.isna(lbl) else None
                        q_map[sym]   = q
                        top_map[sym] = (q == 1) if q is not None else None
                except Exception:
                    order = np.argsort(vals_arr)[::-1]
                    n = len(order)
                    for rank, idx in enumerate(order):
                        sym = syms_arr[idx]
                        q = min(4, int(rank / n * 4) + 1)
                        q_map[sym]   = q
                        top_map[sym] = (q == 1)
            elif len(valid_pairs) >= 2:
                syms_arr  = [x[0] for x in valid_pairs]
                vals_arr  = np.array([x[1] for x in valid_pairs])
                median_val = float(np.median(vals_arr))
                for sym, val in valid_pairs:
                    q_map[sym]   = 1 if val >= median_val else 4
                    top_map[sym] = (val >= median_val)
            return q_map, top_map

        # Universe-wide quartiles for return
        valid_rets    = [(s, r) for s, r in fund_fwd_rets.items()    if r is not None]
        valid_sharpes = [(s, v) for s, v in fund_fwd_sharpes.items() if v is not None]
        quartile_map, top_q_map       = _assign_univ_quartiles(valid_rets)
        sharpe_q_map, top_sharpe_q_map = _assign_univ_quartiles(valid_sharpes)

        # ── Build update rows ─────────────────────────────────────────────
        for _, row in group.iterrows():
            sym     = row["symbol"]
            fwd_ret = fund_fwd_rets.get(sym)
            if fwd_ret is None:
                continue
            update: dict[str, Any] = {
                "symbol":       sym,
                "as_of_date":   str(as_of),
                ret_col:        round(fwd_ret, 4),
                quartile_col:   quartile_map.get(sym),
                top_q_col:      top_q_map.get(sym),
            }
            sharpe_val = fund_fwd_sharpes.get(sym)
            if sharpe_val is not None:
                update["fwd_sharpe_3m"] = round(sharpe_val, 4)
            update["fwd_sharpe_q_3m"]     = sharpe_q_map.get(sym)
            update["fwd_top_sharpe_q_3m"] = top_sharpe_q_map.get(sym)
            updates.append(update)

    if stale_skipped:
        log.warning("Skipped %d stale labels (close gap > %dd from target date) — "
                    "they will retry on future runs as fresher prices arrive",
                    stale_skipped, max_gap)

    if not updates:
        log.info("No rows ready to label")
        return 0

    pos = sum(1 for u in updates if u.get(top_q_col) is True)
    log.info("Ready to label %d rows  (positive=%d, %.1f%%)",
             len(updates), pos, 100 * pos / len(updates))

    if dry_run:
        log.info("dry-run — sample: %s", updates[0] if updates else {})
        return len(updates)

    batch_size = 500
    for i in range(0, len(updates), batch_size):
        chunk = updates[i : i + batch_size]
        supabase.table("stock_features").upsert(
            chunk, on_conflict="symbol,as_of_date"
        ).execute()
        total_labeled += len(chunk)
        log.info("Upserted %d / %d", min(i + batch_size, len(updates)), len(updates))

    return total_labeled


def main():
    p = argparse.ArgumentParser(description="Label stock forward returns (universe-wide quartiles)")
    p.add_argument("--window",  type=int, default=90,
                   help="Forward window in days: 90=3M (default), 30=1M")
    p.add_argument("--dry-run", action="store_true",
                   help="Compute but don't write to Supabase")
    args = p.parse_args()

    ret_col, quartile_col, top_q_col = _col_names(args.window)
    log.info("Horizon: %dd  →  columns: %s / %s / %s",
             args.window, ret_col, quartile_col, top_q_col)

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)

    supabase = create_client(url, key)
    cutoff   = date.today() - timedelta(days=args.window)
    unlabeled = load_unlabeled(supabase, cutoff, top_q_col)

    if unlabeled.empty:
        log.info("Nothing to label — run extract_stock_features.py --backfill 730 first")
        return

    n = compute_labels(
        unlabeled,
        fwd_days=args.window,
        ret_col=ret_col,
        quartile_col=quartile_col,
        top_q_col=top_q_col,
        dry_run=args.dry_run,
        supabase=supabase if not args.dry_run else None,
    )
    log.info("Done. Labeled %d rows.", n)


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
