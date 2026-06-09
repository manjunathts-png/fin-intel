"""
Shared constants for the ML pipeline.
Import from here instead of duplicating across scripts.
"""

# ─── Feature discovery (blocklist approach) ───────────────────────────────────
#
# Problem with hardcoded whitelists (FEATURE_COLS / STOCK_FEATURE_COLS):
#   Any new column written to the DB is silently ignored by the model until
#   someone remembers to add it to the list — a hidden contract with no
#   enforcement, and the bug only surfaces as "AUC didn't improve".
#
# Solution: blocklist instead of whitelist.
#   get_feature_cols(df) returns every numeric column that isn't an identifier,
#   a forward label, or other metadata. New features are auto-discovered on the
#   next training run without any code change.
#
# The null-rate filter in train.py / train_stock.py then drops columns with
# too many NULLs, so partially-backfilled features degrade gracefully.

# Columns that must NEVER be used as features.
# Split into groups so it's obvious why each one is excluded.
_MF_NON_FEATURE_COLS: frozenset[str] = frozenset({
    # ── Identifiers ────────────────────────────────────────────────────────
    "scheme_code", "as_of_date", "category", "fund_name",
    # ── Forward labels — must not leak into features ────────────────────────
    # Binary targets
    "fwd_top_q_3m", "fwd_top_q_1m",
    "fwd_top_sharpe_q_3m", "fwd_top_sharpe_q_1m",
    # Continuous returns / Sharpe
    "fwd_ret_3m", "fwd_ret_1m",
    "fwd_sharpe_3m",
    # Quartile ranks (int 1–4): perfectly correlated with the target.
    # CRITICAL: at inference time these are NULL → median-imputed to ~2.5
    # → model predicts "not top quartile" for every fund → all scores = 0
    "fwd_quartile_3m", "fwd_quartile_1m",
    # Sharpe quartile ranks
    "fwd_sharpe_q_3m", "fwd_sharpe_q_1m",
    # ── Admin / internal ───────────────────────────────────────────────────
    "id", "created_at", "updated_at",
})

_STOCK_NON_FEATURE_COLS: frozenset[str] = frozenset({
    # ── Identifiers ────────────────────────────────────────────────────────
    "symbol", "as_of_date", "sector", "stock_name",
    # ── Forward labels — must not leak into features ────────────────────────
    # Binary targets
    "fwd_top_q_3m", "fwd_top_q_1m",
    "fwd_top_sharpe_q_3m", "fwd_top_sharpe_q_1m",
    # Continuous returns / Sharpe
    "fwd_ret_3m", "fwd_ret_1m",
    "fwd_sharpe_3m",
    # Quartile ranks (int 1–4): perfectly correlated with the target.
    # CRITICAL: at inference time these are NULL → median-imputed to ~2.5
    # → model predicts "not top quartile" for every stock → all scores = 0
    "fwd_quartile_3m", "fwd_quartile_1m",
    # Sharpe quartile ranks
    "fwd_sharpe_q_3m", "fwd_sharpe_q_1m",
    # ── Admin / internal ───────────────────────────────────────────────────
    "id", "created_at", "updated_at",
})


def get_mf_feature_cols(df) -> list[str]:
    """
    Auto-discover MF feature columns from a DataFrame.
    Returns every numeric column that is safe to use as a model feature.

    Two exclusion layers (belt-and-suspenders):
      1. fwd_ prefix rule  — any column starting with 'fwd_' is a forward label
         written by label_targets.py and must never be a feature. This catches
         new forward-label columns automatically even if the blocklist is not
         updated (e.g. the fwd_quartile_3m bug that caused all scores = 0).
      2. Explicit blocklist — identifiers, admin columns, and any edge-case
         forward labels that don't follow the fwd_ convention.
    """
    numeric = df.select_dtypes(include=["number"]).columns.tolist()
    return [c for c in numeric
            if not c.startswith("fwd_")          # Layer 1: prefix rule
            and c not in _MF_NON_FEATURE_COLS]   # Layer 2: explicit blocklist


def get_stock_feature_cols(df) -> list[str]:
    """
    Auto-discover stock feature columns from a DataFrame.
    Returns every numeric column that is safe to use as a model feature.

    Two exclusion layers (belt-and-suspenders):
      1. fwd_ prefix rule  — any column starting with 'fwd_' is a forward label
         written by label_stock_targets.py and must never be a feature.
      2. Explicit blocklist — identifiers and admin columns.
    """
    numeric = df.select_dtypes(include=["number"]).columns.tolist()
    return [c for c in numeric
            if not c.startswith("fwd_")             # Layer 1: prefix rule
            and c not in _STOCK_NON_FEATURE_COLS]   # Layer 2: explicit blocklist


# ─── MF model targets ─────────────────────────────────────────────────────────

TARGET_COL        = "fwd_top_q_3m"
RETURN_COL        = "fwd_ret_3m"
SHARPE_TARGET_COL = "fwd_top_sharpe_q_3m"

# ─── Stock model targets ──────────────────────────────────────────────────────

STOCK_TARGET_COL        = "fwd_top_q_3m"
STOCK_RETURN_COL        = "fwd_ret_3m"
STOCK_SHARPE_TARGET_COL = "fwd_top_sharpe_q_3m"

# ─── MF category → model group mapping ───────────────────────────────────────
# All unknown categories fall back to "other".

