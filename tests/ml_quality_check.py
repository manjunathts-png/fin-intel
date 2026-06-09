#!/usr/bin/env python3
"""ML pipeline quality assertions.
Exits 0 if all checks pass, exits 1 on any failure.
GitHub Actions annotations are emitted for each failure/warning.
"""
import os, sys, statistics
from datetime import date, timedelta
import httpx

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_KEY"]
HDR = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Accept": "application/json"}

def get(table, qs=""):
    r = httpx.get(f"{URL}/rest/v1/{table}?{qs}", headers=HDR, timeout=30)
    r.raise_for_status()
    return r.json()

failures = []
warnings = []

def fail(msg):
    print(f"::error::{msg}")
    failures.append(msg)

def warn(msg):
    print(f"::warning::{msg}")
    warnings.append(msg)

def ok(msg):
    print(f"  ✓  {msg}")


print("── Stock predictions ────────────────────────────────────────────────────")

# 1. Freshness
latest = get("stock_predictions", "select=prediction_date&order=prediction_date.desc&limit=1")
if not latest:
    fail("No rows in stock_predictions — ML pipeline has never written predictions")
    print("\nFAIL — aborting (no data)")
    sys.exit(1)

pred_date = date.fromisoformat(latest[0]["prediction_date"])
today = date.today()
stale_after = today - timedelta(days=4)   # tolerate weekends + 1 buffer day

if pred_date < stale_after:
    fail(f"Predictions are stale: latest={pred_date}  ({(today - pred_date).days}d old, allowed ≤4)")
else:
    ok(f"Predictions are fresh: {pred_date}")

# 2. Count
preds = get(
    "stock_predictions",
    f"select=symbol,p_top_quartile_1m,p_top_quartile_3m"
    f"&prediction_date=eq.{pred_date}&limit=600",
)
n = len(preds)
if n < 400:
    fail(f"Only {n} predictions for {pred_date} (expected ≥400 for Nifty 500 universe)")
else:
    ok(f"Prediction count: {n}")

# 3. Score spread — 1M
scores_1m = [r["p_top_quartile_1m"] for r in preds if r.get("p_top_quartile_1m") is not None]
if len(scores_1m) >= 20:
    std = statistics.stdev(scores_1m)
    lo, hi = min(scores_1m), max(scores_1m)
    if std < 0.03:
        fail(
            f"1M model not discriminating: std={std:.4f} (threshold 0.03) "
            f"range=[{lo:.3f},{hi:.3f}] — key features may still be mostly null"
        )
    else:
        ok(f"1M score spread: std={std:.4f}  range=[{lo:.3f},{hi:.3f}]")
else:
    warn(f"Too few 1M scores to check spread: {len(scores_1m)}")

# 4. Score spread — 3M
scores_3m = [r["p_top_quartile_3m"] for r in preds if r.get("p_top_quartile_3m") is not None]
if len(scores_3m) >= 20:
    std = statistics.stdev(scores_3m)
    if std < 0.03:
        fail(f"3M model not discriminating: std={std:.4f} (threshold 0.03)")
    else:
        ok(f"3M score spread: std={std:.4f}")
elif scores_3m:
    warn(f"Only {len(scores_3m)} 3M scores found for {pred_date}")
else:
    warn("No 3M stock predictions found — 3M model may have failed or not run")


print("\n── Stock features (core columns) ─────────────────────────────────────────")

# 5. Core feature null rates — must be low or backfill is broken
feat_date = pred_date
feat_rows = get(
    "stock_features",
    f"select=symbol,ret1m,ret3m,momentum_20d,vol_3m,close"
    f"&as_of_date=eq.{feat_date}&limit=600",
)
if not feat_rows:
    # Try the prior business day
    feat_date = pred_date - timedelta(days=1)
    feat_rows = get(
        "stock_features",
        f"select=symbol,ret1m,ret3m,momentum_20d,vol_3m,close"
        f"&as_of_date=eq.{feat_date}&limit=600",
    )

if not feat_rows:
    fail(f"No stock_features rows found for {pred_date} or {pred_date - timedelta(1)}")
else:
    ok(f"{len(feat_rows)} stock_features rows for {feat_date}")
    CORE = ["ret1m", "ret3m", "momentum_20d", "vol_3m", "close"]
    for col in CORE:
        null_pct = sum(1 for r in feat_rows if r.get(col) is None) / len(feat_rows) * 100
        if null_pct > 25:
            fail(f"  feature '{col}' is {null_pct:.1f}% null (threshold 25%) — OHLCV fetch may be broken")
        else:
            ok(f"  {col}: {null_pct:.1f}% null")

    # Newer columns — warn if null (expected until backfill runs)
    NEW_COLS = ["sharpe_1y", "sortino_1y", "sector_rel_sharpe", "pe_ratio", "fii_net_5d"]
    new_sample = get(
        "stock_features",
        f"select=sharpe_1y,sortino_1y,sector_rel_sharpe,pe_ratio,fii_net_5d"
        f"&as_of_date=eq.{feat_date}&limit=600",
    )
    if new_sample:
        for col in NEW_COLS:
            null_pct = sum(1 for r in new_sample if r.get(col) is None) / len(new_sample) * 100
            if null_pct > 80:
                warn(
                    f"  feature '{col}' is {null_pct:.0f}% null — "
                    f"run nifty500_backfill to populate (model will have lower accuracy until then)"
                )


print("\n── MF predictions ───────────────────────────────────────────────────────")

# 6. MF prediction freshness
mf_latest = get("predictions", "select=as_of_date&order=as_of_date.desc&limit=1")
if not mf_latest:
    warn("No rows in 'predictions' table — MF model may never have run")
else:
    mf_date = date.fromisoformat(mf_latest[0]["as_of_date"])
    if mf_date < stale_after:
        fail(f"MF predictions stale: latest={mf_date} ({(today - mf_date).days}d old)")
    else:
        ok(f"MF predictions fresh: {mf_date}")

    mf_count = get("predictions", f"select=scheme_code&as_of_date=eq.{mf_date}&limit=200")
    ok(f"MF prediction count: {len(mf_count)}")


print("\n── Summary ──────────────────────────────────────────────────────────────")
print(f"  Failures : {len(failures)}")
print(f"  Warnings : {len(warnings)}")

if warnings:
    for w in warnings:
        print(f"  ⚠  {w}")

if failures:
    print("\nFAILED checks:")
    for f in failures:
        print(f"  ✗  {f}")
    sys.exit(1)
else:
    print("\nALL CHECKS PASSED")
