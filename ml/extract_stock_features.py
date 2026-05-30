"""
Stock Feature Engineering
=========================

Pulls the curated stock universe (symbols from backend/stock_universe.js),
fetches OHLCV history from Yahoo Finance chart API v8, and computes a
~40-dimensional feature vector per stock per day.

Features include:
  - Price returns (ret1w/1m/3m/6m/1y)
  - Risk metrics (vol_30/90d/1y, max_dd, downside_dev, sharpe, sortino)
  - Technical indicators (RSI-14, MACD histogram, Bollinger %B, volume ratio,
    52-week high proximity)
  - Cross-sectional ranks within sector + full universe
  - Style vs Nifty (beta, alpha, correlation)
  - Fundamentals snapshot (P/E, P/B, ROE, growth, margins)
  - Macro context (Nifty ret, VIX, USD/INR, US 10Y — reused from macro cache)

Usage:
    python extract_stock_features.py                    # today only
    python extract_stock_features.py --backfill 730     # 2-year backfill
    python extract_stock_features.py --as-of 2026-05-25
    python extract_stock_features.py --dry-run

Env:
    SUPABASE_URL
    SUPABASE_SERVICE_KEY
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

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
log = logging.getLogger("extract_stock_features")

ROOT          = Path(__file__).parent.parent
UNIVERSE_JS   = ROOT / "backend" / "stock_universe.js"
CACHE_DIR     = Path(__file__).parent / ".cache_stock"
FUND_CACHE_DIR = Path(__file__).parent / ".cache_fundamentals"
MACRO_CACHE   = Path(__file__).parent / ".cache_macro"
CACHE_DIR.mkdir(exist_ok=True)
FUND_CACHE_DIR.mkdir(exist_ok=True)

STOCK_CACHE_HOURS = 24
FUND_CACHE_HOURS  = 24
TRADING_DAYS      = 252
RISK_FREE_RATE    = 0.07

_YF_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}
_YF_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
_YF_SUMMARY_URL = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/{ticker}"

_SESSION: requests.Session | None = None


def _get_session() -> requests.Session:
    global _SESSION
    if _SESSION is None:
        _SESSION = requests.Session()
        _SESSION.verify = False      # LibreSSL workaround on macOS
        _SESSION.headers.update(_YF_HEADERS)
        try:
            _SESSION.get("https://fc.yahoo.com", timeout=10, allow_redirects=True)
        except Exception:
            pass
    return _SESSION


# ─── Universe loading ─────────────────────────────────────────────────────────

@dataclass
class Stock:
    symbol: str    # NSE ticker without .NS suffix, e.g. "TCS"
    label: str
    sector: str


def load_universe() -> list[Stock]:
    """Parse backend/stock_universe.js to extract {symbol, label, sector}."""
    text = UNIVERSE_JS.read_text()
    stocks: list[Stock] = []

    # "Sector Name": [ { symbol: "TCS.NS", label: "TCS" }, ... ]
    sec_re  = re.compile(r'"([^"]+)"\s*:\s*\[([^\]]*)\]', re.DOTALL)
    stk_re  = re.compile(r'\{\s*symbol:\s*"([^"]+)"\s*,\s*label:\s*"([^"]+)"\s*\}')

    for sec_match in sec_re.finditer(text):
        sector = sec_match.group(1)
        block  = sec_match.group(2)
        for s_match in stk_re.finditer(block):
            raw_sym = s_match.group(1)
            label   = s_match.group(2)
            # Strip .NS — we store bare symbol, append .NS only for Yahoo calls
            symbol  = raw_sym.replace(".NS", "").replace(".BO", "")
            stocks.append(Stock(symbol=symbol, label=label, sector=sector))

    log.info("Loaded %d stocks across %d sectors", len(stocks), len({s.sector for s in stocks}))
    return stocks


# ─── OHLCV fetcher with disk cache ───────────────────────────────────────────

def fetch_ohlcv(symbol: str, start: str = "2022-01-01") -> pd.DataFrame:
    """
    Fetch daily OHLCV from Yahoo Finance chart API v8.
    Returns DataFrame with columns: date (DatetimeIndex), open, high, low, close, volume.
    Caches to .cache_stock/<SYMBOL>.parquet (24h TTL).
    """
    cache_file = CACHE_DIR / f"{symbol}.parquet"
    if cache_file.exists():
        age_h = (datetime.now().timestamp() - cache_file.stat().st_mtime) / 3600
        if age_h < STOCK_CACHE_HOURS:
            df = pd.read_parquet(cache_file)
            df.index = pd.to_datetime(df.index)
            return df

    ticker = f"{symbol}.NS"
    start_ts = int(pd.Timestamp(start).timestamp())
    end_ts   = int(pd.Timestamp.now().timestamp()) + 86400
    params   = {"interval": "1d", "period1": start_ts, "period2": end_ts,
                 "events": "history", "includePrePost": "false"}
    url      = _YF_CHART_URL.format(ticker=ticker)
    session  = _get_session()

    for attempt in range(2):
        try:
            r = session.get(url, params=params, timeout=20)
            if r.status_code == 429:
                if attempt == 0:
                    time.sleep(6)
                    continue
                log.debug("%s rate-limited — giving up", symbol)
                return pd.DataFrame()
            if r.status_code != 200:
                log.debug("%s HTTP %d", symbol, r.status_code)
                return pd.DataFrame()

            data   = r.json()
            result = data.get("chart", {}).get("result")
            if not result:
                return pd.DataFrame()

            meta       = result[0]
            timestamps = meta.get("timestamp", [])
            quote      = meta.get("indicators", {}).get("quote", [{}])[0]
            adj_closes = (
                meta.get("indicators", {}).get("adjclose", [{}])[0].get("adjclose")
            )
            closes = adj_closes or quote.get("close", [])
            opens  = quote.get("open",   [])
            highs  = quote.get("high",   [])
            lows   = quote.get("low",    [])
            vols   = quote.get("volume", [])

            if not timestamps or not closes:
                return pd.DataFrame()

            idx = pd.to_datetime(timestamps, unit="s").tz_localize(None)
            df  = pd.DataFrame({
                "open":   opens  if opens  else [None] * len(timestamps),
                "high":   highs  if highs  else [None] * len(timestamps),
                "low":    lows   if lows   else [None] * len(timestamps),
                "close":  closes,
                "volume": vols   if vols   else [None] * len(timestamps),
            }, index=idx)
            df = df.dropna(subset=["close"]).sort_index()
            df = df[df["close"] > 0]
            if not df.empty:
                df.to_parquet(cache_file)
            return df

        except requests.exceptions.RequestException as e:
            log.debug("%s fetch error (attempt %d): %s", symbol, attempt + 1, e)
            time.sleep(4)

    return pd.DataFrame()


# ─── Fundamentals fetcher with disk cache ────────────────────────────────────

def fetch_fundamentals(symbol: str) -> dict[str, Any]:
    """
    Fetch current fundamental data from Yahoo Finance quoteSummary.
    Caches to .cache_fundamentals/<SYMBOL>.json (24h TTL).

    Note: fundamentals are point-in-time (today's values used for all
    historical feature rows). This is a known approximation for v1.
    """
    cache_file = FUND_CACHE_DIR / f"{symbol}.json"
    if cache_file.exists():
        age_h = (datetime.now().timestamp() - cache_file.stat().st_mtime) / 3600
        if age_h < FUND_CACHE_HOURS:
            try:
                return json.loads(cache_file.read_text())
            except Exception:
                pass

    ticker  = f"{symbol}.NS"
    url     = _YF_SUMMARY_URL.format(ticker=ticker)
    params  = {
        "modules": "summaryDetail,financialData,defaultKeyStatistics,assetProfile,price"
    }
    session = _get_session()

    try:
        r = session.get(url, params=params, timeout=15)
        if r.status_code == 429:
            time.sleep(5)
            r = session.get(url, params=params, timeout=15)
        if r.status_code != 200:
            return {}

        data    = r.json()
        results = data.get("quoteSummary", {}).get("result")
        if not results:
            return {}

        qr  = results[0]
        sd  = qr.get("summaryDetail",        {})
        fd  = qr.get("financialData",         {})
        ks  = qr.get("defaultKeyStatistics",  {})
        pr  = qr.get("price",                 {})

        def rv(d: dict, k: str, scale: float = 1.0) -> float | None:
            v = d.get(k)
            if isinstance(v, dict):
                v = v.get("raw")
            if v is None:
                return None
            try:
                return round(float(v) * scale, 4)
            except (TypeError, ValueError):
                return None

        fundamentals = {
            "pe_ratio":        rv(sd, "trailingPE"),
            "pb_ratio":        rv(ks, "priceToBook"),
            "roe":             rv(fd, "returnOnEquity",  100.0),
            "revenue_growth":  rv(fd, "revenueGrowth",   100.0),
            "earnings_growth": rv(fd, "earningsGrowth",  100.0),
            "profit_margins":  rv(fd, "profitMargins",   100.0),
            "debt_to_equity":  rv(fd, "debtToEquity"),
            "dividend_yield":  rv(sd, "dividendYield",   100.0),
        }
        cache_file.write_text(json.dumps(fundamentals))
        return fundamentals

    except Exception as e:
        log.debug("Fundamentals failed for %s: %s", symbol, e)
        return {}


# ─── Macro cache reader ───────────────────────────────────────────────────────

def _load_macro_cache(filename: str) -> pd.DataFrame:
    """Load a macro parquet from .cache_macro/. Returns empty DF if missing."""
    path = MACRO_CACHE / filename
    if not path.exists():
        return pd.DataFrame()
    try:
        df = pd.read_parquet(path)
        df.index = pd.to_datetime(df.index)
        return df
    except Exception:
        return pd.DataFrame()


def _val_at_or_before(df: pd.DataFrame, target: pd.Timestamp) -> float | None:
    if df.empty or "close" not in df.columns:
        return None
    try:
        sub = df[df.index <= target]
    except TypeError:
        return None
    if sub.empty:
        return None
    return float(sub["close"].iloc[-1])


def load_macro_series() -> dict[str, pd.DataFrame]:
    """Load all macro caches once, return as a dict."""
    return {
        "nifty":   _load_macro_cache("nifty_daily.parquet"),
        "vix":     _load_macro_cache("vix_daily.parquet"),
        "usdinr":  _load_macro_cache("usdinr_daily.parquet"),
        "us10y":   _load_macro_cache("us10y_daily.parquet"),
    }


def get_macro_row(macro: dict[str, pd.DataFrame], as_of: pd.Timestamp) -> dict[str, Any]:
    """Return macro feature values for a given date."""
    nifty  = macro["nifty"]
    nifty1m  = None
    nifty3m  = None
    if not nifty.empty:
        cur = _val_at_or_before(nifty, as_of)
        p1m = _val_at_or_before(nifty, as_of - timedelta(days=30))
        p3m = _val_at_or_before(nifty, as_of - timedelta(days=90))
        if cur and p1m and p1m > 0:
            nifty1m = round((cur - p1m) / p1m * 100, 4)
        if cur and p3m and p3m > 0:
            nifty3m = round((cur - p3m) / p3m * 100, 4)

    return {
        "nifty_ret1m": nifty1m,
        "nifty_ret3m": nifty3m,
        "india_vix":   _val_at_or_before(macro["vix"],    as_of),
        "usd_inr":     _val_at_or_before(macro["usdinr"], as_of),
        "us_10y_yield":_val_at_or_before(macro["us10y"],  as_of),
    }


# ─── Technical indicator helpers ─────────────────────────────────────────────

def _closes_at(df: pd.DataFrame, as_of: pd.Timestamp, days: int = 400) -> np.ndarray:
    """Return close prices from (as_of - days) to as_of, inclusive."""
    sub = df[(df.index <= as_of) & (df.index > as_of - timedelta(days=days))]
    return sub["close"].dropna().values.astype(float)


def _ema(prices: np.ndarray, n: int) -> np.ndarray:
    k = 2.0 / (n + 1)
    out = np.empty(len(prices))
    out[0] = prices[0]
    for i in range(1, len(prices)):
        out[i] = prices[i] * k + out[i - 1] * (1.0 - k)
    return out


def rsi14(closes: np.ndarray) -> float | None:
    if len(closes) < 15:
        return None
    c = closes[-min(200, len(closes)):]
    deltas = np.diff(c)
    gains  = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    # Initial 14-period average
    ag, al = gains[:14].mean(), losses[:14].mean()
    # Wilder's smoothing over the rest
    for g, l in zip(gains[14:], losses[14:]):
        ag = (ag * 13 + g) / 14
        al = (al * 13 + l) / 14
    if al == 0:
        return 100.0
    return float(100.0 - 100.0 / (1.0 + ag / al))


def macd_histogram(closes: np.ndarray) -> float | None:
    if len(closes) < 35:
        return None
    ema12 = _ema(closes, 12)
    ema26 = _ema(closes, 26)
    macd  = ema12 - ema26
    if len(macd) < 9:
        return None
    signal = _ema(macd, 9)
    return float(macd[-1] - signal[-1])


def bollinger_pct(closes: np.ndarray, n: int = 20) -> float | None:
    if len(closes) < n:
        return None
    window = closes[-n:]
    m  = window.mean()
    s  = window.std(ddof=1)
    if s == 0:
        return 0.5
    upper = m + 2 * s
    lower = m - 2 * s
    if upper == lower:
        return 0.5
    return float(np.clip((closes[-1] - lower) / (upper - lower), -0.5, 1.5))


def volume_ratio(df: pd.DataFrame, as_of: pd.Timestamp) -> float | None:
    """Today's volume / trailing 20-day average volume."""
    if "volume" not in df.columns:
        return None
    sub = df[df.index <= as_of]
    if len(sub) < 22:
        return None
    today_vol = sub["volume"].iloc[-1]
    avg20     = sub["volume"].iloc[-21:-1].replace(0, np.nan).mean()
    if avg20 is None or np.isnan(avg20) or avg20 == 0:
        return None
    return float(round(today_vol / avg20, 4))


