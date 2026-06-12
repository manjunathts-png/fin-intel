"""
Pick Outcome Tracker — the realized-P&L feedback loop
======================================================

refresh-cache.js snapshots the top-100 ranked picks into pick_history every
EOD run. This script backfills the realized forward returns for those
snapshots from the local OHLCV parquet cache, closing the loop between
"what we recommended" and "what actually happened".

Entry convention (no lookahead): picks are computed at EOD of pick_date, so
the earliest realistic fill is the NEXT trading day's close. ret_5d/10d/21d
measure entry → entry + N trading days.

Run nightly after label_stock_targets.py (the OHLCV cache is already fresh).

Usage:
    python track_pick_outcomes.py             # backfill all resolvable rows
    python track_pick_outcomes.py --dry-run

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
log = logging.getLogger("track_pick_outcomes")

CACHE_DIR = Path(__file__).parent / ".cache_stock"
HORIZONS = {"ret_5d": 5, "ret_10d": 10, "ret_21d": 21}   # trading days after entry

# Round-trip transaction cost in % (brokerage + STT + impact for liquid NSE
# names). Gross hit rates flatter the system; the net numbers are what an
# investor actually keeps.
COST_PCT = 0.30


def net_of_cost(returns: pd.Series, cost_pct: float = COST_PCT) -> pd.Series:
    """Realized returns minus the round-trip transaction cost."""
    return returns - cost_pct


def compute_outcomes(closes: pd.Series, pick_date: date) -> dict[str, Any] | None:
    """Compute entry close + forward returns for one pick from a close series.

    closes: pd.Series indexed by DatetimeIndex (sorted ascending).
    Returns dict with entry_close and whichever ret_* horizons have resolved,
    or None when no trading day after pick_date exists yet.
    """
    if closes is None or closes.empty:
        return None
    fut = closes[closes.index > pd.Timestamp(pick_date)]
    if fut.empty:
        return None
    entry = float(fut.iloc[0])
    if not np.isfinite(entry) or entry <= 0:
        return None
    out: dict[str, Any] = {"entry_close": round(entry, 4)}
    for col, n in HORIZONS.items():
        if len(fut) > n:
            exit_px = float(fut.iloc[n])
            out[col] = round((exit_px / entry - 1) * 100, 4)
        else:
            out[col] = None
    return out


def load_pending(supabase, max_age_days: int = 365) -> pd.DataFrame:
    """Load pick_history rows still missing their 21d outcome, old enough that
    at least the 5d outcome could have resolved (~8 calendar days)."""
    newest = date.today() - timedelta(days=8)
    oldest = date.today() - timedelta(days=max_age_days)
    rows, page_size, offset = [], 1000, 0
    while True:
        resp = (
            supabase.table("pick_history")
            .select("pick_date,symbol,ret_5d,ret_10d,ret_21d")
            .is_("ret_21d", "null")
            .gte("pick_date", str(oldest))
            .lte("pick_date", str(newest))
            .order("pick_date")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    df = pd.DataFrame(rows)
    log.info("Found %d pick rows pending outcomes", len(df))
    return df


def backfill(supabase, pending: pd.DataFrame, dry_run: bool = False) -> int:
    updates: list[dict[str, Any]] = []
    closes_cache: dict[str, pd.Series | None] = {}

    for _, row in pending.iterrows():
        sym = row["symbol"]
        if sym not in closes_cache:
            cache_file = CACHE_DIR / f"{sym}.parquet"
            ser = None
            if cache_file.exists():
                try:
                    df = pd.read_parquet(cache_file)
                    df.index = pd.to_datetime(df.index)
                    ser = df["close"].sort_index()
                except Exception as e:
                    log.debug("OHLCV cache read failed for %s: %s", sym, e)
            closes_cache[sym] = ser

        ser = closes_cache[sym]
        if ser is None:
            continue
        pick_d = date.fromisoformat(str(row["pick_date"])[:10])
        out = compute_outcomes(ser, pick_d)
        if out is None:
            continue
        # Only write when something NEW resolved vs what's already stored
        has_new = any(
            out.get(col) is not None and row.get(col) is None
            for col in HORIZONS
        )
        if not has_new:
            continue
        updates.append({
            "pick_date": str(pick_d),
            "symbol":    sym,
            **{k: v for k, v in out.items() if v is not None},
            "outcomes_updated_at": pd.Timestamp.utcnow().isoformat(),
        })

    if not updates:
        log.info("No new outcomes to write")
        return 0
    if dry_run:
        log.info("dry-run: would write %d outcome rows; sample: %s", len(updates), updates[0])
        return len(updates)

    total = 0
    for i in range(0, len(updates), 500):
        chunk = updates[i : i + 500]
        supabase.table("pick_history").upsert(chunk, on_conflict="pick_date,symbol").execute()
        total += len(chunk)
    log.info("Wrote outcomes for %d pick rows", total)
    return total


def report_summary(supabase) -> None:
    """Log the headline number: how the top-50 picks actually performed."""
    try:
        resp = (
            supabase.table("pick_history")
            .select("rank,ret_21d")
            .not_.is_("ret_21d", "null")
            .gte("pick_date", str(date.today() - timedelta(days=120)))
            .execute()
        )
        rows = resp.data or []
        if len(rows) < 20:
            log.info("Outcome summary: only %d resolved picks — need more history", len(rows))
            return
        df = pd.DataFrame(rows)
        top50 = df[df["rank"] <= 50]["ret_21d"]
        rest  = df[df["rank"] > 50]["ret_21d"]
        net50 = net_of_cost(top50)
        log.info(
            "Outcome summary (last 120d, 21d fwd): top-50 mean=%.2f%% median=%.2f%% "
            "hit-rate(>0)=%.0f%% (n=%d)  |  ranks 51-100 mean=%.2f%% (n=%d)",
            top50.mean(), top50.median(), (top50 > 0).mean() * 100, len(top50),
            rest.mean() if len(rest) else float("nan"), len(rest),
        )
        log.info(
            "Net of %.2f%% round-trip cost: top-50 mean=%.2f%% hit-rate=%.0f%%",
            COST_PCT, net50.mean(), (net50 > 0).mean() * 100,
        )
    except Exception as e:
        log.debug("Outcome summary failed: %s", e)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)
    supabase = create_client(url, key)

    try:
        pending = load_pending(supabase)
    except Exception as e:
        if "pick_history" in str(e) or "does not exist" in str(e):
            log.error("pick_history table missing — run migrate_012 (dispatch target=migrate)")
            sys.exit(1)
        raise

    if pending.empty:
        log.info("Nothing pending.")
    else:
        n = backfill(supabase, pending, dry_run=args.dry_run)
        log.info("Done. %d rows updated.", n)
    report_summary(supabase)


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