CATEGORY_GROUPS: dict[str, str] = {
    # Broad equity
    "Large Cap":       "equity",
    "Mid Cap":         "equity",
    "Small Cap":       "equity",
    "Flexi Cap":       "equity",
    "Large & Mid Cap": "equity",
    "Micro Cap":       "equity",
    "Multi Cap":       "equity",
    "Value":           "equity",
    "ELSS":            "equity",
    # Thematic / sector equity
    "Defence":                "sector",
    "PSU":                    "sector",
    "Technology":             "sector",
    "Pharma & Healthcare":    "sector",
    "Banking & Financial":    "sector",
    "Infrastructure":         "sector",
    "Manufacturing":          "sector",
    "Consumption":            "sector",
    "Energy":                 "sector",
    # Fixed income
    "Liquid":               "fixed_income",
    "Ultra Short Duration":  "fixed_income",
    "Low Duration":          "fixed_income",
    "Short Duration":        "fixed_income",
    "Medium Duration":       "fixed_income",
    "Long Duration":         "fixed_income",
    "Gilt":                  "fixed_income",
    "Credit Risk":           "fixed_income",
    "Money Market":          "fixed_income",
    "Corporate Bond":        "fixed_income",
    # Hybrid
    "Balanced":              "hybrid",
    "Aggressive Hybrid":     "hybrid",
    "Conservative Hybrid":   "hybrid",
    "Multi Asset":           "hybrid",
    # Commodities
    "Gold":          "commodity",
    "Silver":        "commodity",
    "Gold & Silver": "commodity",
}

# ─── Shared constants ─────────────────────────────────────────────────────────

RISK_FREE_RATE = 0.07   # India 10Y G-Sec rough proxy
TRADING_DAYS   = 252


# ─── Backwards compatibility ──────────────────────────────────────────────────
# Old whitelists kept so existing imports don't break during transition.
# train.py and train_stock.py have been updated to use get_*_feature_cols().
# These will be removed in a future cleanup.

def _legacy_feature_cols_warning(name: str) -> None:
    import warnings
    warnings.warn(
        f"{name} is a static whitelist and will miss new features. "
        "Use get_mf_feature_cols(df) or get_stock_feature_cols(df) instead.",
        DeprecationWarning, stacklevel=3,
    )

class _DeprecatedList(list):
    def __init__(self, items, name):
        super().__init__(items)
        self._name = name
    def __iter__(self):
        _legacy_feature_cols_warning(self._name)
        return super().__iter__()

FEATURE_COLS = _DeprecatedList([
    "ret1w", "ret1m", "ret3m", "ret6m", "ret1y", "ret3y", "ret5y",
    "cagr5y", "cagr10y", "vol_30d", "vol_90d", "vol_1y",
    "max_dd_1y", "downside_dev_1y", "sharpe_1y", "sortino_1y",
    "z1w", "positive_months_12m",
    "cat_rank_1m", "cat_rank_3m", "cat_rank_1y",
    "univ_rank_1m", "univ_rank_3m", "univ_rank_1y", "cat_z",
    "cat_momentum_3m", "cat_vs_univ_3m",
    "beta_nifty", "alpha_nifty", "corr_nifty",
    "nifty_ret1m", "nifty_ret3m", "india_vix", "usd_inr", "us_10y_yield",
    "sentiment_score",
    "cat_rel_max_dd_1y", "cat_rel_vol_1y", "cat_rel_sharpe_1y", "cat_rel_downside_dev",
], name="FEATURE_COLS")

STOCK_FEATURE_COLS = _DeprecatedList([
    "ret1w", "ret1m", "ret2m", "ret3m", "ret6m", "ret9m", "ret1y",
    "vol_30d", "vol_90d", "vol_1y", "max_dd_1y", "downside_dev_1y",
    "sharpe_1y", "sortino_1y", "rsi_14", "macd_hist", "bb_pct", "vol_ratio",
    "high52w_pct", "delivery_pct", "delivery_pct_5d_avg", "z1w",
    "positive_months_12m", "sector_rank_1m", "sector_rank_3m", "sector_rank_1y",
    "univ_rank_1m", "univ_rank_3m", "univ_rank_1y", "sector_z",
    "sector_rel_ret1m", "sector_rel_ret2m", "sector_rel_ret3m",
    "sector_rel_ret6m", "sector_rel_ret9m", "sector_rel_vol30d",
    "sector_rel_vol90d", "sector_rel_vol1y", "sector_rel_sharpe",
    "sector_rel_sortino", "sector_rel_rsi", "sector_rel_bb",
    "sector_rel_high52w", "sector_rel_beta", "sector_rel_maxdd",
    "sector_rel_delivery", "univ_rel_ret1m", "univ_rel_ret3m",
    "univ_rel_vol30d", "univ_rel_sharpe", "sector_momentum_3m",
    "sector_vs_univ_3m", "beta_nifty", "alpha_nifty", "corr_nifty",
    "pe_ratio", "pb_ratio", "roe", "revenue_growth", "earnings_growth",
    "profit_margins", "debt_to_equity", "dividend_yield",
    "nifty_ret1m", "nifty_ret3m", "india_vix", "usd_inr", "us_10y_yield",
    "fii_net_5d", "fii_net_20d", "dii_net_5d", "dii_net_20d",
    "fiidii_net_5d", "fiidii_net_20d", "sentiment_score",
], name="STOCK_FEATURE_COLS")
