"""
Walk-forward out-of-sample evaluation
======================================

Time-series CV folds still overlap the training distribution; a true holdout —
the most recent labeled history, never seen during fitting — is the honest
estimate of live performance. Both trainers (train.py, train_stock.py) call
evaluate_oos_windows() and log oos_auc next to cv_auc; the ML blend gate in
backend/ml_blend.js prefers oos_auc when present.

Two leakage controls beyond the plain temporal split:

  EMBARGO — the 3M target means a row at date T carries a label computed from
  prices up to T+90. Without an embargo, fit rows just before the holdout
  cutoff embed information about the exact period the holdout evaluates.
  Fit rows within `embargo_days` (= the label horizon) of the holdout start
  are therefore dropped.

  MULTI-WINDOW — a single 90-day holdout is one regime window and high
  variance. evaluate_oos_windows() walks back through up to n_windows
  consecutive holdout windows and reports the mean, so the blend gate sees a
  stabler estimate. Older windows activate automatically as labeled history
  grows past what each window + embargo needs.

The production model is still refit on ALL labeled data afterwards — the
holdout models exist only to measure, not to predict.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

log = logging.getLogger("oos")

HOLDOUT_DAYS     = 90    # calendar days of labeled history per OOS window
MIN_HOLDOUT_ROWS = 30    # below this the metric is too noisy to report
MIN_FIT_ROWS     = 100
DEFAULT_WINDOWS  = 3     # rolling OOS windows (older ones skip if data is short)


def embargo_for_target(target_col: str) -> int:
    """Embargo length = the label's forward horizon: 30d for 1M targets,
    90d for 3M targets. A row's label looks this far into the future, so fit
    rows closer than this to the holdout leak holdout-period returns."""
    return 30 if "_1m" in target_col else 90


def time_holdout_split(
    df: pd.DataFrame,
    date_col: str = "as_of_date",
    holdout_days: int = HOLDOUT_DAYS,
    embargo_days: int = 0,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Split labeled rows into (fit, holdout) strictly by date.

    Holdout = rows in the last `holdout_days` calendar days of labeled history.
    Fit     = rows at least `embargo_days` before the holdout starts — rows in
    the embargo gap are dropped entirely (their labels overlap the holdout
    period). No shuffling — the boundary is a single point in time, so the
    holdout is a genuine "future" relative to the fit set.
    """
    max_date = df[date_col].max()
    cutoff = max_date - pd.Timedelta(days=holdout_days)
    fit = df[df[date_col] <= cutoff - pd.Timedelta(days=embargo_days)]
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


def _evaluate_pair(
    fit_df: pd.DataFrame,
    hold_df: pd.DataFrame,
    target_col: str,
    params: dict,
    prepare_X_fn,
) -> dict:
    """Prepare features for a (fit, holdout) pair and score it.

    prepare_X_fn must be the trainer's own prepare_X(df, fit_medians=None) →
    (X, medians), so feature selection and imputation match production exactly.
    Holdout imputation uses fit-set medians — no information from the holdout
    leaks into preprocessing.
    """
    X_fit, fit_medians = prepare_X_fn(fit_df)
    X_hold, _ = prepare_X_fn(hold_df, fit_medians)
    # Align holdout columns to the fit feature set
    for col in X_fit.columns:
        if col not in X_hold.columns:
            X_hold[col] = fit_medians.get(col, 0.0)
    X_hold = X_hold[X_fit.columns]

    y_fit = fit_df[target_col].astype(int)
    y_hold = hold_df[target_col].astype(int)
    return oos_metrics(params, X_fit, y_fit, X_hold, y_hold)


def evaluate_oos(
    train_df: pd.DataFrame,
    target_col: str,
    params: dict,
    prepare_X_fn,
    date_col: str = "as_of_date",
    holdout_days: int = HOLDOUT_DAYS,
    embargo_days: int | None = None,
) -> dict:
    """Single-window walk-forward evaluation with a label-horizon embargo.

    embargo_days=None infers the embargo from the target column name
    (30d for *_1m targets, 90d otherwise).
    """
    if embargo_days is None:
        embargo_days = embargo_for_target(target_col)
    fit_df, hold_df = time_holdout_split(train_df, date_col, holdout_days, embargo_days)
    if fit_df.empty or hold_df.empty:
        log.warning("OOS skipped: empty fit or holdout after split (embargo=%dd)", embargo_days)
        return {"oos_auc": None, "oos_precision_top_q": None, "oos_samples": int(len(hold_df))}

    metrics = _evaluate_pair(fit_df, hold_df, target_col, params, prepare_X_fn)
    if metrics["oos_auc"] is not None:
        log.info(
            "Walk-forward OOS (%dd holdout, %dd embargo, %d rows, %s → %s): AUC=%.4f  Precision@Q1=%.4f",
            holdout_days, embargo_days, metrics["oos_samples"],
            hold_df[date_col].min().date(), hold_df[date_col].max().date(),
            metrics["oos_auc"], metrics["oos_precision_top_q"],
        )
    return metrics