def high52w_proximity(df: pd.DataFrame, as_of: pd.Timestamp) -> float | None:
    """% below 52-week high (0 = at the high, negative = below it)."""
    sub = df[(df.index <= as_of) & (df.index > as_of - timedelta(days=365))]
    if sub.empty or "high" not in sub.columns:
        return None
    cur = df[df.index <= as_of]["close"]
    if cur.empty:
        return None
    h52 = sub["high"].max()
    if h52 <= 0:
        return None
    latest = float(cur.iloc[-1])
    return float(round((latest - h52) / h52 * 100.0, 4))


# ─── Price-based stats ────────────────────────────────────────────────────────

def price_at(df: pd.DataFrame, as_of: pd.Timestamp) -> float | None:
    sub = df[df.index <= as_of]["close"]
    return float(sub.iloc[-1]) if not sub.empty else None


def pct_ret(df: pd.DataFrame, as_of: pd.Timestamp, days: int) -> float | None:
    cur  = price_at(df, as_of)
    past = price_at(df, as_of - timedelta(days=days))
    if cur is None or past is None or past <= 0:
        return None
    return round((cur - past) / past * 100.0, 4)


def daily_rets_arr(df: pd.DataFrame, as_of: pd.Timestamp, days: int) -> np.ndarray:
    sub = df[(df.index <= as_of) & (df.index > as_of - timedelta(days=days))]["close"]
    if len(sub) < 2:
        return np.array([])
    return sub.pct_change().dropna().values.astype(float)


