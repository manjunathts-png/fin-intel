"""
Walk-Forward Backtest Harness
==============================

Evaluates MF prediction quality using a rolling-window walk-forward approach so
there is ZERO look-ahead bias. Each fold:

  1. Train on data from [train_start, fold_end)
  2. Predict on a held-out test window [fold_end, fold_end + step_days)
  3. Evaluate using ground-truth fwd_top_q_3m labels

The aggregate report shows per-fold AUC, precision@top-quartile, simulated
portfolio return, and alpha vs Nifty.

Usage:
    python backtest.py                          # default 8 folds, 90-day steps
    python backtest.py --folds 12 --step-days 60
    python backtest.py --train-days 730         # 2-year train window
    python backtest.py --output results.csv     # save per-fold CSV
    python backtest.py --dry-run                # load data, skip model fit

Env:
    SUPABASE_URL
    SUPABASE_SERVICE_KEY
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import warnings
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

warnings.filterwarnings("ignore", category=UserWarning)

# ─── Setup ────────────────────────────────────────────────────────────────────

load_dotenv()
load_dotenv(Path(__file__).parent.parent / "backend" / ".env", override=False)
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("backtest")

# Feature columns used by the model (must match mf_features schema)
FEATURE_COLS = [
    # Fund-level returns
    "ret1w", "ret1m", "ret3m", "ret6m", "ret1y", "ret3y", "ret5y",
    "cagr5y", "cagr10y",
    # Volatility + risk
    "vol_30d", "vol_90d", "vol_1y",
    "max_dd_1y", "downside_dev_1y",
    "sharpe_1y", "sortino_1y",
    # Momentum
    "z1w",
    # Consistency
    "positive_months_12m",
    # Cross-sectional ranks
    "cat_rank_1m", "cat_rank_3m", "cat_rank_1y",
    "univ_rank_1m", "univ_rank_3m", "univ_rank_1y",
    "cat_z",
    # Style
    "beta_nifty", "alpha_nifty", "corr_nifty",
    # Macro context (same across funds on same date)
    "nifty_ret1m", "nifty_ret3m",
    "india_vix", "usd_inr", "us_10y_yield",
    # News sentiment (-1.0 → +1.0; NULL imputed to 0.0)
    "sentiment_score",
]

TARGET_COL = "fwd_top_q_3m"           # binary: 1 = top quartile next 3m
RETURN_COL = "fwd_ret_3m"             # for simulated return computation

RISK_FREE_RATE = 0.07


# ─── Data loading ────────────────────────────────────────────────────────────

def load_features(supabase) -> pd.DataFrame:
    """Pull all labeled rows from mf_features (fwd_top_q_3m IS NOT NULL)."""
    log.info("Loading feature data from Supabase…")
    rows: list[dict] = []
    page_size = 1000
    offset = 0
    while True:
        resp = (
            supabase.table("mf_features")
            .select("*")
            .not_.is_(TARGET_COL, "null")
            .order("as_of_date")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size

    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["as_of_date"] = pd.to_datetime(df["as_of_date"])
    log.info("Loaded %d labeled rows spanning %s → %s",
             len(df), df["as_of_date"].min().date(), df["as_of_date"].max().date())
    return df


def load_features_from_csv(path: str) -> pd.DataFrame:
    """Alternative: load from a local CSV (useful for offline dev)."""
    df = pd.read_csv(path, parse_dates=["as_of_date"])
    log.info("Loaded %d rows from %s", len(df), path)
    return df


# ─── Feature prep ────────────────────────────────────────────────────────────

def prepare_xy(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Return (X, y) with imputed features and binary target."""
    available = [c for c in FEATURE_COLS if c in df.columns]
    missing = [c for c in FEATURE_COLS if c not in df.columns]
    if missing:
        log.warning("Missing feature columns (will skip): %s", missing)

    X = df[available].copy()
    # Median imputation per column (simple, works well for tree models)
    for col in X.columns:
        med = X[col].median()
        X[col] = X[col].fillna(med)

    y = df[TARGET_COL].astype(int)
    return X, y


# ─── Model builder ───────────────────────────────────────────────────────────

