"""
Macro Feature Fetcher
======================

Fetches market-wide macro indicators for each trading day and upserts them
into mf_features rows as additional columns. These are identical across all
funds on the same date, providing market context to the model.

Macro signals fetched (all via yfinance):
  nifty_ret1m    — Nifty 50 1-month return (%)
  nifty_ret3m    — Nifty 50 3-month return (%)
  india_vix      — India VIX level (fear gauge)
  usd_inr        — USD/INR spot rate
  us_10y_yield   — US 10-year Treasury yield (%)

Beta/alpha/corr vs Nifty are computed from daily returns (requires NAV cache):
  beta_nifty     — Fund return regression slope vs Nifty daily returns (1y)
  alpha_nifty    — Annualized intercept (excess return)
  corr_nifty     — Pearson correlation with Nifty

Usage:
    python macro_features.py                    # update today
    python macro_features.py --backfill 365     # fill last 365 days
    python macro_features.py --as-of 2026-01-15
    python macro_features.py --dry-run          # compute, don't write

Env:
    SUPABASE_URL
    SUPABASE_SERVICE_KEY
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import warnings
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client
from tqdm import tqdm

warnings.filterwarnings("ignore")

# ─── Setup ────────────────────────────────────────────────────────────────────

load_dotenv()
load_dotenv(Path(__file__).parent.parent / "backend" / ".env", override=False)
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("macro_features")

TRADING_DAYS = 252
CACHE_DIR = Path(__file__).parent / ".cache_macro"
CACHE_DIR.mkdir(exist_ok=True)

# Yahoo Finance tickers
TICKERS = {
    "nifty":    "^NSEI",
    "vix":      "^INDIAVIX",
    "usd_inr":  "USDINR=X",
    "us_10y":   "^TNX",
}

NIFTY_CACHE = CACHE_DIR / "nifty_daily.parquet"
VIX_CACHE   = CACHE_DIR / "vix_daily.parquet"
USDINR_CACHE = CACHE_DIR / "usdinr_daily.parquet"
US10Y_CACHE  = CACHE_DIR / "us10y_daily.parquet"
NAV_CACHE_DIR = Path(__file__).parent / ".cache_nav"


# ─── yfinance data fetching ──────────────────────────────────────────────────

def fetch_yf(ticker: str, cache_file: Path, start: str = "2018-01-01") -> pd.DataFrame:
    """
    Fetch daily OHLCV from Yahoo Finance. Cache to parquet.
    Returns DataFrame with DatetimeIndex and 'close' column.
    """
    try:
        import yfinance as yf
    except ImportError:
        log.error("yfinance not installed. Run: pip install yfinance")
        return pd.DataFrame()

    # Use cache if fresh (< 12h)
    if cache_file.exists():
        age_h = (datetime.now().timestamp() - cache_file.stat().st_mtime) / 3600
        if age_h < 12:
            df = pd.read_parquet(cache_file)
            log.debug("Loaded %s from cache (%d rows)", ticker, len(df))
            return df

    try:
        df = yf.download(ticker, start=start, auto_adjust=True, progress=False)
        if df.empty:
            log.warning("yfinance returned no data for %s", ticker)
            return pd.DataFrame()

        df = df[["Close"]].rename(columns={"Close": "close"})
        df.index = pd.to_datetime(df.index)
        df = df.sort_index()
        df.to_parquet(cache_file)
        log.info("Fetched %s: %d rows (%s → %s)",
                 ticker, len(df), df.index.min().date(), df.index.max().date())
        return df
    except Exception as e:
        log.error("Failed to fetch %s: %s", ticker, e)
        return pd.DataFrame()


def value_at_or_before(df: pd.DataFrame, target: pd.Timestamp) -> float | None:
    """Latest close at or before target date."""
    sub = df[df.index <= target]
    if sub.empty:
        return None
    return float(sub["close"].iloc[-1])


def pct_return_yf(df: pd.DataFrame, as_of: pd.Timestamp, days: int) -> float | None:
    cur  = value_at_or_before(df, as_of)
    past = value_at_or_before(df, as_of - timedelta(days=days))
    if cur is None or past is None or past == 0:
        return None
    return (cur - past) / past * 100.0


# ─── Nifty beta / alpha / corr computation ───────────────────────────────────

def nifty_regression(
    fund_code: str,
    nifty_df: pd.DataFrame,
    as_of: pd.Timestamp,
    days: int = 365,
) -> tuple[float | None, float | None, float | None]:
    """
    Compute beta, annualized alpha, and correlation of fund vs Nifty
    over the trailing `days` calendar days.

    Returns (beta, alpha_ann, corr) or (None, None, None) on failure.
    """
    cache_file = NAV_CACHE_DIR / f"{fund_code}.parquet"
    if not cache_file.exists():
        return None, None, None

    try:
        nav_df = pd.read_parquet(cache_file)
        nav_df["date"] = pd.to_datetime(nav_df["date"])
        nav_df = nav_df.set_index("date").sort_index()

        start_dt = as_of - timedelta(days=days)

        # Daily fund returns
        fund_sub = nav_df[(nav_df.index > start_dt) & (nav_df.index <= as_of)]["nav"]
        fund_rets = fund_sub.pct_change().dropna()

        # Daily Nifty returns (align to same dates)
        nifty_sub = nifty_df[(nifty_df.index > start_dt) & (nifty_df.index <= as_of)]["close"]
        nifty_rets = nifty_sub.pct_change().dropna()

        # Inner join on dates
        combined = pd.concat([fund_rets.rename("fund"), nifty_rets.rename("nifty")], axis=1).dropna()
        if len(combined) < 30:
            return None, None, None

        x = combined["nifty"].values
        y = combined["fund"].values

        # OLS regression: y = alpha_daily + beta * x
        cov = np.cov(x, y)
        var_x = cov[0, 0]
        if var_x == 0:
            return None, None, None

        beta = float(cov[0, 1] / var_x)
        alpha_daily = float(np.mean(y) - beta * np.mean(x))
        alpha_ann = float(alpha_daily * TRADING_DAYS * 100.0)  # annualized %

        corr = float(np.corrcoef(x, y)[0, 1])

        return beta, alpha_ann, corr
    except Exception as e:
        log.debug("Regression failed for %s: %s", fund_code, e)
        return None, None, None


# ─── Macro row builder ────────────────────────────────────────────────────────

def build_macro_row(
    as_of: pd.Timestamp,
    nifty_df: pd.DataFrame,
    vix_df: pd.DataFrame,
    usdinr_df: pd.DataFrame,
    us10y_df: pd.DataFrame,
) -> dict:
    return {
        "nifty_ret1m": pct_return_yf(nifty_df, as_of, 30),
        "nifty_ret3m": pct_return_yf(nifty_df, as_of, 90),
        "india_vix":   value_at_or_before(vix_df,    as_of),
        "usd_inr":     value_at_or_before(usdinr_df, as_of),
        "us_10y_yield": value_at_or_before(us10y_df, as_of),
    }


# ─── Database helpers ─────────────────────────────────────────────────────────

def load_fund_codes_for_date(supabase, as_of_date: date) -> list[str]:
    """Return all scheme_codes for a given as_of_date."""
    resp = (
        supabase.table("mf_features")
        .select("scheme_code")
        .eq("as_of_date", str(as_of_date))
        .execute()
    )
    return [r["scheme_code"] for r in (resp.data or [])]


def upsert_macro_rows(supabase, rows: list[dict], batch: int = 500) -> int:
    """Upsert macro columns into mf_features via the existing PK."""
    total = 0
    # Replace NaN with None
    cleaned = []
    for row in rows:
        cleaned.append({
            k: (None if isinstance(v, float) and np.isnan(v) else v)
            for k, v in row.items()
        })

    for i in range(0, len(cleaned), batch):
        chunk = cleaned[i : i + batch]
        supabase.table("mf_features").upsert(
            chunk, on_conflict="scheme_code,as_of_date"
        ).execute()
        total += len(chunk)
    return total


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--as-of",    type=str, default=None)
    p.add_argument("--backfill", type=int, default=0,   help="N days to backfill")
    p.add_argument("--dry-run",  action="store_true")
    p.add_argument("--skip-regression", action="store_true",
                   help="Skip beta/alpha/corr computation (much faster)")
    args = p.parse_args()

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)

    supabase = create_client(url, key)

    # ── 1. Fetch all market data upfront ──────────────────────────────────
    log.info("Fetching macro data from Yahoo Finance…")
    nifty_df  = fetch_yf(TICKERS["nifty"],   NIFTY_CACHE)
    vix_df    = fetch_yf(TICKERS["vix"],     VIX_CACHE)
    usdinr_df = fetch_yf(TICKERS["usd_inr"], USDINR_CACHE)
    us10y_df  = fetch_yf(TICKERS["us_10y"],  US10Y_CACHE)

    if nifty_df.empty:
        log.error("Could not fetch Nifty data — aborting")
        sys.exit(1)

    # ── 2. Build date range ────────────────────────────────────────────────
    if args.as_of:
        as_of_end = pd.Timestamp(args.as_of)
    else:
        as_of_end = pd.Timestamp.now().normalize()

    if args.backfill > 0:
        dates = [as_of_end - timedelta(days=d) for d in range(args.backfill)]
    else:
        dates = [as_of_end]

    dates = [d for d in dates if d.dayofweek < 5]  # skip weekends
    log.info("Processing macro features for %d date(s)", len(dates))

    # ── 3. Process each date ───────────────────────────────────────────────
    total_written = 0
    for as_of in tqdm(dates, desc="macro dates"):
        as_of_date = as_of.date()

        # Shared macro values (same for all funds on this date)
        macro = build_macro_row(as_of, nifty_df, vix_df, usdinr_df, us10y_df)

        # Per-fund regression (beta/alpha/corr)
        if not args.skip_regression:
            fund_codes = load_fund_codes_for_date(supabase, as_of_date)
        else:
            fund_codes = []

        if fund_codes:
            rows = []
            for code in tqdm(fund_codes, desc=f"regression {as_of_date}", leave=False):
                beta, alpha_ann, corr = nifty_regression(code, nifty_df, as_of)
                row = {
                    "scheme_code": code,
                    "as_of_date":  str(as_of_date),
                    **macro,
                    "beta_nifty":  beta,
                    "alpha_nifty": alpha_ann,
                    "corr_nifty":  corr,
                }
                rows.append(row)
        else:
            # No fund-specific regression — just update macro columns
            # We need scheme_codes to know which rows to update
            codes = load_fund_codes_for_date(supabase, as_of_date)
            rows = [
                {"scheme_code": c, "as_of_date": str(as_of_date), **macro}
                for c in codes
            ]

        if not rows:
            log.debug("No rows for %s (extract_features.py may not have run yet)", as_of_date)
            continue

        if args.dry_run:
            log.info("dry-run: would update %d rows for %s — sample macro: nifty_ret1m=%.2f vix=%.1f",
                     len(rows), as_of_date,
                     macro.get("nifty_ret1m") or 0,
                     macro.get("india_vix") or 0)
        else:
            n = upsert_macro_rows(supabase, rows)
            total_written += n
            log.info("%s: updated %d rows (nifty_ret1m=%.2f%% vix=%.1f)",
                     as_of_date, n,
                     macro.get("nifty_ret1m") or 0,
                     macro.get("india_vix") or 0)

    log.info("Done. Total rows updated: %d", total_written)


if __name__ == "__main__":
    main()
