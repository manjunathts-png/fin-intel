"""
News Sentiment Analyser — MF Fund Sentiment via Claude
=======================================================

Fetches recent news headlines for each fund (via Google News RSS, no API key
needed), sends them in batches to Claude for structured sentiment analysis,
and stores results in two places:

  1. mf_sentiment       — full record: score, label, summary, key_themes, headlines
  2. mf_features        — sentiment_score + sentiment_label columns (for ML)

Designed to run WEEKLY (not daily) to keep Claude API costs low.

Assumptions / trade-offs:
  - Google News RSS is used as a free news source. Coverage is best for large
    fund houses (SBI, HDFC, Mirae, Axis, etc.) and categories (Large Cap, etc.).
    Smaller/niche funds may have sparse results — those get sentiment_score=0.0.
  - Claude Haiku is used for cost efficiency (~30x cheaper than Sonnet).
    Switch to Sonnet via --model if deeper analysis is needed.
  - Fund news proxy: we search by fund house name + category rather than scheme code
    (AMFI scheme codes are not searchable on news sites).
  - Batch size 5 funds per Claude call (one prompt with 5 structured blocks).

Usage:
    python sentiment.py                         # update all funds
    python sentiment.py --fund-code 120503      # single fund
    python sentiment.py --dry-run               # fetch news, don't call Claude
    python sentiment.py --model claude-3-5-haiku-20241022  # cheaper/faster
    python sentiment.py --force                 # re-run even if already done this week

Env:
    SUPABASE_URL
    SUPABASE_SERVICE_KEY
    ANTHROPIC_API_KEY
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client
from tqdm import tqdm

load_dotenv()
load_dotenv(Path(__file__).parent.parent / "backend" / ".env", override=False)
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("sentiment")

ROOT = Path(__file__).parent.parent
UNIVERSE_JS = ROOT / "backend" / "mf_universe.js"

DEFAULT_MODEL = "claude-haiku-4-5-20251001"  # Haiku 4.5 — faster + cheaper than Haiku 3
MAX_HEADLINES_PER_FUND = 10
BATCH_SIZE = 5        # funds per Claude API call
RETRY_DELAY = 2.0     # seconds between retries
MAX_RETRIES = 3


# ─── Universe loading (mirrors extract_features.py) ──────────────────────────

@dataclass
class Fund:
    code: str
    label: str
    category: str

    @property
    def fund_house(self) -> str:
        """Extract fund house from label. E.g. 'HDFC Mid-Cap Opportunities' → 'HDFC'."""
        parts = self.label.split()
        return parts[0] if parts else self.label

    @property
    def search_query(self) -> str:
        """Google News search query for this fund."""
        # Use fund house + category for broader but relevant coverage
        house = self.fund_house
        cat = self.category.replace("&", "and")
        # Also include fund name terms (first 3 words max)
        name_words = " ".join(self.label.split()[:4])
        return f'"{house}" mutual fund India {cat}'


def load_universe(code_filter: str | None = None) -> list[Fund]:
    text = UNIVERSE_JS.read_text()
    funds: list[Fund] = []
    cat_re  = re.compile(r'"([^"]+)"\s*:\s*\[([^\]]*)\]', re.DOTALL)
    fund_re = re.compile(r'\{\s*code:\s*"([^"]+)"\s*,\s*label:\s*"([^"]+)"\s*\}')
    for cm in cat_re.finditer(text):
        category = cm.group(1)
        for fm in fund_re.finditer(cm.group(2)):
            if code_filter is None or fm.group(1) == code_filter:
                funds.append(Fund(code=fm.group(1), label=fm.group(2), category=category))
    return funds


# ─── News fetching via Google News RSS ───────────────────────────────────────

def fetch_headlines(query: str, max_results: int = MAX_HEADLINES_PER_FUND) -> list[str]:
    """
    Fetch recent news headlines from Google News RSS.
    Returns a list of title strings (up to max_results).
    No API key required.
    """
    try:
        import feedparser
    except ImportError:
        log.error("feedparser not installed. Run: pip install feedparser")
        return []

    url = f"https://news.google.com/rss/search?q={quote_plus(query)}&hl=en-IN&gl=IN&ceid=IN:en"
    try:
        feed = feedparser.parse(url)
        headlines: list[str] = []
        cutoff = datetime.now() - timedelta(days=14)  # last 2 weeks

        for entry in feed.entries[:max_results * 2]:  # fetch extra, filter by date
            # Parse publish date if available
            published = None
            if hasattr(entry, "published_parsed") and entry.published_parsed:
                published = datetime(*entry.published_parsed[:6])
            if published and published < cutoff:
                continue

            title = entry.get("title", "").strip()
            # Clean Google News title (often ends with " - Source Name")
            title = re.sub(r"\s*-\s*[A-Z][^-]{3,40}$", "", title).strip()
            if title and len(title) > 15:
                headlines.append(title)
            if len(headlines) >= max_results:
                break

        return headlines
    except Exception as e:
        log.debug("RSS fetch failed for '%s': %s", query, e)
        return []


# ─── Claude API sentiment analysis ───────────────────────────────────────────

SENTIMENT_SYSTEM = """You are a financial analyst specialising in Indian mutual funds.
You receive news headlines about mutual fund houses or fund categories and assess their
sentiment from an investor's perspective. You always respond with valid JSON only."""