def build_model(random_state: int = 42):
    """Return a LightGBM binary classifier with reasonable defaults."""
    try:
        import lightgbm as lgb
        return lgb.LGBMClassifier(
            n_estimators=400,
            learning_rate=0.05,
            max_depth=5,
            num_leaves=31,
            min_child_samples=20,
            subsample=0.8,
            colsample_bytree=0.8,
            reg_alpha=0.1,
            reg_lambda=0.1,
            class_weight="balanced",
            random_state=random_state,
            verbose=-1,
        )
    except ImportError:
        log.warning("LightGBM not installed — falling back to RandomForest")
        from sklearn.ensemble import RandomForestClassifier
        return RandomForestClassifier(
            n_estimators=200,
            max_depth=6,
            class_weight="balanced",
            random_state=random_state,
            n_jobs=-1,
        )


# ─── Evaluation helpers ───────────────────────────────────────────────────────

def compute_auc(y_true: np.ndarray, y_prob: np.ndarray) -> float | None:
    from sklearn.metrics import roc_auc_score
    if y_true.sum() == 0 or y_true.sum() == len(y_true):
        return None
    try:
        return float(roc_auc_score(y_true, y_prob))
    except Exception:
        return None


def precision_at_top_k(y_true: np.ndarray, y_prob: np.ndarray, k_frac: float = 0.25) -> float | None:
    """Precision among the top k% by predicted probability."""
    n = max(1, int(len(y_prob) * k_frac))
    top_idx = np.argsort(y_prob)[-n:]
    if len(top_idx) == 0:
        return None
    return float(y_true[top_idx].mean())


def simulated_return(df_test: pd.DataFrame, y_prob: np.ndarray, top_frac: float = 0.25) -> float | None:
    """Equal-weight portfolio of top-predicted funds vs actual realized returns."""
    if RETURN_COL not in df_test.columns:
        return None
    n = max(1, int(len(y_prob) * top_frac))
    top_idx = np.argsort(y_prob)[-n:]
    rets = df_test[RETURN_COL].values
    valid = ~np.isnan(rets[top_idx])
    if valid.sum() == 0:
        return None
    return float(rets[top_idx][valid].mean())


def benchmark_return(df_test: pd.DataFrame) -> float | None:
    """Simple equal-weight return of all funds in the test window."""
    if RETURN_COL not in df_test.columns:
        return None
    rets = df_test[RETURN_COL].dropna()
    if rets.empty:
        return None
    return float(rets.mean())


# ─── Walk-forward engine ──────────────────────────────────────────────────────

@dataclass
class FoldResult:
    fold: int
    train_start: date
    train_end: date
    test_start: date
    test_end: date
    n_train: int
    n_test: int
    auc: float | None
    precision_top_q: float | None
    sim_return_3m: float | None        # % return of top-q portfolio (3m window)
    benchmark_3m: float | None         # equal-weight universe return
    alpha_3m: float | None             # sim_return - benchmark
    feature_importance: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "fold": self.fold,
            "train_start": str(self.train_start),
            "train_end": str(self.train_end),
            "test_start": str(self.test_start),
            "test_end": str(self.test_end),
            "n_train": self.n_train,
            "n_test": self.n_test,
            "auc": round(self.auc, 4) if self.auc else None,
            "precision_top_q": round(self.precision_top_q, 4) if self.precision_top_q else None,
            "sim_return_3m_pct": round(self.sim_return_3m, 2) if self.sim_return_3m else None,
            "benchmark_3m_pct": round(self.benchmark_3m, 2) if self.benchmark_3m else None,
            "alpha_3m_pct": round(self.alpha_3m, 2) if self.alpha_3m else None,
        }


