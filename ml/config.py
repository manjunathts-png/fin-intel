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
    # Returns
    "ret1w", "ret1m", "ret3m", "ret6m", "ret1y",
    # Risk
    "vol_30d", "vol_90d", "vol_1y",
    "max_dd_1y", "downside_dev_1y",
    "sharpe_1y", "sortino_1y",
    # Technical indicators (new vs MF model)
    "rsi_14", "macd_hist", "bb_pct", "vol_ratio", "high52w_pct",
    # Momentum
    "z1w", "positive_months_12m",
    # Cross-sectional ranks
    "sector_rank_1m", "sector_rank_3m", "sector_rank_1y",
    "univ_rank_1m", "univ_rank_3m", "univ_rank_1y",
    "sector_z",
    # Sector-level momentum vs universe (cross-sector signal)
    "sector_momentum_3m",   # median ret3m of all stocks in this sector
    "sector_vs_univ_3m",    # percentile rank of that sector median vs all sectors
    # Style vs Nifty
    "beta_nifty", "alpha_nifty", "corr_nifty",
    # Fundamentals snapshot
    "pe_ratio", "pb_ratio", "roe",
    "revenue_growth", "earnings_growth", "profit_margins",
    "debt_to_equity", "dividend_yield",
    # Macro context
    "nifty_ret1m", "nifty_ret3m",
    "india_vix", "usd_inr", "us_10y_yield",
]

STOCK_TARGET_COL  = "fwd_top_q_3m"
STOCK_RETURN_COL  = "fwd_ret_3m"
STOCK_SHARPE_TARGET_COL = "fwd_top_sharpe_q_3m"

# ─── Shared constants ─────────────────────────────────────────────────────────

RISK_FREE_RATE = 0.07   # India 10Y G-Sec rough proxy
TRADING_DAYS = 252
