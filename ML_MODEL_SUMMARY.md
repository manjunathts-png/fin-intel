# Fin Intel — ML Prediction Models
### Mutual Funds & Stocks · Technical Reference & Business Summary
*Updated: June 2026 (reflects all changes through Jun 12, 2026)*

---

## Executive Summary

Fin Intel uses a **gradient-boosted tree classifier (LightGBM)** to rank mutual funds and stocks by the probability of outperforming their peers over the next 3 months. The model does not predict absolute returns — it predicts *relative rank within a category/sector*. An 80% ML Score means the model believes this fund has an 80% probability of landing in the top quartile of its category in the next quarter.

| | Mutual Funds | Stocks |
|---|---|---|
| **Universe** | ~100 funds · 25 categories | ~500 stocks (Nifty 500) · 17 sectors |
| **Algorithm** | LightGBM + Isotonic Calibration | LightGBM + Isotonic Calibration |
| **Target** | Top-quartile in category (3m) | Top-quartile in sector (3m) OR Sharpe-quartile (3m) |
| **CV AUC** | **0.730** | Varies by training run |
| **OOS AUC** | — | Tracked (oos_auc in stock_model_runs); blend gated at 0.55 |
| **Precision@Q1** | **52.5%** (2.1× lift over 25% base) | Tracked (oos_precision_top_q) |
| **CAGR Alpha** | **+1.55%** vs equal-weight benchmark | — |
| **Retrain frequency** | Nightly (5 AM IST, weekdays) | Nightly (weekdays only) |
| **Model features** | ~40 (auto-discovered via blocklist) | ~67 OHLCV + cross-sectional (auto-discovered) |
| **Snapshot fundamentals** | N/A | 13 features stored in DB, used in JS scoring only |

---

## 1. What Problem Are We Solving?

There are 10,000+ mutual funds in India and hundreds of liquid NSE stocks. Picking which one to hold in each category or sector is hard — momentum alone is noisy, and analyst reports are often lagging. We want a systematic signal that combines momentum, risk, market context, and news into a single probability score.

**The ML question we ask:**

> *Given everything we know about a fund/stock today — its returns, risk profile, market position, macro environment, and news sentiment — what is the probability it will be a top-quartile performer in its category over the next 3 months?*

This is a **binary classification** problem (top-quartile = 1, else = 0). Base rate is exactly 25% by construction (one in four funds in each category will be top-quartile).

---

## 2. Algorithm

```
┌─────────────────────────────────────────────────────────────┐
│              LightGBM Binary Classifier                     │
│  (gradient boosted decision trees — fast, handles nulls,    │
│   native feature importance via gain splitting)             │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│        CalibratedClassifierCV  (isotonic regression)        │
│  Converts raw model scores → calibrated probabilities       │
│  so that "60%" really does mean 60/40 odds, not just a rank │
└─────────────────────────────────────────────────────────────┘
                        │
                        ▼
             p_top_quartile_3m  ∈  [0.0, 1.0]
             → displayed as ML Score 0–100%

             p_top_sharpe_q_3m  ∈  [0.0, 1.0]     ← stocks: preferred blend input
             → risk-adjusted quartile probability
```

### Why LightGBM?
- Handles missing values natively (no imputation needed for sparse macro features)
- Trains in seconds on our dataset size
- Feature importance via gain gives interpretable signals
- Outperforms linear models and random forests on tabular financial data in benchmarks

### Why Calibration?
Without calibration, raw LightGBM scores are *ordinal* (rank-correct but not probability-correct). Isotonic calibration fits a monotone function on held-out data so that the output is a proper probability. This matters for the composite score blend and for the MDD gate logic.

---

## 3. Mutual Funds Model

### 3.1 Hyperparameters

| Parameter | Value | What it controls |
|---|---|---|
| `n_estimators` | 500 | Number of boosting rounds |
| `learning_rate` | 0.04 | Step size per tree (lower = more trees needed, lower overfitting) |
| `max_depth` | 5 | Max tree depth |
| `num_leaves` | 31 | Leaf nodes per tree (complexity) |
| `min_child_samples` | 20 | Min samples per leaf (prevents overfitting small categories) |
| `subsample` | 0.8 | Row sampling per tree (bagging) |
| `colsample_bytree` | 0.8 | Column sampling per tree (feature bagging) |
| `reg_alpha` | 0.1 | L1 regularisation |
| `reg_lambda` | 0.2 | L2 regularisation |
| `class_weight` | balanced | Upweights the minority class (top-quartile = 25% of data) |

*Optuna hyperparameter tuning available via `python train.py --tune --n-trials 50` (≈30 min).*

### 3.2 Feature Set (~40 auto-discovered)

Features are auto-discovered from the `mf_features` table using `get_mf_feature_cols(df)` in `config.py`. Any new numeric column that isn't an identifier, forward label, or `fwd_`-prefixed column is automatically included.