def annualized_vol(rets: np.ndarray) -> float | None:
    if len(rets) < 5:
        return None
    return float(round(rets.std(ddof=1) * np.sqrt(TRADING_DAYS) * 100.0, 4))


def max_dd(df: pd.DataFrame, as_of: pd.Timestamp, days: int) -> float | None:
    sub = df[(df.index <= as_of) & (df.index > as_of - timedelta(days=days))]["close"]
    if len(sub) < 2:
        return None
    prices = sub.values.astype(float)
    peak   = np.maximum.accumulate(prices)
    return float(round((prices - peak).min() / peak.max() * 100.0, 4))


def downside_dev(rets: np.ndarray) -> float | None:
    if len(rets) < 5:
        return None
    neg = rets[rets < 0]
    if len(neg) < 2:
        return 0.0
    return float(round(neg.std(ddof=1) * np.sqrt(TRADING_DAYS) * 100.0, 4))


def sharpe(ret1y: float | None, vol1y: float | None) -> float | None:
    if ret1y is None or vol1y is None or vol1y == 0:
        return None
    return round((ret1y - RISK_FREE_RATE * 100) / vol1y, 4)


def sortino(ret1y: float | None, dd1y: float | None) -> float | None:
    if ret1y is None or dd1y is None or dd1y == 0:
        return None
    return round((ret1y - RISK_FREE_RATE * 100) / dd1y, 4)


