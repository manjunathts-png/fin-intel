"""
GDELT-Powered News Sentiment Pipeline
======================================

Fetches recent news articles for mutual funds and stocks from GDELT v2 DOC API
(free, no API key required), then scores them with Claude Haiku.

Writes results to mf_sentiment (funds) and stock_sentiment (stocks) in Supabase.
This replaces/supplements the manual RSS feed approach in sentiment.py and enables
historical backfill — GDELT has articles going back to 2013.

Usage:
    python gdelt_sentiment.py --mode mf                  # Score all MF funds (this week)
    python gdelt_sentiment.py --mode stocks              # Score all Nifty 500 stocks
    python gdelt_sentiment.py --mode mf --backfill 52    # Backfill last 52 weeks for MFs
    python gdelt_sentiment.py --mode mf --dry-run        # Fetch + score without writing

Env:
    SUPABASE_URL
    SUPABASE_SERVICE_KEY
    ANTHROPIC_API_KEY

Design:
    1. For each fund/stock, query GDELT for the entity name over a 7-day window
    2. Collect up to 20 article titles
    3. Batch through Claude Haiku: sentiment score (-1 to +1), label, summary, key_themes
    4. Write one row per entity per week to the sentiment table
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()
load_dotenv(Path(__file__).parent.parent / "backend" / ".env", override=False)

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("gdelt_sentiment")

# ── GDELT v2 DOC API ─────────────────────────────────────────────────────────
GDELT_URL  = "https://api.gdeltproject.org/api/v2/doc/doc"
MAX_ARTS    = 25         # articles per entity per week
GDELT_DELAY = 6.0        # seconds between requests — GDELT enforces 1 req/5s

# ── Claude model ─────────────────────────────────────────────────────────────
CLAUDE_MODEL = "claude-haiku-4-5"

# ── Entity query templates ────────────────────────────────────────────────────
STOCK_QUERY_SUFFIX = ' India NSE earnings'

# Maps AMC short-names → full company names as they appear in financial press
# GDELT indexes news articles — use the name financial journalists actually use
AMC_FULL_NAMES: dict[str, str] = {
    "HDFC":           "HDFC AMC",
    "SBI":            "SBI Mutual Fund",
    "ICICI Prudential":"ICICI Prudential AMC",
    "Axis":           "Axis Mutual Fund",
    "Nippon India":   "Nippon India Mutual Fund",
    "Kotak":          "Kotak Mahindra AMC",
    "Mirae Asset":    "Mirae Asset India",
    "DSP":            "DSP Mutual Fund",
    "Aditya Birla":   "Aditya Birla Sun Life AMC",
    "Franklin":       "Franklin Templeton India",
    "UTI":            "UTI Mutual Fund",
    "Tata":           "Tata Mutual Fund",
    "Canara Robeco":  "Canara Robeco Mutual Fund",
    "Sundaram":       "Sundaram Mutual Fund",
    "Edelweiss":      "Edelweiss Mutual Fund",
    "Invesco":        "Invesco India Mutual Fund",
    "Motilal Oswal":  "Motilal Oswal Mutual Fund",
    "Parag Parikh":   "Parag Parikh Mutual Fund",
    "PGIM":           "PGIM India Mutual Fund",
    "Baroda BNP":     "Baroda BNP Paribas Mutual Fund",
    "White Oak":      "White Oak Capital",
    "360 ONE":        "360 ONE Asset Management",
    "Quantum":        "Quantum Mutual Fund",
    "Navi":           "Navi Mutual Fund",
}


# ── MF universe helpers ───────────────────────────────────────────────────────
def _amc_query(fund_name: str) -> str:
    """
    Build a GDELT-optimised query string for an MF fund.
    Uses the full AMC company name as it appears in financial press.
    'HDFC Top 100 Fund' → '"HDFC AMC" India'
    """
    # Match longest AMC prefix first
    MULTI_WORD = [
        "Nippon India", "Mirae Asset", "ICICI Prudential", "Aditya Birla",
        "Canara Robeco", "Motilal Oswal", "Parag Parikh", "Baroda BNP",
        "White Oak", "360 ONE", "SBI ", "Axis ", "HDFC ", "Kotak ",
        "DSP ", "Franklin", "UTI ", "Tata ", "Sundaram ", "Edelweiss ",
        "Invesco ", "PGIM ", "Quantum ", "Navi ",
    ]
    short_name = fund_name.split()[0]
    for prefix in MULTI_WORD:
        if fund_name.startswith(prefix.strip()):
            short_name = prefix.strip()
            break

    full_name = AMC_FULL_NAMES.get(short_name, f"{short_name} Mutual Fund")
    return f'"{full_name}" India'


# ── GDELT fetcher ─────────────────────────────────────────────────────────────
def fetch_gdelt_articles(
    query: str,
    week_start: date,
    max_records: int = MAX_ARTS,
    retries: int = 3,
) -> list[str]:
    """
    Fetch article titles from GDELT for a given query string over a 7-day window.
    Returns a list of article title strings (empty list on error or no results).
    Handles 429 rate-limit by waiting and retrying up to `retries` times.
    """
    week_end = week_start + timedelta(days=7)
    fmt = "%Y%m%d%H%M%S"
    params = {
        "query":          query,
        "mode":           "artlist",
        "maxrecords":     str(max_records),
        "format":         "json",
        "sortby":         "DateDesc",
        "startdatetime":  week_start.strftime(fmt),
        "enddatetime":    week_end.strftime(fmt),
    }
    for attempt in range(retries):
        try:
            resp = requests.get(GDELT_URL, params=params, timeout=25)
            if resp.status_code == 429:
                wait = GDELT_DELAY * (attempt + 2)
                log.debug("GDELT 429 for %r — waiting %.0fs (attempt %d)", query, wait, attempt + 1)
                time.sleep(wait)
                continue
            if resp.status_code != 200:
                log.debug("GDELT non-200 for %r: %d", query, resp.status_code)
                return []
            data = resp.json()
            articles = data.get("articles", [])
            titles = [a.get("title", "").strip() for a in articles if a.get("title")]
            return [t for t in titles if len(t) > 10]
        except Exception as e:
            log.debug("GDELT fetch failed for %r: %s", query, e)
            if attempt < retries - 1:
                time.sleep(GDELT_DELAY)
    return []


# ── Claude Haiku scorer ───────────────────────────────────────────────────────
def score_with_claude(
    entity_name: str,
    headlines: list[str],
    claude_client,
) -> dict | None:
    """
    Score a list of headlines for an entity using Claude Haiku.
    Returns {score, label, summary, key_themes} or None on failure.
    """
    if not headlines:
        return None

    headlines_text = "\n".join(f"- {h}" for h in headlines[:20])
    prompt = f"""You are a financial news sentiment analyst.

