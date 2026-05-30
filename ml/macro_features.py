"""
Macro Feature Fetcher
======================

Fetches market-wide macro indicators for each trading day and upserts them
into mf_features rows as additional columns. These are identical across all
funds on the same date, providing market context to the model.

Macro signals fetched (all via Yahoo Finance chart API):
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
import time
import warnings
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import urllib3
from dotenv import load_dotenv
from supabase import create_client
from tqdm import tqdm

warnings.filterwarnings("ignore")
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

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

# Yahoo Finance tickers — tried in order until one succeeds
TICKERS = {
    "nifty":   ["^NSEI", "NIFTYBEES.NS"],   # Nifty 50 index, fallback ETF proxy
    "vix":     ["^INDIAVIX"],
    "usd_inr": ["USDINR=X", "INR=X"],
    "us_10y":  ["^TNX", "TLT"],             # US 10Y yield, fallback: 20Y bond ETF
}

# Fallback: UTI Nifty 50 Index Direct Growth on mfapi.in (use as Nifty proxy)
NIFTY_MFAPI_CODE = "120716"

NIFTY_CACHE  = CACHE_DIR / "nifty_daily.parquet"
VIX_CACHE    = CACHE_DIR / "vix_daily.parquet"
USDINR_CACHE = CACHE_DIR / "usdinr_daily.parquet"
US10Y_CACHE  = CACHE_DIR / "us10y_daily.parquet"
NAV_CACHE_DIR = Path(__file__).parent / ".cache_nav"

# Shared requests session (SSL disabled for macOS LibreSSL compatibility)
_SESSION: requests.Session | None = None

_YF_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

# Yahoo Finance chart API v8 — no crumb needed for basic queries
_YF_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"


def _get_session() -> requests.Session:
    global _SESSION
    if _SESSION is None:
        _SESSION = requests.Session()
        _SESSION.verify = False          # LibreSSL workaround on macOS
        _SESSION.headers.update(_YF_HEADERS)
        # Warm up cookies from fc.yahoo.com (same as yfinance basic strategy)
        try:
            _SESSION.get("https://fc.yahoo.com", timeout=10, allow_redirects=True)
        except Exception:
            pass
    return _SESSION


# ─── Direct Yahoo Finance chart API fetcher ──────────────────────────────────

def _fetch_yahoo_direct(ticker: str, start: str) -> pd.DataFrame:
    """
    Fetch daily close directly from Yahoo Finance chart API (v8).
    Bypasses yfinance to avoid rate-limiting and SSL issues on macOS.
    Returns a DataFrame with DatetimeIndex and 'close' column, or empty DF.
    """
    start_ts = int(pd.Timestamp(start).timestamp())
    end_ts   = int(pd.Timestamp.now().timestamp()) + 86400

    params = {
        "interval": "1d",
        "period1":  start_ts,
        "period2":  end_ts,
        "events":   "history",
        "includePrePost": "false",
    }
    url = _YF_CHART_URL.format(ticker=ticker)
    session = _get_session()

    for attempt in range(2):  # 2 tries max; fallbacks handle persistent 429s
        try:
            r = session.get(url, params=params, timeout=20)
            if r.status_code == 429:
                if attempt == 0:
                    log.warning("%s rate-limited (429) — waiting 5s before retry", ticker)
                    time.sleep(5)
                else:
                    log.warning("%s rate-limited again — giving up, will try fallback", ticker)
                    return pd.DataFrame()
                continue
            if r.status_code != 200:
                log.warning("%s returned HTTP %d", ticker, r.status_code)
                return pd.DataFrame()

            data = r.json()
            result = data.get("chart", {}).get("result")
            if not result:
                log.warning("%s: no chart result in response", ticker)
                return pd.DataFrame()

            meta = result[0]
            timestamps = meta.get("timestamp", [])
            closes = (
                meta.get("indicators", {})
                    .get("adjclose", [{}])[0]
                    .get("adjclose")
                or meta.get("indicators", {})
                    .get("quote", [{}])[0]
                    .get("close")
            )
            if not timestamps or not closes:
                log.warning("%s: empty timestamps or closes", ticker)
                return pd.DataFrame()

            idx = pd.to_datetime(timestamps, unit="s").tz_localize(None)
            df = pd.DataFrame({"close": closes}, index=idx)
            df = df.dropna().sort_index()
            return df

        except requests.exceptions.RequestException as e:
            log.warning("%s fetch error (attempt %d): %s", ticker, attempt + 1, e)
            time.sleep(5)

    return pd.DataFrame()


def _fetch_nifty_via_mfapi(start: str = "2018-01-01") -> pd.DataFrame:
    """
    Fetch Nifty 50 daily close via UTI Nifty 50 Index Fund NAV from mfapi.in.
    Used as fallback when Yahoo Finance rate-limits ^NSEI.
    NAV of a pure Nifty 50 index fund tracks the index within ~0.1%.
    """
    try:
        session = _get_session()
        r = session.get(f"https://api.mfapi.in/mf/{NIFTY_MFAPI_CODE}", timeout=20)
        if r.status_code != 200:
            return pd.DataFrame()
        data = r.json()
        navs = data.get("data", [])
        if not navs:
            return pd.DataFrame()
        df = pd.DataFrame(navs)
        df["date"] = pd.to_datetime(df["date"], dayfirst=True)
        df["nav"]  = pd.to_numeric(df["nav"], errors="coerce")
        df = df.rename(columns={"nav": "close"}).set_index("date").sort_index()
        df = df[["close"]].dropna()
        df = df[df.index >= pd.Timestamp(start)]
        log.info("Fetched Nifty via mfapi.in (UTI Nifty 50): %d rows (%s → %s)",
                 len(df), df.index.min().date(), df.index.max().date())
        return df
    except Exception as e:
        log.warning("mfapi.in Nifty fallback failed: %s", e)
        return pd.DataFrame()


def _fetch_usdinr_frankfurter(start: str = "2018-01-01") -> pd.DataFrame:
    """
    Fetch USD/INR historical rates from frankfurter.app (ECB data, free, no key).
    Fallback when Yahoo Finance rate-limits USDINR=X.
    """
    try:
        session = _get_session()
        # Frankfurter.app max range is ~1 year per call; chunk if needed
        start_dt = pd.Timestamp(start)
        today    = pd.Timestamp.now().normalize()
        chunks   = []
        dt = start_dt
        while dt <= today:
            end = min(dt + timedelta(days=364), today)
            url = f"https://api.frankfurter.app/{dt.date()}..{end.date()}"
            r = session.get(url, params={"from": "USD", "to": "INR"}, timeout=15)
            if r.status_code != 200:
                break
            rates = r.json().get("rates", {})
            if rates:
                chunk = pd.DataFrame(
                    [(pd.Timestamp(d), v["INR"]) for d, v in rates.items()],
                    columns=["date", "close"]
                ).set_index("date")
                chunks.append(chunk)
            dt = end + timedelta(days=1)
            time.sleep(0.3)

        if not chunks:
            return pd.DataFrame()
        df = pd.concat(chunks).sort_index()
        df = df[~df.index.duplicated(keep="last")]
        log.info("Fetched USD/INR via frankfurter.app: %d rows", len(df))
        return df
    except Exception as e:
        log.warning("frankfurter.app USD/INR fallback failed: %s", e)
        return pd.DataFrame()


def fetch_yf(tickers, cache_file: Path, start: str = "2018-01-01") -> pd.DataFrame:
    """
    Fetch daily close from Yahoo Finance with fallback to alternative sources.
    tickers: str or list[str] — tried in order until one succeeds.
    Caches result to parquet (12h TTL).
    """
    if isinstance(tickers, str):
        tickers = [tickers]

    # Use cache if fresh (< 12h)
    if cache_file.exists():
        age_h = (datetime.now().timestamp() - cache_file.stat().st_mtime) / 3600
        if age_h < 12:
            df = pd.read_parquet(cache_file)
            log.debug("Loaded %s from cache (%d rows)", tickers[0], len(df))
            return df

    # ── Try Yahoo Finance first ──────────────────────────────────────────────
    for ticker in tickers:
        try:
            df = _fetch_yahoo_direct(ticker, start)
            if not df.empty:
                df.to_parquet(cache_file)
                log.info("Fetched %s (via %s): %d rows (%s → %s)",
                         tickers[0], ticker, len(df),
                         df.index.min().date(), df.index.max().date())
                return df
            log.warning("%s returned no data — trying next fallback", ticker)
        except Exception as e:
            log.warning("%s failed (%s) — trying next fallback", ticker, e)

    # ── Non-Yahoo fallbacks ──────────────────────────────────────────────────
    primary = tickers[0]

    if primary in ("^NSEI", "NIFTYBEES.NS"):
        log.info("Yahoo rate-limited for Nifty — trying mfapi.in fallback")
        df = _fetch_nifty_via_mfapi(start)
        if not df.empty:
            df.to_parquet(cache_file)
            return df

    if primary in ("USDINR=X", "INR=X"):
        log.info("Yahoo rate-limited for USD/INR — trying frankfurter.app fallback")
        df = _fetch_usdinr_frankfurter(start)
        if not df.empty:
            df.to_parquet(cache_file)
            return df

    log.error("All sources failed for %s: %s", primary, tickers)
    return pd.DataFrame()


def value_at_or_before(df: pd.DataFrame, target: pd.Timestamp) -> float | None:
    """Latest close at or before target date."""
    if df.empty or "close" not in df.columns:
        return None
    try:
        sub = df[df.index <= target]
    except TypeError:
        return None  # index is not DatetimeIndex (empty df with RangeIndex)
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
