#!/usr/bin/env python3
"""ML pipeline quality assertions.
Exits 0 if all checks pass, exits 1 on any failure.
GitHub Actions annotations are emitted for each failure/warning.
"""
import os, sys, statistics, json
from datetime import date, timedelta, timezone, datetime
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

def hours_since(iso_str):
    """Return hours elapsed since an ISO-8601 timestamp string."""
    if not iso_str:
        return float("inf")
    dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - dt).total_seconds() / 3600


def business_hours_since(iso_str):
    """Like hours_since, but discounts full weekend (Sat/Sun, UTC calendar
    day) overlap. mf_radar is refreshed only by the nightly weekday cron —
    NSE/AMFI don't publish over the weekend, so a flat wall-clock threshold
    fails this check every single weekend (and into Monday, until that
    night's run lands) even though nothing is broken. Mirrors
    backend/utils.js's businessHoursAge — keep the two in sync.
    """
    if not iso_str:
        return float("inf")
    start = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    now = datetime.now(timezone.utc)
    if now <= start:
        return 0.0

    one_day = timedelta(days=1)
    weekend = timedelta(0)
    cursor = start.replace(hour=0, minute=0, second=0, microsecond=0)
    while cursor < now:
        day_end = cursor + one_day
        overlap_start = max(cursor, start)
        overlap_end = min(day_end, now)
        if overlap_end > overlap_start and cursor.weekday() >= 5:  # 5=Sat, 6=Sun
            weekend += overlap_end - overlap_start
        cursor = day_end
    return (now - start - weekend).total_seconds() / 3600


# ════════════════════════════════════════════════════════════════════════════════
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
    f"select=symbol,p_top_quartile_1m,p_top_quartile_3m,pred_rank,pred_sector_rank"
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

    # catch all-zero or near-zero scores — genuine collapse produces min < 0.01,
    # not legitimate tail values around 0.03–0.05 (which are fine for weak stocks).
    if lo < 0.01:
        fail(f"1M min score is {lo:.4f} — scores near 0 indicate model collapse or zero-fill")
    else:
        ok(f"1M min score: {lo:.4f} (>0.01)")

    if hi < 0.20:
        fail(f"1M max score is {hi:.4f} — all scores below 0.20, model has no confident picks")
    else:
        ok(f"1M max score: {hi:.4f} (>0.20)")
else:
    warn(f"Too few 1M scores to check spread: {len(scores_1m)}")

# 4. Score spread — 3M
scores_3m = [r["p_top_quartile_3m"] for r in preds if r.get("p_top_quartile_3m") is not None]
if len(scores_3m) >= 20:
    std = statistics.stdev(scores_3m)
    lo3, hi3 = min(scores_3m), max(scores_3m)
    if std < 0.03:
        fail(f"3M model not discriminating: std={std:.4f} (threshold 0.03)  range=[{lo3:.3f},{hi3:.3f}]")
    else:
        ok(f"3M score spread: std={std:.4f}  range=[{lo3:.3f},{hi3:.3f}]")

    # catch all-zero or near-zero 3M scores — genuine collapse produces min < 0.01.
    # A healthy model can have tail scores of 0.02–0.05 for genuinely weak stocks.
    if lo3 < 0.01:
        fail(f"3M min score is {lo3:.4f} — scores near 0 indicate model collapse or zero-fill")
    else:
        ok(f"3M min score: {lo3:.4f} (>0.01)")
elif scores_3m:
    warn(f"Only {len(scores_3m)} 3M scores found for {pred_date}")
else:
    warn("No 3M stock predictions found — 3M model may have failed or not run")

# NEW — 5. pred_rank null rate (this is what the UI actually displays)
rank_null = sum(1 for r in preds if r.get("pred_rank") is None)
if n > 0:
    rank_null_pct = rank_null / n * 100
    if rank_null_pct > 10:
        fail(f"pred_rank is null for {rank_null}/{n} stocks ({rank_null_pct:.1f}%) — UI will show blank ranks")
    else:
        ok(f"pred_rank populated: {n - rank_null}/{n} stocks have a rank")


# ════════════════════════════════════════════════════════════════════════════════
print("\n── Stock picks cache (price freshness) ──────────────────────────────────")

# NEW — 6. radar_cache stock_picks freshness + count
cache_row = get("radar_cache", "select=data,built_at&key=eq.stock_picks&limit=1")
if not cache_row:
    fail("radar_cache has no stock_picks row — nightly refresh has never run or cache was wiped")
else:
    row = cache_row[0]
    age_h = hours_since(row.get("built_at"))
    if age_h > 28:
        fail(f"stock_picks cache is {age_h:.1f}h old (threshold 28h) — nightly price refresh may have failed")
    else:
        ok(f"stock_picks cache age: {age_h:.1f}h (<28h)")

    # data.all = full scanned universe (up to 200); data.picks = top 50 display list
    # Check the full scan count, not just the display picks
    raw = row.get("data") or {}
    if isinstance(raw, dict):
        all_stocks = raw.get("all", raw.get("picks", []))
    else:
        all_stocks = raw if isinstance(raw, list) else []
    stock_count = len(all_stocks) if isinstance(all_stocks, list) else 0

    if stock_count < 100:
        fail(f"stock_picks cache has only {stock_count} stocks in full scan (threshold 100) — refresh scan may have failed")
    else:
        ok(f"stock_picks cache count: {stock_count} stocks")

    # Price coverage uses the display picks (top 50) — those are what the UI shows
    data = raw.get("picks", all_stocks) if isinstance(raw, dict) else all_stocks

    # NEW — 7. Price coverage: check close prices are not missing/zero
    if isinstance(data, list) and data:
        with_price = sum(1 for s in data if s.get("close") not in (None, 0))
        coverage = with_price / len(data)
        if coverage < 0.80:
            fail(f"Stock price coverage: only {with_price}/{len(data)} stocks have a valid close ({coverage*100:.0f}% < 80%) — price refresh broken")
        else:
            ok(f"Stock price coverage: {with_price}/{len(data)} ({coverage*100:.0f}%)")

        # NEW — 8. Stale prices: sample closes should not all be the same date long ago
        dates = [s.get("date") or s.get("as_of") or s.get("last_updated") for s in data[:20] if s]
        dates = [d for d in dates if d]
        if dates:
            most_recent = max(dates)
            ok(f"Most recent price date in cache: {most_recent}")