SENTIMENT_PROMPT_TEMPLATE = """Analyse the news sentiment for the following mutual funds.
For each fund, return a JSON object with these exact fields:
- sentiment_score: float from -1.0 (very negative) to 1.0 (very positive), 0.0 = neutral
- sentiment_label: exactly one of "Positive", "Neutral", or "Negative"
- summary: 2-3 sentences explaining the key themes affecting this fund's outlook
- key_themes: list of 2-4 short theme labels (e.g. ["FII inflows", "rate cut expectation"])

Respond with a JSON array, one object per fund, in the same order as provided.
If a fund has no headlines, return sentiment_score=0.0, sentiment_label="Neutral", summary="No recent news found.", key_themes=[].

Funds to analyse:
{fund_blocks}
"""


def format_fund_block(fund: Fund, headlines: list[str]) -> str:
    if headlines:
        hl_text = "\n".join(f"  - {h}" for h in headlines[:MAX_HEADLINES_PER_FUND])
        return f"Fund: {fund.label} ({fund.category})\nHeadlines:\n{hl_text}"
    else:
        return f"Fund: {fund.label} ({fund.category})\nHeadlines: (none found)"


def call_claude_batch(
    funds: list[Fund],
    headlines_map: dict[str, list[str]],
    client,
    model: str,
) -> list[dict]:
    """
    Send a batch of funds to Claude for sentiment scoring.
    Returns a list of dicts (one per fund) with sentiment fields.
    Falls back to neutral on any parse error.
    """
    blocks = [format_fund_block(f, headlines_map.get(f.code, [])) for f in funds]
    prompt = SENTIMENT_PROMPT_TEMPLATE.format(fund_blocks="\n\n".join(blocks))

    for attempt in range(MAX_RETRIES):
        try:
            message = client.messages.create(
                model=model,
                max_tokens=1024,
                messages=[{"role": "user", "content": prompt}],
                system=SENTIMENT_SYSTEM,
            )
            raw = message.content[0].text.strip()

            # Strip markdown code fences if Claude adds them
            raw = re.sub(r"^```(?:json)?\s*", "", raw)
            raw = re.sub(r"\s*```$", "", raw)

            results = json.loads(raw)
            if isinstance(results, list) and len(results) == len(funds):
                return results
            log.warning("Claude returned %d results for %d funds — using fallback",
                        len(results) if isinstance(results, list) else 0, len(funds))
        except json.JSONDecodeError as e:
            log.warning("JSON parse error (attempt %d): %s", attempt + 1, e)
        except Exception as e:
            log.warning("Claude API error (attempt %d): %s", attempt + 1, e)
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY * (attempt + 1))

    # Fallback: neutral for all funds in this batch
    return [_neutral_result() for _ in funds]


