"""
Stock Model Trainer — Top-Quartile Predictor
=============================================

1. Loads labeled rows from stock_features (fwd_top_q_3m IS NOT NULL)
2. Optionally tunes hyperparameters with Optuna
3. Fits calibrated LightGBM on the full labeled dataset
4. Generates predictions for the latest as_of_date
5. Writes to:
   - stock_predictions  (symbol, prediction_date, p_top_quartile_3m, ...)
   - stock_model_runs   (audit log)

Usage:
    python train_stock.py                       # train + predict for today
    python train_stock.py --tune --n-trials 50  # Optuna tuning
    python train_stock.py --dry-run             # train but don't write

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
import time
import warnings
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

from config import STOCK_SHARPE_TARGET_COL, STOCK_TARGET_COL, get_stock_feature_cols
from oos import evaluate_oos_windows, insert_model_run

warnings.filterwarnings("ignore", category=UserWarning)

load_dotenv()
load_dotenv(Path(__file__).parent.parent / "backend" / ".env", override=False)
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("train_stock")

TRAINING_CACHE = Path(__file__).parent / ".cache_training"
_CACHE_TTL_H   = 20   # nightly runs at 5AM; EOD at 3:45PM hits cache; next 5AM misses → fresh


# ─── Default hyperparameters ─────────────────────────────────────────────────

DEFAULT_PARAMS = {
    "n_estimators":      400,
    "learning_rate":     0.05,
    "max_depth":         5,
    "num_leaves":        31,
    "min_child_samples": 15,
    "subsample":         0.8,
    "colsample_bytree":  0.8,
    "reg_alpha":         0.1,
    "reg_lambda":        0.2,
    "class_weight":      "balanced",
    "random_state":      42,
    "verbose":           -1,
}


# ─── Data loading ─────────────────────────────────────────────────────────────

def load_labeled(supabase, target_col: str) -> pd.DataFrame:
    cache_path = TRAINING_CACHE / f"stock_features_{target_col}.parquet"
    TRAINING_CACHE.mkdir(exist_ok=True)

    if cache_path.exists():
        age_h = (time.time() - cache_path.stat().st_mtime) / 3600
        if age_h < _CACHE_TTL_H:
            log.info("Training cache hit: %s (%.1fh old)", cache_path.name, age_h)
            df = pd.read_parquet(cache_path)
            df["as_of_date"] = pd.to_datetime(df["as_of_date"])
            log.info("Loaded %d training rows from cache", len(df))
            return df
        log.info("Training cache stale (%.1fh > %dh) — re-fetching from Supabase", age_h, _CACHE_TTL_H)

    log.info("Loading labeled training data from stock_features (target=%s)…", target_col)
    rows, page_size, offset = [], 1000, 0
    while True:
        resp = (
            supabase.table("stock_features")
            .select("*")
            .not_.is_(target_col, "null")
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
        try:
            df.to_parquet(cache_path, index=False)
            log.info("Saved training cache: %s (%d rows)", cache_path.name, len(df))
        except Exception as e:
            log.warning("Could not save training cache: %s", e)
    log.info("Loaded %d training rows", len(df))
    return df


def load_latest_features(supabase, prediction_date: date) -> pd.DataFrame:
    for lookback in range(5):
        d = prediction_date - timedelta(days=lookback)
        resp = (
            supabase.table("stock_features")
            .select("*")
            .eq("as_of_date", str(d))
            .execute()
        )
        rows = resp.data or []
        if rows:
            log.info("Using stock features from %s (%d stocks)", d, len(rows))
            df = pd.DataFrame(rows)
            df["as_of_date"] = pd.to_datetime(df["as_of_date"])
            return df
    log.error("No feature rows found near %s. Run extract_stock_features.py first.", prediction_date)
    return pd.DataFrame()


# ─── Feature preparation ─────────────────────────────────────────────────────

# Market-wide columns carry the same value for every stock on a given date —
# a per-date cross-sectional rank would collapse them to a constant 0.5, so
# they are kept on their raw scale.
_MACRO_COLS = frozenset({
    "nifty_ret1m", "nifty_ret3m", "india_vix", "usd_inr", "us_10y_yield",
    "fii_net_5d", "fii_net_20d", "dii_net_5d", "dii_net_20d",
    "fiidii_net_5d", "fiidii_net_20d",
})


def prepare_X(df: pd.DataFrame, fit_medians: dict | None = None) -> tuple[pd.DataFrame, dict]:
    """Select model features, rank-transform, and impute.

    Stock-level features are converted to within-date percentile ranks (0–1):
    the label is cross-sectional (quartile within sector per date), but raw
    levels (vol, returns, RSI) drift with market regime, so global tree splits
    learned on one regime stop separating stocks in the next. Per-date ranking
    removes that drift. The transform is self-contained per date — no state is
    fitted, so it cannot leak across the train/holdout boundary, and inference
    (a single date's cross-section) ranks identically.
    """
    available = get_stock_feature_cols(df)
    X = df[available].copy().astype(float)
    rank_cols = [c for c in X.columns if c not in _MACRO_COLS]
    if rank_cols and "as_of_date" in df.columns:
        X[rank_cols] = X[rank_cols].groupby(df["as_of_date"]).rank(pct=True)
    medians: dict[str, float] = {}
    for col in X.columns:
        med = fit_medians[col] if (fit_medians and col in fit_medians) else float(X[col].median())
        medians[col] = med
        X[col] = X[col].fillna(med)
    return X, medians


def audit_null_rates(X: pd.DataFrame, threshold: float = 0.30) -> None:
    null_rates = X.isnull().mean().sort_values(ascending=False)
    high_null  = null_rates[null_rates > threshold]
    if high_null.empty:
        log.info("Null-rate audit: all features below %.0f%% threshold", threshold * 100)
    else:
        log.warning("%d feature(s) exceed %.0f%% nulls:", len(high_null), threshold * 100)
        for feat, rate in high_null.items():
            log.warning("  %-30s  %.1f%% null", feat, rate * 100)


def check_leakage(X: pd.DataFrame, y: pd.Series, threshold: float = 0.70) -> None:
    """
    Detect data leakage: flag any feature with |correlation| > threshold with target.

    A legitimate feature rarely exceeds 0.5 correlation with a binary target.
    Anything above 0.7 almost certainly means future information leaked in —
    e.g. a forward-label column that wasn't excluded from the feature set.

    Exits with error if leakage is found — a leaky model would score 0 at
    inference time (feature is NULL → imputed to median → wrong prediction).
    """
    # Fill NaN so corrwith doesn't silently drop columns
    corrs = X.fillna(X.median()).corrwith(y.astype(float)).abs().sort_values(ascending=False)
    leaky = corrs[corrs > threshold]
    if not leaky.empty:
        log.error("─── LEAKAGE DETECTED ──────────────────────────────────────")
        log.error("The following features have suspiciously high correlation")
        log.error("with the target (|r| > %.2f). They may be forward labels", threshold)
        log.error("that were not excluded by the blocklist:")
        for feat, r in leaky.items():
            log.error("  %-35s  |r| = %.4f", feat, r)
        log.error("Fix: add these columns to _STOCK_NON_FEATURE_COLS in config.py")
        log.error("─────────────────────────────────────────────────────────────")
        raise SystemExit(1)
    log.info("Leakage check passed: no feature exceeds |r|=%.2f with target", threshold)


def check_null_drift(X_train: pd.DataFrame, X_pred: pd.DataFrame,
                     warn_threshold: float = 0.50) -> None:
    """
    Detect the 'null-at-inference' pattern that causes all predictions to collapse.

    If a column is mostly non-null in training but mostly null in inference,
    it is almost certainly a forward label (future return) that wasn't excluded.
    At inference time the feature is NULL → imputed to median → model outputs
    a constant probability → all scores identical (usually 0 or near-0).
    """
    train_nulls = X_train.isnull().mean()
    pred_nulls  = X_pred.isnull().mean()
    # Columns with low null rate in training but high null rate in inference
    drift = pred_nulls[(pred_nulls > warn_threshold) & (train_nulls < 0.10)]
    if not drift.empty:
        log.warning("─── NULL DRIFT WARNING ──────────────────────────────────")
        log.warning("These features are mostly non-null in training but mostly")
        log.warning("null in inference — scores may collapse to near-0:")
        for feat, rate in drift.items():
            log.warning("  %-35s  train_null=%.1f%%  pred_null=%.1f%%",
                        feat, train_nulls[feat] * 100, rate * 100)
        log.warning("If scores look wrong, check if these are forward labels.")
        log.warning("─────────────────────────────────────────────────────────")


# ─── Optuna tuning ────────────────────────────────────────────────────────────

def tune_hyperparams(X_train: pd.DataFrame, y_train: pd.Series, n_trials: int = 50) -> dict:
    try:
        import optuna
        import lightgbm as lgb
        from sklearn.model_selection import TimeSeriesSplit, cross_val_score

        optuna.logging.set_verbosity(optuna.logging.WARNING)

        def objective(trial):
            # Search space is deliberately tighter than typical LightGBM
            # defaults: cross-sectional equity data has a far lower
            # signal-to-noise ratio, so shallow trees, large leaves, and
            # aggressive column subsampling act as regularizers against
            # memorizing per-stock anomalies.
            params = {
                "n_estimators":      trial.suggest_int("n_estimators", 200, 800),
                "learning_rate":     trial.suggest_float("learning_rate", 0.01, 0.1, log=True),
                "max_depth":         trial.suggest_int("max_depth", 2, 4),
                "num_leaves":        trial.suggest_int("num_leaves", 7, 15),
                "min_child_samples": trial.suggest_int("min_child_samples", 50, 150),
                "subsample":         trial.suggest_float("subsample", 0.6, 1.0),
                "colsample_bytree":  trial.suggest_float("colsample_bytree", 0.3, 0.6),
                "reg_alpha":         trial.suggest_float("reg_alpha", 1e-3, 1.0, log=True),
                "reg_lambda":        trial.suggest_float("reg_lambda", 1e-3, 1.0, log=True),
                "class_weight": "balanced", "random_state": 42, "verbose": -1,
            }
            m  = lgb.LGBMClassifier(**params)
            cv = TimeSeriesSplit(n_splits=5)
            scores = cross_val_score(m, X_train, y_train, cv=cv, scoring="roc_auc", n_jobs=-1)
            return scores.mean()

        study = optuna.create_study(direction="maximize")
        study.optimize(objective, n_trials=n_trials, show_progress_bar=True)
        best = study.best_params
        best.update({"class_weight": "balanced", "random_state": 42, "verbose": -1})
        log.info("Best AUC (CV): %.4f | params: %s", study.best_value, best)
        return best
    except ImportError:
        log.warning("Optuna not installed — using default params")
        return DEFAULT_PARAMS


# ─── Training ─────────────────────────────────────────────────────────────────

def train_model(X_train, y_train, params, calibrate=True):
    import lightgbm as lgb
    from sklearn.calibration import CalibratedClassifierCV

    base = lgb.LGBMClassifier(**params)
    if calibrate and len(y_train) >= 200:
        model = CalibratedClassifierCV(base, cv=5, method="isotonic")
        log.info("Fitting calibrated LightGBM…")
    else:
        model = base
        log.info("Fitting LightGBM (no calibration)…")
    model.fit(X_train, y_train)
    log.info("Training complete")
    return model


def cross_val_metrics(X, y, params) -> dict[str, float]:
    import lightgbm as lgb
    from sklearn.model_selection import TimeSeriesSplit
    from sklearn.metrics import roc_auc_score

    kf = TimeSeriesSplit(n_splits=5)
    aucs, precs = [], []
    for train_idx, val_idx in kf.split(X, y):
        m = lgb.LGBMClassifier(**params)
        m.fit(X.iloc[train_idx], y.iloc[train_idx])
        prob  = m.predict_proba(X.iloc[val_idx])[:, 1]
        y_val = y.iloc[val_idx].values
        if y_val.sum() > 0:
            aucs.append(roc_auc_score(y_val, prob))
        n = max(1, int(len(prob) * 0.25))
        precs.append(float(y_val[np.argsort(prob)[-n:]].mean()))

    return {
        "cv_auc":              float(np.mean(aucs))  if aucs  else None,
        "cv_precision_top_q":  float(np.mean(precs)) if precs else None,
    }


# ─── SHAP ─────────────────────────────────────────────────────────────────────

def compute_shap_top5(model, X) -> list[list[dict]]:
    try:
        import shap
        base = model
        if hasattr(model, "calibrated_classifiers_"):
            base = model.calibrated_classifiers_[0].estimator
        elif hasattr(model, "estimator") and hasattr(model.estimator, "feature_importances_"):
            base = model.estimator

        explainer = shap.TreeExplainer(base)
        sv = explainer.shap_values(X)
        if isinstance(sv, list):
            sv = sv[1]

        results = []
        feat_names = X.columns.tolist()
        for i in range(len(X)):
            row_shap = sv[i]
            row_vals = X.iloc[i]
            order    = np.argsort(np.abs(row_shap))[::-1][:5]
            results.append([
                {"name": feat_names[j], "value": round(float(row_vals.iloc[j]), 4),
                 "shap": round(float(row_shap[j]), 4)}
                for j in order
            ])
        return results
    except Exception as e:
        log.debug("SHAP failed (%s) — skipping top_features", e)
        return [[] for _ in range(len(X))]


def get_feature_importance(model, feature_names) -> list[dict]:
    base = model
    if hasattr(model, "calibrated_classifiers_"):
        base = model.calibrated_classifiers_[0].estimator
    elif hasattr(model, "estimator") and hasattr(model.estimator, "feature_importances_"):
        base = model.estimator
    if not hasattr(base, "feature_importances_"):
        return []
    fi    = base.feature_importances_
    pairs = sorted(zip(feature_names, fi.tolist()), key=lambda x: x[1], reverse=True)
    return [{"feature": k, "importance": round(v, 4)} for k, v in pairs[:20]]


# ─── Writers ──────────────────────────────────────────────────────────────────

def write_predictions(supabase, pred_df, probs, top_features_list,
                      model_version, prediction_date, prob_col: str = "p_top_quartile_3m",
                      batch=500) -> int:
    rows   = []
    order  = np.argsort(probs)[::-1]
    g_rank = np.empty(len(probs), dtype=int)
    g_rank[order] = np.arange(1, len(probs) + 1)

    sectors    = pred_df["sector"].fillna("Unknown").values
    sec_ranks  = np.zeros(len(probs), dtype=int)
    for sec in np.unique(sectors):
        mask      = sectors == sec
        sec_probs = probs[mask]
        sec_ord   = np.argsort(sec_probs)[::-1]
        r         = np.empty(len(sec_probs), dtype=int)
        r[sec_ord] = np.arange(1, len(sec_probs) + 1)
        sec_ranks[mask] = r

    for i, (_, row) in enumerate(pred_df.iterrows()):
        rows.append({
            "symbol":           row["symbol"],
            "prediction_date":  str(prediction_date),
            "model_version":    model_version,
            prob_col:           round(float(probs[i]), 6),
            "pred_rank":        int(g_rank[i]),
            "pred_sector_rank": int(sec_ranks[i]),
            "top_features":     top_features_list[i],
        })

    total = 0
    for i in range(0, len(rows), batch):
        supabase.table("stock_predictions").upsert(
            rows[i : i + batch], on_conflict="symbol,prediction_date,model_version"
        ).execute()
        total += len(rows[i : i + batch])
    log.info("Wrote %d prediction rows (model=%s)", total, model_version)
    return total


def write_model_run(supabase, model_version, feature_count, training_samples,
                    training_window, cv_metrics, params, feature_importance, notes=""):
    row = {
        "model_version":      model_version,
        "feature_count":      feature_count,
        "training_samples":   training_samples,
        "training_window":    training_window,
        "cv_auc":              cv_metrics.get("cv_auc"),
        "cv_precision_top_q":  cv_metrics.get("cv_precision_top_q"),
        "oos_auc":             cv_metrics.get("oos_auc"),
        "oos_precision_top_q": cv_metrics.get("oos_precision_top_q"),
        "oos_samples":         cv_metrics.get("oos_samples"),
        "hyperparams":         params,
        "feature_importance": feature_importance,
        "notes":              notes,
    }
    insert_model_run(supabase, "stock_model_runs", row)
    log.info("Logged model run: %s  AUC=%.3f  OOS-AUC=%s", model_version,
             cv_metrics.get("cv_auc") or 0,
             f"{cv_metrics['oos_auc']:.3f}" if cv_metrics.get("oos_auc") is not None else "n/a")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--prediction-date", type=str, default=None)
    p.add_argument("--horizon",       type=str, default="3m", choices=["3m", "1m"],
                   help="Prediction horizon: 3m (default) or 1m")
    p.add_argument("--tune",          action="store_true")
    p.add_argument("--n-trials",      type=int, default=50)
    p.add_argument("--no-calibrate",  action="store_true")
    p.add_argument("--no-shap",       action="store_true")
    p.add_argument("--dry-run",       action="store_true")
    p.add_argument("--sharpe-target", action="store_true",
                   help="Use risk-adjusted (Sharpe-quartile) label instead of raw-return quartile")
    args = p.parse_args()

    # Resolve horizon-specific column names
    if args.horizon == "1m":
        target_col = "fwd_top_q_1m"
        prob_col   = "p_top_quartile_1m"
    elif args.sharpe_target:
        target_col = STOCK_SHARPE_TARGET_COL   # fwd_top_sharpe_q_3m
        prob_col   = "p_top_sharpe_q_3m"
    else:
        target_col = STOCK_TARGET_COL           # fwd_top_q_3m
        prob_col   = "p_top_quartile_3m"
    horizon_tag = args.horizon
    log.info("Horizon: %s  target=%s  output=%s  sharpe=%s",
             horizon_tag, target_col, prob_col, args.sharpe_target)

    pred_date = date.fromisoformat(args.prediction_date) if args.prediction_date else date.today()

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)

    supabase = create_client(url, key)

    # ── 1. Load training data ──────────────────────────────────────────────
    train_df = load_labeled(supabase, target_col)
    if len(train_df) < 50:
        log.error(
            "Only %d labeled rows found for %s. Run:\n"
            "  python extract_stock_features.py --backfill 730 --no-fundamentals\n"
            "  python label_stock_targets.py --window %s\n"
            "to build the training set (needs %s+ days of data).",
            len(train_df), target_col,
            "30" if args.horizon == "1m" else "90",
            "30" if args.horizon == "1m" else "90",
        )
        sys.exit(1)

    X_train, train_medians = prepare_X(train_df)
    y_train = train_df[target_col].astype(int)
    training_window = (
        f"{train_df['as_of_date'].min().date()} to {train_df['as_of_date'].max().date()}"
    )
    log.info("Training set: %d rows × %d features  window: %s",
             len(X_train), len(X_train.columns), training_window)
    log.info("Class balance: %d positive / %d negative (%.1f%%)",
             y_train.sum(), len(y_train) - y_train.sum(), y_train.mean() * 100)
    audit_null_rates(train_df[get_stock_feature_cols(train_df)])
    check_leakage(X_train, y_train)   # exits if any feature |r|>0.70 with target

    # ── 2. Hyperparameters ─────────────────────────────────────────────────
    params = tune_hyperparams(X_train, y_train, n_trials=args.n_trials) if args.tune else DEFAULT_PARAMS
    if not args.tune:
        log.info("Using default hyperparameters")

    # ── 3. Cross-validation ────────────────────────────────────────────────
    log.info("Running 5-fold TimeSeriesSplit CV…")
    cv_metrics = cross_val_metrics(X_train, y_train, params)
    log.info("CV AUC=%.4f  Precision@Q1=%.4f",
             cv_metrics.get("cv_auc") or 0, cv_metrics.get("cv_precision_top_q") or 0)

    # ── 3b. Walk-forward out-of-sample check (rolling embargoed windows) ───
    # CV folds overlap the training distribution; oos_auc is the honest live
    # estimate and the ML blend gate (backend/ml_blend.js) prefers it.
    # Multi-window mean with a label-horizon embargo — see ml/oos.py.
    oos = evaluate_oos_windows(train_df, target_col, params, prepare_X)
    oos.pop("oos_windows", None)  # per-window detail is logged, not persisted
    cv_metrics.update(oos)

    # ── 4. Train on full labeled set ───────────────────────────────────────
    model = train_model(X_train, y_train, params, calibrate=not args.no_calibrate)
    fi    = get_feature_importance(model, X_train.columns.tolist())
    if fi:
        log.info("Top 5 features: %s", [x["feature"] for x in fi[:5]])

    # ── 5. Inference features ──────────────────────────────────────────────
    pred_df = load_latest_features(supabase, pred_date)
    if pred_df.empty:
        log.error("No inference features available. Exiting.")
        sys.exit(1)

    X_pred, _ = prepare_X(pred_df, fit_medians=train_medians)
    for col in X_train.columns:
        if col not in X_pred.columns:
            X_pred[col] = train_medians.get(col, 0.0)
    X_pred = X_pred[X_train.columns]
    check_null_drift(X_train, X_pred)  # warns if a col is non-null in train but null in inference

    # ── 6. Predict ─────────────────────────────────────────────────────────
    probs  = model.predict_proba(X_pred)[:, 1]
    p5, p95 = np.percentile(probs, [5, 95])
    log.info(
        "Predictions: %d stocks  mean=%.3f  std=%.3f  p5=%.3f  p95=%.3f",
        len(probs), probs.mean(), probs.std(), p5, p95,
    )
    if probs.std() < 0.04:
        log.warning(
            "std=%.4f is very low — model may not be discriminating. "
            "Check feature data and training set size.",
            probs.std(),
        )

    # ── 7. SHAP ────────────────────────────────────────────────────────────
    top_features_list = (
        [[] for _ in range(len(X_pred))]
        if args.no_shap
        else compute_shap_top5(model, X_pred)
    )

    # ── 8. Model version ───────────────────────────────────────────────────
    feat_hash     = hashlib.md5(",".join(sorted(X_train.columns)).encode()).hexdigest()[:6]
    model_version = f"stock_lgbm_v1.0_{horizon_tag}_{pred_date}_{feat_hash}"

    # ── 9. Write ───────────────────────────────────────────────────────────
    if args.dry_run:
        log.info("dry-run: skipping Supabase writes")
        log.info("Sample: symbol=%s  p=%.4f",
                 pred_df.iloc[0]["symbol"], float(probs[0]))
    else:
        write_predictions(supabase, pred_df, probs, top_features_list,
                          model_version=model_version, prediction_date=pred_date,
                          prob_col=prob_col)
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
    from script_runner import run
    run(main)