def run_walk_forward(
    df: pd.DataFrame,
    n_folds: int = 8,
    step_days: int = 90,
    train_days: int = 365,
    dry_run: bool = False,
) -> list[FoldResult]:
    """
    Walk-forward evaluation.

    Timeline (example, 8 folds, 90-day steps):
      Fold 1: train [T0, T0+365), test [T0+365, T0+455)
      Fold 2: train [T0+90, T0+455), test [T0+455, T0+545)
      ...
    """
    dates = df["as_of_date"].sort_values()
    global_end = dates.max()

    # Anchor test end at the most recent data point
    test_end_final = global_end
    results: list[FoldResult] = []

    for fold_i in range(n_folds - 1, -1, -1):
        test_end = test_end_final - timedelta(days=fold_i * step_days)
        test_start = test_end - timedelta(days=step_days)
        train_end = test_start
        train_start = train_end - timedelta(days=train_days)

        train_mask = (df["as_of_date"] >= train_start) & (df["as_of_date"] < train_end)
        test_mask  = (df["as_of_date"] >= test_start)  & (df["as_of_date"] < test_end)

        df_train = df[train_mask].copy()
        df_test  = df[test_mask].copy()

        fold_num = n_folds - fold_i
        log.info(
            "Fold %d/%d  train=%s→%s (%d rows)  test=%s→%s (%d rows)",
            fold_num, n_folds,
            train_start.date(), train_end.date(), len(df_train),
            test_start.date(), test_end.date(), len(df_test),
        )

        if len(df_train) < 50 or len(df_test) < 10:
            log.warning("Fold %d skipped — insufficient data", fold_num)
            continue

        if dry_run:
            results.append(FoldResult(
                fold=fold_num,
                train_start=train_start.date(), train_end=train_end.date(),
                test_start=test_start.date(), test_end=test_end.date(),
                n_train=len(df_train), n_test=len(df_test),
                auc=None, precision_top_q=None,
                sim_return_3m=None, benchmark_3m=None, alpha_3m=None,
            ))
            continue

        X_train, y_train = prepare_xy(df_train)
        X_test,  y_test  = prepare_xy(df_test)

        # Align columns (test may have different nulls after imputation)
        common_cols = X_train.columns.tolist()
        X_test = X_test[common_cols]

        model = build_model(random_state=42 + fold_num)
        try:
            model.fit(X_train, y_train)
        except Exception as e:
            log.error("Fold %d training failed: %s", fold_num, e)
            continue

        y_prob = model.predict_proba(X_test)[:, 1]

        auc = compute_auc(y_test.values, y_prob)
        prec = precision_at_top_k(y_test.values, y_prob, k_frac=0.25)
        sim_ret = simulated_return(df_test, y_prob, top_frac=0.25)
        bench = benchmark_return(df_test)
        alpha = (sim_ret - bench) if (sim_ret is not None and bench is not None) else None

        # Feature importance
        fi: dict[str, float] = {}
        if hasattr(model, "feature_importances_"):
            fi = dict(zip(common_cols, model.feature_importances_.tolist()))

        result = FoldResult(
            fold=fold_num,
            train_start=train_start.date(), train_end=train_end.date(),
            test_start=test_start.date(), test_end=test_end.date(),
            n_train=len(df_train), n_test=len(df_test),
            auc=auc, precision_top_q=prec,
            sim_return_3m=sim_ret, benchmark_3m=bench, alpha_3m=alpha,
            feature_importance=fi,
        )
        results.append(result)
        log.info(
            "  AUC=%.3f  Prec@Q1=%.3f  SimRet=%.1f%%  Bench=%.1f%%  Alpha=%.1f%%",
            auc or 0, prec or 0, sim_ret or 0, bench or 0, alpha or 0,
        )

    return results


# ─── Aggregate reporting ──────────────────────────────────────────────────────

def aggregate_report(results: list[FoldResult]) -> dict[str, Any]:
    if not results:
        return {}

    aucs   = [r.auc  for r in results if r.auc  is not None]
    precs  = [r.precision_top_q for r in results if r.precision_top_q is not None]
    rets   = [r.sim_return_3m for r in results if r.sim_return_3m is not None]
    benches= [r.benchmark_3m   for r in results if r.benchmark_3m   is not None]
    alphas = [r.alpha_3m for r in results if r.alpha_3m is not None]

    # Annualized return: compound 4 quarterly returns → annualized
    def annualize_q(q_pct: float) -> float:
        return ((1 + q_pct / 100) ** 4 - 1) * 100

    ann_sim   = annualize_q(np.mean(rets))   if rets    else None
    ann_bench = annualize_q(np.mean(benches)) if benches else None
    ann_alpha = (ann_sim - ann_bench)         if (ann_sim is not None and ann_bench is not None) else None

    # Aggregate feature importance (mean across folds)
    all_fi: dict[str, list[float]] = {}
    for r in results:
        for k, v in r.feature_importance.items():
            all_fi.setdefault(k, []).append(v)
    agg_fi = {k: float(np.mean(v)) for k, v in all_fi.items()}
    top_features = sorted(agg_fi.items(), key=lambda x: x[1], reverse=True)[:10]

    return {
        "n_folds": len(results),
        "mean_auc": round(float(np.mean(aucs)), 4) if aucs else None,
        "std_auc":  round(float(np.std(aucs)), 4)  if aucs else None,
        "mean_precision_top_q": round(float(np.mean(precs)), 4) if precs else None,
        "mean_sim_return_3m_pct": round(float(np.mean(rets)), 2) if rets else None,
        "mean_benchmark_3m_pct":  round(float(np.mean(benches)), 2) if benches else None,
        "mean_alpha_3m_pct":      round(float(np.mean(alphas)), 2) if alphas else None,
        "annualized_sim_return_pct":  round(ann_sim, 2)   if ann_sim   is not None else None,
        "annualized_benchmark_pct":   round(ann_bench, 2) if ann_bench is not None else None,
        "annualized_alpha_pct":       round(ann_alpha, 2) if ann_alpha is not None else None,
        "top_features": [{"feature": k, "importance": round(v, 4)} for k, v in top_features],
    }