def _neutral_result() -> dict:
    return {
        "sentiment_score": 0.0,
        "sentiment_label": "Neutral",
        "summary": "Sentiment analysis unavailable.",
        "key_themes": [],
    }


def parse_sentiment_result(raw: dict) -> dict:
    """Validate and clamp a single sentiment result from Claude."""
    score = float(raw.get("sentiment_score", 0.0))
    score = max(-1.0, min(1.0, score))  # clamp to [-1, 1]
    label = raw.get("sentiment_label", "Neutral")
    if label not in ("Positive", "Neutral", "Negative"):
        label = "Neutral"
    return {
        "sentiment_score": round(score, 4),
        "sentiment_label": label,
        "summary":         str(raw.get("summary", ""))[:500],
        "key_themes":      raw.get("key_themes", [])[:4],
    }


# ─── Database helpers ─────────────────────────────────────────────────────────

def already_done_this_week(supabase, code: str, week_start: date) -> bool:
    resp = (
        supabase.table("mf_sentiment")
        .select("scheme_code")
        .eq("scheme_code", code)
        .eq("week_start_date", str(week_start))
        .limit(1)
        .execute()
    )
    return bool(resp.data)


def upsert_sentiment_record(
    supabase,
    fund: Fund,
    week_start: date,
    result: dict,
    headlines: list[str],
    model: str,
) -> None:
    row = {
        "scheme_code":      fund.code,
        "week_start_date":  str(week_start),
        "sentiment_score":  result["sentiment_score"],
        "sentiment_label":  result["sentiment_label"],
        "summary":          result["summary"],
        "key_themes":       result["key_themes"],
        "headlines_used":   headlines[:MAX_HEADLINES_PER_FUND],
        "headline_count":   len(headlines),
        "model_used":       model,
    }
    supabase.table("mf_sentiment").upsert(
        row, on_conflict="scheme_code,week_start_date"
    ).execute()


