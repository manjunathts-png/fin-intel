"""
Walk-forward out-of-sample evaluation
======================================

Time-series CV folds still overlap the training distribution; a true holdout —
the most recent 90 days of labeled history, never seen during fitting — is the
honest estimate of live performance. Both trainers (train.py, train_stock.py)
call evaluate_oos() and log oos_auc next to cv_auc; the ML blend gate in
backend/ml_blend.js prefers oos_auc when present.

The production model is still refit on ALL labeled data afterwards — the
holdout model exists only to measure, not to predict.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

log = logging.getLogger("oos")

HOLDOUT_DAYS     = 90    # calendar days of labeled history reserved for OOS
MIN_HOLDOUT_ROWS = 30    # below this the metric is too noisy to report
MIN_FIT_ROWS     = 100


def time_holdout_split(
    df: pd.DataFrame,
    date_col: str = "as_of_date",
    holdout_days: int = HOLDOUT_DAYS,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Split labeled rows into (fit, holdout) strictly by date.

    Holdout = rows in the last `holdout_days` calendar days of labeled history.
    No shuffling — the boundary is a single point in time, so the holdout is a
    genuine "future" relative to the fit set.
    """
    max_date = df[date_col].max()
    cutoff = max_date - pd.Timedelta(days=holdout_days)
    fit = df[df[date_col] <= cutoff]
    holdout = df[df[date_col] > cutoff]
    return fit, holdout


def oos_metrics(params: dict, X_fit, y_fit, X_hold, y_hold) -> dict:
    """Train a fresh LightGBM on the fit set, score the holdout.

    Returns {"oos_auc", "oos_precision_top_q", "oos_samples"} with None metrics
    when the holdout is too small or single-class (metric would be undefined).
    """
    out: dict = {
        "oos_auc": None,
        "oos_precision_top_q": None,
        "oos_samples": int(len(X_hold)),
    }
    if len(X_fit) < MIN_FIT_ROWS or len(X_hold) < MIN_HOLDOUT_ROWS:
        log.warning("OOS skipped: fit=%d holdout=%d rows (need %d/%d)",
                    len(X_fit), len(X_hold), MIN_FIT_ROWS, MIN_HOLDOUT_ROWS)
        return out
    if pd.Series(y_fit).nunique() < 2 or pd.Series(y_hold).nunique() < 2:
        log.warning("OOS skipped: single-class fit or holdout")
        return out

    import lightgbm as lgb
    from sklearn.metrics import roc_auc_score

    m = lgb.LGBMClassifier(**params)
    m.fit(X_fit, y_fit)
    prob = m.predict_proba(X_hold)[:, 1]

    out["oos_auc"] = float(roc_auc_score(y_hold, prob))
    n_top = max(1, int(len(prob) * 0.25))
    top_idx = np.argsort(prob)[-n_top:]
    out["oos_precision_top_q"] = float(np.asarray(y_hold)[top_idx].mean())
    return out


def evaluate_oos(
    train_df: pd.DataFrame,
    target_col: str,
    params: dict,
    prepare_X_fn,
    date_col: str = "as_of_date",
    holdout_days: int = HOLDOUT_DAYS,
) -> dict:
    """End-to-end walk-forward evaluation for a trainer.

    prepare_X_fn must be the trainer's own prepare_X(df, fit_medians=None) →
    (X, medians), so feature selection and imputation match production exactly.
    Holdout imputation uses fit-set medians — no information from the holdout
    leaks into preprocessing.
    """
    fit_df, hold_df = time_holdout_split(train_df, date_col, holdout_days)
    if fit_df.empty or hold_df.empty:
        log.warning("OOS skipped: empty fit or holdout after split")
        return {"oos_auc": None, "oos_precision_top_q": None, "oos_samples": int(len(hold_df))}

    X_fit, fit_medians = prepare_X_fn(fit_df)
    X_hold, _ = prepare_X_fn(hold_df, fit_medians)
    # Align holdout columns to the fit feature set
    for col in X_fit.columns:
        if col not in X_hold.columns:
            X_hold[col] = fit_medians.get(col, 0.0)
    X_hold = X_hold[X_fit.columns]

    y_fit = fit_df[target_col].astype(int)
    y_hold = hold_df[target_col].astype(int)

    metrics = oos_metrics(params, X_fit, y_fit, X_hold, y_hold)
    if metrics["oos_auc"] is not None:
        log.info(
            "Walk-forward OOS (%dd holdout, %d rows, %s → %s): AUC=%.4f  Precision@Q1=%.4f",
            holdout_days, metrics["oos_samples"],
            hold_df[date_col].min().date(), hold_df[date_col].max().date(),
            metrics["oos_auc"], metrics["oos_precision_top_q"],
        )
    return metrics
