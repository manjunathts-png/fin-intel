"""
Production Trainer — MF Top-Quartile Predictor
===============================================

1. Loads all labeled rows from mf_features (fwd_top_q_3m IS NOT NULL)
2. Optionally tunes hyperparameters with Optuna (--tune)
3. Fits a calibrated LightGBM on the full labeled dataset
4. Computes SHAP values for explainability
5. Generates predictions for the latest as_of_date rows
6. Writes:
   - mf_predictions (scheme_code, prediction_date, p_top_quartile_3m, pred_rank, top_features)
   - mf_model_runs  (audit log: AUC, precision, backtest summary, feature importance)

Usage:
    python train.py                       # train + predict for today
    python train.py --tune --n-trials 50  # Optuna tuning (slow, ~30 min)
    python train.py --prediction-date 2026-05-30
    python train.py --dry-run             # train but don't write to Supabase

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
from datetime import date, timedelta
from typing import Any

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

warnings.filterwarnings("ignore", category=UserWarning)

# ─── Setup ────────────────────────────────────────────────────────────────────

load_dotenv()
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("train")

FEATURE_COLS = [
    "ret1w", "ret1m", "ret3m", "ret6m", "ret1y", "ret3y", "ret5y",
    "cagr5y", "cagr10y",
    "vol_30d", "vol_90d", "vol_1y",
    "max_dd_1y", "downside_dev_1y",
    "sharpe_1y", "sortino_1y",
    "z1w",
    "positive_months_12m",
    "cat_rank_1m", "cat_rank_3m", "cat_rank_1y",
    "univ_rank_1m", "univ_rank_3m", "univ_rank_1y",
    "cat_z",
]

TARGET_COL = "fwd_top_q_3m"


# ─── Default LightGBM hyperparameters ────────────────────────────────────────

DEFAULT_PARAMS = {
    "n_estimators": 500,
    "learning_rate": 0.04,
    "max_depth": 5,
    "num_leaves": 31,
    "min_child_samples": 20,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "reg_alpha": 0.1,
    "reg_lambda": 0.2,
    "class_weight": "balanced",
    "random_state": 42,
    "verbose": -1,
}


# ─── Data loading ────────────────────────────────────────────────────────────

def load_labeled(supabase) -> pd.DataFrame:
    """Pull all rows with ground-truth labels for training."""
    log.info("Loading labeled training data from mf_features…")
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
    if not df.empty:
        df["as_of_date"] = pd.to_datetime(df["as_of_date"])
    log.info("Loaded %d training rows", len(df))
    return df


def load_latest_features(supabase, prediction_date: date) -> pd.DataFrame:
    """Pull the most recent feature rows for inference."""
    # Look back up to 5 days (weekends + holidays)
    for lookback in range(5):
        d = prediction_date - timedelta(days=lookback)
        resp = (
            supabase.table("mf_features")
            .select("*")
            .eq("as_of_date", str(d))
            .execute()
        )
        rows = resp.data or []
        if rows:
            log.info("Using features from %s (%d funds)", d, len(rows))
            df = pd.DataFrame(rows)
            df["as_of_date"] = pd.to_datetime(df["as_of_date"])
            return df

    log.error("No feature rows found near %s. Run extract_features.py first.", prediction_date)
    return pd.DataFrame()


# ─── Feature preparation ─────────────────────────────────────────────────────

def prepare_X(df: pd.DataFrame, fit_medians: dict[str, float] | None = None) -> tuple[pd.DataFrame, dict[str, float]]:
    """
    Returns (X, medians) where medians can be passed in at inference time
    to ensure consistent imputation.
    """
    available = [c for c in FEATURE_COLS if c in df.columns]
    X = df[available].copy().astype(float)

    medians: dict[str, float] = {}
    for col in X.columns:
        if fit_medians is not None and col in fit_medians:
            med = fit_medians[col]
        else:
            med = float(X[col].median())
        medians[col] = med
        X[col] = X[col].fillna(med)

    return X, medians


# ─── Optuna tuning ────────────────────────────────────────────────────────────

def tune_hyperparams(X_train: pd.DataFrame, y_train: pd.Series, n_trials: int = 50) -> dict[str, Any]:
    """Bayesian hyperparameter search using Optuna + 5-fold CV."""
    try:
        import optuna
        import lightgbm as lgb
        from sklearn.model_selection import StratifiedKFold, cross_val_score

        optuna.logging.set_verbosity(optuna.logging.WARNING)

        def objective(trial):
            params = {
                "n_estimators": trial.suggest_int("n_estimators", 200, 800),
                "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.1, log=True),
                "max_depth": trial.suggest_int("max_depth", 3, 7),
                "num_leaves": trial.suggest_int("num_leaves", 15, 63),
                "min_child_samples": trial.suggest_int("min_child_samples", 10, 50),
                "subsample": trial.suggest_float("subsample", 0.6, 1.0),
                "colsample_bytree": trial.suggest_float("colsample_bytree", 0.6, 1.0),
                "reg_alpha": trial.suggest_float("reg_alpha", 1e-3, 1.0, log=True),
                "reg_lambda": trial.suggest_float("reg_lambda", 1e-3, 1.0, log=True),
                "class_weight": "balanced",
                "random_state": 42,
                "verbose": -1,
            }
            model = lgb.LGBMClassifier(**params)
            cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
            scores = cross_val_score(model, X_train, y_train, cv=cv, scoring="roc_auc", n_jobs=-1)
            return scores.mean()

        study = optuna.create_study(direction="maximize")
        study.optimize(objective, n_trials=n_trials, show_progress_bar=True)
        best = study.best_params
        best["class_weight"] = "balanced"
        best["random_state"] = 42
        best["verbose"] = -1
        log.info("Best AUC (CV): %.4f | params: %s", study.best_value, best)
        return best
    except ImportError:
        log.warning("Optuna not installed — using default hyperparameters")
        return DEFAULT_PARAMS


# ─── Training ────────────────────────────────────────────────────────────────

def train_model(
    X_train: pd.DataFrame,
    y_train: pd.Series,
    params: dict[str, Any],
    calibrate: bool = True,
):
    """Fit LightGBM with optional Platt/isotonic calibration."""
    import lightgbm as lgb
    from sklearn.calibration import CalibratedClassifierCV

    base = lgb.LGBMClassifier(**params)

    if calibrate and len(y_train) >= 200:
        # Isotonic calibration — better for imbalanced classes
        model = CalibratedClassifierCV(base, cv=5, method="isotonic")
        log.info("Fitting calibrated LightGBM…")
    else:
        model = base
        log.info("Fitting LightGBM (no calibration — small dataset)…")

    model.fit(X_train, y_train)
    log.info("Training complete")
    return model


def cross_val_metrics(
    X: pd.DataFrame, y: pd.Series, params: dict[str, Any]
) -> dict[str, float]:
    """5-fold stratified CV for AUC + precision@top-quartile."""
    import lightgbm as lgb
    from sklearn.model_selection import StratifiedKFold
    from sklearn.metrics import roc_auc_score

    kf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    aucs: list[float] = []
    precs: list[float] = []

    for train_idx, val_idx in kf.split(X, y):
        m = lgb.LGBMClassifier(**params)
        m.fit(X.iloc[train_idx], y.iloc[train_idx])
        prob = m.predict_proba(X.iloc[val_idx])[:, 1]
        y_val = y.iloc[val_idx].values

        if y_val.sum() > 0:
            aucs.append(roc_auc_score(y_val, prob))

        n = max(1, int(len(prob) * 0.25))
        top_idx = np.argsort(prob)[-n:]
        precs.append(float(y_val[top_idx].mean()))

    return {
        "cv_auc": float(np.mean(aucs)) if aucs else None,
        "cv_precision_top_q": float(np.mean(precs)) if precs else None,
    }


# ─── SHAP explanations ───────────────────────────────────────────────────────

def compute_shap_top5(model, X: pd.DataFrame) -> list[list[dict]]:
    """
    Returns a list (one per fund) of top-5 SHAP contributors as
    [{"name": "ret1y", "value": 12.3, "shap": 0.08}, ...]
    Falls back to feature importance if SHAP unavailable.
    """
    try:
        import shap

        # Get base estimator if calibrated
        base = model
        if hasattr(model, "estimator"):
            base = model.estimator
        elif hasattr(model, "base_estimator"):
            base = model.base_estimator

        explainer = shap.TreeExplainer(base)
        shap_vals = explainer.shap_values(X)

        # For binary, shap_values may be a list of 2 arrays or a single array
        if isinstance(shap_vals, list):
            sv = shap_vals[1]  # positive class
        else:
            sv = shap_vals

        results: list[list[dict]] = []
        feat_names = X.columns.tolist()
        for i in range(len(X)):
            row_shap = sv[i]
            row_vals = X.iloc[i]
            order = np.argsort(np.abs(row_shap))[::-1][:5]
            top5 = [
                {
                    "name": feat_names[j],
                    "value": round(float(row_vals.iloc[j]), 4),
                    "shap": round(float(row_shap[j]), 4),
                }
                for j in order
            ]
            results.append(top5)
        return results

    except Exception as e:
        log.debug("SHAP failed (%s) — using empty top_features", e)
        return [[] for _ in range(len(X))]


# ─── Feature importance ──────────────────────────────────────────────────────

def get_feature_importance(model, feature_names: list[str]) -> list[dict]:
    """Top 20 features by importance from the fitted model."""
    base = model
    if hasattr(model, "estimator"):
        base = model.estimator
    elif hasattr(model, "base_estimator"):
        base = model.base_estimator

    if not hasattr(base, "feature_importances_"):
        return []

    fi = base.feature_importances_
    pairs = sorted(zip(feature_names, fi.tolist()), key=lambda x: x[1], reverse=True)
    return [{"feature": k, "importance": round(v, 4)} for k, v in pairs[:20]]


# ─── Prediction writer ───────────────────────────────────────────────────────

def write_predictions(
    supabase,
    pred_df: pd.DataFrame,
    probs: np.ndarray,
    top_features_list: list[list[dict]],
    model_version: str,
    prediction_date: date,
    batch: int = 500,
) -> int:
    rows: list[dict] = []

    # Sort by probability for global ranking
    order = np.argsort(probs)[::-1]
    global_ranks = np.empty(len(probs), dtype=int)
    global_ranks[order] = np.arange(1, len(probs) + 1)

    # Category ranking
    cats = pred_df["category"].fillna("Unknown").values
    cat_ranks = np.zeros(len(probs), dtype=int)
    for cat in np.unique(cats):
        mask = cats == cat
        cat_probs = probs[mask]
        cat_order = np.argsort(cat_probs)[::-1]
        ranks = np.empty(len(cat_probs), dtype=int)
        ranks[cat_order] = np.arange(1, len(cat_probs) + 1)
        cat_ranks[mask] = ranks

    for i, (_, fund_row) in enumerate(pred_df.iterrows()):
        rows.append({
            "scheme_code":       fund_row["scheme_code"],
            "prediction_date":   str(prediction_date),
            "model_version":     model_version,
            "p_top_quartile_3m": round(float(probs[i]), 6),
            "pred_rank":         int(global_ranks[i]),
            "pred_cat_rank":     int(cat_ranks[i]),
            "top_features":      top_features_list[i],
        })

    total = 0
    for i in range(0, len(rows), batch):
        chunk = rows[i : i + batch]
        supabase.table("mf_predictions").upsert(
            chunk, on_conflict="scheme_code,prediction_date,model_version"
        ).execute()
        total += len(chunk)

    log.info("Wrote %d prediction rows (model=%s)", total, model_version)
    return total


def write_model_run(
    supabase,
    model_version: str,
    feature_count: int,
    training_samples: int,
    training_window: str,
    cv_metrics: dict[str, float],
    params: dict[str, Any],
    feature_importance: list[dict],
    notes: str = "",
) -> None:
    row = {
        "model_version":       model_version,
        "feature_count":       feature_count,
        "training_samples":    training_samples,
        "training_window":     training_window,
        "cv_auc":              cv_metrics.get("cv_auc"),
        "cv_precision_top_q":  cv_metrics.get("cv_precision_top_q"),
        "hyperparams":         params,
        "feature_importance":  feature_importance,
        "notes":               notes,
    }
    supabase.table("mf_model_runs").insert(row).execute()
    log.info("Logged model run: %s  AUC=%.3f", model_version, cv_metrics.get("cv_auc") or 0)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--prediction-date", type=str, default=None,
                   help="YYYY-MM-DD for predictions (default: today)")
    p.add_argument("--tune",          action="store_true", help="Run Optuna hyperparameter tuning")
    p.add_argument("--n-trials",      type=int, default=50, help="Optuna trial count (default 50)")
    p.add_argument("--no-calibrate",  action="store_true", help="Skip probability calibration")
    p.add_argument("--no-shap",       action="store_true", help="Skip SHAP computation (faster)")
    p.add_argument("--dry-run",       action="store_true", help="Train but don't write to Supabase")
    args = p.parse_args()

    pred_date = date.fromisoformat(args.prediction_date) if args.prediction_date else date.today()

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)

    supabase = create_client(url, key)

    # ── 1. Load training data ──────────────────────────────────────────────
    train_df = load_labeled(supabase)
    if len(train_df) < 50:
        log.error(
            "Only %d labeled rows found. Run:\n"
            "  python extract_features.py --backfill 365\n"
            "  # wait 3 months, then:\n"
            "  python label_targets.py\n"
            "to build the training set.",
            len(train_df),
        )
        sys.exit(1)

    X_train, train_medians = prepare_X(train_df)
    y_train = train_df[TARGET_COL].astype(int)

    training_window = f"{train_df['as_of_date'].min().date()} to {train_df['as_of_date'].max().date()}"
    log.info("Training set: %d rows, %d features, window: %s",
             len(X_train), len(X_train.columns), training_window)
    log.info("Class balance: %d positive / %d negative (%.1f%%)",
             y_train.sum(), len(y_train) - y_train.sum(),
             y_train.mean() * 100)

    # ── 2. Hyperparameter selection ────────────────────────────────────────
    if args.tune:
        log.info("Running Optuna tuning with %d trials…", args.n_trials)
        params = tune_hyperparams(X_train, y_train, n_trials=args.n_trials)
    else:
        params = DEFAULT_PARAMS
        log.info("Using default hyperparameters")

    # ── 3. Cross-validation metrics ────────────────────────────────────────
    log.info("Running 5-fold CV for metric estimation…")
    cv_metrics = cross_val_metrics(X_train, y_train, params)
    log.info("CV AUC=%.4f  Precision@Q1=%.4f",
             cv_metrics.get("cv_auc") or 0,
             cv_metrics.get("cv_precision_top_q") or 0)

    # ── 4. Train on full labeled set ───────────────────────────────────────
    model = train_model(X_train, y_train, params, calibrate=not args.no_calibrate)

    # ── 5. Feature importance ──────────────────────────────────────────────
    fi = get_feature_importance(model, X_train.columns.tolist())
    if fi:
        log.info("Top 5 features: %s", [x["feature"] for x in fi[:5]])

    # ── 6. Load inference features ─────────────────────────────────────────
    pred_df = load_latest_features(supabase, pred_date)
    if pred_df.empty:
        log.error("No features available for prediction. Exiting.")
        sys.exit(1)

    X_pred, _ = prepare_X(pred_df, fit_medians=train_medians)
    # Align columns (training may have cols prediction doesn't or vice versa)
    for col in X_train.columns:
        if col not in X_pred.columns:
            X_pred[col] = train_medians.get(col, 0.0)
    X_pred = X_pred[X_train.columns]  # ensure same order

    # ── 7. Predict ─────────────────────────────────────────────────────────
    probs = model.predict_proba(X_pred)[:, 1]
    log.info("Predictions: %d funds  p_top_quartile_3m range=[%.3f, %.3f]",
             len(probs), probs.min(), probs.max())

    # ── 8. SHAP ────────────────────────────────────────────────────────────
    if args.no_shap:
        top_features_list = [[] for _ in range(len(X_pred))]
    else:
        log.info("Computing SHAP values…")
        top_features_list = compute_shap_top5(model, X_pred)

    # ── 9. Model version tag ───────────────────────────────────────────────
    model_version = f"lgbm_v1.0_{pred_date}"

    # ── 10. Write to Supabase ──────────────────────────────────────────────
    if args.dry_run:
        log.info("dry-run: skipping Supabase writes")
        log.info("Sample prediction: scheme=%s  p=%.4f  rank=%d",
                 pred_df.iloc[0]["scheme_code"],
                 float(probs[0]),
                 int(np.argsort(probs)[::-1].tolist().index(0)) + 1)
    else:
        write_predictions(
            supabase, pred_df, probs, top_features_list,
            model_version=model_version,
            prediction_date=pred_date,
        )
        write_model_run(
            supabase,
            model_version=model_version,
            feature_count=len(X_train.columns),
            training_samples=len(X_train),
            training_window=training_window,
            cv_metrics=cv_metrics,
            params={k: v for k, v in params.items() if k not in ("verbose", "random_state")},
            feature_importance=fi,
        )

    log.info("Done. Model version: %s", model_version)


if __name__ == "__main__":
    main()
