# Fin Intel — ML Prediction Models
### Mutual Funds & Stocks · Technical Reference & Business Summary
*Updated: June 2026*

---

## Executive Summary

Fin Intel uses a **gradient-boosted tree classifier (LightGBM)** to rank mutual funds and stocks by the probability of outperforming their peers over the next 3 months. The model does not predict absolute returns — it predicts *relative rank within a category/sector*. An 80% ML Score means the model believes this fund has an 80% probability of landing in the top quartile of its category in the next quarter.

| | Mutual Funds | Stocks |
|---|---|---|
| **Universe** | 75 funds · 18 categories | ~158 stocks · 17 sectors |
| **Algorithm** | LightGBM + Isotonic Calibration | LightGBM + Isotonic Calibration |
| **Target** | Top-quartile in category (3m) | Top-quartile in sector (3m) |
| **CV AUC** | **0.730** | In progress |
| **Precision@Q1** | **52.5%** (2.1× lift over 25% base) | In progress |
| **CAGR Alpha** | **+1.55%** vs equal-weight benchmark | — |
| **Retrain frequency** | Nightly (5 AM IST) | Nightly |
| **Features** | 34 (32 active) | 47 |

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
```

### Why LightGBM?
- Handles missing values natively (no imputation needed for sparse macro features)
- Trains in seconds on our dataset size (~15k rows)
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

### 3.2 Feature Set (34 defined, 32 active)

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

STYLE vs BENCHMARK (3 features)
├── beta_nifty   — Sensitivity to Nifty moves (OLS, trailing 1Y daily)
├── alpha_nifty  — Excess return vs Nifty (Jensen's alpha)
└── corr_nifty   — Correlation with Nifty (diversification signal)  ⭐ #2 feature

MACRO CONTEXT (5 features)
├── nifty_ret1m   — Nifty 50 1-month return
├── nifty_ret3m   — Nifty 50 3-month return
├── india_vix     — India Volatility Index (⚠ currently null — Yahoo rate-limited)
├── usd_inr       — USD/INR exchange rate (via Yahoo → ECB fallback)
└── us_10y_yield  — US 10Y Treasury yield (via Yahoo → FRED fallback)

SENTIMENT (1 feature)
└── sentiment_score  — News sentiment score -1 to +1 (Claude Haiku, weekly)
                       (currently null for historical data; live-only going forward)
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

---

## 4. Stocks Model

### 4.1 How It Differs from the MF Model

The stocks model uses the same LightGBM + calibration architecture but adds **technical indicators** and **fundamental factors** that are unavailable for mutual funds (which don't have intraday prices or P/E ratios).

| | MF Model | Stock Model |
|---|---|---|
| n_estimators | 500 | 400 |
| learning_rate | 0.04 | 0.05 |
| Features | 34 | 47 |
| Unique to stocks | — | RSI, MACD, Bollinger Bands, P/E, P/B, ROE, revenue growth, earnings growth, debt/equity, dividend yield |
| Universe | 75 funds · 18 categories | ~158 stocks · 17 sectors |

### 4.2 Additional Stock Features (13 extra vs MF model)

```
TECHNICAL INDICATORS (5 features)
├── rsi_14       — RSI (14-day): momentum oscillator 0–100
├── macd_hist    — MACD histogram: trend strength and direction
├── bb_pct       — Bollinger Band %: where price sits within the band
├── vol_ratio    — Volume ratio (20-day vs 50-day avg): unusual activity signal
└── high52w_pct  — % below 52-week high: identifies breakout candidates