# ════════════════════════════════════════════════════════════════════════════════
print("\n── Stock features (core columns) ─────────────────────────────────────────")

# 9. Core feature null rates — look back up to 4 days to cover weekends + holidays
feat_date = None
feat_rows = []
for days_back in range(5):
    candidate = pred_date - timedelta(days=days_back)
    rows = get(
        "stock_features",
        f"select=symbol,ret1m,ret3m,vol_30d,vol_90d"
        f"&as_of_date=eq.{candidate}&limit=600",
    )
    if rows:
        feat_date = candidate
        feat_rows = rows
        break

if not feat_rows:
    fail(f"No stock_features rows found in last 5 days (checked back to {pred_date - timedelta(4)})")
else:
    ok(f"{len(feat_rows)} stock_features rows for {feat_date}")
    CORE = ["ret1m", "ret3m", "vol_30d", "vol_90d"]
    for col in CORE:
        null_pct = sum(1 for r in feat_rows if r.get(col) is None) / len(feat_rows) * 100
        if null_pct > 25:
            fail(f"  feature '{col}' is {null_pct:.1f}% null (threshold 25%) — OHLCV fetch may be broken")
        else:
            ok(f"  {col}: {null_pct:.1f}% null")

    # Newer columns — warn until backfill populates them
    NEW_COLS = ["sharpe_1y", "sortino_1y", "pe_ratio"]
    new_sample = get(
        "stock_features",
        f"select=sharpe_1y,sortino_1y,pe_ratio"
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
            else:
                ok(f"  {col}: {null_pct:.1f}% null")


# ════════════════════════════════════════════════════════════════════════════════
print("\n── Mutual fund predictions & cache ─────────────────────────────────────")

# 10. MF prediction freshness + count
mf_latest = get("mf_predictions", "select=prediction_date&order=prediction_date.desc&limit=1")
if not mf_latest:
    warn("No rows in 'mf_predictions' table — MF model may never have run")
else:
    mf_date = date.fromisoformat(mf_latest[0]["prediction_date"])
    if mf_date < stale_after:
        fail(f"MF predictions stale: latest={mf_date} ({(today - mf_date).days}d old)")
    else:
        ok(f"MF predictions fresh: {mf_date}")

    mf_count = get("mf_predictions", f"select=scheme_code&prediction_date=eq.{mf_date}&limit=200")
    if len(mf_count) < 30:
        fail(f"MF prediction count is {len(mf_count)} (expected ≥30) — MF model may not have scored all funds")
    else:
        ok(f"MF prediction count: {len(mf_count)}")

# NEW — 11. mf_radar cache freshness + fund count
mf_cache = get("radar_cache", "select=data,built_at&key=eq.mf_radar&limit=1")
if not mf_cache:
    fail("radar_cache has no mf_radar row — MF refresh has never run or cache was wiped")
else:
    mf_row = mf_cache[0]
    mf_age_h = hours_since(mf_row.get("built_at"))
    mf_biz_age_h = business_hours_since(mf_row.get("built_at"))
    if mf_biz_age_h > 28:
        fail(f"mf_radar cache is {mf_age_h:.1f}h old ({mf_biz_age_h:.1f}h business-hours, threshold 28h) — MF refresh may have failed")
    else:
        ok(f"mf_radar cache age: {mf_age_h:.1f}h ({mf_biz_age_h:.1f}h business-hours, <28h)")

    mf_data = mf_row.get("data") or {}
    if isinstance(mf_data, dict):
        # Structure: { categories: [{ funds: [...] }, ...] }
        categories = mf_data.get("categories", [])
        mf_fund_count = sum(len(c.get("funds", [])) for c in categories if isinstance(c, dict))
    else:
        mf_fund_count = 0

    if mf_fund_count < 60:
        fail(f"mf_radar has only {mf_fund_count} funds (expected ≥60) — MF data is mostly missing")
    else:
        ok(f"mf_radar fund count: {mf_fund_count}")

# NEW — 12. ETF cache count
etf_cache = get("radar_cache", "select=data,built_at&key=eq.etf_picks&limit=1")
if not etf_cache:
    warn("radar_cache has no etf_picks row — ETF refresh may not have run yet")
else:
    etf_row = etf_cache[0]
    etf_data = etf_row.get("data") or {}
    if isinstance(etf_data, dict):
        # Structure: { types: [{ etfs: [...] }, ...] }
        etf_types = etf_data.get("types", [])
        etf_count = sum(len(t.get("etfs", [])) for t in etf_types if isinstance(t, dict))
    else:
        etf_count = 0
    if etf_count < 3:
        fail(f"etf_picks has only {etf_count} ETFs (expected ≥3) — ETF refresh may have failed")
    else:
        ok(f"ETF count: {etf_count}")


# ════════════════════════════════════════════════════════════════════════════════
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
