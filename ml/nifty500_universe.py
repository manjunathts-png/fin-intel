"""
Nifty 500 Universe Builder
==========================

Downloads the official Nifty 500 constituent list from NSE, maps NSE industry
classifications to our sector groups, and outputs nifty500_stocks.json for use
by extract_stock_features.py (--nifty500 flag).

Run once to initialise, then monthly to pick up reconstitutions:
    python nifty500_universe.py            # fetch + write nifty500_stocks.json
    python nifty500_universe.py --dry-run  # print summary only

Output: ml/nifty500_stocks.json
    {
      "IT": [{"symbol": "TCS.NS", "label": "TCS", "nse_symbol": "TCS"}, ...],
      "Banking - Private": [...],
      ...
    }
"""

from __future__ import annotations

import argparse
import json
import logging
import time
from pathlib import Path

import pandas as pd
import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("nifty500_universe")

# ── NSE source ────────────────────────────────────────────────────────────────
NSE_CSV_URL = "https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv"
OUTPUT_FILE = Path(__file__).parent / "nifty500_stocks.json"

# ── PSU bank symbols (split "Financial Services - Banks" into PSU vs Private) ─
PSU_BANKS = {
    "SBIN", "BANKBARODA", "PNB", "CANBK", "UNIONBANK", "INDIANB",
    "MAHABANK", "UCOBANK", "CENTRALBK", "BANKINDIA", "IOB", "J&KBANK",
    "BKGM", "ALBK", "ANDHRABANK",
}

# ── NSE Industry → our sector group ──────────────────────────────────────────
# Exact NSE industry strings from ind_nifty500list.csv (as of 2026-05)
# "Financial Services" is split further by company name (bank vs NBFC) in _sector()
INDUSTRY_MAP: dict[str, str] = {
    "information technology":                "IT",
    "capital goods":                         "Capital Goods & Defence",
    "healthcare":                            "Pharma",
    "automobile and auto components":        "Auto & EV",
    "consumer services":                     "Consumption & Retail",
    "fast moving consumer goods":            "FMCG",
    "chemicals":                             "Chemicals & Fertilisers",
    "metals & mining":                       "Metals & Mining",
    "power":                                 "Energy & Oil",
    "oil gas & consumable fuels":            "Energy & Oil",
    "consumer durables":                     "Consumption & Retail",
    "services":                              "Diversified",
    "construction":                          "Cement & Construction",
    "construction materials":                "Cement & Construction",
    "realty":                                "Real Estate",
    "telecommunication":                     "Telecom",
    "textiles":                              "Consumption & Retail",
    "media entertainment & publication":     "Consumption & Retail",
    "diversified":                           "Diversified",
    # Legacy / alternate strings kept for robustness
    "banks":                                 "Banking - Private",
    "pharmaceuticals":                       "Pharma",
    "pharmaceuticals & biotech":             "Pharma",
    "it-software":                           "IT",
    "metals":                                "Metals & Mining",
    "steel":                                 "Metals & Mining",
    "oil & gas":                             "Energy & Oil",
    "cement & cement products":              "Cement & Construction",
    "infrastructure":                        "Cement & Construction",
    "financial technology (fintech)":        "Finance - NBFC",
    "insurance":                             "Finance - NBFC",
    "housing finance":                       "Finance - NBFC",
}


def _sector(industry: str, symbol: str, company_name: str = "") -> str:
    """Map NSE industry string → our sector group."""
    key = industry.strip().lower()

    # "Financial Services" in Nifty 500 covers both banks and NBFCs.
    # Split by checking company name for "Bank" / "Small Finance".
    if key == "financial services":
        name_up = company_name.upper()
        if any(w in name_up for w in ("BANK", "BANKING")):
            return "Banking - PSU" if symbol.upper() in PSU_BANKS else "Banking - Private"
        return "Finance - NBFC"

    # Legacy bank entries
    if key in ("banks", "financial services - banks"):
        return "Banking - PSU" if symbol.upper() in PSU_BANKS else "Banking - Private"

    return INDUSTRY_MAP.get(key, "Diversified")


def fetch_nifty500() -> pd.DataFrame:
    """Download Nifty 500 CSV from NSE with session-based cookie handling."""
    session = requests.Session()
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": "https://www.nseindia.com/",
    }
    # Seed cookies by visiting the NSE homepage first
    try:
        session.get("https://www.nseindia.com/", headers=headers, timeout=15)
        time.sleep(1)
    except Exception as e:
        log.warning("NSE homepage seed failed (continuing anyway): %s", e)

    log.info("Downloading Nifty 500 CSV from NSE…")
    resp = session.get(NSE_CSV_URL, headers=headers, timeout=30)
    resp.raise_for_status()

    from io import StringIO
    df = pd.read_csv(StringIO(resp.text))
    df.columns = [c.strip() for c in df.columns]
    log.info("Downloaded %d rows", len(df))
    return df


def build_universe(df: pd.DataFrame) -> dict[str, list[dict]]:
    """
    Map Nifty 500 rows → sector-grouped universe dict.
    Returns {sector: [{symbol, label, nse_symbol}]}.
    """
    universe: dict[str, list[dict]] = {}
    skipped = 0

    for _, row in df.iterrows():
        nse_sym  = str(row.get("Symbol", "")).strip()
        name     = str(row.get("Company Name", "")).strip()
        industry = str(row.get("Industry", "")).strip()
        series   = str(row.get("Series", "")).strip()

        # Only continuous trading series (EQ, BE); skip SME, warrants, etc.
        if series not in ("EQ", "BE", ""):
            skipped += 1
            continue
        if not nse_sym or not name:
            skipped += 1
            continue

        sector = _sector(industry, nse_sym, name)
        yahoo_sym = nse_sym + ".NS"

        universe.setdefault(sector, []).append({
            "symbol":     yahoo_sym,
            "label":      name,
            "nse_symbol": nse_sym,
        })

    log.info(
        "Built universe: %d stocks across %d sectors (skipped %d non-EQ rows)",
        sum(len(v) for v in universe.values()), len(universe), skipped,
    )
    for sector, stocks in sorted(universe.items(), key=lambda x: -len(x[1])):
        log.info("  %-30s  %d stocks", sector, len(stocks))

    return universe


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true", help="Print summary, don't write JSON")
    args = p.parse_args()

    df = fetch_nifty500()
    universe = build_universe(df)

    if args.dry_run:
        print(json.dumps({k: len(v) for k, v in universe.items()}, indent=2))
        return

    OUTPUT_FILE.write_text(json.dumps(universe, indent=2, ensure_ascii=False))
    log.info("Written: %s  (%d sectors, %d stocks)",
             OUTPUT_FILE, len(universe), sum(len(v) for v in universe.values()))


if __name__ == "__main__":
    main()
