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
import hashlib
import json
import logging
import os
import sys
import warnings
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

from config import CATEGORY_GROUPS, FEATURE_COLS, SHARPE_TARGET_COL, TARGET_COL

warnings.filterwarnings("ignore", category=UserWarning)

# ─── Setup ────────────────────────────────────────────────────────────────────

load_dotenv()
load_dotenv(Path(__file__).parent.parent / "backend" / ".env", override=False)
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("train")


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


# ─── Data quality audit ──────────────────────────────────────────────────────

def audit_null_rates(X: pd.DataFrame, threshold: float = 0.20) -> None:
    """Log features whose null rate exceeds threshold before imputation."""
    null_rates = X.isnull().mean().sort_values(ascending=False)
    high_null = null_rates[null_rates > threshold]
    if high_null.empty:
        log.info("Null-rate audit: all features below %.0f%% threshold", threshold * 100)
    else:
        log.warning(
            "Null-rate audit: %d feature(s) exceed %.0f%% nulls — "
            "consider data quality investigation:",
            len(high_null), threshold * 100,
        )
        for feat, rate in high_null.items():
            log.warning("  %-25s  %.1f%% null", feat, rate * 100)


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
    """5-fold time-series CV for AUC + precision@top-quartile.

    Uses TimeSeriesSplit so each validation fold is always strictly after its
    training fold — no lookahead bias from shuffling across dates.
    """
    import lightgbm as lgb
    from sklearn.model_selection import TimeSeriesSplit
    from sklearn.metrics import roc_auc_score

    kf = TimeSeriesSplit(n_splits=5)
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

        # CalibratedClassifierCV (sklearn >= 1.2) stores fitted estimators in
        # calibrated_classifiers_[i].estimator — model.estimator is the *unfitted*
        # template and cannot be used for SHAP.
        base = model
        if hasattr(model, "calibrated_classifiers_"):
            base = model.calibrated_classifiers_[0].estimator
        elif hasattr(model, "estimator") and hasattr(model.estimator, "feature_importances_"):
            base = model.estimator

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
    if hasattr(model, "calibrated_classifiers_"):
        base = model.calibrated_classifiers_[0].estimator
    elif hasattr(model, "estimator") and hasattr(model.estimator, "feature_importances_"):
        base = model.estimator

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
    prob_col: str = "p_top_quartile_3m",
    category_group: str | None = None,
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
        row: dict = {
            "scheme_code":     fund_row["scheme_code"],
            "prediction_date": str(prediction_date),
            "model_version":   model_version,
            prob_col:          round(float(probs[i]), 6),
            "pred_rank":       int(global_ranks[i]),
            "pred_cat_rank":   int(cat_ranks[i]),
            "top_features":    top_features_list[i],
        }
        if category_group is not None:
            row["category_group"] = category_group
        rows.append(row)

    total = 0
    for i in range(0, len(rows), batch):
        chunk = rows[i : i + batch]
        supabase.table("mf_predictions").upsert(
            chunk, on_conflict="scheme_code,prediction_date,model_version"
        ).execute()
        total += len(chunk)

    log.info("Wrote %d prediction rows (model=%s)", total, model_version)
    return total


