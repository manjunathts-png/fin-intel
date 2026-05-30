# fin-intel ML — MF Prediction Pipeline

Predicts which mutual funds will outperform (top quartile within their category) over the next 3 months using **37 engineered features** across NAV history, macro market data, and news sentiment + LightGBM.

---

## Architecture

```
ml/
  extract_features.py       — Feature engineering: NAV history → mf_features (30 fund features)
  macro_features.py         — Market context: Nifty/VIX/USD-INR/US10Y → mf_features (5 macro + 3 style)
  sentiment.py              — News sentiment: Google News RSS → Claude → mf_sentiment + mf_features
  label_targets.py          — Backfills fwd_ret_3m / fwd_quartile_3m / fwd_top_q_3m
  backtest.py               — Walk-forward backtester: mf_features → AUC + alpha report
  train.py                  — Production trainer: LightGBM + SHAP → mf_predictions + mf_model_runs
  requirements.txt          — Python dependencies
  setup.sql                 — Supabase schema for mf_features, mf_predictions, mf_model_runs
  migrate_001_sentiment.sql — Adds sentiment columns + mf_sentiment table
  .cache_nav/               — Disk cache for mfapi.in NAV history (gitignored)
  .cache_macro/             — Disk cache for Yahoo Finance macro data (gitignored)
```

---

## One-time Setup

### 1. Run the Supabase schema

Open the Supabase SQL editor and run these **in order**:

1. `setup.sql` — base tables
2. `migrate_001_sentiment.sql` — adds sentiment columns

`setup.sql` creates:
- `mf_features` — one row per (scheme_code, as_of_date), ~30 feature columns
- `mf_predictions` — model outputs: `p_top_quartile_3m`, `pred_rank`, SHAP top-5
- `mf_model_runs` — audit log of every training run + backtest metrics

### 2. Create a Python environment

```bash
cd fin-intel/ml
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. Set environment variables

The scripts read from `.env` in the repo root, or directly from the environment:

```bash
export SUPABASE_URL=https://xxxx.supabase.co
export SUPABASE_SERVICE_KEY=eyJ...
export ANTHROPIC_API_KEY=sk-ant-...   # required only for sentiment.py
```

Add these to GitHub repository secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY`.

---

## Daily Pipeline (automated via GitHub Actions)

```bash
# Run in this order manually, or via the nightly GitHub Actions cron:
python extract_features.py          # 1. NAV-based features
python macro_features.py --skip-regression  # 2. Macro context
python label_targets.py             # 3. Fill in labels for old rows
python train.py --no-shap           # 4. Train + predict

# Weekly (separate cron — Monday midnight IST):
python sentiment.py                 # News sentiment via Claude
```

---

## Feature Engineering

```bash
# Compute features for today
python extract_features.py

# Dry-run — compute but don't write to Supabase
python extract_features.py --dry-run

# Backfill last 365 days (for training data)
python extract_features.py --backfill 365

# Specific date
python extract_features.py --as-of 2026-01-15
```

**Features computed per fund per day (~30 dimensions):**

| Group | Features |
|---|---|
| Returns | ret1w, ret1m, ret3m, ret6m, ret1y, ret3y, ret5y, cagr5y, cagr10y |
| Volatility / Risk | vol_30d, vol_90d, vol_1y, max_dd_1y, downside_dev_1y |
| Risk-adjusted | sharpe_1y, sortino_1y |
| Momentum | z1w (weekly z-score vs trailing 12 weeks) |
| Consistency | positive_months_12m |
| Cross-sectional | cat_rank_1m/3m/1y, univ_rank_1m/3m/1y, cat_z |
| Style vs Nifty | beta_nifty, alpha_nifty (annualized), corr_nifty |
| Macro | nifty_ret1m/3m, india_vix, usd_inr, us_10y_yield |
| News Sentiment | sentiment_score (-1.0 → +1.0) |

**Target labels** (`fwd_ret_3m`, `fwd_quartile_3m`, `fwd_top_q_3m`) are filled retroactively during backfill once the forward window has elapsed.

---

## Macro Features

```bash
python macro_features.py                    # today
python macro_features.py --backfill 365     # historical backfill
python macro_features.py --skip-regression  # skip beta/alpha/corr (faster, for CI)
```

Fetches via Yahoo Finance (12h disk cache). Requires `yfinance`.

---

## News Sentiment

```bash
python sentiment.py                         # all funds, current week
python sentiment.py --fund-code 120503      # single fund
python sentiment.py --dry-run               # fetch headlines, skip Claude
python sentiment.py --force                 # re-run even if already done this week
```

Uses **Google News RSS** (no API key) for headlines + **Claude Haiku** for analysis.
Runs weekly; writes to `mf_sentiment` and propagates `sentiment_score` to `mf_features`.

Estimated cost: ~$0.03–0.10 per weekly run for 50 funds (Claude Haiku pricing).

---

## Walk-Forward Backtest

```bash
# Default: 12 folds × 90-day steps, 365-day train window
python backtest.py

# Custom fold structure
python backtest.py --folds 8 --step-days 90 --train-days 548

# Output a CSV report
python backtest.py --output backtest_results.csv
```

Prints per-fold AUC, precision@top-quartile, and simulated annualized return vs Nifty.

---

## Training

```bash
# Train on all labeled data, write predictions for today's features
python train.py

# Dry-run — train but don't write predictions
python train.py --dry-run
```

After training, the model version (e.g. `lgbm_v1.0_2026-05-30`) is logged to `mf_model_runs` and predictions are written to `mf_predictions`.

---

## GitHub Actions Integration

The production pipeline runs daily via `.github/workflows/refresh.yml`.

Planned cron step (to add after validation):
```yaml
- name: Extract features
  run: |
    cd ml
    pip install -r requirements.txt -q
    python extract_features.py
  env:
    SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
    SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
```

---

## Model Details

- **Algorithm:** LightGBM binary classifier (gradient boosted trees)
- **Target:** `fwd_top_q_3m` — will this fund be in the top quartile of its category 3 months from now?
- **Validation:** Walk-forward (no lookahead). Each fold trains on past data only.
- **Key hyperparameters:** tuned via Optuna (see `train.py`)
- **Outputs:** calibrated probability `p_top_quartile_3m` per fund, per day

---

## Data Flow

```
mfapi.in NAV history
        │
        ▼
extract_features.py
        │  (~30 features per fund per day)
        ▼
Supabase: mf_features
        │
        ├──► backtest.py  ──► console/CSV report
        │
        └──► train.py ──► Supabase: mf_predictions
                                    mf_model_runs
```