def z1w_score(df: pd.DataFrame, as_of: pd.Timestamp) -> float | None:
    weekly: list[float] = []
    for w in range(1, 13):
        cur  = price_at(df, as_of - timedelta(days=7 * (w - 1)))
        past = price_at(df, as_of - timedelta(days=7 * w))
        if cur is None or past is None or past <= 0:
            continue
        weekly.append((cur - past) / past * 100.0)
    if len(weekly) < 4:
        return None
    arr = np.array(weekly)
    std = arr.std(ddof=1)
    if std == 0:
        return None
    return float(round((arr[0] - arr.mean()) / std, 4))


def positive_months(df: pd.DataFrame, as_of: pd.Timestamp) -> int | None:
    count, valid = 0, 0
    for m in range(12):
        end   = as_of - timedelta(days=30 * m)
        start = end   - timedelta(days=30)
        cur  = price_at(df, end)
        past = price_at(df, start)
        if cur is None or past is None or past <= 0:
            continue
        valid += 1
        if cur > past:
            count += 1
    return count if valid >= 9 else None


# ─── Beta / alpha / corr vs Nifty ────────────────────────────────────────────

def beta_alpha_corr(
    stock_df: pd.DataFrame,
    nifty_df: pd.DataFrame,
    as_of: pd.Timestamp,
    days: int = 365,
) -> tuple[float | None, float | None, float | None]:
    if nifty_df.empty:
        return None, None, None
    start = as_of - timedelta(days=days)
    s_sub = stock_df[(stock_df.index > start) & (stock_df.index <= as_of)]["close"]
    n_sub = nifty_df[(nifty_df.index > start) & (nifty_df.index <= as_of)]["close"]
    merged = pd.concat([s_sub.rename("stock"), n_sub.rename("nifty")], axis=1).dropna()
    if len(merged) < 30:
        return None, None, None
    sr = merged["stock"].pct_change().dropna()
    nr = merged["nifty"].pct_change().dropna()
    merged2 = pd.concat([sr, nr], axis=1).dropna()
    if len(merged2) < 20 or merged2.std().min() == 0:
        return None, None, None
    sr2 = merged2["stock"].values
    nr2 = merged2["nifty"].values
    corr = float(np.corrcoef(sr2, nr2)[0, 1])
    var_n = float(nr2.var())
    if var_n == 0:
        return None, None, None
    beta  = float(np.cov(sr2, nr2)[0, 1] / var_n)
    alpha = float((sr2.mean() - beta * nr2.mean()) * TRADING_DAYS * 100)
    return round(beta, 4), round(alpha, 4), round(corr, 4)