def run_category_group_pipeline(
    supabase,
    train_df: pd.DataFrame,
    pred_df: pd.DataFrame,
    params: dict,
    pred_date: date,
    target_col: str,
    prob_col: str,
    horizon_tag: str,
    args,
) -> None:
    """Train one model per category group and write group-specific predictions."""
    import hashlib

    cats = pred_df["category"].fillna("Unknown")
    groups_in_pred = cats.map(lambda c: CATEGORY_GROUPS.get(c, "other")).unique()

    for group in sorted(groups_in_pred):
        # Filter training and inference data to this group
        train_cats = train_df["category"].fillna("Unknown")
        train_mask = train_cats.map(lambda c: CATEGORY_GROUPS.get(c, "other")) == group
        group_train = train_df[train_mask].copy()

        pred_cats = pred_df["category"].fillna("Unknown")
        pred_mask = pred_cats.map(lambda c: CATEGORY_GROUPS.get(c, "other")) == group
        group_pred = pred_df[pred_mask].copy()

        n_train = group_train[target_col].notna().sum() if target_col in group_train else 0
        log.info("Group '%s': %d training samples, %d inference funds", group, n_train, len(group_pred))

        if n_train < 30:
            log.warning("Skipping group '%s' — too few labeled samples (%d < 30)", group, n_train)
            continue
        if group_pred.empty:
            log.warning("Skipping group '%s' — no funds to predict", group)
            continue

        X_tr, medians = prepare_X(group_train)
        y_tr = group_train[target_col].astype(int)

        cv_metrics = cross_val_metrics(X_tr, y_tr, params)
        log.info("[%s] CV AUC=%.4f  Precision@Q1=%.4f", group,
                 cv_metrics.get("cv_auc") or 0, cv_metrics.get("cv_precision_top_q") or 0)

        model = train_model(X_tr, y_tr, params, calibrate=not args.no_calibrate)

        fi = get_feature_importance(model, X_tr.columns.tolist())
        if fi:
            log.info("[%s] Top 5 features: %s", group, [x["feature"] for x in fi[:5]])

        X_pr, _ = prepare_X(group_pred, fit_medians=medians)
        for col in X_tr.columns:
            if col not in X_pr.columns:
                X_pr[col] = medians.get(col, 0.0)
        X_pr = X_pr[X_tr.columns]

        probs = model.predict_proba(X_pr)[:, 1]

        if args.no_shap:
            top_features_list = [[] for _ in range(len(X_pr))]
        else:
            top_features_list = compute_shap_top5(model, X_pr)

        feat_hash = hashlib.md5(",".join(sorted(X_tr.columns)).encode()).hexdigest()[:6]
        model_version = f"lgbm_v1.0_{horizon_tag}_{group}_{pred_date}_{feat_hash}"

        shap_stability = check_shap_stability(supabase, fi, model_version, horizon_tag=horizon_tag)

        if args.dry_run:
            log.info("[%s] dry-run: skipping writes (sample p=%.4f)", group, float(probs[0]))
        else:
            write_predictions(
                supabase, group_pred, probs, top_features_list,
                model_version=model_version,
                prediction_date=pred_date,
                prob_col=prob_col,
                category_group=group,
            )
            stability_note = (
                f"group={group} shap_stability={shap_stability.get('status', 'unknown')} "
                f"overlap={shap_stability.get('overlap')}/5 "
                f"vs {shap_stability.get('prev_version', 'n/a')}"
            ) if shap_stability.get("checked") else f"group={group}"
            training_window = f"{group_train['as_of_date'].min().date()} to {group_train['as_of_date'].max().date()}"
            write_model_run(
                supabase,
                model_version=model_version,
                feature_count=len(X_tr.columns),
                training_samples=len(X_tr),
                training_window=training_window,
                cv_metrics=cv_metrics,
                params={k: v for k, v in params.items() if k not in ("verbose", "random_state")},
                feature_importance=fi,
                notes=stability_note,
            )


