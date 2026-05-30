# fin-intel ML — MF Prediction Pipeline

Predicts which mutual funds will outperform (top quartile within their category) over the next 3 months using ~30 engineered features + LightGBM.

---

## Architecture

```
ml/
  extract_features.py   — Feature engineering: NAV history → mf_features table
  backtest.py           — Walk-forward backtester: mf_features → backtest report
  train.py              — Production trainer: fits LightGBM, writes mf_predictions
  requirements.txt      — Python dependencies
  setup.sql             — Supabase schema (run once in SQL editor)
  .cache_nav/           — Disk cache for mfapi.in NAV history (gitignored)
```

---

## One-time Setup

### 1. Run the Supabase schema

Open the Supabase SQL editor and run `setup.sql`. This creates:
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

**Target labels** (`fwd_ret_3m`, `fwd_quartile_3m`, `fwd_top_q_3m`) are filled retroactively during backfill once the forward window has elapsed.

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