FUNDAMENTALS (8 features)
├── pe_ratio         — Price / Earnings (valuation)
├── pb_ratio         — Price / Book (asset value)
├── roe              — Return on Equity (management quality)
├── revenue_growth   — YoY revenue growth
├── earnings_growth  — YoY earnings growth
├── profit_margins   — Net margin
├── debt_to_equity   — Leverage / financial risk
└── dividend_yield   — Income signal / value proxy
```

### 4.3 Stock Universe (17 Sectors)

| Sector | Stocks |
|---|---|
| IT | 11 (TCS, Infosys, HCL Tech, Wipro, Tech Mahindra, Coforge, Persistent, Mphasis, OFSS, Netweb, Techno Electric) |
| Banking - Private | 8 (HDFC Bank, ICICI, Kotak, Axis, IndusInd, Federal, IDFC First, RBL) |
| Banking - PSU | 6 (SBI, BoB, PNB, Canara, Union, Indian) |
| Auto & EV | 12 (Maruti, M&M, Ashok Leyland, Bajaj Auto, Hero, Eicher, + EV plays) |
| Pharma | ~ |
| FMCG | ~ |
| Metals & Mining | ~ |
| Energy & Oil | ~ |
| Capital Goods & Defence | ~ |
| Finance - NBFC | ~ |
| Real Estate | ~ |
| Telecom | ~ |
| Consumption & Retail | ~ |
| Chemicals & Fertilisers | ~ |
| Cables & Electronics | ~ |
| Cement & Construction | ~ |
| Diversified | ~ |
| **Total** | **~158 stocks** |

---

## 5. Accuracy & Effectiveness

### 5.1 Walk-Forward Backtest (MF Model)

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

**How to read AUC for finance:**
```
AUC 0.50 = Random — coin flip
AUC 0.55 = Weak signal — marginally better than random
AUC 0.65 = Moderate — academic papers often report this
AUC 0.70 = Strong — genuine predictive edge in financial markets  ← we are here
AUC 0.80 = Very strong — rare without lookahead bias
AUC 1.00 = Perfect — impossible on live data (lookahead bias)
```

### 5.2 Precision@Q1 — The Right Framing

Precision@Q1 = 52.5% means our top picks land in the actual top quartile 52.5% of the time.

```
Random baseline:    25%   (1-in-4 chance by definition)
Our model:          52.5%  ← 2.1× lift
```

This is **not** to be compared against "percentage of time the fund goes up." In a neutral market, most funds either slightly gain or slightly lose. The question we answer is: *among all funds in this category, are our picks more likely than random to be in the top 25%?* The answer is: yes, 2.1× more likely.

### 5.3 Asymmetric Error — Why Mistakes Are Acceptable

When the model is wrong, the cost is low:

```
When CORRECT (52.5% of picks):  avg return  +1.22% per quarter
When WRONG   (47.5% of picks):  avg return  -0.26% per quarter

