# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This System Does

Fin Intel is a daily AI-powered stock and mutual fund ranking engine for Indian equities. It fetches NSE/Yahoo data nightly, scores Nifty 500 stocks through a 6-layer pipeline, and publishes a top-50 ranked list to a React UI. Key outputs: `picks` (top-50 stocks with composite scores 0–100), `mf_radar` (mutual fund rankings), `etf_picks`.

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
  src/pages/      — StockPicks.jsx, MfPicks.jsx, EtfPicks.jsx, Admin.jsx, DeepDive.jsx, …
  src/components/ — Shared UI components
```

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
