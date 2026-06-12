# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This System Does

Fin Intel is a daily AI-powered investment intelligence platform for Indian equities covering stocks, mutual funds, ETFs, fund deep-dives, and persona-based portfolio advice. It fetches NSE/Yahoo/mfapi data nightly, scores Nifty 500 stocks through a 6-layer pipeline, and publishes ranked picks to a React UI. Key `radar_cache` blobs: `picks` (top-50 stocks), `mf_radar` (MF rankings), `etf_picks`, `stock_all` (full universe).

**Env vars required everywhere:** `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`. Optional: `ANTHROPIC_API_KEY` (rationale generation + sentiment), `LOG_LEVEL`.

---

## Commands

### Backend (Node.js — `backend/`)
```bash
cd backend && npm ci

# Run all tests
node --test

# Run a single test file
node --test stock_signals.test.js

# Manual pipeline run (what GitHub Actions does nightly)
node refresh-cache.js all        # MF + stocks full rebuild
node refresh-cache.js stocks     # Stocks EOD only
node refresh-cache.js intraday   # Fast intraday update (no ML retrain)
```

### ML Pipeline (Python — `ml/`)
```bash
cd ml
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Run the full test suite
python3 -m pytest ml/tests -q

# Run a single test file
python3 -m pytest ml/tests/test_health_report.py -v

# Key scripts (run in order for a full rebuild):
python extract_stock_features.py    # OHLCV → stock_features
python label_stock_targets.py       # Backfill fwd_top_q_3m labels
python train_stock.py               # Train LightGBM → stock_predictions
python ic_monitor.py                # Rolling IC drift check → signal_ic_history
python track_pick_outcomes.py       # Backfill realized returns → pick_history
python health_report.py             # Nightly digest → GITHUB_STEP_SUMMARY + system_health

# Useful flags
python extract_stock_features.py --dry-run
python extract_stock_features.py --backfill 365
python train_stock.py --tune --n-trials 50   # Optuna search (~30 min)
python backtest_stock_signals.py             # Full IC/returns backtest
python ic_monitor.py --horizon 3m
```

### Frontend (`frontend/`)
```bash
cd frontend && npm install
npm run dev      # Vite dev server
npm run build    # Production build
```

---

## Architecture

### Repo Layout
```
backend/          Node.js pipeline + scoring (runs in GitHub Actions)
  refresh-cache.js      — Nightly orchestrator: entry point for all stock/MF builds
  refresh-intraday.js   — Intraday update (eodBase + fresh signals, no retrain)
  stock_signals.js      — eodSignalScore() + intradaySignalScore() + compositeScore
  regime.js             — computeRegime() + applyRegime() (VIX/breadth/FII vote)
  portfolio_guards.js   — applySectorCap() (30% per sector, −6 dock)
  ml_blend.js           — loadMlBlend() (OOS-gated LightGBM blend)
  utils.js              — round2, mean, stddev, daysAgo, atomicWrite

ml/               Python ML + data pipeline
  config.py             — Feature blocklists, ROUND_TRIP_COST_PCT, max_label_gap_days()
  oos.py                — evaluate_oos(), insert_model_run() (shared by both trainers)
  script_runner.py      — run(main) wrapper used by every ml/*.py __main__ block
  extract_stock_features.py  — Bhavcopy + Yahoo OHLCV → stock_features (Supabase)
  train_stock.py        — LightGBM trainer → stock_predictions + stock_model_runs
  health_report.py      — 5-component nightly digest (sources/freshness/IC/model/outcomes)
  ic_monitor.py         — Rolling 30-date Spearman IC per signal → signal_ic_history
  track_pick_outcomes.py — pick_history → realized 5d/10d/21d returns
  migrate_0NN_*.sql     — Sequential Supabase migrations (run manually in SQL editor)

frontend/         React 18 + Vite + TailwindCSS
  src/pages/
    StockPicks.jsx      — Top-50 stock ranking with score, signals, AI probability, verdict
    MfPicks.jsx         — Best fund per category (25 categories, ~100 funds), verdict + ML %
    MfRadar.jsx         — Category leaderboard with 3 tabs: momentum / risk-adj / long-term compounders
    EtfPicks.jsx        — 30 curated ETFs across 6 types, premium/discount alerts, hotspots
    DeepDive.jsx        — Per-fund 15Y NAV analysis: rolling returns (1/3/5Y), SIP XIRR, drawdowns
    PersonaAdvisor.jsx  — 5 investor profiles (Aggressive/Growth/Balanced/Conservative/Dividend),
                          corpus input, horizon picker, auto-populated MF+stock portfolio
    StockPicks.jsx      — Top-50 ranking (also accessible as Stocks.jsx / StockAllPage.jsx)
    Admin.jsx           — Health dashboard: source status, freshness, model AUC, IC drift, hit rate
  src/components/ — Shared UI components
```

### Mutual Fund Pipeline