def check_shap_stability(
    supabase,
    current_fi: list[dict],
    model_version: str,
    horizon_tag: str = "",
) -> dict[str, Any]:
    """
    Compare the current run's top-5 features against the most recent previous
    model run stored in mf_model_runs — filtered to the SAME horizon (1m/3m)
    so cross-horizon comparisons don't generate spurious drift alerts.

    Returns a stability report dict that is attached to the model-run notes.

    Stability thresholds (top-5 overlap):
      5/5 — stable      (no warning)
      4/5 — mild drift  (INFO)
      3/5 — moderate    (WARNING — monitor)
      <3/5 — unstable   (WARNING — investigate before trusting predictions)
    """
    report = {"checked": False, "overlap": None, "status": "unknown", "prev_version": None}
    if not current_fi:
        return report
    try:
        import time as _time
        query = (
            supabase.table("mf_model_runs")
            .select("model_version,feature_importance,trained_at")
            .neq("model_version", model_version)
        )
        # Filter to same horizon so 3m models only compare against 3m baselines
        if horizon_tag:
            query = query.like("model_version", f"lgbm_v1.0_{horizon_tag}_%")
        # Retry on Supabase Cloudflare 1101 transient errors
        resp = None
        for attempt in range(3):
            try:
                resp = query.order("trained_at", desc=True).limit(1).execute()
                break
            except Exception as exc:
                wait = 10 * (2 ** attempt)
                log.warning("SHAP stability query failed (attempt %d/3): %s — retrying in %ds",
                            attempt + 1, str(exc)[:80], wait)
                _time.sleep(wait)
        if resp is None:
            log.warning("SHAP stability check failed after 3 retries — skipping")
            return report
        if not resp.data:
            log.info("SHAP stability: no previous model run found — first run, skipping")
            return report

        prev = resp.data[0]
        prev_fi: list[dict] = prev.get("feature_importance") or []
        if len(prev_fi) < 3:
            log.info(
                "SHAP stability: previous run (%s) has no feature importance stored — "
                "comparison skipped (pre-SHAP run or empty)",
                prev.get("model_version"),
            )
            return report
        prev_top5 = [x["feature"] for x in prev_fi[:5]]
        curr_top5 = [x["feature"] for x in current_fi[:5]]

        overlap = len(set(curr_top5) & set(prev_top5))
        report.update({
            "checked": True,
            "overlap": overlap,
            "prev_version": prev["model_version"],
            "current_top5": curr_top5,
            "prev_top5": prev_top5,
        })

        # Rank-shift: position change for features that appear in both lists
        rank_shifts = []
        for feat in set(curr_top5) & set(prev_top5):
            curr_rank = curr_top5.index(feat)
            prev_rank = prev_top5.index(feat)
            rank_shifts.append(abs(curr_rank - prev_rank))
        mean_shift = round(float(np.mean(rank_shifts)), 2) if rank_shifts else None
        report["mean_rank_shift"] = mean_shift

        if overlap == 5:
            status = "stable"
            log.info("SHAP stable: 5/5 top features match previous run (%s)", prev["model_version"])
        elif overlap == 4:
            status = "mild_drift"
            log.info(
                "SHAP mild drift: 4/5 top features match (%s). "
                "New: %s  Dropped: %s",
                prev["model_version"],
                list(set(curr_top5) - set(prev_top5)),
                list(set(prev_top5) - set(curr_top5)),
            )
        elif overlap == 3:
            status = "moderate_drift"
            log.warning(
                "[!] SHAP moderate drift: only 3/5 top features match (%s). "
                "New features: %s  Dropped: %s  Mean rank shift: %.1f. "
                "Monitor next 2-3 runs before trusting predictions.",
                prev["model_version"],
                list(set(curr_top5) - set(prev_top5)),
                list(set(prev_top5) - set(curr_top5)),
                mean_shift or 0,
            )
        else:
            status = "unstable"
            log.warning(
                "[!!] SHAP unstable: only %d/5 top features match (%s). "
                "Current: %s  Previous: %s. "
                "Possible causes: india_vix/sentiment went live, feature data gap, "
                "regime shift in training window. Investigate before acting on predictions.",
                overlap,
                prev["model_version"],
                curr_top5,
                prev_top5,
            )

        report["status"] = status
    except Exception as e:
        log.warning("SHAP stability check failed: %s", e)

    return report


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
    p.add_argument("--horizon",  type=str, default="3m", choices=["3m", "1m"],
                   help="Prediction horizon: 3m (default) or 1m")
    p.add_argument("--tune",             action="store_true", help="Run Optuna hyperparameter tuning")
    p.add_argument("--n-trials",         type=int, default=50, help="Optuna trial count (default 50)")
    p.add_argument("--no-calibrate",     action="store_true", help="Skip probability calibration")
    p.add_argument("--no-shap",          action="store_true", help="Skip SHAP computation (faster)")
    p.add_argument("--dry-run",          action="store_true", help="Train but don't write to Supabase")
    p.add_argument("--category-groups",  action="store_true",
                   help="Train a separate model per category group (equity/sector/fixed_income/…)")
    p.add_argument("--sharpe-target",    action="store_true",
                   help="Use risk-adjusted (Sharpe-quartile) label instead of raw-return quartile")
    args = p.parse_args()

    if args.horizon == "1m":
        target_col = "fwd_top_q_1m"
        prob_col   = "p_top_quartile_1m"
    elif args.sharpe_target:
        target_col = SHARPE_TARGET_COL      # fwd_top_sharpe_q_3m
        prob_col   = "p_top_sharpe_q_3m"
    else:
        target_col = TARGET_COL             # fwd_top_q_3m
        prob_col   = "p_top_quartile_3m"
    horizon_tag = args.horizon
    log.info("Horizon: %s  target=%s  output=%s  category_groups=%s",
             horizon_tag, target_col, prob_col, args.category_groups)

    pred_date = date.fromisoformat(args.prediction_date) if args.prediction_date else date.today()

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)

    supabase = create_client(url, key)

    # ── 1. Load training data ──────────────────────────────────────────────
    train_df = load_labeled(supabase)
    # Filter to rows with the correct target column labeled
    if target_col in train_df.columns:
        train_df = train_df[train_df[target_col].notna()]
    if len(train_df) < 50:
        log.error(
            "Only %d labeled rows found for %s. Run:\n"
            "  python extract_features.py --backfill 365\n"
            "  python label_targets.py --window %s\n"
            "to build the training set.",
            len(train_df), target_col,
            "30" if args.horizon == "1m" else "90",
        )
        sys.exit(1)

    X_train, train_medians = prepare_X(train_df)
    y_train = train_df[target_col].astype(int)

    training_window = f"{train_df['as_of_date'].min().date()} to {train_df['as_of_date'].max().date()}"
    log.info("Training set: %d rows, %d features, window: %s",
             len(X_train), len(X_train.columns), training_window)
    log.info("Class balance: %d positive / %d negative (%.1f%%)",
             y_train.sum(), len(y_train) - y_train.sum(),
             y_train.mean() * 100)

    # ── 1b. Null-rate audit (before imputation) ────────────────────────────
    audit_null_rates(train_df[[c for c in FEATURE_COLS if c in train_df.columns]])

    # ── 2. Hyperparameter selection ────────────────────────────────────────
    if args.tune:
        log.info("Running Optuna tuning with %d trials…", args.n_trials)
        params = tune_hyperparams(X_train, y_train, n_trials=args.n_trials)
    else:
        params = DEFAULT_PARAMS
        log.info("Using default hyperparameters")

    # ── 3. Category-groups mode: train one model per group and exit ────────
    if args.category_groups:
        pred_df = load_latest_features(supabase, pred_date)
        if pred_df.empty:
            log.error("No features available for prediction. Exiting.")
            sys.exit(1)
        run_category_group_pipeline(
            supabase, train_df, pred_df,
            params=params,
            pred_date=pred_date,
            target_col=target_col,
            prob_col=prob_col,
            horizon_tag=horizon_tag,
            args=args,
        )
        log.info("Category-groups pipeline complete.")
        return

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
    p5, p95 = np.percentile(probs, [5, 95])
    log.info(
        "Predictions: %d funds  mean=%.3f  std=%.3f  p5=%.3f  p95=%.3f  "
        "range=[%.3f, %.3f]",
        len(probs), probs.mean(), probs.std(), p5, p95, probs.min(), probs.max(),
    )
    if probs.std() < 0.05:
        log.warning(
            "Prediction std=%.4f is very low — model may not be discriminating "
            "between funds. Check feature data and training set size.",
            probs.std(),
        )

    # ── 8. SHAP ────────────────────────────────────────────────────────────
    if args.no_shap:
        top_features_list = [[] for _ in range(len(X_pred))]
    else:
        log.info("Computing SHAP values…")
        top_features_list = compute_shap_top5(model, X_pred)

    # ── 9. Model version tag ───────────────────────────────────────────────
    # Include a short hash of the feature set so the version string changes
    # whenever columns are added or removed.
    feat_hash = hashlib.md5(
        ",".join(sorted(X_train.columns)).encode()
    ).hexdigest()[:6]
    model_version = f"lgbm_v1.0_{horizon_tag}_{pred_date}_{feat_hash}"

    # ── 9b. SHAP stability check ───────────────────────────────────────────
    # Compare top-5 features against the previous model run. Warn if <4/5
    # features overlap — signals feature drift, data gap, or regime shift.
    # Runs even in dry-run mode (read-only query).
    shap_stability = check_shap_stability(supabase, fi, model_version, horizon_tag=horizon_tag)

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
            prob_col=prob_col,
        )
        # Attach SHAP stability report to model-run notes for the audit log
        stability_note = (
            f"shap_stability={shap_stability.get('status', 'unknown')} "
            f"overlap={shap_stability.get('overlap')}/5 "
            f"vs {shap_stability.get('prev_version', 'n/a')}"
        ) if shap_stability.get("checked") else ""
        write_model_run(
            supabase,
            model_version=model_version,
            feature_count=len(X_train.columns),
            training_samples=len(X_train),
            training_window=training_window,
            cv_metrics=cv_metrics,
            params={k: v for k, v in params.items() if k not in ("verbose", "random_state")},
            feature_importance=fi,
            notes=stability_note,
        )

    log.info("Done. Model version: %s", model_version)


if __name__ == "__main__":
    main()