```
RETURNS (9 features)
├── ret1w    — 1-week return
├── ret1m    — 1-month return
├── ret3m    — 3-month return
├── ret6m    — 6-month return
├── ret1y    — 1-year return
├── ret3y    — 3-year return
├── ret5y    — 5-year return
├── cagr5y   — 5-year CAGR
└── cagr10y  — 10-year CAGR (29% null for funds < 10 yrs old)

RISK (7 features)
├── vol_30d          — 30-day rolling volatility
├── vol_90d          — 90-day rolling volatility
├── vol_1y           — 1-year rolling volatility
├── max_dd_1y        — Worst peak-to-trough drawdown (trailing 1Y)  ⭐ #1 feature
├── downside_dev_1y  — Downside deviation (semi-deviation)
├── sharpe_1y        — Sharpe ratio (1Y, Rf = 7%)
└── sortino_1y       — Sortino ratio (1Y, penalises only downside vol)

MOMENTUM & CONSISTENCY (2 features)
├── z1w                — Z-score of 1w return vs category peers
└── positive_months_12m — % of last 12 months with positive return

CROSS-SECTIONAL RANKS (7 features)
├── cat_rank_1m / cat_rank_3m / cat_rank_1y     — Rank within category
├── univ_rank_1m / univ_rank_3m / univ_rank_1y  — Rank within full universe
└── cat_z                                         — Category-level z-score vs universe

CATEGORY SIGNALS (2 features)
├── cat_momentum_3m  — Median 3m return of all funds in this category
└── cat_vs_univ_3m   — Percentile of that category median vs all categories

CATEGORY-RELATIVE RISK (4 features)  ← added Jun 2026
├── cat_rel_max_dd_1y       — This fund's max_dd_1y minus category median
├── cat_rel_vol_1y          — This fund's vol_1y minus category median
├── cat_rel_sharpe_1y       — This fund's sharpe_1y minus category median
└── cat_rel_downside_dev    — This fund's downside_dev minus category median

STYLE vs BENCHMARK (3 features)
├── beta_nifty   — Sensitivity to Nifty moves (OLS, trailing 1Y daily)
├── alpha_nifty  — Excess return vs Nifty (Jensen's alpha)
└── corr_nifty   — Correlation with Nifty (diversification signal)  ⭐ #2 feature

MACRO CONTEXT (5 features)
├── nifty_ret1m   — Nifty 50 1-month return
├── nifty_ret3m   — Nifty 50 3-month return
├── india_vix     — India Volatility Index (Yahoo Finance v8 + Kite fallback — now live)
├── usd_inr       — USD/INR exchange rate (via Yahoo → ECB fallback)
└── us_10y_yield  — US 10Y Treasury yield (via Yahoo → FRED fallback)

SENTIMENT (1 feature)
└── sentiment_score  — News sentiment score -1 to +1 (Claude Haiku, weekly)
                       (null for historical data; live-only going forward)
```

### 3.3 Top 5 Features by Importance (LightGBM gain)

```
Rank  Feature              Importance   Interpretation
────  ───────────────────  ──────────   ──────────────────────────────────────────
 1    max_dd_1y             ████████    Risk-managed funds outperform consistently
 2    corr_nifty            ██████      Low-correlation funds add alpha vs index
 3    cagr10y               █████       Long-run quality signal filters noise
 4    downside_dev_1y       ████        Downside volatility is more predictive than total vol
 5    vol_1y                ███         Extreme volatility → lower Q1 probability
```

*Key insight: The model learned that **risk-adjusted quality** (not raw momentum) predicts top-quartile membership. A fund with strong recent returns but high drawdown is penalised — consistent with how category-relative rankings work in practice.*

### 3.4 MF Universe — 25 Categories

Funds are grouped into 5 model groups for category-relative scoring:

| Group | Categories |
|---|---|
| `equity` | Large Cap, Mid Cap, Small Cap, Flexi Cap, Large & Mid Cap, Micro Cap, Multi Cap, Value, ELSS |
| `sector` | Defence, PSU, Technology, Pharma & Healthcare, Banking & Financial, Infrastructure, Manufacturing, Consumption, Energy |
| `fixed_income` | Liquid, Ultra Short Duration, Low Duration, Short Duration, Medium Duration, Long Duration, Gilt, Credit Risk, Money Market, Corporate Bond |
| `hybrid` | Balanced, Aggressive Hybrid, Conservative Hybrid, Multi Asset |
| `commodity` | Gold, Silver, Gold & Silver |

---

## 4. Stocks Model

### 4.1 How It Differs from the MF Model

The stocks model uses the same LightGBM + calibration architecture but adds **cross-sectional sector signals**, **delivery/flow data**, and **technical indicators** that are unavailable for mutual funds. Snapshot fundamentals (P/E, ROE, etc.) are collected but **excluded from model training** — they are point-in-time unsafe for historical training (see Section 5).

| | MF Model | Stock Model |
|---|---|---|
| n_estimators | 500 | 400 |
| learning_rate | 0.04 | 0.05 |
| min_child_samples | 20 | 15 |
| Model features | ~40 | ~67 (OHLCV + cross-sectional) |
| Snapshot fundamentals | N/A | 13 cols — stored in DB, JS scoring only |
| Universe | ~100 funds · 25 categories | ~500 stocks (Nifty 500) · 17 sectors |
| Secondary target | — | `fwd_top_sharpe_q_3m` → `p_top_sharpe_q_3m` |

### 4.2 Stock Feature Set (~67 model features, auto-discovered)

Features are auto-discovered from the `stock_features` table using `get_stock_feature_cols(df)` in `config.py`. Snapshot fundamentals are held in a separate blocklist (`_STOCK_SNAPSHOT_FUNDAMENTAL_COLS`) and excluded from the model.

