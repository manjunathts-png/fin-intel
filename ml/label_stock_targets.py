"""
Stock Target Label Backfiller
==============================

For each row in stock_features where `fwd_top_q_3m` IS NULL and as_of_date
is at least 90 days in the past, compute the 3-month forward return from the
OHLCV cache and assign quartile labels within each sector.

Mirrors label_targets.py (which does the same for mf_features).

Usage:
    python label_stock_targets.py              # label all unlabeled rows
    python label_stock_targets.py --dry-run    # show counts, don't write
    python label_stock_targets.py --window 60  # use 60-day forward window

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

load_dotenv()
load_dotenv(Path(__file__).parent.parent / "backend" / ".env", override=False)
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("label_stock_targets")

CACHE_DIR = Path(__file__).parent / ".cache_stock"


def load_unlabeled(supabase, cutoff: date) -> pd.DataFrame:
    log.info("Loading unlabeled stock_features rows with as_of_date <= %s", cutoff)
    rows: list[dict] = []
    page_size = 1000
    offset    = 0
    while True:
        resp = (
            supabase.table("stock_features")
            .select("symbol,as_of_date,sector,ret1y")
            .is_("fwd_top_q_3m", "null")
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
    fwd_days: int = 90,
    dry_run: bool = False,
    supabase = None,
) -> int:
    """Compute forward 3-month return from OHLCV cache, assign sector quartiles."""
    total_labeled = 0
    date_groups   = unlabeled.groupby("as_of_date")
    log.info("Processing %d distinct as_of_dates", len(date_groups))

    updates: list[dict[str, Any]] = []

    for as_of_ts, group in date_groups:
        as_of       = as_of_ts.date()
        target_date = as_of + timedelta(days=fwd_days)

        fund_fwd_rets: dict[str, float] = {}

        for _, row in group.iterrows():
            sym        = row["symbol"]
            cache_file = CACHE_DIR / f"{sym}.parquet"

            fwd_ret = None
            if cache_file.exists():
                try:
                    df     = pd.read_parquet(cache_file)
                    df.index = pd.to_datetime(df.index)

                    past_sub = df[df.index <= pd.Timestamp(as_of)]
                    fut_sub  = df[df.index <= pd.Timestamp(target_date)]

                    if not past_sub.empty and not fut_sub.empty:
                        price_past = float(past_sub["close"].iloc[-1])
                        price_fut  = float(fut_sub["close"].iloc[-1])
                        actual_fut = fut_sub.index[-1]
                        gap_days   = abs((pd.Timestamp(target_date) - actual_fut).days)

                        if gap_days > 30:
                            log.debug(
                                "Skipping stale label for %s as_of=%s: "
                                "future close %s is %d days from target %s",
                                sym, as_of, actual_fut.date(), gap_days, target_date,
                            )
                        elif price_past > 0:
                            fwd_ret = (price_fut - price_past) / price_past * 100.0
                except Exception as e:
                    log.debug("OHLCV cache read failed for %s: %s", sym, e)

            fund_fwd_rets[sym] = fwd_ret

        # Per-sector quartile ranking
        sector_map: dict[str, list[tuple[str, float]]] = {}
        for _, row in group.iterrows():
            sym = row["symbol"]
            sec = row.get("sector", "Unknown")
            ret = fund_fwd_rets.get(sym)
            if ret is not None:
                sector_map.setdefault(sec, []).append((sym, ret))

        quartile_map: dict[str, int]  = {}
        top_q_map:    dict[str, bool] = {}

        for sec, items in sector_map.items():
            if len(items) < 2:
                for sym, ret in items:
                    quartile_map[sym] = 1 if ret > 0 else 4
                    top_q_map[sym]    = ret > 0
                continue
            codes_arr = [x[0] for x in items]
            rets_arr  = np.array([x[1] for x in items])
            try:
                labels = pd.qcut(rets_arr, q=4, labels=[4, 3, 2, 1], duplicates="drop")
                for sym, lbl in zip(codes_arr, labels):
                    q = int(lbl) if not pd.isna(lbl) else None
                    quartile_map[sym] = q
                    top_q_map[sym]    = (q == 1) if q is not None else None
            except Exception:
                order = np.argsort(rets_arr)[::-1]
                n     = len(order)
                for rank, idx in enumerate(order):
                    sym = codes_arr[idx]
                    q   = min(4, int(rank / n * 4) + 1)
                    quartile_map[sym] = q
                    top_q_map[sym]    = q == 1

        for _, row in group.iterrows():
            sym     = row["symbol"]
            fwd_ret = fund_fwd_rets.get(sym)
            fwd_q   = quartile_map.get(sym)
            fwd_top = top_q_map.get(sym)

            if fwd_ret is None:
                continue

            updates.append({
                "symbol":          sym,
                "as_of_date":      str(as_of),
                "fwd_ret_3m":      round(fwd_ret, 4),
                "fwd_quartile_3m": fwd_q,
                "fwd_top_q_3m":    fwd_top,
            })

    if not updates:
        log.info("No rows ready to label")
        return 0

    log.info("Labeling %d rows", len(updates))

    if dry_run:
        log.info("dry-run sample: %s", updates[0] if updates else {})
        return len(updates)

    batch_size = 500
    for i in range(0, len(updates), batch_size):
        chunk = updates[i : i + batch_size]
        supabase.table("stock_features").upsert(
            chunk, on_conflict="symbol,as_of_date"
        ).execute()
        total_labeled += len(chunk)
        log.info("Upserted %d/%d label rows", min(i + batch_size, len(updates)), len(updates))

    return total_labeled


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--window",   type=int, default=90,
                   help="Forward window in days (default 90)")
    p.add_argument("--dry-run",  action="store_true",
                   help="Compute but don't write")
    args = p.parse_args()

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)

    supabase = create_client(url, key)

    cutoff    = date.today() - timedelta(days=args.window)
    unlabeled = load_unlabeled(supabase, cutoff)

    if unlabeled.empty:
        log.info("Nothing to label — run extract_stock_features.py --backfill 730 first")
        sys.exit(0)

    n = compute_labels(unlabeled, fwd_days=args.window, dry_run=args.dry_run,
                       supabase=supabase if not args.dry_run else None)
    log.info("Done. Labeled %d rows.", n)


if __name__ == "__main__":
    main()