`momentum.js` (called from `refresh-cache.js`) builds the MF leaderboard:
- **Universe**: 25 categories, ~100 funds (curated in `mf_universe.js`)
- **Data**: mfapi.in NAV history (24h disk cache; stale-on-error fallback to AMFI portal)
- **Scoring**: `momentumScore = 1W×25% + 1M×20% + 3M×15% + 6M×10% + 1Y×10% + 5Y-CAGR×5% + Sharpe×5%`, normalised 0–100, then z-score conviction multiplier (0.55–1.00). Final composite = 65% momentum + 35% verdict signal.
- **Verdicts** (in `generate-rationales.js`): Strong Buy (score≥9 & z≥0.8), Buy (score≥6 OR z≥1.0), Hold, Avoid. Confidence = High (z≥1.5 + all returns positive + score≥8).
- **ML blend**: `mf_predictions.p_top_quartile_3m` shown as "ML Score %" in UI. MDD gate: funds with `max_dd_1y < −25%` get ML contribution halved.
- **Benchmarks** (`mf_benchmarks.js`): per-category Yahoo Finance index for 5Y alpha. Nifty 100 → Large Cap, Nifty Midcap Select → Mid Cap, Nifty Smallcap 100 → Small Cap, etc.
- **Output**: `radar_cache` key `mf_radar` + `pick_rationales` table (daily rule-based) + `pick_ai_rationales` (weekly Claude-generated)

### ETF Pipeline

`etf_momentum.js` (called from `refresh-cache.js`) builds the ETF leaderboard:
- **Universe**: 30 ETFs in 6 types — Equity Broad (5), Equity Sector (9), Smart Beta (5), Commodity Gold (4), Commodity Silver (3), International (4). Curated in `etf_universe.js`.
- **Data**: Yahoo Finance NSE prices (primary, real-time returns); mfapi.in NAV (secondary, premium/discount only).
- **Scoring**: Same momentum formula as MF + ETF-specific adjustments: liquidity penalty (−5 tiny, −3 thin, −1 small), premium >1% → −3, TER >1% → −1.5, TER <0.2% → +0.5.
- **Output**: `radar_cache` key `etf_picks` including premium/discount %, avg daily ₹ volume, liquidity flag.

### Deep Dive (frontend-only, no backend cache)

`DeepDive.jsx` fetches live from mfapi.in on demand (no Supabase involvement):
- Loads up to 15 years of daily NAVs for any fund
- Computes rolling 1Y/3Y/5Y CAGR windows (min/max/mean, % positive, % >12/15/18%)
- Risk metrics: Sharpe (Rf=7%), Sortino, Calmar (ann_return / |max_dd|)
- Significant drawdown periods: top 5 by depth with recovery timeline
- Historical SIP: ₹10K/month back-tested at actual NAVs → XIRR, wealth multiple

### Persona Advisor (frontend-only, reads existing caches)

`PersonaAdvisor.jsx` reads `radar_cache` blobs already built by the nightly pipeline:
- 5 profiles: Aggressive 🚀, Growth 📈, Balanced ⚖️, Conservative 🛡️, Dividend Seeker 💰
- Each has a fixed allocation (e.g. Aggressive = SmallCap 35%, MidCap 25%, Stocks 20%, Gold 5%, Debt 5%, Cash 10%)
- MF slot gate: skip if category z-score < −0.5 (Cool/Cold market)
- Stock gate: minimum composite score per persona (60/55/50/45), sector whitelist if specified, prefers Core stocks (≥7 days in top 50)
- Outputs: projected corpus range, expected return/DD/Sharpe, recommended fund+stock picks with allocation ₹, scoring explainer

### Rationale Generation

Two daily scripts write pre-computed verdicts so the UI never calls Claude inline:
- `generate-rationales.js` → `pick_rationales` table (MF verdicts: macro_theme, bull_case, bear_case, confidence_reason)
- `generate-stock-rationales.js` → `stock_pick_rationales` table (Stock verdicts: prioritises institutional > RS > technical > fundamental signals)
- `pick_ai_rationales` / `stock_pick_ai_rationales` — weekly Claude-generated deeper analysis (requires `ANTHROPIC_API_KEY`)

### Stock Scoring Pipeline (the critical flow)

`refresh-cache.js` runs this sequence every nightly "all" or "stocks" trigger:

1. **Data fetch** — `buildSignalsLeaderboard()` calls `stock_bhavcopy.js` (NSE delivery %), `nse_discovery.js` (bulk deals, OI, 52W highs), `yahoo_fundamentals.js` (P/E, ROE, growth).
2. **`eodSignalScore(sig)`** — 30+ signals scored per stock. Returns a raw 0–100 value. Also sets `overextensionPenalty`, `pullbackBonus`, `liquidityPenalty`, `signalCount` on the stock object.
3. **Fundamentals adjustment** — market-cap tier bonus/penalty (+3 large, −10 micro) + earnings/ROE bonuses.
4. **`loadMlBlend(supabase)`** then **`applyMlBlend(stocks, blend)`** — blends LightGBM percentile into composite; weight = 0 if OOS AUC < 0.52 (gate in `ml_blend.js`).
5. **`computeRegime({stocks, niftyReturns, macro})`** then **`applyRegime(stocks, info)`** — docks weak names (below 200DMA or rsVsNifty3M < −10%) by −4 (neutral) or −12 (risk\_off). In risk\_off also amplifies overextensionPenalty × 1.5.
6. **`p.eodBaseScore = p.compositeScore`** — snapshot post-regime score; used by `refresh-intraday.js` as stable base. **Must happen after `applyRegime`.**
7. **EMA smoothing** — `0.6 × rawScore + 0.4 × prevEodScore`.
8. **Incumbent hysteresis** — +5 to stocks in yesterday's top 50.
9. **Primary sort** by `compositeScore DESC`.
10. **`applySectorCap(stocks, {topN:50})`** — dock 6 pts from names beyond 30% per sector in top-50 window, then re-sort.
11. **Write** `picks` JSON blob to `radar_cache` Supabase table; snapshot top-100 to `pick_history`.

