"""Same-run disk cache for expensive Supabase full-table pulls.

train.py and train_stock.py each get invoked 3x per pipeline run (raw-return,
Sharpe-target, and 1m horizon), and every invocation is a separate OS process
that otherwise re-downloads the same (or heavily overlapping) mf_features /
stock_features table from Supabase from scratch. For a low-traffic site,
this repeated pipeline re-fetch — not visitor traffic — is the dominant
driver of Supabase egress: 2 daily triggers (`all`, `stocks`) x 3 trainer
invocations each means the full stock_features table alone was downloaded
up to 5x/weekday before this cache existed.

The cache lives in the job's own ephemeral runner filesystem, not in the
cross-run `actions/cache` paths — a stale cross-day hit would silently
train on yesterday's data, which the max_age check below also guards
against defensively.
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

import pandas as pd

log = logging.getLogger(__name__)


def cached_or_fetch(cache_path: str | Path, fetch_fn, max_age_seconds: int = 1800) -> pd.DataFrame:
    """Return fetch_fn()'s result, reusing a same-run parquet cache when fresh."""
    path = Path(cache_path)
    if path.exists() and (time.time() - path.stat().st_mtime) < max_age_seconds:
        try:
            df = pd.read_parquet(path)
            log.info("Reusing cached %s (%d rows) — no Supabase fetch", path.name, len(df))
            return df
        except Exception as e:
            log.warning("Cache read failed for %s (%s) — re-fetching", path.name, e)

    df = fetch_fn()
    if not df.empty:
        try:
            df.to_parquet(path)
        except Exception as e:
            log.warning("Cache write failed for %s (%s) — continuing without it", path.name, e)
    return df
