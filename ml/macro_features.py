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

NIFTY_CACHE   = CACHE_DIR / "nifty_daily.parquet"
VIX_CACHE     = CACHE_DIR / "vix_daily.parquet"
USDINR_CACHE  = CACHE_DIR / "usdinr_daily.parquet"
US10Y_CACHE   = CACHE_DIR / "us10y_daily.parquet"
FIIDII_CACHE  = CACHE_DIR / "fiidii_daily.parquet"
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


def _fetch_vix_yahoo(start: str = "2018-01-01") -> pd.DataFrame:
    """
    Fetch India VIX history via Yahoo Finance v8 raw API.
    Uses SSL verification disabled (required on macOS LibreSSL + GitHub Actions).
    Symbol: ^INDIAVIX  Works reliably on both local and CI environments.
    """
    import urllib3
    urllib3.disable_warnings()
    # Use a fresh session with SSL verify disabled — required on both macOS LibreSSL
    # and GitHub Actions runners where the Yahoo Finance cert chain can't be verified.
    session = requests.Session()
    session.verify = False
    session.headers.update({"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"})
    try:
        session.get("https://fc.yahoo.com", timeout=8, allow_redirects=True)
    except Exception:
        pass
    start_ts = int(pd.Timestamp(start).timestamp())
    end_ts   = int(pd.Timestamp.now().timestamp()) + 86400
    params   = {"interval": "1d", "period1": start_ts, "period2": end_ts, "events": "history"}
    for base in ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"]:
        try:
            r = session.get(f"{base}/v8/finance/chart/%5EINDIAVIX", params=params, timeout=20)
            if r.status_code != 200:
                continue
            data   = r.json()
            result = data.get("chart", {}).get("result")
            if not result:
                continue
            ts     = result[0].get("timestamp", [])
            closes = result[0].get("indicators", {}).get("quote", [{}])[0].get("close", [])
            if not ts or not closes:
                continue
            idx = pd.to_datetime(ts, unit="s").tz_localize(None)
            df  = pd.DataFrame({"close": closes}, index=idx).dropna()
            df  = df[df["close"] > 0].sort_index()
            if df.empty:
                continue
            df.to_parquet(VIX_CACHE)   # update carry-forward cache
            log.info("Yahoo VIX: %d rows (%s → %s, latest=%.2f)",
                     len(df), df.index.min().date(), df.index.max().date(), df["close"].iloc[-1])
            return df
        except Exception as e:
            log.warning("Yahoo VIX %s failed: %s", base, e)
    return pd.DataFrame()


def _fetch_vix_kite(start: str = "2018-01-01", access_token: str = "") -> pd.DataFrame:
    """
    Fetch India VIX daily history from Kite Connect API.
    Requires KITE_API_KEY + a valid access_token (expires 6 AM IST daily).
    Instrument token 264969 = India VIX on NSE.
    """
    try:
        from kiteconnect import KiteConnect
        kc = KiteConnect(api_key=os.environ.get("KITE_API_KEY", "9tbbi2hz87cqmnlr"))
        kc.set_access_token(access_token)
        from datetime import datetime as _dt
        records = kc.historical_data(
            instrument_token=264969,
            from_date=_dt.strptime(start, "%Y-%m-%d"),
            to_date=_dt.now(),
            interval="day",
        )
        if not records:
            return pd.DataFrame()
        df = pd.DataFrame(records)
        df["date"] = pd.to_datetime(df["date"]).dt.normalize()
        df = df.set_index("date")[["close"]].rename(columns={"close": "india_vix"})
        # Rename to match the expected "close" column convention used by value_at_or_before()
        df = df.rename(columns={"india_vix": "close"})
        df = df.sort_index().dropna()
        log.info("Kite VIX: %d rows (%s → %s)",
                 len(df), df.index.min().date(), df.index.max().date())
        # Also save to VIX_CACHE so carry-forward works on next run
        df.to_parquet(VIX_CACHE)
        return df
    except Exception as e:
        log.warning("Kite VIX fetch failed: %s", e)
        return pd.DataFrame()


def _fetch_vix_nse(start: str = "2018-01-01") -> pd.DataFrame:
    """
    Fetch India VIX history from NSE archives (public CSV, no auth required).
    URL: https://nsearchives.nseindia.com/content/vix/VIX_History.csv
    Columns: Date, Open, High, Low, Close, Prev Close, Change, %Change
    """
    try:
        session = _get_session()
        r = session.get(
            "https://nsearchives.nseindia.com/content/vix/VIX_History.csv",
            timeout=30,
        )
        if r.status_code != 200 or len(r.content) < 200:
            log.warning("NSE VIX archive returned HTTP %d", r.status_code)
            return pd.DataFrame()
        from io import StringIO
        df = pd.read_csv(StringIO(r.text))
        df.columns = [c.strip().lower() for c in df.columns]
        if "date" not in df.columns or "close" not in df.columns:
            log.warning("NSE VIX CSV has unexpected columns: %s", list(df.columns))
            return pd.DataFrame()
        df["date"] = pd.to_datetime(df["date"], dayfirst=True, errors="coerce")
        df = df.dropna(subset=["date"])
        df["close"] = pd.to_numeric(df["close"], errors="coerce")
        df = df.set_index("date")[["close"]].dropna().sort_index()
        df = df[df.index >= pd.Timestamp(start)]
        log.info("Fetched India VIX via NSE archive: %d rows (%s → %s)",
                 len(df), df.index.min().date(), df.index.max().date())
        return df
    except Exception as e:
        log.warning("NSE VIX archive failed: %s", e)
        return pd.DataFrame()


