-- Migration 009: stock_sentiment table + GDELT source tracking
-- stock_sentiment mirrors mf_sentiment structure for stocks (NSE symbol-keyed).

CREATE TABLE IF NOT EXISTS stock_sentiment (
    id                BIGSERIAL PRIMARY KEY,
    symbol            TEXT        NOT NULL,           -- NSE symbol (e.g. "TCS")
    week_start_date   DATE        NOT NULL,           -- Monday of the scored week
    sentiment_score   FLOAT,                          -- -1.0 to 1.0
    sentiment_label   TEXT,                           -- Positive | Neutral | Negative
    summary           TEXT,
    key_themes        JSONB,
    source            TEXT DEFAULT 'gdelt',           -- news source used
    generated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (symbol, week_start_date)
);

CREATE INDEX IF NOT EXISTS idx_stock_sentiment_symbol  ON stock_sentiment (symbol);
CREATE INDEX IF NOT EXISTS idx_stock_sentiment_week    ON stock_sentiment (week_start_date DESC);

-- Add source column to mf_sentiment too (tracks whether data came from GDELT or legacy RSS)
ALTER TABLE mf_sentiment ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'gdelt';

COMMENT ON TABLE stock_sentiment IS 'Weekly GDELT-sourced sentiment scores for NSE stocks, scored by Claude Haiku.';