def propagate_to_mf_features(supabase, fund: Fund, result: dict) -> int:
    """
    Update the most recent mf_features row(s) for this fund with sentiment columns.
    We update all rows within the past 7 days so the score reaches the latest date.
    """
    cutoff = str(date.today() - timedelta(days=7))
    resp = (
        supabase.table("mf_features")
        .select("scheme_code,as_of_date")
        .eq("scheme_code", fund.code)
        .gte("as_of_date", cutoff)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return 0

    updates = []
    for r in rows:
        updates.append({
            "scheme_code":      r["scheme_code"],
            "as_of_date":       r["as_of_date"],
            "sentiment_score":  result["sentiment_score"],
            "sentiment_label":  result["sentiment_label"],
            "sentiment_as_of":  datetime.utcnow().isoformat(),
        })

    for upd in updates:
        supabase.table("mf_features").upsert(
            upd, on_conflict="scheme_code,as_of_date"
        ).execute()
    return len(updates)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--fund-code", type=str, default=None,
                   help="Process a single fund (scheme code)")
    p.add_argument("--dry-run",   action="store_true",
                   help="Fetch news and show output, skip Claude + DB writes")
    p.add_argument("--force",     action="store_true",
                   help="Re-run even if already done this week")
    p.add_argument("--model",     type=str, default=DEFAULT_MODEL,
                   help=f"Claude model (default: {DEFAULT_MODEL})")
    p.add_argument("--no-propagate", action="store_true",
                   help="Don't update mf_features with sentiment scores")
    args = p.parse_args()

    # Check env vars
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")

    if not supabase_url or not supabase_key:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)
    if not anthropic_key and not args.dry_run:
        log.error("ANTHROPIC_API_KEY must be set (or use --dry-run)")
        sys.exit(1)

    supabase = create_client(supabase_url, supabase_key)

    # Claude client
    claude = None
    if not args.dry_run:
        try:
            import anthropic
            claude = anthropic.Anthropic(api_key=anthropic_key)
        except ImportError:
            log.error("anthropic SDK not installed. Run: pip install anthropic")
            sys.exit(1)

    # Check feedparser
    try:
        import feedparser  # noqa: F401
    except ImportError:
        log.error("feedparser not installed. Run: pip install feedparser")
        sys.exit(1)

    # Load fund universe
    funds = load_universe(code_filter=args.fund_code)
    if not funds:
        log.error("No funds loaded (code filter: %s)", args.fund_code)
        sys.exit(1)
    log.info("Loaded %d funds", len(funds))

    # Current week start (Monday)
    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    log.info("Week start: %s", week_start)

    # ── Step 1: Fetch news for all funds ──────────────────────────────────
    log.info("Fetching news headlines…")
    headlines_map: dict[str, list[str]] = {}
    to_process: list[Fund] = []

    for fund in tqdm(funds, desc="news fetch"):
        if not args.force and already_done_this_week(supabase, fund.code, week_start):
            log.debug("Skipping %s (already done this week)", fund.code)
            continue
        headlines = fetch_headlines(fund.search_query)
        headlines_map[fund.code] = headlines
        to_process.append(fund)
        time.sleep(0.3)  # be polite to Google News

    log.info("%d funds need sentiment analysis (%d skipped as already done)",
             len(to_process), len(funds) - len(to_process))

    if not to_process:
        log.info("All funds already have sentiment for this week. Use --force to re-run.")
        return

    if args.dry_run:
        log.info("=== DRY RUN — sample news fetch ===")
        for fund in to_process[:3]:
            hl = headlines_map.get(fund.code, [])
            log.info("\n%s (%s)\n  Query: %s\n  Headlines (%d):\n%s",
                     fund.label, fund.category, fund.search_query, len(hl),
                     "\n".join(f"    - {h}" for h in hl[:5]) or "    (none)")
        log.info("Would process %d funds in %d batches of %d",
                 len(to_process), (len(to_process) + BATCH_SIZE - 1) // BATCH_SIZE, BATCH_SIZE)
        return

    # ── Step 2: Batch Claude calls ─────────────────────────────────────────
    log.info("Running Claude sentiment analysis in batches of %d…", BATCH_SIZE)
    total_written = 0
    total_propagated = 0

    for i in tqdm(range(0, len(to_process), BATCH_SIZE), desc="sentiment batches"):
        batch = to_process[i : i + BATCH_SIZE]

        # Claude API call
        raw_results = call_claude_batch(batch, headlines_map, claude, args.model)

        for fund, raw in zip(batch, raw_results):
            result = parse_sentiment_result(raw)
            headlines = headlines_map.get(fund.code, [])

            log.debug("%s: score=%.2f  label=%s  themes=%s",
                      fund.label, result["sentiment_score"],
                      result["sentiment_label"], result["key_themes"])

            # Write to mf_sentiment
            upsert_sentiment_record(supabase, fund, week_start, result, headlines, args.model)
            total_written += 1

            # Propagate to mf_features
            if not args.no_propagate:
                n = propagate_to_mf_features(supabase, fund, result)
                total_propagated += n

        # Small pause between batches to stay within rate limits
        time.sleep(1.0)

    log.info("Done. Wrote %d sentiment records. Updated %d mf_features rows.",
             total_written, total_propagated)

    # ── Step 3: Summary report ────────────────────────────────────────────
    resp = (
        supabase.table("mf_sentiment")
        .select("sentiment_label,sentiment_score")
        .eq("week_start_date", str(week_start))
        .execute()
    )
    if resp.data:
        df = pd.DataFrame(resp.data)
        counts = df["sentiment_label"].value_counts().to_dict()
        avg_score = df["sentiment_score"].mean()
        log.info(
            "Week %s summary: Positive=%d  Neutral=%d  Negative=%d  avg_score=%.3f",
            week_start,
            counts.get("Positive", 0),
            counts.get("Neutral", 0),
            counts.get("Negative", 0),
            avg_score,
        )


if __name__ == "__main__":
    from script_runner import run
    run(main)