def _fetch_us10y_fred(start: str = "2018-01-01") -> pd.DataFrame:
    """
    Fetch US 10-Year Treasury Constant Maturity Rate (DGS10) from FRED.
    Free, no API key required, no rate limits. Covers 1962–present.
    https://fred.stlouisfed.org/series/DGS10
    """
    try:
        session = _get_session()
        url = "https://fred.stlouisfed.org/graph/fredgraph.csv"
        r = session.get(url, params={"id": "DGS10"}, timeout=45)
        if r.status_code != 200:
            log.warning("FRED DGS10 returned HTTP %d", r.status_code)
            return pd.DataFrame()
        from io import StringIO
        df = pd.read_csv(StringIO(r.text), parse_dates=["observation_date"])
        df = df.rename(columns={"observation_date": "date", "DGS10": "close"})
        df = df.set_index("date").sort_index()
        df["close"] = pd.to_numeric(df["close"], errors="coerce")
        df = df.dropna()
        df = df[df.index >= pd.Timestamp(start)]
        log.info("Fetched US 10Y via FRED (DGS10): %d rows (%s → %s)",
                 len(df), df.index.min().date(), df.index.max().date())
        return df
    except Exception as e:
        log.warning("FRED DGS10 fallback failed: %s", e)
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


def _fetch_fiidii_nse() -> pd.DataFrame:
    """
    Fetch FII/DII net equity cash-segment flows from NSE API.
    Returns DataFrame with DatetimeIndex and columns fii_net_cr, dii_net_cr (₹ crore).
    Typically covers the last ~30 trading days; called daily to build up the cache.
    """
    session = requests.Session()
    session.verify = False
    session.headers.update({
        "User-Agent":  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept":      "application/json, text/plain, */*",
        "Referer":     "https://www.nseindia.com",
        "Accept-Language": "en-US,en;q=0.9",
    })
    try:
        # Warm up NSE session cookies — required for API calls
        session.get("https://www.nseindia.com", timeout=15, allow_redirects=True)
        time.sleep(1)
        r = session.get(
            "https://www.nseindia.com/api/fiidiiTradeReact",
            timeout=20,
        )
        if r.status_code != 200:
            log.warning("FII/DII NSE API returned HTTP %d", r.status_code)
            return pd.DataFrame()
        data = r.json()
        if not data or not isinstance(data, list):
            return pd.DataFrame()
        rows = []
        for rec in data:
            try:
                dt      = pd.Timestamp(str(rec.get("date", "")), dayfirst=True)
                fii_net = float(str(rec.get("fiiNet",  "0")).replace(",", ""))
                dii_net = float(str(rec.get("diiNet",  "0")).replace(",", ""))
                if pd.isna(dt):
                    continue
                rows.append({"date": dt, "fii_net_cr": fii_net, "dii_net_cr": dii_net})
            except Exception:
                continue
        if not rows:
            return pd.DataFrame()
        df = pd.DataFrame(rows).set_index("date").sort_index()
        df = df[df.index > pd.Timestamp("2015-01-01")]
        log.info("FII/DII NSE API: %d rows (%s → %s)",
                 len(df), df.index.min().date(), df.index.max().date())
        return df
    except Exception as e:
        log.warning("FII/DII NSE API failed: %s", e)
        return pd.DataFrame()


def fetch_fiidii() -> pd.DataFrame:
    """
    Fetch FII/DII net equity flows, maintaining an incremental local cache.
    Each daily run appends the latest ~30 rows so the cache grows continuously.
    Computes rolling 5-day and 20-day net flow columns for use as model features.
    """
    # Load existing cache
    existing = pd.DataFrame()
    if FIIDII_CACHE.exists():
        try:
            existing = pd.read_parquet(FIIDII_CACHE)
            existing.index = pd.to_datetime(existing.index)
        except Exception:
            pass

    # Check freshness (< 12h = skip re-fetch)
    if FIIDII_CACHE.exists():
        age_h = (datetime.now().timestamp() - FIIDII_CACHE.stat().st_mtime) / 3600
        if age_h < 12 and not existing.empty:
            log.debug("FII/DII cache fresh (%d rows)", len(existing))
            return existing

    # Fetch fresh data from NSE
    fresh = _fetch_fiidii_nse()

    if not fresh.empty:
        if not existing.empty:
            combined = pd.concat([existing[["fii_net_cr", "dii_net_cr"]], fresh]).sort_index()
            combined = combined[~combined.index.duplicated(keep="last")]
        else:
            combined = fresh
        # Add rolling features
        combined["fii_net_5d"]  = combined["fii_net_cr"].rolling(5,  min_periods=1).sum()
        combined["fii_net_20d"] = combined["fii_net_cr"].rolling(20, min_periods=5).sum()
        combined["dii_net_5d"]  = combined["dii_net_cr"].rolling(5,  min_periods=1).sum()
        combined["dii_net_20d"] = combined["dii_net_cr"].rolling(20, min_periods=5).sum()
        combined["fiidii_net_5d"]  = combined["fii_net_5d"]  + combined["dii_net_5d"]
        combined["fiidii_net_20d"] = combined["fii_net_20d"] + combined["dii_net_20d"]
        combined.to_parquet(FIIDII_CACHE)
        log.info("FII/DII cache updated: %d rows, last=%s",
                 len(combined), combined.index.max().date())
        return combined
    elif not existing.empty:
        log.info("FII/DII: using cached data (%d rows)", len(existing))
        return existing

    log.warning("FII/DII: no data available (NSE API failed, cache empty)")
    return pd.DataFrame()


def fetch_yf(tickers, cache_file: Path, start: str = "2018-01-01") -> pd.DataFrame:
    """
    Fetch daily close for a macro series.
    Reliable non-Yahoo sources are tried FIRST; Yahoo Finance is the last resort
    (Yahoo blocks shared datacenter IPs like GitHub Actions runners).
    tickers: str or list[str] — first ticker determines which series this is.
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

    primary = tickers[0]
    df = pd.DataFrame()

    # ── Reliable sources first (work on CI without auth) ────────────────────
    if primary in ("^NSEI", "NIFTYBEES.NS"):
        log.info("Fetching Nifty via mfapi.in…")
        df = _fetch_nifty_via_mfapi(start)

    elif primary == "^INDIAVIX":
        # Primary: Yahoo Finance v8 raw API (SSL verify disabled — works on CI and macOS)
        log.info("Fetching India VIX via Yahoo Finance v8…")
        df = _fetch_vix_yahoo(start)
        # Fallback: cached parquet from last successful fetch (carry-forward — VIX never goes null)
        if df.empty and VIX_CACHE.exists():
            try:
                df = pd.read_parquet(VIX_CACHE)
                log.info("Using cached VIX parquet (%d rows, latest=%s)",
                         len(df), df.index.max().date() if not df.empty else "?")
            except Exception as e:
                log.warning("Failed to load VIX cache: %s", e)
        # Last resort: Kite API (requires KITE_ACCESS_TOKEN env var, expires daily)
        if df.empty:
            kite_token = os.environ.get("KITE_ACCESS_TOKEN")
            if kite_token:
                df = _fetch_vix_kite(start, kite_token)
        if df.empty:
            log.info("Fetching India VIX via NSE archive…")
            df = _fetch_vix_nse(start)

    elif primary in ("USDINR=X", "INR=X"):
        log.info("Fetching USD/INR via frankfurter.app…")
        df = _fetch_usdinr_frankfurter(start)

    elif primary in ("^TNX", "TLT"):
        log.info("Fetching US 10Y via FRED…")
        df = _fetch_us10y_fred(start)

    # ── Yahoo Finance as last-resort fallback ────────────────────────────────
    if df.empty:
        log.info("Primary source failed for %s — trying Yahoo Finance fallback…", primary)
        for ticker in tickers:
            try:
                df = _fetch_yahoo_direct(ticker, start)
                if not df.empty:
                    log.info("Yahoo fallback succeeded for %s via %s", primary, ticker)
                    break
                log.warning("Yahoo %s returned empty", ticker)
            except Exception as e:
                log.warning("Yahoo %s failed: %s", ticker, e)

    if not df.empty:
        df.to_parquet(cache_file)
        log.info("Cached %s: %d rows (%s → %s)",
                 primary, len(df), df.index.min().date(), df.index.max().date())
    else:
        log.error("All sources failed for %s", primary)

    return df


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
    log.info("Fetching macro series (mfapi/frankfurter/FRED primary, Yahoo fallback)…")
    nifty_df  = fetch_yf(TICKERS["nifty"],   NIFTY_CACHE)
    vix_df    = fetch_yf(TICKERS["vix"],     VIX_CACHE)
    usdinr_df = fetch_yf(TICKERS["usd_inr"], USDINR_CACHE)
    us10y_df  = fetch_yf(TICKERS["us_10y"],  US10Y_CACHE)
    log.info("Fetching FII/DII equity flows from NSE…")
    fetch_fiidii()   # update cache; stock feature extractor reads directly from parquet

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
    try:
        main()
    except SystemExit as e:
        os._exit(e.code if isinstance(e.code, int) else 1)
    except Exception:
        import traceback
        traceback.print_exc()
        os._exit(1)
    os._exit(0)