def print_report(results: list[FoldResult], agg: dict[str, Any]) -> None:
    print("\n" + "═" * 72)
    print("  Walk-Forward Backtest Results")
    print("═" * 72)
    header = f"{'Fold':>4}  {'Train':>21}  {'Test':>21}  {'AUC':>5}  {'P@Q1':>5}  {'Ret%':>6}  {'α%':>6}"
    print(header)
    print("─" * 72)
    for r in results:
        print(
            f"{r.fold:>4}  "
            f"{str(r.train_start)+'→'+str(r.train_end):>21}  "
            f"{str(r.test_start)+'→'+str(r.test_end):>21}  "
            f"{r.auc or 0:>5.3f}  "
            f"{r.precision_top_q or 0:>5.3f}  "
            f"{r.sim_return_3m or 0:>5.1f}%  "
            f"{r.alpha_3m or 0:>+5.1f}%"
        )
    print("═" * 72)
    print(f"  Mean AUC:          {agg.get('mean_auc', '–')} ± {agg.get('std_auc', '–')}")
    print(f"  Precision @Top-Q:  {agg.get('mean_precision_top_q', '–')}")
    print(f"  Annualized return: {agg.get('annualized_sim_return_pct', '–')}%")
    print(f"  Benchmark (eq-wt): {agg.get('annualized_benchmark_pct', '–')}%")
    print(f"  Annualized alpha:  {agg.get('annualized_alpha_pct', '–')}%")
    if agg.get("top_features"):
        print("\n  Top features (avg importance):")
        for item in agg["top_features"][:5]:
            print(f"    {item['feature']:<25} {item['importance']:.4f}")
    print("═" * 72 + "\n")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--folds",      type=int,   default=8,   help="Number of walk-forward folds")
    p.add_argument("--step-days",  type=int,   default=90,  help="Days between fold starts")
    p.add_argument("--train-days", type=int,   default=365, help="Days of training data per fold")
    p.add_argument("--output",     type=str,   default=None, help="CSV path for per-fold results")
    p.add_argument("--csv",        type=str,   default=None, help="Load features from local CSV instead of Supabase")
    p.add_argument("--dry-run",    action="store_true", help="Load data, skip model fit")
    args = p.parse_args()

    # Load data
    if args.csv:
        df = load_features_from_csv(args.csv)
    else:
        url = os.environ.get("SUPABASE_URL")
        key = os.environ.get("SUPABASE_SERVICE_KEY")
        if not url or not key:
            log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
            sys.exit(1)
        supabase = create_client(url, key)
        df = load_features(supabase)

    if df.empty:
        log.error("No labeled data found. Run extract_features.py --backfill 365+ first, then wait 3 months for labels to populate.")
        sys.exit(1)

    log.info("Starting walk-forward: %d folds, %d-day steps, %d-day train window",
             args.folds, args.step_days, args.train_days)

    results = run_walk_forward(
        df,
        n_folds=args.folds,
        step_days=args.step_days,
        train_days=args.train_days,
        dry_run=args.dry_run,
    )

    if not results:
        log.error("No folds completed — not enough data?")
        sys.exit(1)

    agg = aggregate_report(results)
    print_report(results, agg)

    if args.output:
        rows = [r.to_dict() for r in results]
        pd.DataFrame(rows).to_csv(args.output, index=False)
        log.info("Per-fold results written to %s", args.output)

    # Write aggregate to stdout as JSON for CI ingestion
    print("Aggregate JSON:")
    print(json.dumps(agg, indent=2))


if __name__ == "__main__":
    main()
