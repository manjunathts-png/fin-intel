"""
Target Label Backfiller
========================

For each row in mf_features where `fwd_top_q_3m` IS NULL and the as_of_date
is at least 90 days in the past, compute the forward 3-month return and category
quartile, then upsert those labels back into the table.

Run this daily (or after extract_features.py) so the training dataset stays fresh.

Usage:
    python label_targets.py                # label all unlabeled rows older than 90d
    python label_targets.py --dry-run      # show what would be labeled
    python label_targets.py --window 60    # use 60-day forward window instead of 90

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
log = logging.getLogger("label_targets")

RISK_FREE_RATE = 0.07


def load_unlabeled(supabase, cutoff: date) -> pd.DataFrame:
    """Load mf_features rows that need labels (old enough, not yet labeled)."""
    log.info("Loading unlabeled rows with as_of_date <= %s", cutoff)
    rows: list[dict] = []
    page_size = 1000
    offset = 0
    while True:
        resp = (
            supabase.table("mf_features")
            .select("scheme_code,as_of_date,category,ret1y")
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


def load_feature_window(supabase, start: date, end: date) -> pd.DataFrame:
    """Load feature rows in a date window (for forward NAV lookup)."""
    resp = (
        supabase.table("mf_features")
        .select("scheme_code,as_of_date,ret1m,ret3m")
        .gte("as_of_date", str(start))
        .lte("as_of_date", str(end))
        .execute()
    )
    df = pd.DataFrame(resp.data or [])
    if not df.empty:
        df["as_of_date"] = pd.to_datetime(df["as_of_date"])
    return df


def compute_labels(
    unlabeled: pd.DataFrame,
    supabase,
    fwd_days: int = 90,
    dry_run: bool = False,
) -> int:
    """
    For each unlabeled row, find the feature row closest to (as_of_date + fwd_days)
    and use ret1m as a proxy for the realized 3m return (i.e., the ret1m at the
    target date = the return over the most recent 30 days AT that future date,
    not a perfect 3m forward return but a tractable approximation until we have
    more data).

    A cleaner approach: use the NAV directly from the parquet cache.
    We do that here if the cache exists, otherwise fall back to the proxy.
    """
    from pathlib import Path
    import re

    cache_dir = Path(__file__).parent / ".cache_nav"
    total_labeled = 0

    # Group by as_of_date for efficient batch processing
    date_groups = unlabeled.groupby("as_of_date")
    log.info("Processing %d distinct as_of_dates", len(date_groups))

    updates: list[dict[str, Any]] = []

    for as_of_ts, group in date_groups:
        as_of = as_of_ts.date()
        target_date = as_of + timedelta(days=fwd_days)

        fund_fwd_rets: dict[str, float] = {}

        for _, row in group.iterrows():
            code = row["scheme_code"]
            cache_file = cache_dir / f"{code}.parquet"

            fwd_ret = None
            if cache_file.exists():
                try:
                    nav_df = pd.read_parquet(cache_file)
                    nav_df["date"] = pd.to_datetime(nav_df["date"])

                    # NAV at as_of
                    past = nav_df[nav_df["date"] <= pd.Timestamp(as_of)]
                    # NAV at target_date
                    fut  = nav_df[nav_df["date"] <= pd.Timestamp(target_date)]

                    if not past.empty and not fut.empty:
                        nav_past = float(past.iloc[-1]["nav"])
                        nav_fut  = float(fut.iloc[-1]["nav"])
                        actual_fut_date = fut.iloc[-1]["date"]
                        # Staleness guard: if the closest future NAV is >30 days
                        # away from target_date, the label measures the wrong window.
                        gap_days = abs((pd.Timestamp(target_date) - actual_fut_date).days)
                        if gap_days > 30:
                            log.debug(
                                "Skipping stale label for %s as_of=%s: "
                                "future NAV date %s is %d days from target %s",
                                code, as_of, actual_fut_date.date(), gap_days, target_date,
                            )
                            # Leave fwd_ret as None — row won't be labeled
                        elif nav_past > 0:
                            fwd_ret = (nav_fut - nav_past) / nav_past * 100.0
                except Exception as e:
                    log.debug("NAV cache read failed for %s: %s", code, e)

            fund_fwd_rets[code] = fwd_ret

        # Compute per-category quartile rankings
        # group all funds with valid fwd_rets by category
        cat_map: dict[str, list[tuple[str, float]]] = {}
        for _, row in group.iterrows():
            code = row["scheme_code"]
            cat  = row.get("category", "Unknown")
            ret  = fund_fwd_rets.get(code)
            if ret is not None:
                cat_map.setdefault(cat, []).append((code, ret))

        # Assign quartiles within each category
        quartile_map: dict[str, int] = {}
        top_q_map: dict[str, bool] = {}
        for cat, items in cat_map.items():
            if len(items) < 2:
                # Not enough peers for quartile — mark as top if positive
                for code, ret in items:
                    quartile_map[code] = 1 if ret > 0 else 4
                    top_q_map[code] = ret > 0
                continue
            codes_arr = [x[0] for x in items]
            rets_arr  = np.array([x[1] for x in items])
            # quartile: 1=top 25%, 4=bottom 25%
            # pd.qcut with labels 4→1 (descending)
            try:
                labels = pd.qcut(rets_arr, q=4, labels=[4, 3, 2, 1], duplicates="drop")
                for code, lbl in zip(codes_arr, labels):
                    q = int(lbl) if not pd.isna(lbl) else None
                    quartile_map[code] = q
                    top_q_map[code] = (q == 1) if q is not None else None
            except Exception:
                # fallback: rank-based
                order = np.argsort(rets_arr)[::-1]  # descending
                n = len(order)
                for rank, idx in enumerate(order):
                    code = codes_arr[idx]
                    q = min(4, int(rank / n * 4) + 1)
                    quartile_map[code] = q
                    top_q_map[code] = q == 1

        # Build update rows
        for _, row in group.iterrows():
            code = row["scheme_code"]
            fwd_ret = fund_fwd_rets.get(code)
            fwd_q   = quartile_map.get(code)
            fwd_top = top_q_map.get(code)

            if fwd_ret is None:
                continue  # No NAV data for forward date yet

            updates.append({
                "scheme_code":        code,
                "as_of_date":         str(as_of),
                "fwd_ret_3m":         round(fwd_ret, 4),
                "fwd_quartile_3m":    fwd_q,
                "fwd_top_q_3m":       fwd_top,
            })

    if not updates:
        log.info("No rows ready to label")
        return 0

    log.info("Labeling %d rows", len(updates))

    if dry_run:
        log.info("dry-run: sample update: %s", updates[0] if updates else {})
        return len(updates)

    # Batch upsert
    batch_size = 500
    for i in range(0, len(updates), batch_size):
        chunk = updates[i : i + batch_size]
        supabase.table("mf_features").upsert(
            chunk, on_conflict="scheme_code,as_of_date"
        ).execute()
        total_labeled += len(chunk)
        log.info("Upserted %d/%d label rows", min(i + batch_size, len(updates)), len(updates))

    return total_labeled


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--window", type=int, default=90, help="Forward window in days (default 90)")
    p.add_argument("--dry-run", action="store_true", help="Compute but don't write")
    args = p.parse_args()

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)

    supabase = create_client(url, key)

    # Only label rows where the forward window has fully elapsed
    cutoff = date.today() - timedelta(days=args.window)
    unlabeled = load_unlabeled(supabase, cutoff)

    if unlabeled.empty:
        log.info("Nothing to label — run extract_features.py --backfill 365 first")
        sys.exit(0)

    n = compute_labels(unlabeled, supabase, fwd_days=args.window, dry_run=args.dry_run)
    log.info("Done. Labeled %d rows.", n)


if __name__ == "__main__":
    main()