```
RETURNS (7 features)
├── ret1w  — 1-week return
├── ret1m  — 1-month return
├── ret2m  — 2-month return                         ← added Jun 2026
├── ret3m  — 3-month return
├── ret6m  — 6-month return
├── ret9m  — 9-month return                         ← added Jun 2026
└── ret1y  — 1-year return

RISK (7 features)
├── vol_30d         — 30-day rolling volatility
├── vol_90d         — 90-day rolling volatility
├── vol_1y          — 1-year rolling volatility
├── max_dd_1y       — Worst peak-to-trough drawdown
├── downside_dev_1y — Downside deviation
├── sharpe_1y       — Sharpe ratio (Rf = 7%)
└── sortino_1y      — Sortino ratio

TECHNICAL INDICATORS (5 features)
├── rsi_14      — RSI (14-day): momentum oscillator 0–100
├── macd_hist   — MACD histogram: trend strength and direction
├── bb_pct      — Bollinger Band %: where price sits within the band
├── vol_ratio   — Volume ratio (20-day vs 50-day avg): unusual activity
└── high52w_pct — % below 52-week high: breakout candidates

DELIVERY & INSTITUTIONAL FLOW (8 features)             ← all added Jun 2026
├── delivery_pct       — NSE bhavcopy delivery % (today)
├── delivery_pct_5d_avg — 5-day average delivery %
├── fii_net_5d         — FII net buy/sell (5-day rolling, ₹ Cr)
├── fii_net_20d        — FII net buy/sell (20-day rolling)
├── dii_net_5d         — DII net buy/sell (5-day rolling)
├── dii_net_20d        — DII net buy/sell (20-day rolling)
├── fiidii_net_5d      — Combined FII+DII net (5-day)
└── fiidii_net_20d     — Combined FII+DII net (20-day)

MOMENTUM & CONSISTENCY (2 features)
├── z1w                — Z-score of 1w return vs universe
└── positive_months_12m — % of last 12 months with positive return

SECTOR RANKS (4 features)
├── sector_rank_1m / sector_rank_3m / sector_rank_1y  — Rank within sector
└── sector_z  — Sector-level z-score vs universe

UNIVERSE RANKS (3 features)
├── univ_rank_1m / univ_rank_3m / univ_rank_1y  — Rank in full Nifty 500

SECTOR-RELATIVE Z-SCORES (16 features)               ← all added Jun 2026
├── sector_rel_ret1m / ret2m / ret3m / ret6m / ret9m  — Return vs sector median
├── sector_rel_vol30d / vol90d / vol1y                 — Volatility vs sector
├── sector_rel_sharpe / sortino                        — Risk-adjusted vs sector
├── sector_rel_rsi / bb                                — Technicals vs sector
├── sector_rel_high52w / beta / maxdd / delivery       — Other vs sector

UNIVERSE-RELATIVE (4 features)                        ← added Jun 2026
├── univ_rel_ret1m / ret3m   — Return vs full Nifty 500 median
├── univ_rel_vol30d          — Volatility vs universe
└── univ_rel_sharpe          — Sharpe vs universe

SECTOR MACRO (2 features)
├── sector_momentum_3m  — Median 3m return of all stocks in this sector
└── sector_vs_univ_3m   — Percentile of sector momentum vs all sectors

MARKET (3 features)
├── beta_nifty   — Sensitivity to Nifty moves
├── alpha_nifty  — Excess return vs Nifty
└── corr_nifty   — Correlation with Nifty

MACRO CONTEXT (5 features)
├── nifty_ret1m / nifty_ret3m — Nifty 50 returns
├── india_vix     — India VIX (Yahoo Finance v8 primary + Kite fallback — now live)
├── usd_inr       — USD/INR (Yahoo → ECB fallback)
└── us_10y_yield  — US 10Y Treasury yield (Yahoo → FRED fallback)

SENTIMENT (1 feature)
└── sentiment_score — Fund/stock news sentiment (Claude Haiku, weekly; null for historical)
```

**Snapshot fundamentals (stored in `stock_features`, excluded from model):**
```
pe_ratio, pb_ratio, roe, revenue_growth, earnings_growth, profit_margins,
debt_to_equity, dividend_yield,
eps_beat_rate_4q, eps_surprise_avg_4q, eps_qoq_slope, eps_rev_30d, eps_rev_90d
```
These are applied as bonuses/penalties in `stock_signals.js` at inference time, where "today's value" is correct. Using them in model training would create point-in-time leakage (current P/E attached to 2-year-old rows).

### 4.3 Per-Date Rank Transform (stocks only)

Before training, stock-level features are converted to **within-date cross-sectional percentile ranks** (0–1) in `prepare_X()`. The label is cross-sectional (quartile within sector per date), but raw feature levels (volatility, returns, RSI) drift with market regime — tree splits learned on one regime's levels stop separating stocks in the next. Per-date ranking removes that drift.