`refresh-intraday.js` skips steps 1–8 (uses `eodBaseScore` from the nightly run) and re-scores only with fresh intraday signals (volume shock, breakout, gap, relative strength) to avoid re-running the ML model.

### Penalty Sign Convention
All penalty fields (`regimePenalty`, `liquidityPenalty`, `sectorCapPenalty`, `regimeOverextPenalty`) are **positive magnitudes** — the caller does `compositeScore - penalty`. `overextensionPenalty` is **negative** (already a deduction from `eodSignalScore`).

### Supabase Tables
| Table | Written by | Purpose |
|---|---|---|
| `radar_cache` | `refresh-cache.js` | JSON blobs: `picks`, `mf_radar`, `etf_picks`, `stock_all` |
| `stock_features` | `extract_stock_features.py` | Per-stock OHLCV features, one row per (symbol, as_of_date) |
| `stock_predictions` | `train_stock.py` | LightGBM probabilities: `p_top_quartile_3m`, `p_top_sharpe_q_3m` |
| `stock_model_runs` | `train_stock.py` via `oos.insert_model_run()` | CV AUC, OOS AUC, feature importance audit log |
| `pick_history` | `refresh-cache.js` | Daily top-100 snapshot; backfilled with `ret_5d/10d/21d` |
| `signal_ic_history` | `ic_monitor.py` | Rolling Spearman IC per signal; `sign_flipped` flag |
| `system_health` | `health_report.py` | Per-component status rows (migration 013) |
| `mf_features` | `extract_features.py` | NAV-based features for mutual funds |
| `mf_predictions` | `train.py` | MF model probabilities + SHAP top-5 |
| `pick_rationales` | `generate-rationales.js` | Daily rule-based MF verdicts (bull/bear case, confidence) |
| `pick_ai_rationales` | `generate-rationales.js` (Claude) | Weekly AI-generated MF deep-dive rationales |
| `stock_pick_rationales` | `generate-stock-rationales.js` | Daily rule-based stock verdicts |
| `stock_pick_ai_rationales` | `generate-stock-rationales.js` (Claude) | Weekly AI-generated stock rationales |
| `mf_sentiment` | `sentiment.py` | Weekly news sentiment per fund (Claude Haiku) |

### ML Conventions
- **Feature discovery**: blocklist approach in `config.py` (`get_stock_feature_cols(df)`). Any new numeric column in `stock_features` is auto-included in training unless listed in `_STOCK_NON_FEATURE_COLS` or `_STOCK_SNAPSHOT_FUNDAMENTAL_COLS`. **Snapshot fundamentals (P/E, ROE, etc.) are excluded from the model** — they're point-in-time unsafe for historical training but used in the JS scoring layer.
- **OOS validation**: Both `train.py` and `train_stock.py` call `evaluate_oos()` from `oos.py` (last 90 days of labeled history held out). The ML blend gate in `ml_blend.js` prefers `oos_auc` over `cv_auc`.
- **Schema-drift tolerance**: `extract_stock_features.py` strips unrecognised columns and retries on PostgREST "column not found" errors. New migrations can be applied while the pipeline is live.
- **Exit handling**: Every `ml/*.py` script's `__main__` block calls `from script_runner import run; run(main)` — this ensures `os._exit()` bypasses supabase-py's C++ teardown crash.

### GitHub Actions Triggers
| Cron (UTC) | IST | Target |
|---|---|---|
| `30 23 * * 1-5` | 5:00 AM | `all` — full MF + stocks rebuild + ML retrain |
| `15 10 * * 1-5` | 3:45 PM | `stocks` — EOD final prices |
| `10 4 * * 1-5` | 9:40 AM | `intraday` — market open |
| `0 7 * * 1-5` | 12:30 PM | `intraday` — midday |
| `0 10 * * 1-5` | 3:30 PM | `intraday` — pre-close |

Manual dispatch via `workflow_dispatch` accepts a `target` input (see `.github/workflows/refresh.yml` for full option list including `signal_backtest`, `migrate`, `restore_persistence`).

### Database Migrations
Migrations live in `ml/migrate_0NN_*.sql`. They are **not auto-applied** — run them manually in the Supabase SQL editor in order. `run_migrations.py` can apply pending ones programmatically. The pipeline degrades gracefully on unmigrated columns (strips the column, logs a warning).