# ─── Per-stock feature builder ────────────────────────────────────────────────

def build_stock_features(
    stock: Stock,
    ohlcv: pd.DataFrame,
    fundamentals: dict[str, Any],
    macro: dict[str, pd.DataFrame],
    as_of: pd.Timestamp,
) -> dict[str, Any] | None:
    if ohlcv is None or ohlcv.empty:
        return None
    # Require data within 14 days of as_of
    if ohlcv.index.max() < as_of - timedelta(days=14):
        return None

    d30  = daily_rets_arr(ohlcv, as_of, 30)
    d90  = daily_rets_arr(ohlcv, as_of, 90)
    d365 = daily_rets_arr(ohlcv, as_of, 365)

    ret1y  = pct_ret(ohlcv, as_of, 365)
    vol1y  = annualized_vol(d365)
    dd1y   = downside_dev(d365)

    # Technical: need close array up to as_of
    c400 = _closes_at(ohlcv, as_of, days=400)

    nifty_df = macro.get("nifty", pd.DataFrame())
    b, a, c  = beta_alpha_corr(ohlcv, nifty_df, as_of)
    macro_row = get_macro_row(macro, as_of)

    feats: dict[str, Any] = {
        "symbol":     stock.symbol,
        "as_of_date": as_of.strftime("%Y-%m-%d"),
        "stock_name": stock.label,
        "sector":     stock.sector,

        # Returns
        "ret1w": pct_ret(ohlcv, as_of, 7),
        "ret1m": pct_ret(ohlcv, as_of, 30),
        "ret3m": pct_ret(ohlcv, as_of, 90),
        "ret6m": pct_ret(ohlcv, as_of, 180),
        "ret1y": ret1y,

        # Risk
        "vol_30d":        annualized_vol(d30),
        "vol_90d":        annualized_vol(d90),
        "vol_1y":         vol1y,
        "max_dd_1y":      max_dd(ohlcv, as_of, 365),
        "downside_dev_1y": dd1y,
        "sharpe_1y":      sharpe(ret1y, vol1y),
        "sortino_1y":     sortino(ret1y, dd1y),

        # Technical
        "rsi_14":     rsi14(c400),
        "macd_hist":  macd_histogram(c400),
        "bb_pct":     bollinger_pct(c400),
        "vol_ratio":  volume_ratio(ohlcv, as_of),
        "high52w_pct": high52w_proximity(ohlcv, as_of),

        # Momentum
        "z1w":               z1w_score(ohlcv, as_of),
        "positive_months_12m": positive_months(ohlcv, as_of),

        # Beta / alpha / corr
        "beta_nifty":  b,
        "alpha_nifty": a,
        "corr_nifty":  c,

        # Fundamentals (snapshot)
        **{k: fundamentals.get(k) for k in (
            "pe_ratio", "pb_ratio", "roe",
            "revenue_growth", "earnings_growth", "profit_margins",
            "debt_to_equity", "dividend_yield",
        )},

        # Macro
        **macro_row,
    }
    return feats


