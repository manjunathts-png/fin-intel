"""
Feature Engineering for MF Prediction
======================================

Pulls the curated MF universe (codes from backend/mf_universe.js), fetches NAV
history from mfapi.in for each scheme, and computes a ~30-dimensional feature
vector per fund per day. Writes to Supabase `mf_features` table.

Idempotent: re-running for the same as_of_date upserts in place.

Usage:
    python extract_features.py                      # today's features
    python extract_features.py --backfill 365       # backfill last 365 days
    python extract_features.py --as-of 2026-05-25   # specific date
    python extract_features.py --dry-run            # compute, don't write

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
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client
from tqdm import tqdm

# ─── Setup ────────────────────────────────────────────────────────────────────

load_dotenv()
load_dotenv(Path(__file__).parent.parent / "backend" / ".env", override=False)
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("extract_features")

ROOT = Path(__file__).parent.parent      # fin-intel/
UNIVERSE_JS = ROOT / "backend" / "mf_universe.js"
MFAPI_URL = "https://api.mfapi.in/mf/{code}"
RISK_FREE_RATE = 0.07                    # India 10Y G-Sec, rough proxy
TRADING_DAYS = 252


# ─── Universe loading (parses the JS file) ───────────────────────────────────

@dataclass
class Fund:
    code: str
    label: str
    category: str


def load_universe() -> list[Fund]:
    """Read backend/mf_universe.js and extract { code, label, category } entries.

    The JS file is a CommonJS module. We use a forgiving regex rather than a
    full JS parser since the file's structure is stable.
    """
    text = UNIVERSE_JS.read_text()
    funds: list[Fund] = []

    # Match: "Category Name": [ { code: "...", label: "..." }, ... ]
    cat_re = re.compile(r'"([^"]+)"\s*:\s*\[([^\]]*)\]', re.DOTALL)
    fund_re = re.compile(r'\{\s*code:\s*"([^"]+)"\s*,\s*label:\s*"([^"]+)"\s*\}')

    for cat_match in cat_re.finditer(text):
        category = cat_match.group(1)
        block = cat_match.group(2)
        for f_match in fund_re.finditer(block):
            funds.append(Fund(code=f_match.group(1), label=f_match.group(2), category=category))

    log.info("loaded %d funds across %d categories", len(funds), len({f.category for f in funds}))
    return funds


# ─── NAV fetcher with simple disk cache ──────────────────────────────────────

CACHE_DIR = Path(__file__).parent / ".cache_nav"
CACHE_DIR.mkdir(exist_ok=True)
NAV_CACHE_HOURS = 24


def fetch_nav_history(code: str, http: httpx.Client) -> pd.DataFrame:
    """Returns daily NAV DataFrame with columns: date (datetime64), nav (float).

    Uses disk cache to avoid hammering mfapi.in during iteration.
    """
    cache_file = CACHE_DIR / f"{code}.parquet"
    if cache_file.exists():
        age_h = (datetime.now().timestamp() - cache_file.stat().st_mtime) / 3600
        if age_h < NAV_CACHE_HOURS:
            return pd.read_parquet(cache_file)

    r = http.get(MFAPI_URL.format(code=code), timeout=20.0)
    r.raise_for_status()
    data = r.json()
    rows = []
    for d in data.get("data", []):
        m = re.match(r"^(\d{2})-(\d{2})-(\d{4})$", d.get("date", ""))
        if not m:
            continue
        try:
            nav = float(d["nav"])
        except (TypeError, ValueError):
            continue
        if nav <= 0:
            continue
        rows.append({"date": f"{m.group(3)}-{m.group(2)}-{m.group(1)}", "nav": nav})

    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").reset_index(drop=True)
    df.to_parquet(cache_file, index=False)
    return df


# ─── Feature computations ────────────────────────────────────────────────────

def nav_at_or_before(df: pd.DataFrame, target: pd.Timestamp) -> float | None:
    """Return the NAV on the latest date <= target, or None."""
    sub = df[df["date"] <= target]
    if sub.empty:
        return None
    return float(sub.iloc[-1]["nav"])


def pct_return(df: pd.DataFrame, as_of: pd.Timestamp, days: int) -> float | None:
    cur = nav_at_or_before(df, as_of)
    past = nav_at_or_before(df, as_of - timedelta(days=days))
    if cur is None or past is None or past <= 0:
        return None
    return (cur - past) / past * 100.0


def cagr(df: pd.DataFrame, as_of: pd.Timestamp, years: float) -> float | None:
    cur = nav_at_or_before(df, as_of)
    past = nav_at_or_before(df, as_of - timedelta(days=int(365.25 * years)))
    if cur is None or past is None or past <= 0:
        return None
    return ((cur / past) ** (1.0 / years) - 1.0) * 100.0


def daily_returns(df: pd.DataFrame, as_of: pd.Timestamp, days: int) -> pd.Series:
    sub = df[(df["date"] <= as_of) & (df["date"] > as_of - timedelta(days=days))]
    if len(sub) < 2:
        return pd.Series(dtype=float)
    return sub["nav"].pct_change().dropna()


def annualized_vol(daily_rets: pd.Series) -> float | None:
    if len(daily_rets) < 5:
        return None
    return float(daily_rets.std(ddof=1) * np.sqrt(TRADING_DAYS) * 100.0)


def max_drawdown(df: pd.DataFrame, as_of: pd.Timestamp, days: int) -> float | None:
    sub = df[(df["date"] <= as_of) & (df["date"] > as_of - timedelta(days=days))]
    if len(sub) < 2:
        return None
    nav = sub["nav"].values
    peak = np.maximum.accumulate(nav)
    dd = (nav - peak) / peak
    return float(dd.min() * 100.0)


def downside_dev(daily_rets: pd.Series) -> float | None:
    if len(daily_rets) < 5:
        return None
    neg = daily_rets[daily_rets < 0]
    if len(neg) < 2:
        return 0.0
    return float(neg.std(ddof=1) * np.sqrt(TRADING_DAYS) * 100.0)


def sharpe(ret_pct: float | None, vol_pct: float | None) -> float | None:
    if ret_pct is None or vol_pct is None or vol_pct == 0:
        return None
    rf_pct = RISK_FREE_RATE * 100
    return (ret_pct - rf_pct) / vol_pct


def sortino(ret_pct: float | None, downside_pct: float | None) -> float | None:
    if ret_pct is None or downside_pct is None or downside_pct == 0:
        return None
    rf_pct = RISK_FREE_RATE * 100
    return (ret_pct - rf_pct) / downside_pct


def z1w_score(df: pd.DataFrame, as_of: pd.Timestamp) -> float | None:
    """z-score of this week's return vs trailing 12-week weekly returns."""
    weekly_rets: list[float] = []
    for w in range(1, 13):
        cur = nav_at_or_before(df, as_of - timedelta(days=7 * (w - 1)))
        past = nav_at_or_before(df, as_of - timedelta(days=7 * w))
        if cur is None or past is None or past <= 0:
            continue
        weekly_rets.append((cur - past) / past * 100.0)
    if len(weekly_rets) < 4:
        return None
    arr = np.array(weekly_rets)
    if arr.std(ddof=1) == 0:
        return None
    current_ret = arr[0]
    mean = arr.mean()
    return float((current_ret - mean) / arr.std(ddof=1))