Gain/Loss ratio:  4.7x  (wins are 4.7× larger than losses on average)
```

This asymmetry is why AUC 0.730 translates to real alpha even at 50% win rate on folds — the magnitude of wins dwarfs the magnitude of misses.

### 5.4 Known Limitation — High-Beta Bias

The model has a **high-beta bias**: it tends to select sector funds with higher drawdowns than the category median.

```
Mean max drawdown (1Y) of selected funds:  -18.4%
Mean max drawdown (1Y) of full universe:   -15.9%
Gap:                                       -2.5 percentage points
```

**Cause:** `max_dd_1y` is the #1 feature — the model has learned that funds that *recovered from* big drawdowns are more likely to be top-quartile. But it sometimes selects funds *currently in* a high-drawdown state.

**Mitigation implemented:** MDD Gate in the scoring pipeline — ML Score is penalised 50% for funds with max_dd_1y < -25%, and these funds are moved from "Buy" to "Watch" unless analyst conviction is High.

---

## 6. Data Pipeline

### 6.1 Data Sources & Update Frequency

```
┌───────────────────────────────────────────────────────────────────────┐
│                        NIGHTLY  (5 AM IST)                            │
│                        GitHub Actions                                 │
├─────────────────┬─────────────────────────────────────────────────────┤
│ Data Source     │ What it feeds                                       │
├─────────────────┼─────────────────────────────────────────────────────┤
│ mfapi.in        │ Daily NAV for 75 MFs → mf_features                 │
│                 │  (stale-on-error fallback; 24h local cache)         │
│ Yahoo Finance   │ Nifty 50, USD/INR, India VIX, stock OHLCV          │
│ FRED (St. Louis)│ US 10Y Treasury yield (60yr daily history, free)   │
│ ECB via FF      │ USD/INR fallback when Yahoo rate-limits             │
│ NSE Bhavcopy    │ Daily stock OHLCV CSV for all CM-segment stocks     │
├─────────────────┼─────────────────────────────────────────────────────┤
│                        WEEKLY  (Mon midnight IST)                     │
├─────────────────┼─────────────────────────────────────────────────────┤
│ Claude Haiku    │ News headlines → sentiment_score per fund           │
│ (Anthropic API) │  (fund-specific news search → -1.0 to +1.0 score)  │
├─────────────────┼─────────────────────────────────────────────────────┤
│                        ON DEMAND                                       │
├─────────────────┼─────────────────────────────────────────────────────┤
│ Optuna          │ Hyperparameter tuning (--tune, ~30 min, ~50 trials) │
│ SHAP            │ Per-fund feature attribution stored in predictions  │
└─────────────────┴─────────────────────────────────────────────────────┘
```

### 6.2 Full Pipeline Flow

```
                     ┌──────────────────┐
                     │   GitHub Actions │  Triggers: 5 AM IST daily
                     │    (nightly)     │
                     └────────┬─────────┘
                              │
              ┌───────────────▼────────────────┐
              │       extract_features.py       │
              │  8 parallel workers             │
              │  mfapi.in NAV → 34 features     │
              │  per fund per day → mf_features │
              └───────────────┬────────────────┘
                              │
              ┌───────────────▼────────────────┐
              │       macro_features.py         │
              │  Nifty · VIX · USD/INR · US10Y  │
              │  → appended to mf_features      │
              └───────────────┬────────────────┘
                              │
              ┌───────────────▼────────────────┐
              │        label_targets.py         │
              │  Look ahead 90 days             │
              │  Rank funds within category     │
              │  Top 25% → fwd_top_q_3m = 1    │
              │  (staleness guard: skip if      │
              │   NAV gap > 30 days)            │
              └───────────────┬────────────────┘
                              │
              ┌───────────────▼────────────────┐
              │           train.py             │
              │  • Null-rate audit              │
              │  • TimeSeriesSplit 5-fold CV    │
              │  • LightGBM + isotonic calib.  │
              │  • SHAP feature attribution     │
              │  • Prediction health check      │
              │  • SHAP stability comparison   │
              │  → mf_predictions              │
              │  → mf_model_runs (audit log)   │
              └───────────────┬────────────────┘
                              │
              ┌───────────────▼────────────────┐
              │         Frontend (React)        │
              │  ML Score shown as %           │
              │  Blended into composite score  │
              │  (50% momentum + 25% verdict   │
              │   + 25% ML Score)              │
              └────────────────────────────────┘
```

### 6.3 Label Construction

The target is computed with a **forward 90-day window**:

```
Today (T)                T + 90 days
    │                         │
    ●─────────────────────────●
    │                         │
  Feature                Forward return
  snapshot               computed here
  (all 34 cols)          
                         All funds ranked within category
                         Top 25% → label = 1
                         Bottom 75% → label = 0
```

This means only rows where we *already know the outcome* are used for training. Predictions for the current date use the most recent feature snapshot, and the label is `unknown` (will be resolved 90 days later when the nightly pipeline runs).

---

## 7. Composite Score Formula

The ML Score is one of three inputs to the final fund ranking shown in the UI:

```
                    ┌─────────────────────────────────────────┐
                    │           Composite Score               │
                    │                                         │
                    │  = Momentum Score × 50%                 │
                    │  + Analyst Verdict × 25%                │
                    │  + ML Score × 25%                       │
                    │                                         │
                    │  (Before ML data: 65% momentum,         │
                    │   35% verdict)                          │
                    └─────────────────────────────────────────┘

                    MDD Gate (override):
                    • max_dd_1y < −25%  → ML Score × 0.5 penalty
                    • max_dd_1y < −20%  → warning badge shown
                    • MDD-penalised + not High confidence → move to Watch