# ─── Cross-sectional features ─────────────────────────────────────────────────

def add_cross_sectional(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not rows:
        return rows
    df = pd.DataFrame(rows)

    # Universe-wide percentile ranks
    for col, dest in [("ret1m", "univ_rank_1m"), ("ret3m", "univ_rank_3m"), ("ret1y", "univ_rank_1y")]:
        if col in df:
            df[dest] = df[col].rank(pct=True)

    # Sector-relative percentile ranks
    for col, dest in [("ret1m", "sector_rank_1m"), ("ret3m", "sector_rank_3m"), ("ret1y", "sector_rank_1y")]:
        if col in df:
            df[dest] = df.groupby("sector")[col].rank(pct=True)

    # Sector z-score of z1w (momentum conviction within sector)
    if "z1w" in df:
        df["sector_z"] = df.groupby("sector")["z1w"].transform(
            lambda x: (x - x.mean()) / (x.std(ddof=1) if x.std(ddof=1) > 0 else 1.0)
        )

    return df.to_dict("records")


# ─── Supabase writer ─────────────────────────────────────────────────────────

_INTEGER_COLS = {"positive_months_12m"}


def _clean_val(k: str, v: Any) -> Any:
    if hasattr(v, "item"):
        v = v.item()
    if isinstance(v, float):
        if np.isnan(v):
            return None
        if k in _INTEGER_COLS and v == int(v):
            return int(v)
    return v


def upsert_features(supabase, rows: list[dict[str, Any]], batch: int = 300) -> int:
    if not rows:
        return 0
    total   = 0
    cleaned = [{k: _clean_val(k, v) for k, v in row.items()} for row in rows]
    for i in range(0, len(cleaned), batch):
        chunk = cleaned[i : i + batch]
        supabase.table("stock_features").upsert(
            chunk, on_conflict="symbol,as_of_date"
        ).execute()
        total += len(chunk)
    return total


# ─── Main ─────────────────────────────────────────────────────────────────────

def _process_stock(stock: Stock, ohlcv_map: dict, fund_map: dict, macro: dict,
                   as_of: pd.Timestamp) -> dict[str, Any] | None:
    ohlcv  = ohlcv_map.get(stock.symbol, pd.DataFrame())
    fundam = fund_map.get(stock.symbol, {})
    return build_stock_features(stock, ohlcv, fundam, macro, as_of)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--as-of",    type=str, default=None,
                   help="YYYY-MM-DD (default: today)")
    p.add_argument("--backfill", type=int, default=0,
                   help="N days to backfill (e.g. 730 for 2 years)")
    p.add_argument("--dry-run",  action="store_true",
                   help="Compute but don't write to Supabase")
    p.add_argument("--workers",  type=int, default=4,
                   help="Yahoo fetch threads for OHLCV (default 4)")
    args = p.parse_args()

    stocks = load_universe()
    if not stocks:
        log.error("No stocks loaded"); sys.exit(1)

    as_of_end = pd.Timestamp(args.as_of) if args.as_of else pd.Timestamp.now().normalize()

    if args.backfill > 0:
        dates = [as_of_end - timedelta(days=d) for d in range(args.backfill)]
    else:
        dates = [as_of_end]
    dates = [d for d in dates if d.dayofweek < 5]  # skip weekends

    log.info("Dates: %d  Stocks: %d  Workers: %d", len(dates), len(stocks), args.workers)

    # ── Fetch all OHLCV once (reuse cache across dates) ──────────────────────
    log.info("Warming OHLCV cache for %d stocks…", len(stocks))
    ohlcv_map: dict[str, pd.DataFrame] = {}
    start_date = (as_of_end - timedelta(days=max(args.backfill + 400, 400))).strftime("%Y-%m-%d")

    def _fetch_one(s: Stock) -> tuple[str, pd.DataFrame]:
        return s.symbol, fetch_ohlcv(s.symbol, start=start_date)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for sym, df in tqdm(
            pool.map(_fetch_one, stocks), total=len(stocks), desc="OHLCV"
        ):
            ohlcv_map[sym] = df
    ok = sum(1 for df in ohlcv_map.values() if not df.empty)
    log.info("OHLCV ready: %d/%d stocks have data", ok, len(stocks))

    # ── Fetch fundamentals once ───────────────────────────────────────────────
    log.info("Warming fundamentals cache…")
    fund_map: dict[str, dict] = {}

    def _fetch_fund(s: Stock) -> tuple[str, dict]:
        return s.symbol, fetch_fundamentals(s.symbol)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for sym, fd in tqdm(
            pool.map(_fetch_fund, stocks), total=len(stocks), desc="Fundamentals"
        ):
            fund_map[sym] = fd

    # ── Load macro cache once ─────────────────────────────────────────────────
    macro = load_macro_series()
    if macro["nifty"].empty:
        log.warning(
            "Nifty macro cache missing — run macro_features.py first. "
            "Continuing without macro features."
        )

    # ── Connect to Supabase ───────────────────────────────────────────────────
    supabase = None
    if not args.dry_run:
        supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

    # ── Iterate over dates ────────────────────────────────────────────────────
    total_written = 0
    for as_of in tqdm(dates, desc="dates"):
        rows = []
        for stock in stocks:
            try:
                row = _process_stock(stock, ohlcv_map, fund_map, macro, as_of)
                if row:
                    rows.append(row)
            except Exception as e:
                log.warning("  %s %s: %s", stock.symbol, as_of.date(), e)

        rows = add_cross_sectional(rows)

        if args.dry_run:
            log.info("dry-run %s: %d rows", as_of.date(), len(rows))
            if as_of == dates[0] and rows:
                log.info("sample: %s", {k: v for k, v in list(rows[0].items())[:10]})
        else:
            written = upsert_features(supabase, rows)
            total_written += written
            log.info("%s: wrote %d feature rows", as_of.date(), written)

    log.info("Done. Total rows written: %d", total_written)


if __name__ == "__main__":
    main()