def positive_months(df: pd.DataFrame, as_of: pd.Timestamp) -> int | None:
    """Count of positive-return months in trailing 12 months."""
    count = 0
    valid = 0
    for m in range(12):
        end = as_of - timedelta(days=30 * m)
        start = end - timedelta(days=30)
        cur = nav_at_or_before(df, end)
        past = nav_at_or_before(df, start)
        if cur is None or past is None or past <= 0:
            continue
        valid += 1
        if cur > past:
            count += 1
    return count if valid >= 9 else None


# ─── Per-fund feature builder ────────────────────────────────────────────────

def build_fund_features(fund: Fund, df: pd.DataFrame, as_of: pd.Timestamp) -> dict[str, Any] | None:
    """Compute the per-fund feature row for a given as_of date."""
    if df is None or df.empty:
        return None
    if df["date"].max() < as_of - timedelta(days=14):
        # Stale data — fund probably wound down
        return None

    d30 = daily_returns(df, as_of, 30)
    d90 = daily_returns(df, as_of, 90)
    d365 = daily_returns(df, as_of, 365)

    ret1y = pct_return(df, as_of, 365)
    vol1y = annualized_vol(d365)

    feats: dict[str, Any] = {
        "scheme_code": fund.code,
        "as_of_date":  as_of.strftime("%Y-%m-%d"),
        "fund_name":   fund.label,
        "category":    fund.category,

        # Returns
        "ret1w":  pct_return(df, as_of, 7),
        "ret1m":  pct_return(df, as_of, 30),
        "ret3m":  pct_return(df, as_of, 90),
        "ret6m":  pct_return(df, as_of, 180),
        "ret1y":  ret1y,
        "ret3y":  pct_return(df, as_of, 365 * 3),
        "ret5y":  pct_return(df, as_of, 365 * 5),
        "cagr5y": cagr(df, as_of, 5),
        "cagr10y": cagr(df, as_of, 10),

        # Vol + risk
        "vol_30d": annualized_vol(d30),
        "vol_90d": annualized_vol(d90),
        "vol_1y":  vol1y,
        "max_dd_1y": max_drawdown(df, as_of, 365),
        "downside_dev_1y": downside_dev(d365),
        "sharpe_1y": sharpe(ret1y, vol1y),
        "sortino_1y": sortino(ret1y, downside_dev(d365)),

        # Momentum z
        "z1w": z1w_score(df, as_of),

        # Style
        "positive_months_12m": positive_months(df, as_of),
    }
    return feats


