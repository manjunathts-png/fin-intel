"""
Target Label Backfiller
========================

For each row in mf_features where `fwd_top_q_3m` IS NULL and the as_of_date
is at least 90 days in the past, compute the forward 3-month return and category
quartile, then upsert those labels back into the table.

Run this daily (or after extract_features.py) so the training dataset stays fresh.

Usage:
    python label_targets.py                     # label all unlabeled rows older than 90d
    python label_targets.py --dry-run           # show what would be labeled
    python label_targets.py --window 60         # use 60-day forward window instead of 90
    python label_targets.py --fix-sharpe        # backfill Sharpe labels for rows that
                                                #   already have fwd_top_q_3m but are
                                                #   missing fwd_top_sharpe_q_3m

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


def _col_names(fwd_days: int) -> tuple[str, str, str]:
    if fwd_days <= 45:
        return "fwd_ret_1m", "fwd_quartile_1m", "fwd_top_q_1m"
    return "fwd_ret_3m", "fwd_quartile_3m", "fwd_top_q_3m"


def _fwd_sharpe(nav_df: pd.DataFrame, as_of: "date", target_date: "date") -> float | None:
    """Realized Sharpe ratio over the forward window using daily NAV returns."""
    window = nav_df[
        (nav_df["date"] > pd.Timestamp(as_of)) &
        (nav_df["date"] <= pd.Timestamp(target_date))
    ]
    if len(window) < 5:
        return None
    daily_rets = window["nav"].pct_change().dropna()
    if len(daily_rets) < 5 or daily_rets.std(ddof=1) == 0:
        return None
    fwd_days = (target_date - as_of).days
    total_ret_pct = (window["nav"].iloc[-1] / nav_df[nav_df["date"] <= pd.Timestamp(as_of)].iloc[-1]["nav"] - 1) * 100
    rf_period_pct = RISK_FREE_RATE * (fwd_days / 365) * 100
    ann_vol_pct = float(daily_rets.std(ddof=1) * np.sqrt(252) * 100)
    return (total_ret_pct - rf_period_pct) / ann_vol_pct


def load_unlabeled(supabase, cutoff: date, top_q_col: str = "fwd_top_q_3m") -> pd.DataFrame:
    """Load mf_features rows that need labels (old enough, not yet labeled)."""
    log.info("Loading unlabeled rows (%s IS NULL, as_of_date <= %s)", top_q_col, cutoff)
    rows: list[dict] = []
    page_size = 1000
    offset = 0
    while True:
        resp = (
            supabase.table("mf_features")
            .select("scheme_code,as_of_date,category,ret1y")
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
    ret_col: str = "fwd_ret_3m",
    quartile_col: str = "fwd_quartile_3m",
    top_q_col: str = "fwd_top_q_3m",
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
        fund_fwd_sharpes: dict[str, float | None] = {}

        for _, row in group.iterrows():
            code = row["scheme_code"]
            cache_file = cache_dir / f"{code}.parquet"

            fwd_ret = None
            fwd_sharpe = None
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
                            fwd_sharpe = _fwd_sharpe(nav_df, as_of, target_date)
                except Exception as e:
                    log.debug("NAV cache read failed for %s: %s", code, e)

            fund_fwd_rets[code] = fwd_ret
            fund_fwd_sharpes[code] = fwd_sharpe

        # Compute per-category quartile rankings for both return and Sharpe
        cat_ret_map: dict[str, list[tuple[str, float]]] = {}
        cat_sharpe_map: dict[str, list[tuple[str, float]]] = {}
        for _, row in group.iterrows():
            code = row["scheme_code"]
            cat  = row.get("category", "Unknown")
            ret  = fund_fwd_rets.get(code)
            sharpe = fund_fwd_sharpes.get(code)
            if ret is not None:
                cat_ret_map.setdefault(cat, []).append((code, ret))
            if sharpe is not None:
                cat_sharpe_map.setdefault(cat, []).append((code, sharpe))

        quartile_map, top_q_map = _assign_quartiles(cat_ret_map)
        sharpe_q_map, top_sharpe_q_map = _assign_quartiles(cat_sharpe_map)

        # Build update rows
        for _, row in group.iterrows():
            code = row["scheme_code"]
            fwd_ret = fund_fwd_rets.get(code)
            fwd_q   = quartile_map.get(code)
            fwd_top = top_q_map.get(code)

            if fwd_ret is None:
                continue  # No NAV data for forward date yet

            update: dict[str, Any] = {
                "scheme_code":   code,
                "as_of_date":    str(as_of),
                ret_col:         round(fwd_ret, 4),
                quartile_col:    fwd_q,
                top_q_col:       fwd_top,
            }
            # Sharpe-based labels (may be None if vol is zero or insufficient data)
            sharpe_val = fund_fwd_sharpes.get(code)
            if sharpe_val is not None:
                update["fwd_sharpe_3m"] = round(sharpe_val, 4)
            update["fwd_sharpe_q_3m"]     = sharpe_q_map.get(code)
            update["fwd_top_sharpe_q_3m"] = top_sharpe_q_map.get(code)

            updates.append(update)

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


def _assign_quartiles(cat_map: dict) -> tuple[dict, dict]:
    """Assign within-category quartile ranks. Returns (quartile_map, top_q_map).
    Quartile 1 = best, 4 = worst. Handles categories with <4 members gracefully.
    Module-level so both compute_labels and backfill_sharpe_labels can use it.
    """
    q_map: dict[str, int] = {}
    top_map: dict[str, bool] = {}
    for cat, items in cat_map.items():
        if len(items) < 2:
            for code, val in items:
                q_map[code] = 1 if val > 0 else 4
                top_map[code] = val > 0
            continue
        codes_arr = [x[0] for x in items]
        vals_arr  = np.array([x[1] for x in items])
        try:
            labels = pd.qcut(vals_arr, q=4, labels=[4, 3, 2, 1], duplicates="drop")
            for code, lbl in zip(codes_arr, labels):
                q = int(lbl) if not pd.isna(lbl) else None
                q_map[code] = q
                top_map[code] = (q == 1) if q is not None else None
        except Exception:
            order = np.argsort(vals_arr)[::-1]
            n = len(order)
            for rank, idx in enumerate(order):
                c = codes_arr[idx]
                q = min(4, int(rank / n * 4) + 1)
                q_map[c] = q
                top_map[c] = q == 1
    return q_map, top_map


def load_sharpe_unlabeled(supabase, cutoff: date) -> pd.DataFrame:
    """Load rows that have a return label but are missing the Sharpe label.

    This happens because load_unlabeled() filters on fwd_top_q_3m IS NULL —
    once the return quartile is written, those rows are never revisited for
    the Sharpe calculation even when it returned None on first pass.
    """
    log.info("Loading rows with fwd_top_q_3m set but fwd_top_sharpe_q_3m IS NULL (as_of_date <= %s)", cutoff)
    rows: list[dict] = []
    page_size = 1000
    offset = 0
    while True:
        resp = (
            supabase.table("mf_features")
            .select("scheme_code,as_of_date,category,ret1y")
            .not_.is_("fwd_top_q_3m", "null")      # return label exists
            .is_("fwd_top_sharpe_q_3m", "null")     # but Sharpe label missing
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
    log.info("Found %d rows needing Sharpe backfill", len(df))
    return df


def backfill_sharpe_labels(df: pd.DataFrame, supabase, fwd_days: int = 90, dry_run: bool = False) -> int:
    """Compute and write ONLY the Sharpe-based columns for rows that already have
    fwd_top_q_3m set. Does not touch return labels."""
    from pathlib import Path

    cache_dir = Path(__file__).parent / ".cache_nav"
    total = 0
    updates: list[dict] = []

    for as_of_ts, group in df.groupby("as_of_date"):
        as_of = as_of_ts.date()
        target_date = as_of + timedelta(days=fwd_days)

        fund_fwd_sharpes: dict[str, float | None] = {}
        for _, row in group.iterrows():
            code = row["scheme_code"]
            cache_file = cache_dir / f"{code}.parquet"
            fwd_sharpe = None
            if cache_file.exists():
                try:
                    nav_df = pd.read_parquet(cache_file)
                    nav_df["date"] = pd.to_datetime(nav_df["date"])
                    fwd_sharpe = _fwd_sharpe(nav_df, as_of, target_date)
                except Exception as e:
                    log.debug("NAV cache read failed for %s: %s", code, e)
            fund_fwd_sharpes[code] = fwd_sharpe

        # Rank within category
        cat_sharpe_map: dict[str, list[tuple[str, float]]] = {}
        for _, row in group.iterrows():
            code = row["scheme_code"]
            cat  = row.get("category", "Unknown")
            sharpe = fund_fwd_sharpes.get(code)
            if sharpe is not None:
                cat_sharpe_map.setdefault(cat, []).append((code, sharpe))

        sharpe_q_map, top_sharpe_q_map = _assign_quartiles(cat_sharpe_map)

        for _, row in group.iterrows():
            code = row["scheme_code"]
            as_of_str = str(as_of)
            sharpe_val = fund_fwd_sharpes.get(code)
            if sharpe_val is None and code not in top_sharpe_q_map:
                continue  # Nothing to write for this row
            upd: dict[str, Any] = {
                "scheme_code": code,
                "as_of_date":  as_of_str,
            }
            if sharpe_val is not None:
                upd["fwd_sharpe_3m"] = float(round(sharpe_val, 4))
            if code in sharpe_q_map:
                q_val = sharpe_q_map[code]
                t_val = top_sharpe_q_map.get(code, False)
                upd["fwd_sharpe_q_3m"]     = int(q_val)   if q_val is not None else None
                upd["fwd_top_sharpe_q_3m"] = bool(t_val)  if t_val is not None else None
            updates.append(upd)

    if dry_run:
        computed = sum(1 for u in updates if u.get("fwd_top_sharpe_q_3m") is not None)
        log.info("dry-run: would write Sharpe labels for %d rows (%d with quartile)", len(updates), computed)
        return len(updates)

    batch_size = 500
    for i in range(0, len(updates), batch_size):
        chunk = updates[i : i + batch_size]
        supabase.table("mf_features").upsert(
            chunk, on_conflict="scheme_code,as_of_date"
        ).execute()
        total += len(chunk)
        log.info("Sharpe backfill: upserted %d/%d", min(i + batch_size, len(updates)), len(updates))

    return total


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--window",     type=int,  default=90,
                   help="Forward window in days: 90=3M (default), 30=1M")
    p.add_argument("--dry-run",    action="store_true", help="Compute but don't write")
    p.add_argument("--fix-sharpe", action="store_true",
                   help="Backfill fwd_top_sharpe_q_3m for rows that already have "
                        "fwd_top_q_3m but are missing the Sharpe label. "
                        "Run once after initial deployment to fix historical gap.")
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
    cutoff = date.today() - timedelta(days=args.window)

    # ── Fix-sharpe mode: backfill Sharpe labels on rows that already have return labels
    if args.fix_sharpe:
        df = load_sharpe_unlabeled(supabase, cutoff)
        if df.empty:
            log.info("All labeled rows already have Sharpe labels — nothing to do.")
            sys.exit(0)
        n = backfill_sharpe_labels(df, supabase, fwd_days=args.window, dry_run=args.dry_run)
        log.info("Done. Sharpe backfill: %d rows processed.", n)
        return

    # ── Normal mode: label rows missing fwd_top_q_3m
    unlabeled = load_unlabeled(supabase, cutoff, top_q_col=top_q_col)

    if unlabeled.empty:
        log.info("Nothing to label — run extract_features.py --backfill 365 first")
        sys.exit(0)

    n = compute_labels(
        unlabeled, supabase,
        fwd_days=args.window,
        dry_run=args.dry_run,
        ret_col=ret_col,
        quartile_col=quartile_col,
        top_q_col=top_q_col,
    )
    log.info("Done. Labeled %d rows.", n)


if __name__ == "__main__":
    main()