Entity: {entity_name}

Recent news headlines:
{headlines_text}

Analyse the sentiment of these headlines toward {entity_name} as an investment.
Return ONLY valid JSON with exactly these fields:
{{
  "score": <float from -1.0 (very negative) to 1.0 (very positive)>,
  "label": <"Positive" | "Neutral" | "Negative">,
  "summary": "<1-2 sentence summary of what the headlines say about {entity_name}>",
  "key_themes": ["<theme1>", "<theme2>", "<theme3>"]
}}

Focus on investment-relevant sentiment (earnings, growth, regulation, management).
Do not include any explanation outside the JSON."""

    try:
        msg = claude_client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=400,
            messages=[{"role": "user", "content": prompt}],
        )
        text = msg.content[0].text.strip()
        # Strip markdown code fences if present
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        result = json.loads(text.strip())
        # Validate
        score = float(result.get("score", 0.0))
        score = max(-1.0, min(1.0, score))
        label = result.get("label", "Neutral")
        if label not in ("Positive", "Neutral", "Negative"):
            label = "Neutral"
        return {
            "score":      round(score, 3),
            "label":      label,
            "summary":    str(result.get("summary", ""))[:500],
            "key_themes": list(result.get("key_themes", []))[:5],
        }
    except Exception as e:
        log.debug("Claude scoring failed for %r: %s", entity_name, e)
        return None


# ── Supabase writers ──────────────────────────────────────────────────────────
def upsert_mf_sentiment(supabase, rows: list[dict]) -> None:
    if not rows:
        return
    supabase.table("mf_sentiment").upsert(
        rows, on_conflict="scheme_code,week_start_date"
    ).execute()


def upsert_stock_sentiment(supabase, rows: list[dict]) -> None:
    if not rows:
        return
    # Assumes stock_sentiment table: symbol, week_start_date, sentiment_score, sentiment_label, summary, key_themes
    supabase.table("stock_sentiment").upsert(
        rows, on_conflict="symbol,week_start_date"
    ).execute()


# ── MF fund list loader ───────────────────────────────────────────────────────
def load_mf_universe(supabase) -> list[dict]:
    """Load {scheme_code, fund_name} from the most recent mf_features rows."""
    resp = (
        supabase.table("mf_features")
        .select("scheme_code,fund_name")
        .order("as_of_date", desc=True)
        .limit(500)
        .execute()
    )
    seen = {}
    for row in (resp.data or []):
        sc = row["scheme_code"]
        if sc not in seen and row.get("fund_name"):
            seen[sc] = row["fund_name"]
    return [{"scheme_code": k, "fund_name": v} for k, v in seen.items()]


# ── Stock universe loader ─────────────────────────────────────────────────────
def load_stock_universe(nifty500_json: Path | None = None) -> list[dict]:
    """
    Load {symbol, label} from nifty500_stocks.json (preferred) or stock_universe.js.
    Returns list of {symbol (NSE), label (company name)} dicts.
    """
    nifty_path = nifty500_json or (Path(__file__).parent / "nifty500_stocks.json")
    if nifty_path.exists():
        import json as _json
        data = _json.loads(nifty_path.read_text())
        return [
            {"symbol": entry["nse_symbol"], "label": entry["label"]}
            for entries in data.values()
            for entry in entries
        ]

    # Fallback: parse JS
    js_path = Path(__file__).parent.parent / "backend" / "stock_universe.js"
    import re
    text = js_path.read_text()
    stk_re = re.compile(r'\{\s*symbol:\s*"([^"]+)"\s*,\s*label:\s*"([^"]+)"\s*\}')
    stocks = []
    for m in stk_re.finditer(text):
        sym = m.group(1).replace(".NS", "")
        stocks.append({"symbol": sym, "label": m.group(2)})
    return stocks


# ── Week list builder ─────────────────────────────────────────────────────────
def week_starts(backfill_weeks: int) -> list[date]:
    """Return list of Monday dates going back backfill_weeks weeks."""
    today = date.today()
    # Roll back to the most recent Monday
    monday = today - timedelta(days=today.weekday())
    return [monday - timedelta(weeks=i) for i in range(backfill_weeks)]


# ── Main pipelines ────────────────────────────────────────────────────────────
def run_mf_sentiment(
    supabase,
    claude_client,
    weeks: list[date],
    dry_run: bool = False,
) -> None:
    """Score all MF funds for each week in `weeks`."""
    funds = load_mf_universe(supabase)
    log.info("MF sentiment: %d funds × %d weeks = %d queries",
             len(funds), len(weeks), len(funds) * len(weeks))

    total_written = 0
    for week_start in weeks:
        batch = []
        for fund in funds:
            sc    = fund["scheme_code"]
            name  = fund["fund_name"]
            query = _amc_query(name)

            titles = fetch_gdelt_articles(query, week_start)
            time.sleep(GDELT_DELAY)

            if not titles:
                log.debug("[%s] week=%s  no GDELT articles for %r", sc, week_start, query)
                continue

            result = score_with_claude(name, titles, claude_client)
            if not result:
                continue

            log.info("[%s] %s  week=%s  score=%.2f (%s)  articles=%d",
                     sc, amc, week_start, result["score"], result["label"], len(titles))

            batch.append({
                "scheme_code":      sc,
                "week_start_date":  str(week_start),
                "sentiment_score":  result["score"],
                "sentiment_label":  result["label"],
                "summary":          result["summary"],
                "key_themes":       result["key_themes"],
            })

        if not dry_run and batch:
            upsert_mf_sentiment(supabase, batch)
            total_written += len(batch)
            log.info("Week %s: wrote %d MF sentiment rows", week_start, len(batch))
        elif dry_run:
            log.info("dry-run: week %s  %d rows (not written)", week_start, len(batch))

    log.info("MF sentiment complete. Total written: %d", total_written)


def run_stock_sentiment(
    supabase,
    claude_client,
    weeks: list[date],
    dry_run: bool = False,
) -> None:
    """Score all stocks for each week in `weeks`."""
    stocks = load_stock_universe()
    log.info("Stock sentiment: %d stocks × %d weeks = %d queries",
             len(stocks), len(weeks), len(stocks) * len(weeks))

    total_written = 0
    for week_start in weeks:
        batch = []
        for stock in stocks:
            sym   = stock["symbol"]
            label = stock["label"]
            # Clean company name: remove "Ltd.", "Limited", "Inc." for better GDELT results
            clean = (label
                     .replace(" Ltd.", "").replace(" Limited", "")
                     .replace(" Ltd", "").replace(" Inc.", "")
                     .replace(" Corporation", "").strip())
            query = f'"{clean}"{STOCK_QUERY_SUFFIX}'

            titles = fetch_gdelt_articles(query, week_start)
            time.sleep(GDELT_DELAY)

            if not titles:
                log.debug("[%s] week=%s  no articles", sym, week_start)
                continue

            result = score_with_claude(f"{clean} (NSE: {sym})", titles, claude_client)
            if not result:
                continue

            log.info("[%s] %s  week=%s  score=%.2f (%s)  articles=%d",
                     sym, clean[:25], week_start, result["score"], result["label"], len(titles))

            batch.append({
                "symbol":           sym,
                "week_start_date":  str(week_start),
                "sentiment_score":  result["score"],
                "sentiment_label":  result["label"],
                "summary":          result["summary"],
                "key_themes":       result["key_themes"],
            })

        if not dry_run and batch:
            upsert_stock_sentiment(supabase, batch)
            total_written += len(batch)
            log.info("Week %s: wrote %d stock sentiment rows", week_start, len(batch))
        elif dry_run:
            log.info("dry-run: week %s  %d rows (not written)", week_start, len(batch))

    log.info("Stock sentiment complete. Total written: %d", total_written)


# ── Entry point ───────────────────────────────────────────────────────────────
def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--mode",     choices=["mf", "stocks", "both"], default="mf",
                   help="Which universe to score (default: mf)")
    p.add_argument("--backfill", type=int, default=1,
                   help="Number of weeks to backfill (default: 1 = this week only)")
    p.add_argument("--dry-run",  action="store_true",
                   help="Fetch and score but don't write to Supabase")
    args = p.parse_args()

    # ── Clients ──
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")

    if not supabase_url or not supabase_key:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY required"); sys.exit(1)
    if not anthropic_key:
        log.error("ANTHROPIC_API_KEY required"); sys.exit(1)

    from anthropic import Anthropic
    supabase     = create_client(supabase_url, supabase_key)
    claude_client = Anthropic(api_key=anthropic_key)

    weeks = week_starts(args.backfill)
    log.info("Mode: %s  Weeks: %d  Dry-run: %s", args.mode, len(weeks), args.dry_run)

    if args.mode in ("mf", "both"):
        run_mf_sentiment(supabase, claude_client, weeks, dry_run=args.dry_run)

    if args.mode in ("stocks", "both"):
        run_stock_sentiment(supabase, claude_client, weeks, dry_run=args.dry_run)


if __name__ == "__main__":
    from script_runner import run
    run(main)