def evaluate_oos_windows(
    train_df: pd.DataFrame,
    target_col: str,
    params: dict,
    prepare_X_fn,
    date_col: str = "as_of_date",
    holdout_days: int = HOLDOUT_DAYS,
    n_windows: int = DEFAULT_WINDOWS,
    embargo_days: int | None = None,
) -> dict:
    """Rolling multi-window walk-forward evaluation.

    Window i holds out (max_date − (i+1)·H, max_date − i·H] and fits on rows
    at least `embargo_days` before the window start. Windows that lack enough
    fit or holdout rows are skipped; the loop stops once fit data runs out
    (every older window can only have less). Reported oos_auc /
    oos_precision_top_q are the means over scored windows — a stabler estimate
    than any single window — and per-window detail is returned in
    "oos_windows" for logging.
    """
    if embargo_days is None:
        embargo_days = embargo_for_target(target_col)
    max_date = train_df[date_col].max()

    windows: list[dict] = []
    for i in range(n_windows):
        hold_end   = max_date - pd.Timedelta(days=i * holdout_days)
        hold_start = hold_end - pd.Timedelta(days=holdout_days)
        fit_cutoff = hold_start - pd.Timedelta(days=embargo_days)
        fit_df  = train_df[train_df[date_col] <= fit_cutoff]
        hold_df = train_df[(train_df[date_col] > hold_start) & (train_df[date_col] <= hold_end)]
        if len(fit_df) < MIN_FIT_ROWS:
            log.info("OOS window %d skipped: only %d fit rows before %s — stopping (older windows have less)",
                     i, len(fit_df), fit_cutoff.date())
            break
        if hold_df.empty:
            continue
        m = _evaluate_pair(fit_df, hold_df, target_col, params, prepare_X_fn)
        windows.append({
            **m,
            "window": i,
            "hold_start": str(hold_start.date()),
            "hold_end": str(hold_end.date()),
        })

    aucs  = [w["oos_auc"] for w in windows if w["oos_auc"] is not None]
    precs = [w["oos_precision_top_q"] for w in windows if w["oos_precision_top_q"] is not None]
    samples = sum(w["oos_samples"] for w in windows if w["oos_auc"] is not None)

    result = {
        "oos_auc":             float(np.mean(aucs))  if aucs  else None,
        "oos_precision_top_q": float(np.mean(precs)) if precs else None,
        "oos_samples":         int(samples),
        "oos_windows":         windows,
    }
    if aucs:
        log.info(
            "Walk-forward OOS over %d window(s) (%dd each, %dd embargo): "
            "AUC mean=%.4f std=%.4f  per-window=%s",
            len(aucs), holdout_days, embargo_days,
            result["oos_auc"], float(np.std(aucs)),
            [f"{a:.3f}" for a in aucs],
        )
    else:
        log.warning("OOS: no window had enough data to score (embargo=%dd)", embargo_days)
    return result


OOS_RUN_COLS = ("oos_auc", "oos_precision_top_q", "oos_samples")


def insert_model_run(supabase, table: str, row: dict) -> None:
    """Insert a model-run row; if the oos_* columns don't exist yet
    (migration 012 not applied), retry without them.

    Shared by train.py (mf_model_runs) and train_stock.py (stock_model_runs)
    so the fallback behavior can't drift between the two trainers.
    """
    try:
        supabase.table(table).insert(row, returning="minimal").execute()
    except Exception as e:
        if "oos_" not in str(e):
            raise
        for k in OOS_RUN_COLS:
            row.pop(k, None)
        supabase.table(table).insert(row, returning="minimal").execute()
        log.warning("%s lacks oos_* columns — run migrate_012 (dispatch target=migrate)", table)