- Market-wide columns (`india_vix`, `nifty_ret*`, `usd_inr`, `us_10y_yield`, FII/DII flows) are identical for every stock on a date, so they stay on their raw scale.
- The transform is self-contained per date — no fitted state, so it cannot leak across the train/holdout boundary, and inference (a single date's cross-section) ranks identically.

The Optuna search space is also constrained for financial noise: `max_depth` 2–4, `min_child_samples` 50–150, `colsample_bytree` 0.3–0.6 — shallow trees and aggressive column subsampling prevent memorizing per-stock anomalies.

### 4.4 Secondary Target — Sharpe-Quartile (LIVE)

The stock model now trains two targets:

| Target | Column | Description |
|---|---|---|
| Primary | `fwd_top_q_3m` | Top 25% by raw 3M return within sector |
| Secondary | `fwd_top_sharpe_q_3m` | Top 25% by 3M Sharpe ratio within sector |

The ML blend gate (`ml_blend.js`) **prefers `p_top_sharpe_q_3m`** over `p_top_quartile_3m`. The Sharpe-quartile target de-emphasises high-beta names that post big raw returns but with large drawdowns — exactly the names that hurt on short holding periods.

### 4.5 Stock Universe (17 Sectors, ~500 Stocks)

| Sector | Stocks |
|---|---|
| IT | TCS, Infosys, HCL Tech, Wipro, Tech Mahindra, Coforge, Persistent, Mphasis, OFSS, and others |
| Banking - Private | HDFC Bank, ICICI, Kotak, Axis, IndusInd, Federal, IDFC First, RBL |
| Banking - PSU | SBI, BoB, PNB, Canara, Union, Indian |
| Auto & EV | Maruti, M&M, Ashok Leyland, Bajaj Auto, Hero, Eicher, + EV plays |
| Pharma | — |
| FMCG | — |
| Metals & Mining | — |
| Energy & Oil | — |
| Capital Goods & Defence | — |
| Finance - NBFC | — |
| Real Estate | — |
| Telecom | — |
| Consumption & Retail | — |
| Chemicals & Fertilisers | — |
| Cables & Electronics | — |
| Cement & Construction | — |
| Diversified | — |
| **Total** | **~500 stocks (Nifty 500)** |

---

## 5. Leakage Prevention (Three Layers)

A critical leakage bug was discovered and fixed in June 2026: `fwd_quartile_3m` and `fwd_quartile_1m` (int columns 1–4 correlated with the target label) were included as training features. At inference time these are NULL → imputed to ~2.5 → model predicts "not top quartile" for every stock → all scores collapse to 0.

Three defence layers now prevent any forward label from entering training:

```
Layer 1 — fwd_ PREFIX RULE (automatic)
  get_mf_feature_cols(df) and get_stock_feature_cols(df) in config.py
  exclude ANY column starting with "fwd_" — catches new forward-label
  columns automatically even if the explicit blocklist isn't updated.

Layer 2 — EXPLICIT BLOCKLIST (belt-and-suspenders)
  _MF_NON_FEATURE_COLS and _STOCK_NON_FEATURE_COLS in config.py list
  every identifier, admin column, and edge-case label that doesn't
  follow the fwd_ convention.

Layer 3 — SNAPSHOT FUNDAMENTALS BLOCKLIST (stock model only)
  _STOCK_SNAPSHOT_FUNDAMENTAL_COLS in config.py excludes P/E, ROE,
  earnings momentum, etc. — point-in-time unsafe for historical training.
```

Additionally: `max_label_gap_days()` tightened from a flat 30-day tolerance to **14 days for 3M labels** and **7 days for 1M labels**, preventing a "90-day" label from silently measuring a 60-day window when the target-date price is missing.

A pytest suite in `ml/tests/` enforces these constraints on every CI run.

---

## 6. Walk-Forward OOS Evaluation (Embargoed, Multi-Window)

*Implemented in `ml/oos.py` — used by both `train.py` and `train_stock.py`.*

Time-series cross-validation (TimeSeriesSplit) still overlaps the training distribution and overstates live edge. The honest estimate is a true holdout — recent labeled history **never seen during fitting** — with two extra controls:

**Label-horizon embargo.** A row at date T carries a label computed from prices up to T+90. Without an embargo, fit rows just before the holdout cutoff embed information about the exact period the holdout evaluates. Fit rows within `embargo_days` (90d for 3M targets, 30d for 1M) of the holdout start are dropped.

**Multiple rolling windows.** A single 90-day holdout is one regime window — high variance. The evaluator walks back through up to 3 consecutive 90-day windows and reports the **mean** AUC, so the blend gate sees a stabler estimate. Older windows activate automatically as labeled history grows.

```
All labeled rows ──────────────────────────────────────────────────────
   │◄── fit (win 1) ──►│ embargo │◄ hold 1 ►│◄ hold 0 ►│
   │◄────── fit (win 0) ─────────►│ embargo │◄ hold 0 ►│ (per window)
                                                     max_date
```

- A **separate** LightGBM is trained per window. The production model is still refit on **all** labeled data afterwards — holdout models exist only to measure.
- Holdout imputation uses **fit-set medians** — no information leaks from holdout into preprocessing.
- Mean results logged to `stock_model_runs` as `oos_auc` / `oos_precision_top_q` (requires migration 012); per-window AUCs go to the run log.
- Windows with fewer than 30 holdout rows or 100 fit rows are skipped (too noisy to report).

```python
# Called from train.py and train_stock.py
from oos import evaluate_oos_windows
metrics = evaluate_oos_windows(train_df, target_col="fwd_top_q_3m", params=params,
                               prepare_X_fn=prepare_X)   # embargo inferred: 90d
# → {"oos_auc": 0.58, "oos_precision_top_q": 0.35, "oos_samples": 812,
#    "oos_windows": [{"window": 0, "oos_auc": 0.60, ...}, {"window": 1, ...}]}
```

> Note: adding the embargo typically **lowers** the reported OOS AUC vs the pre-embargo number — the old figure was inflated by label overlap. The new number is the honest one the blend gate should act on.

---

## 7. ML Blend Gate — Stocks

*Implemented in `backend/ml_blend.js`.*

The LightGBM output is blended into the composite stock score **only when the model has demonstrated out-of-sample edge**. A model scoring at chance (OOS AUC ≈ 0.50) must never move the picks — it just adds noise.

```
Blend weight formula:
  auc < AUC_GATE (0.55)             → weight = 0   (ML ignored entirely)
  AUC_FLOOR (0.55) ≤ auc ≤ AUC_FULL (0.62) → weight ramps 0 → MAX_WEIGHT (0.35)
  auc ≥ AUC_FULL                    → weight = MAX_WEIGHT (0.35)

Preferences:
  • Uses oos_auc over cv_auc (honest live estimate)
  • Uses p_top_sharpe_q_3m over p_top_quartile_3m (risk-adjusted)
  • Staleness gate: predictions older than FRESH_DAYS (5) = ignored
  • Coverage gate: fewer than MIN_PREDS (30) scored stocks = ignored
```

The blend converts model probabilities to **cross-sectional percentiles** (0–100) before mixing:

```
compositeScore = (1 − weight) × technicalScore + weight × mlPercentile
```

Both `mlScore` and `mlBlendWeight` are annotated on every stock object for UI transparency.

---

## 8. Signal IC Monitor

*Implemented in `ml/ic_monitor.py` — writes to `signal_ic_history` table.*

A rolling 30-date Spearman Information Coefficient (IC) is computed for each technical signal against 5d/10d/21d forward returns:

- IC > 0 and statistically significant → signal is adding value
- `sign_flipped = true` → signal's direction has reversed vs its historical calibration → warning in health digest
- IC drift alerts surface in the Admin dashboard before they hurt picks

```bash
python ic_monitor.py              # last 90 days, all horizons
python ic_monitor.py --horizon 3m # 3m forward return only
```

---

## 9. Regime Filter

*Implemented in `backend/regime.js` — called from `refresh-cache.js`.*

Three independent signals vote on market regime each nightly run:

| Signal | Risk-on | Neutral | Risk-off |
|---|---|---|---|
| India VIX | < 15 | 15–20 | > 20 |
| Nifty breadth (% above 200DMA) | > 60% | 40–60% | < 40% |
| FII 5-day net flow | > 0 | — | < 0 |
| Nifty 3M return | > +5% | −5% to +5% | < −5% |

**Score docks applied by `applyRegime()`:**

```
risk_off:
  • Stocks below 200DMA OR rsVsNifty3M < −10%  → −12 pts regimePenalty
  • overextensionPenalty amplified ×1.5

neutral:
  • Stocks below 200DMA OR rsVsNifty3M < −10%  → −4 pts regimePenalty
```

All penalty fields (`regimePenalty`, `liquidityPenalty`, `sectorCapPenalty`, `regimeOverextPenalty`) are **positive magnitudes** — the caller does `compositeScore − penalty`. `overextensionPenalty` is **negative** (already a deduction from `eodSignalScore`).

---

## 10. Portfolio Guards

*Implemented in `backend/portfolio_guards.js` — `applySectorCap()` called after sorting.*

Within the top-50 window, no single sector may occupy more than **30%** of picks (= 15 slots). Names beyond the cap are docked 6 points (`SECTOR_CAP_DOCK = 6`) and the list is re-sorted:

```
topN = 50  →  sectorCap = 15 stocks per sector
names[16+] in a sector: sectorCapPenalty += 6, compositeScore -= 6
```

This prevents a single sector (e.g. IT or Banking) from dominating picks during a sector rally, protecting portfolio diversification.

---

## 11. Realized P&L Tracking

*Implemented in `ml/track_pick_outcomes.py` — backfills `pick_history`.*

Every nightly run snapshots the top-100 picks. `track_pick_outcomes.py` backfills realized returns 5, 10, and 21 days after each snapshot, using OHLCV prices from `stock_features`.

**Net-of-cost hit rate** (the right metric — not gross):

```
ROUND_TRIP_COST_PCT = 0.30%   (brokerage + STT + market impact)
net_hit = % of picks where ret_21d > 0.30%

This is the single source of truth in both:
  - track_pick_outcomes.py (full 120d backfill)
  - health_report.py (60d rolling digest)
```

Results surface in the Admin dashboard as "21d net hit rate."

---

## 12. Shared Infrastructure

### script_runner.py

Every `ml/*.py` script's `__main__` block calls:
```python
from script_runner import run
run(main)
```

This wraps `main()` and calls `os._exit()` instead of normal Python exit — bypassing supabase-py's C++ background thread teardown that caused `SIGABRT` crashes on GitHub Actions. All 15 ML scripts share this pattern.

### insert_model_run() — oos.py

Both `train.py` (MF) and `train_stock.py` (stocks) use a shared `insert_model_run(supabase, table, row)` helper in `oos.py`. If the `oos_*` columns don't exist (migration 012 not yet applied), it retries without them and logs a warning rather than crashing.

---

## 13. Accuracy & Effectiveness

### 13.1 Walk-Forward Backtest (MF Model)

*Setup: 4 folds · 180-day training window · 60-day test steps · Jun 2025 – Feb 2026*

```
Fold  Test Window          Regime   AUC    P@Q1    Return%  Alpha
────  ───────────────────  ───────  ─────  ──────  ───────  ──────
  1   Jul – Aug 2025       Neutral  0.737  54.7%   +0.4%    +0.4%
  2   Aug – Oct 2025       Neutral  0.758  55.0%   -0.9%    +0.2%  (benchmark also fell)
  3   Oct – Dec 2025       Neutral  0.651  42.4%   -0.3%    +0.9%
  4   Dec 2025 – Feb 2026  Neutral  0.690  45.1%   +2.3%    +2.3%
  ─   ─────────────────    ───────  ─────  ──────  ───────  ──────
 Avg  (compound)                    0.709  49.3%    —       +1.55% CAGR alpha
```

### 13.2 How to Read AUC for Finance

```
AUC 0.50 = Random — coin flip
AUC 0.55 = Weak signal — marginally better than random (ML blend gate threshold)
AUC 0.62 = Moderate — ML blend fully weighted at this level
AUC 0.65 = Moderate — academic papers often report this
AUC 0.70 = Strong — genuine predictive edge in financial markets  ← MF model
AUC 0.80 = Very strong — rare without lookahead bias
AUC 1.00 = Perfect — impossible on live data (lookahead bias)
```

### 13.3 Precision@Q1 — The Right Framing

Precision@Q1 = 52.5% means our top picks land in the actual top quartile 52.5% of the time.

```
Random baseline:    25%   (1-in-4 chance by definition)
MF model:          52.5%  ← 2.1× lift
```

### 13.4 Asymmetric Error — Why Mistakes Are Acceptable

```
When CORRECT (52.5% of picks):  avg return  +1.22% per quarter
When WRONG   (47.5% of picks):  avg return  -0.26% per quarter

Gain/Loss ratio:  4.7x  (wins are 4.7× larger than losses on average)
```

### 13.5 Known Limitation — High-Beta Bias

The model has a **high-beta bias**: it tends to select sector funds with higher drawdowns than the category median.

```
Mean max drawdown (1Y) of selected funds:  -18.4%
Mean max drawdown (1Y) of full universe:   -15.9%
Gap:                                       -2.5 percentage points
```

**Cause:** `max_dd_1y` is the #1 feature — the model learned that funds that *recovered from* big drawdowns tend to be top-quartile. But it sometimes selects funds *currently in* a high-drawdown state.

**Mitigation:** MDD Gate — ML Score contribution is halved for funds with `max_dd_1y < −25%`.

**For stocks:** the Sharpe-quartile target (`p_top_sharpe_q_3m`) partially addresses this — high-beta names that generate big raw returns but with large drawdowns are penalised by the Sharpe metric. The ML blend gate prefers this signal.

---

## 14. Data Pipeline

### 14.1 Data Sources & Update Frequency

```
┌───────────────────────────────────────────────────────────────────────┐
│                        NIGHTLY  (5 AM IST, weekdays)                  │
│                        GitHub Actions                                 │
├─────────────────┬─────────────────────────────────────────────────────┤
│ Data Source     │ What it feeds                                       │
├─────────────────┼─────────────────────────────────────────────────────┤
│ mfapi.in        │ Daily NAV for ~100 MFs → mf_features               │
│                 │  (24h disk cache; stale-on-error AMFI fallback)     │
│ NSE Bhavcopy    │ Primary OHLCV + delivery % for all CM stocks        │
│   (archive CSV) │  (incremental — only new dates downloaded)          │
│ Yahoo Finance v8│ Nifty 50, India VIX (primary), stock OHLCV fallback │
│ NSE Kite        │ India VIX fallback when Yahoo v8 unavailable        │
│ FRED (St. Louis)│ US 10Y Treasury yield (60yr daily history, free)   │
│ ECB via FF      │ USD/INR fallback when Yahoo rate-limits             │
│ NSE Discovery   │ Bulk deals, OI, 52W highs (intraday only)          │
├─────────────────┼─────────────────────────────────────────────────────┤
│                        WEEKLY  (Mon midnight IST)                     │
├─────────────────┼─────────────────────────────────────────────────────┤
│ Claude Haiku    │ News headlines → sentiment_score per fund/stock      │
│ (Anthropic API) │  (requires ANTHROPIC_API_KEY; -1.0 to +1.0 score)  │
├─────────────────┼─────────────────────────────────────────────────────┤
│                        ON DEMAND                                       │
├─────────────────┼─────────────────────────────────────────────────────┤
│ Optuna          │ Hyperparameter tuning (--tune, ~30 min, ~50 trials) │
│ SHAP            │ Per-fund feature attribution stored in predictions  │
└─────────────────┴─────────────────────────────────────────────────────┘
```

**India VIX status:** Fixed (Jun 2026). Now uses Yahoo Finance v8 API as primary source with NSE Kite as fallback. Previously 100% null due to Yahoo rate-limiting.

**NSE Bhavcopy:** Replaced Stooq/Yahoo as primary OHLCV source for stocks (Jun 2026). Incremental download — only fetches dates not already in the local cache, preventing ML timeout when prior sources were blocked.

### 14.2 Full Pipeline Flow

```
                     ┌──────────────────┐
                     │   GitHub Actions │  Triggers: 5 AM IST, Mon–Fri
                     │    (nightly)     │
                     └────────┬─────────┘
                              │
         ┌────────────────────┼─────────────────────┐
         ▼                    ▼                     ▼
 extract_features.py  extract_stock_features.py  macro_features.py
 (MF NAV → 40 feats)  (NSE bhavcopy + Yahoo      (Nifty · VIX · FII ·
 → mf_features         → ~80 cols per stock)      USD/INR · US10Y)
                       → stock_features
         │                    │
         ▼                    ▼
  label_targets.py    label_stock_targets.py
  (fwd_top_q_3m)      (fwd_top_q_3m + fwd_top_sharpe_q_3m)
  staleness gate:      staleness gate:
  14d for 3M labels    14d for 3M labels
         │                    │
         ▼                    ▼
      train.py          train_stock.py
  • TimeSeriesSplit    • TimeSeriesSplit 5-fold CV
  • OOS holdout (90d)  • OOS holdout (90d) → oos_auc
  • SHAP attribution   • Dual target (raw + Sharpe)
  → mf_predictions     → stock_predictions
  → mf_model_runs      → stock_model_runs
         │                    │
         ▼                    ▼
   health_report.py    ic_monitor.py        track_pick_outcomes.py
   (5-component         (rolling Spearman    (5d/10d/21d realized
    nightly digest)      IC per signal)       returns, net-of-cost)
   → system_health      → signal_ic_history  → pick_history (backfill)
         │
         ▼
    Frontend (React)
    Stock ML: blend gated by OOS AUC (ml_blend.js: weight 0→0.35)
    MF ML: p_top_quartile_3m shown as "ML Score %"
```

### 14.3 Label Construction

The target is computed with a **forward 90-day window**. `max_label_gap_days()` controls staleness tolerance:

```python
max_label_gap_days(fwd_days=90) → 14   # 3M labels
max_label_gap_days(fwd_days=30) → 7    # 1M labels
```

Only rows where the outcome is already known are used for training. Predictions for the current date use the most recent feature snapshot; the label is `unknown` and resolves 90 days later.

---

## 15. Composite Score Formula

### Mutual Funds

```
Composite Score = Momentum Score × 65%
               + Analyst Verdict × 35%

When ML predictions are present:
Composite Score = Momentum Score × 50%
               + Analyst Verdict × 25%
               + ML Score × 25%

MDD Gate:
  max_dd_1y < −25%  → ML Score × 0.5 penalty
  max_dd_1y < −20%  → warning badge shown
```

### Stocks

```
Step 1:  compositeScore = eodSignalScore(30+ signals)
Step 2:  + fundamentals adjustment (market-cap tier, earnings/ROE)
Step 3:  applyMlBlend():  compositeScore = (1−w) × score + w × mlPercentile
           w = 0 if OOS AUC < 0.55; ramps to 0.35 at AUC = 0.62
           prefers p_top_sharpe_q_3m > p_top_quartile_3m
Step 4:  applyRegime(): dock weak names by −4 (neutral) or −12 (risk_off)
Step 5:  eodBaseScore = compositeScore  (snapshot for intraday runs)
Step 6:  EMA smoothing: 0.6 × rawScore + 0.4 × prevEodScore
Step 7:  +5 incumbent hysteresis (stocks in yesterday's top 50)
Step 8:  applySectorCap(): −6 to names beyond 30% sector share in top-50
```

---

## 16. Illustrative Example — How a Fund Gets Its ML Score

**Fund: HDFC Mid Cap Opportunities** · Category: Mid Cap

*Scenario: The model outputs a score of 72% (Positive)*

```
Feature Snapshot (as of today):
──────────────────────────────────────────────────────────────────
ret1w:  +2.1%      z1w: +1.4 (Hot)     cat_rank_1m: 3/12 (top 25%)
ret3m:  +8.4%      max_dd_1y: -14.2%   beta_nifty: 0.91
cagr10y: +17.8%    sharpe_1y: 1.42     corr_nifty: 0.82
vol_1y:  18.2%     positive_months: 8/12
cat_rel_max_dd_1y: +1.7%   (better than category median)
──────────────────────────────────────────────────────────────────

How the model reads this:
  ✓  cagr10y = +17.8% → strong long-run quality (Feature #3)
  ✓  max_dd_1y = -14.2% → better than universe median of -15.9% (Feature #1)
  ✓  cat_rel_max_dd_1y = +1.7% → better than category median (new feature)
  ✓  cat_rank_1m = top 25% → already outperforming in category
  ✓  sharpe_1y = 1.42 → risk-adjusted quality is high
  ✗  corr_nifty = 0.82 → highly correlated, low diversification (Feature #2, mild negative)

LightGBM output (uncalibrated):  0.68
After isotonic calibration:       0.72   ← ML Score shown as 72%
```

---

## 17. Model Monitoring (Built-in)

### Nightly Health Digest (`health_report.py`)

Five components written to `system_health` table (migration 013) and posted to `GITHUB_STEP_SUMMARY`:

| Component | What it checks | Status levels |
|---|---|---|
| `sources` | probe_sources.json — each data source up/down/degraded | ok / warn / critical |
| `freshness` | Age of most recent `stock_features` and `mf_features` rows | ok / warn / critical |
| `ic` | Latest rolling Spearman IC per signal; `sign_flipped` count | ok / warn / critical |
| `model` | Latest OOS AUC vs CV AUC gap; blend active/inactive | ok / warn / critical |
| `outcomes` | 21d net hit rate for top-50 picks (net of 0.30% cost) | ok / warn / critical |

### Per-Training Checks

| Check | Trigger | Action |
|---|---|---|
| **Null-rate audit** | Any feature >20% null | `WARNING` log before training |
| **Prediction distribution** | Std of all predictions < 0.05 | `WARNING` — model not discriminating |
| **SHAP stability** | Top-5 features vs previous run | `mild_drift` if 4/5 match; `WARNING` if ≤3/5 |
| **OOS AUC** | Each training run | Logged to `stock_model_runs`; blend weight set accordingly |
| **IC monitor** | Nightly | Rolling 30-date Spearman IC; alerts on `sign_flipped` |
| **Realized hit rate** | Nightly | Net-of-cost 21d hit rate from `pick_history` |

---

## 18. How the Model Can Get Better

### Done ✅ (shipped Jun 2026)

| Improvement | Status |
|---|---|
| **India VIX** activated | ✅ Fixed — Yahoo Finance v8 + Kite fallback |
| **Sharpe-quartile target** (`fwd_top_sharpe_q_3m`) | ✅ Live — both trainers produce `p_top_sharpe_q_3m`; blend prefers it |
| **OOS walk-forward evaluation** | ✅ Live — 90-day holdout, `oos_auc` logged per run |
| **Sector-relative z-scores** (16 features) | ✅ Live — all sector_rel_* in stock_features |
| **FII/DII flow features** (6 features) | ✅ Live — fii_net_*, dii_net_*, fiidii_net_* |
| **Delivery % features** | ✅ Live — delivery_pct, delivery_pct_5d_avg from NSE bhavcopy |
| **Blocklist-based feature discovery** | ✅ Live — get_stock_feature_cols(df) in config.py |
| **Regime-adaptive scoring** | ✅ Live — regime.js, 3-signal vote, risk_off −12 dock |
| **Sector concentration cap** | ✅ Live — portfolio_guards.js, 30% cap, −6 dock |
| **Realized P&L tracking** | ✅ Live — track_pick_outcomes.py, net-of-cost hit rate |
| **IC drift monitor** | ✅ Live — ic_monitor.py, signal_ic_history, sign_flipped |
| **Earnings momentum features** | ✅ In DB — eps_beat_rate_4q, eps_surprise_avg_4q, eps_qoq_slope (JS scoring layer only) |

### Medium-term (1–3 months)

| Improvement | Expected AUC gain | Effort |
|---|---|---|
| **More labeled data** — each nightly run adds ~500 stock rows; AUC improves as window grows past 1 year | +0.020–0.040 | Zero — automatic |
| **Bear-market folds** — 2022 bear market entering training window | Regime robustness | Automatic |
| **Category-group models** for MF (separate equity/sector/debt) | +0.010–0.030 | Low — `CATEGORY_GROUPS` in config.py, needs `--category-groups` flag |
| **SIP flow proxy** — AMFI monthly category inflows | +0.010–0.020 | Medium |
| **News sentiment backfilled** (historical RSS archives) | +0.010–0.020 | Medium |

### Structural (3–6 months)

| Improvement | Expected gain | Effort |
|---|---|---|
| **Longer horizon (6m model)** | Stable picks, less noise | Medium |
| **Ensemble** — blend 3m + 1m model outputs | +0.005–0.010 | Low |
| **AMC-level signals** — whether the AMC as a whole is outperforming (manager quality) | Novel signal | High |
| **Drawdown regime model** — separate model for bear-market data | Reduces high-beta bias in corrections | High |
| **Options analytics** — IV rank, unusual call/put overlay on top picks | Novel signal | Medium |
| **Direct broker execution API** — Zerodha Kite / ICICI iDirect one-click trade | Product | High |

---

## 19. Limitations & Caveats

```
┌─────────────────────────────────────────────────────────────────┐
│                        ⚠  KNOWN LIMITATIONS                    │
├─────────────────────────────────────────────────────────────────┤
│ 1. SHORT HISTORY — ~12 months of labeled data (Jun 2025 –      │
│    Jun 2026). All backtest folds are "neutral" market regime.   │
│    Model has NOT been tested in a prolonged bear market.        │
│                                                                 │
│ 2. MF PRECISION SCALE — 100 funds × 25% = 25 top-quartile     │
│    slots. 2 fund switches flip Precision@Q1 by ~8 pp.          │
│    AUC is more reliable than precision at this scale.           │
│                                                                 │
│ 3. HIGH-BETA BIAS — Model selects funds/stocks with slightly   │
│    higher drawdowns than universe average.                      │
│    Mitigated by MDD gate (MF) and Sharpe-quartile target        │
│    (stocks) but not eliminated.                                 │
│                                                                 │
│ 4. NULL FEATURES — sentiment_score is null for historical      │
│    data. Stock OOS AUC varies by run; blend may be inactive     │
│    if model edge is below gate threshold (0.55).                │
│                                                                 │
│ 5. CATEGORY-RELATIVE TARGET — A "Buy" in Liquid Funds is top   │
│    quartile among liquid funds, NOT the same as "buy equity."   │
│    The model does not compare across asset classes.             │
│                                                                 │
│ 6. NOT FINANCIAL ADVICE — ML Score is one signal among many.   │
│    Technical regime filter, sector cap, and momentum score      │
│    all carry significant weight alongside the ML probability.   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 20. Technical Glossary

| Term | Definition |
|---|---|
| **AUC (Area Under ROC Curve)** | Probability that the model ranks a random top-quartile fund above a random non-top-quartile fund. 0.5 = random, 1.0 = perfect. |
| **OOS AUC** | Walk-forward out-of-sample AUC — the last 90 days of labeled history held out from training. More conservative and honest than CV AUC. |
| **Precision@Q1** | Of the funds the model selects as likely top-quartile, what % actually are? (Base rate = 25%) |
| **TimeSeriesSplit** | Cross-validation that respects time order — each fold's validation data is strictly after its training data. Prevents lookahead bias. |
| **Isotonic calibration** | Post-processing step that converts model scores into true probabilities using a monotone function fitted on held-out data. |
| **SHAP** | SHapley Additive exPlanations — assigns each feature a contribution to each individual prediction. Enables "why this fund?" explanations. |
| **top-quartile target** | Binary label: 1 if fund/stock is in the top 25% of its category by return over the next 90 days, else 0. |
| **Sharpe-quartile target** | Binary label: 1 if the fund/stock's 3M Sharpe ratio is in the top 25% of its sector. Penalises high-beta names. |
| **Walk-forward backtest** | Simulate live trading: train on past, predict on future, advance window by 60 days, repeat. More realistic than random K-fold. |
| **High-beta bias** | Model tendency to select funds with high market sensitivity, which can underperform in corrections even if they outperform on average. |
| **MDD gate** | Scoring rule: if max drawdown > 25%, halve the ML Score contribution. Reduces high-beta bias in the composite score. |
| **Blend gate** | `ml_blend.js` rule: blend weight = 0 if OOS AUC < 0.55. Prevents a random-chance model from influencing stock picks. |
| **IC (Information Coefficient)** | Spearman rank correlation between a signal and forward return. IC > 0 = signal adds value. Rolling IC drift indicates regime change. |
| **ROUND_TRIP_COST_PCT** | 0.30% — brokerage + STT + market impact for a liquid NSE round-trip. Used by hit-rate calculations to report net-of-cost performance. |
| **eodBaseScore** | Snapshot of `compositeScore` taken after `applyRegime()` during the nightly EOD run. Used as the stable base by `refresh-intraday.js` so intraday updates don't re-run the ML model. |
| **Blocklist discovery** | `get_stock_feature_cols(df)` returns all numeric columns not in the blocklist. New features are auto-included on the next training run — no code change needed. |

---

*Fin Intel ML Pipeline · Contact: manjunathts@gmail.com · Repo: manjunathts-png/fin-intel*