```

---

## 8. Illustrative Example — How a Fund Gets Its ML Score

**Fund: HDFC Mid Cap Opportunities** · Category: Mid Cap

*Scenario: The model outputs a score of 72% (Positive)*

```
Feature Snapshot (as of today):
──────────────────────────────────────────────────────────────────
ret1w:  +2.1%      z1w: +1.4 (Hot)     cat_rank_1m: 3/12 (top 25%)
ret3m:  +8.4%      max_dd_1y: -14.2%   beta_nifty: 0.91
cagr10y: +17.8%    sharpe_1y: 1.42     corr_nifty: 0.82
vol_1y:  18.2%     positive_months: 8/12
──────────────────────────────────────────────────────────────────

How the model reads this:
  ✓  cagr10y = +17.8% → strong long-run quality (Feature #3)
  ✓  max_dd_1y = -14.2% → below universe median of -15.9% (Feature #1, positive signal)
  ✓  cat_rank_1m = top 25% → already outperforming in category
  ✓  sharpe_1y = 1.42 → risk-adjusted quality is high
  ✗  corr_nifty = 0.82 → highly correlated, low diversification value (Feature #2, mild negative)
  ✗  india_vix = NULL → macro context incomplete

LightGBM output (uncalibrated):  0.68
After isotonic calibration:       0.72   ← ML Score shown as 72%

Final Composite Score:
  Momentum Score (ret1w × 0.25 + ret1m × 0.20 + ...):  normalised to 74
  Analyst Verdict (Buy · Medium confidence):             +20 verdict points
  ML Score (72%):                                        72

  Composite = 74 × 50% + 20 × 25% + 72 × 25% = 37 + 5 + 18 = 60
  → Section: WATCH (Buy but Medium confidence, moved to Watch)
```

---

## 9. Model Monitoring (Built-in)

Every nightly run automatically checks:

| Check | Trigger | Action |
|---|---|---|
| **Null-rate audit** | Any feature >20% null | `WARNING` log before training |
| **Prediction distribution** | Std of all predictions < 0.05 | `WARNING` — model not discriminating |
| **SHAP stability** | Compare top-5 features vs previous run | `mild_drift` if 4/5 match; `WARNING` if ≤3/5 |
| **Model version hash** | Feature set changes | Version string changes: `lgbm_v1.0_3m_{date}_{hash}` |
| **Walk-forward backtest** | On demand | `python backtest.py --folds 4 --train-days 180` |

---

## 10. How the Model Can Get Better

### Immediate (< 1 month)

| Improvement | Expected AUC gain | Effort |
|---|---|---|
| **India VIX** activated (auto when Yahoo unblocks) | +0.005–0.015 | Zero — already wired |
| **News sentiment** backfilled (historical RSS) | +0.010–0.020 | Medium |
| **Category-group models** (separate equity/sector/debt) | +0.010–0.030 | Low — already coded, needs `--category-groups` flag |

### Medium-term (1–3 months)

| Improvement | Expected AUC gain | Effort |
|---|---|---|
| **More labeled data** — each nightly run adds 75 rows; AUC should improve as window grows past 1 year | +0.020–0.040 | Zero — automatic |
| **SIP flow proxy** — AMFI publishes monthly category inflows; strong inflow = momentum signal | +0.010–0.020 | Medium |
| **Bear-market folds** — 2022 bear market will enter training window in ~1 year | Regime robustness | Automatic |
| **Sector rotation signal** — cross-category momentum (e.g. pharma outperforming equity → sector funds rotate up) | +0.010–0.025 | Medium |

### Structural (3–6 months)

| Improvement | Expected gain | Effort |
|---|---|---|
| **Sharpe-quartile target** (`fwd_top_sharpe_q_3m`) instead of raw-return quartile — rewards risk-adjusted outperformance, reduces high-beta bias | MDD gap ↓ by ~30% | Low — already coded (`--sharpe-target`) |
| **Longer horizon (6m model)** — less noise, more persistence | Stable picks | Medium |
| **Ensemble** — blend 3m + 1m model outputs | +0.005–0.010 | Low |
| **Nifty 500 stocks fundamentals** from screener.in API | Better stock model | Medium |
| **AMC-level signals** — track whether AMC as a whole is outperforming (manager quality) | Novel signal | High |
| **Drawdown regime model** — separate model trained only on bear-market data | Reduces high-beta bias in corrections | High |

---

## 11. Limitations & Caveats

```
┌─────────────────────────────────────────────────────────────────┐
│                        ⚠  KNOWN LIMITATIONS                    │
├─────────────────────────────────────────────────────────────────┤
│ 1. SHORT HISTORY — Only 9 months of labeled data (Jun 2025 –   │
│    Feb 2026). All 4 backtest folds are "neutral" market regime. │
│    Model has NOT been tested in a bear market (2022-type).      │
│                                                                 │
│ 2. SMALL PREDICTION SET — 75 funds = 19 top-quartile slots.    │
│    2 fund switches flip Precision@Q1 by 10 percentage points.  │
│    AUC is more reliable than precision at this scale.           │
│                                                                 │
│ 3. HIGH-BETA BIAS — Model selects funds with slightly higher   │
│    drawdowns than universe average (-18.4% vs -15.9%).         │
│    Mitigated by MDD gate but not eliminated.                   │
│                                                                 │
│ 4. NULL FEATURES — india_vix is 100% null (Yahoo rate-limited).│
│    sentiment_score is null for historical data.                 │
│    Both will improve automatically over time.                   │
│                                                                 │
│ 5. CATEGORY-RELATIVE TARGET — A "Buy" in Liquid Funds is top   │
│    quartile among liquid funds, NOT the same as "buy equity."  │
│    The model does not compare across asset classes.            │
│                                                                 │
│ 6. NOT FINANCIAL ADVICE — ML Score is one signal among many.   │
│    Analyst verdict and momentum score carry equal weight.       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 12. Technical Glossary

| Term | Definition |
|---|---|
| **AUC (Area Under ROC Curve)** | Probability that the model ranks a random top-quartile fund above a random non-top-quartile fund. 0.5 = random, 1.0 = perfect. |
| **Precision@Q1** | Of the funds the model selects as likely top-quartile, what % actually are? (Base rate = 25%) |
| **TimeSeriesSplit** | Cross-validation that respects time order — each fold's validation data is strictly after its training data. Prevents lookahead bias. |
| **Isotonic calibration** | Post-processing step that converts model scores into true probabilities using a monotone function fitted on held-out data. |
| **SHAP** | SHapley Additive exPlanations — assigns each feature a contribution to each individual prediction. Enables "why this fund?" explanations. |
| **top-quartile target** | Binary label: 1 if fund is in the top 25% of its category by return over the next 90 days, else 0. |
| **Walk-forward backtest** | Simulate live trading: train on past, predict on future, advance window by 60 days, repeat. More realistic than random K-fold. |
| **High-beta bias** | Model tendency to select funds with high market sensitivity, which can underperform in corrections even if they outperform on average. |
| **MDD gate** | Frontend rule: if max drawdown > 25%, halve the ML Score contribution. Reduces high-beta bias in the composite score. |

---

*Fin Intel ML Pipeline · Contact: manjunathts@gmail.com · Repo: manjunathts-png/fin-intel*
