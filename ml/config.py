"""
Shared constants for the ML pipeline.
Import from here instead of duplicating across scripts.
"""

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

RISK_FREE_RATE = 0.07   # India 10Y G-Sec rough proxy
TRADING_DAYS = 252
