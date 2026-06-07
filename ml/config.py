"""
Shared constants for the ML pipeline.
Import from here instead of duplicating across scripts.
"""

# ─── MF model ─────────────────────────────────────────────────────────────────

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
    # Category-level momentum vs universe (cross-category signal)
    "cat_momentum_3m",   # median ret3m of this fund's category
    "cat_vs_univ_3m",    # percentile of cat_momentum_3m vs all categories
    # Style vs benchmark
    "beta_nifty", "alpha_nifty", "corr_nifty",
    # Macro context (same across funds on same date)
    "nifty_ret1m", "nifty_ret3m",
    "india_vix", "usd_inr", "us_10y_yield",
    # News sentiment (-1.0 → +1.0; NULL imputed to 0.0)
    "sentiment_score",
    # Category-relative risk z-scores — within-peer normalization
    # A -25% max drawdown in Small Cap is normal; in Large Cap it's severe.
    # Absolute features give the model the same number for both cases.
    # These z-scores give the model "how much riskier than category peers"
    # and directly reduce the high-beta bias (top feature: max_dd_1y).
    "cat_rel_max_dd_1y",    # within-category z-score of max drawdown (negative = safer)
    "cat_rel_vol_1y",       # within-category z-score of 1yr volatility (negative = steadier)
    "cat_rel_sharpe_1y",    # within-category z-score of Sharpe ratio (positive = better)
    "cat_rel_downside_dev", # within-category z-score of downside deviation
]

TARGET_COL = "fwd_top_q_3m"
RETURN_COL = "fwd_ret_3m"

# Risk-adjusted target — Sharpe-quartile within category (preferred over raw return)
SHARPE_TARGET_COL = "fwd_top_sharpe_q_3m"

# Maps each MF category to a broad model group.
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
    "Liquid":              "fixed_income",
    "Ultra Short Duration": "fixed_income",
    "Low Duration":        "fixed_income",
    "Short Duration":      "fixed_income",
    "Medium Duration":     "fixed_income",
    "Long Duration":       "fixed_income",
    "Gilt":                "fixed_income",
    "Credit Risk":         "fixed_income",
    "Money Market":        "fixed_income",
    "Corporate Bond":      "fixed_income",
    # Hybrid
    "Balanced":              "hybrid",
    "Aggressive Hybrid":     "hybrid",
    "Conservative Hybrid":   "hybrid",
    "Multi Asset":           "hybrid",
    # Commodities
    "Gold": "commodity",
    "Silver": "commodity",
    "Gold & Silver": "commodity",
}

# ─── Stock model ──────────────────────────────────────────────────────────────

STOCK_FEATURE_COLS = [
    # ── Returns (multi-horizon momentum) ──────────────────────────────────────
    "ret1w", "ret1m", "ret2m", "ret3m", "ret6m", "ret9m", "ret1y",
    # ── Risk ──────────────────────────────────────────────────────────────────
    "vol_30d", "vol_90d", "vol_1y",
    "max_dd_1y", "downside_dev_1y",
    "sharpe_1y", "sortino_1y",
    # ── Technical indicators ───────────────────────────────────────────────────
    "rsi_14", "macd_hist", "bb_pct", "vol_ratio", "high52w_pct",
    # ── Delivery volume % (NSE bhavcopy DELIV_PER) ────────────────────────────
    "delivery_pct", "delivery_pct_5d_avg",
    # ── Momentum ──────────────────────────────────────────────────────────────
    "z1w", "positive_months_12m",
    # ── Cross-sectional ranks (universe + sector) ─────────────────────────────
    "sector_rank_1m", "sector_rank_3m", "sector_rank_1y",
    "univ_rank_1m",   "univ_rank_3m",   "univ_rank_1y",
    "sector_z",
    # ── Sector-relative z-scores (key lift — same as cat_rel_* for MF model) ──
    "sector_rel_ret1m",    "sector_rel_ret2m",   "sector_rel_ret3m",
    "sector_rel_ret6m",    "sector_rel_ret9m",
    "sector_rel_vol30d",   "sector_rel_vol90d",  "sector_rel_vol1y",
    "sector_rel_sharpe",   "sector_rel_sortino",
    "sector_rel_rsi",      "sector_rel_bb",      "sector_rel_high52w",
    "sector_rel_beta",     "sector_rel_maxdd",   "sector_rel_delivery",
    # ── Universe-relative z-scores ────────────────────────────────────────────
    "univ_rel_ret1m", "univ_rel_ret3m", "univ_rel_vol30d", "univ_rel_sharpe",
    # ── Cross-sector momentum ─────────────────────────────────────────────────
    "sector_momentum_3m", "sector_vs_univ_3m",
    # ── Style vs Nifty ────────────────────────────────────────────────────────
    "beta_nifty", "alpha_nifty", "corr_nifty",
    # ── Fundamentals snapshot ─────────────────────────────────────────────────
    "pe_ratio", "pb_ratio", "roe",
    "revenue_growth", "earnings_growth", "profit_margins",
    "debt_to_equity", "dividend_yield",
    # ── Macro context ─────────────────────────────────────────────────────────
    "nifty_ret1m", "nifty_ret3m",
    "india_vix", "usd_inr", "us_10y_yield",
    # ── FII/DII institutional flows (rolling net, ₹ crore) ───────────────────
    "fii_net_5d", "fii_net_20d",
    "dii_net_5d", "dii_net_20d",
    "fiidii_net_5d", "fiidii_net_20d",
    # ── News sentiment (GDELT + Claude Haiku, weekly) ─────────────────────────
    "sentiment_score",
]

STOCK_TARGET_COL  = "fwd_top_q_3m"
STOCK_RETURN_COL  = "fwd_ret_3m"
STOCK_SHARPE_TARGET_COL = "fwd_top_sharpe_q_3m"

# ─── Shared constants ─────────────────────────────────────────────────────────

RISK_FREE_RATE = 0.07   # India 10Y G-Sec rough proxy
TRADING_DAYS = 252