# ─── Cross-sectional features (need full cohort) ─────────────────────────────

def add_cross_sectional(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Add category_rank_*, universe_rank_*, cat_z, and category momentum features."""
    if not rows:
        return rows
    df = pd.DataFrame(rows)

    # Universe-wide ranks (0 to 1, higher = better)
    for col, dest in [("ret1m", "univ_rank_1m"), ("ret3m", "univ_rank_3m"), ("ret1y", "univ_rank_1y")]:
        if col in df:
            df[dest] = df[col].rank(pct=True)

    # Category-relative ranks + cat-z
    for col, dest in [("ret1m", "cat_rank_1m"), ("ret3m", "cat_rank_3m"), ("ret1y", "cat_rank_1y")]:
        if col in df:
            df[dest] = df.groupby("category")[col].rank(pct=True)

    # Category z = z-score of fund's z1w within its category
    if "z1w" in df:
        df["cat_z"] = df.groupby("category")["z1w"].transform(
            lambda x: (x - x.mean()) / (x.std(ddof=1) if x.std(ddof=1) > 0 else 1.0)
        )

    # Cross-category momentum: how is this category doing vs all other categories?
    # cat_momentum_3m = median ret3m of all funds in the same category (shared signal)
    # cat_vs_univ_3m  = percentile rank of that category median vs all category medians
    if "ret3m" in df.columns:
        cat_median = df.groupby("category")["ret3m"].transform("median")
        df["cat_momentum_3m"] = cat_median
        # Per-category medians (one value per category)
        cat_medians = df.groupby("category")["ret3m"].median()
        n_cats = len(cat_medians)
        if n_cats > 1:
            cat_pct = cat_medians.rank(pct=True)
            df["cat_vs_univ_3m"] = df["category"].map(cat_pct)
        else:
            df["cat_vs_univ_3m"] = 0.5

    # ── Category-relative risk z-scores ──────────────────────────────────────
    # A -25% max drawdown in Small Cap is normal; in Large Cap it's extreme.
    # Absolute risk features give the model the same value for both.
    # Within-category z-scores fix this: the model now sees "how much riskier
    # than category peers" rather than raw numbers, directly reducing high-beta
    # bias (where the model was rewarding drawdown-recovery regardless of category).
    #
    # cat_rel_max_dd_1y  < 0 = safer than category peers (positive signal)
    # cat_rel_vol_1y     < 0 = less volatile than peers  (positive signal)
    # cat_rel_sharpe_1y  > 0 = better risk-adj return than peers (positive)
    def _cat_zscore(series: pd.Series) -> pd.Series:
        """Within-category z-score. NaN members use 0.0 (neutral)."""
        def _zscore_group(x: pd.Series) -> pd.Series:
            valid = x.dropna()
            if len(valid) < 2:
                return pd.Series(0.0, index=x.index)
            std = valid.std(ddof=1)
            if std == 0:
                return pd.Series(0.0, index=x.index)
            return (x - valid.mean()) / std
        return df.groupby("category")[series.name].transform(_zscore_group).fillna(0.0)

    for raw_col, rel_col in [
        ("max_dd_1y",       "cat_rel_max_dd_1y"),
        ("vol_1y",          "cat_rel_vol_1y"),
        ("sharpe_1y",       "cat_rel_sharpe_1y"),
        ("downside_dev_1y", "cat_rel_downside_dev"),
    ]:
        if raw_col in df.columns:
            df[rel_col] = _cat_zscore(df[raw_col])

    return df.to_dict("records")


# ─── Supabase writer ─────────────────────────────────────────────────────────

_INTEGER_COLS = {"positive_months_12m"}  # DB INTEGER columns that pandas promotes to float64


def _clean_val(k: str, v) -> Any:
    """Convert numpy/pandas scalars to JSON-safe Python types."""
    # numpy scalar → Python native first
    if hasattr(v, "item"):
        v = v.item()
    if isinstance(v, float):
        if np.isnan(v):
            return None
        # Postgres INTEGER columns can't accept "6.0" — cast whole-number floats
        if k in _INTEGER_COLS and v == int(v):
            return int(v)
    return v


def upsert_features(supabase, rows: list[dict[str, Any]], batch: int = 500) -> int:
    """Upsert feature rows with retry logic for transient Supabase/Cloudflare errors.

    Supabase occasionally returns HTTP 500 / Cloudflare 1101 'Worker threw exception'
    under load. Retrying with exponential back-off recovers from these without losing
    the whole batch.
    """
    if not rows:
        return 0
    total = 0
    cleaned = [
        {k: _clean_val(k, v) for k, v in row.items()}
        for row in rows
    ]

    for i in range(0, len(cleaned), batch):
        chunk = cleaned[i : i + batch]
        last_exc: Exception | None = None
        for attempt in range(4):          # up to 4 attempts: 0, 5, 15, 45 s
            try:
                supabase.table("mf_features").upsert(
                    chunk, on_conflict="scheme_code,as_of_date"
                ).execute()
                total += len(chunk)
                last_exc = None
                break
            except Exception as exc:
                last_exc = exc
                wait = 5 * (3 ** attempt)   # 5, 15, 45 s
                log.warning(
                    "Supabase upsert failed (attempt %d/4): %s — retrying in %ds",
                    attempt + 1, str(exc)[:120], wait,
                )
                import time as _time; _time.sleep(wait)
        if last_exc is not None:
            raise RuntimeError(
                f"Supabase upsert failed after 4 attempts: {last_exc}"
            ) from last_exc
    return total


# ─── Main ────────────────────────────────────────────────────────────────────

def _fetch_and_build(fund: Fund, http: httpx.Client, as_of: pd.Timestamp) -> dict[str, Any] | None:
    """Fetch NAV and compute features for one fund. Used by thread pool."""
    nav = fetch_nav_history(fund.code, http)
    return build_fund_features(fund, nav, as_of)


def run_for_date(
    funds: list[Fund],
    http: httpx.Client,
    as_of: pd.Timestamp,
    workers: int = 8,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_fetch_and_build, fund, http, as_of): fund for fund in funds}
        for future in tqdm(as_completed(futures), total=len(futures),
                           desc=f"features {as_of.date()}", leave=False):
            fund = futures[future]
            try:
                feats = future.result()
                if feats:
                    rows.append(feats)
            except Exception as e:
                log.warning("scheme %s (%s): %s", fund.code, fund.label, e)
    return add_cross_sectional(rows)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--as-of", type=str, default=None, help="YYYY-MM-DD (default: today)")
    p.add_argument("--backfill", type=int, default=0, help="N days to backfill (e.g. 365)")
    p.add_argument("--dry-run", action="store_true", help="Compute but don't write to Supabase")
    p.add_argument("--workers", type=int, default=8,
                   help="Parallel NAV fetch threads per date (default: 8)")
    args = p.parse_args()

    funds = load_universe()
    if not funds:
        log.error("No funds loaded from universe")
        sys.exit(1)

    if args.as_of:
        as_of_end = pd.Timestamp(args.as_of)
    else:
        as_of_end = pd.Timestamp.now().normalize()

    if args.backfill > 0:
        dates = [as_of_end - timedelta(days=d) for d in range(args.backfill)]
    else:
        dates = [as_of_end]

    # Skip weekends (no NAV anyway)
    dates = [d for d in dates if d.dayofweek < 5]

    log.info("Computing features for %d date(s), %d funds", len(dates), len(funds))

    supabase = None
    if not args.dry_run:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_KEY"]
        supabase = create_client(url, key)

    log.info("Using %d parallel NAV fetch workers", args.workers)
    with httpx.Client(headers={"User-Agent": "fin-intel-ml/0.1"}) as http:
        total_written = 0
        for as_of in tqdm(dates, desc="dates"):
            rows = run_for_date(funds, http, as_of, workers=args.workers)
            if args.dry_run:
                log.info("dry-run: would write %d rows for %s", len(rows), as_of.date())
                if as_of == dates[0]:
                    log.info("sample row: %s", json.dumps(rows[0] if rows else {}, default=str, indent=2)[:500])
            else:
                written = upsert_features(supabase, rows)
                total_written += written
                log.info("%s: wrote %d feature rows", as_of.date(), written)

    log.info("Done. Total rows written: %d", total_written)


if __name__ == "__main__":
    from script_runner import run
    run(main)
