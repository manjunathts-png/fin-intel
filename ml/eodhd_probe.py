"""
EODHD coverage probe — what does our API key actually return for NSE stocks?

Calls the account endpoint (plan + daily limits) and the fundamentals
endpoint for a few NSE tickers, then prints a coverage summary: how many
quarters/years of statements, whether each quarter carries a filing_date
(needed for point-in-time valuation without look-ahead), and which
headline fields are populated. Never prints the API key or account
identity (name/email) — workflow logs may be public.

Usage:
    EODHD_API_KEY=... python eodhd_probe.py --tickers HDFCBANK,DIXON
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import Any

import httpx

BASE = "https://eodhd.com/api"
HEADLINE_FIELDS = ["MarketCapitalization", "PERatio", "PEGRatio", "BookValue",
                   "ReturnOnEquityTTM", "ProfitMargin", "EBITDA", "DividendYield"]
VALUATION_FIELDS = ["TrailingPE", "ForwardPE", "PriceBookMRQ", "EnterpriseValueEbitda"]
STATEMENT_FIELDS = {
    "Income_Statement": ["totalRevenue", "netIncome", "ebitda", "operatingIncome"],
    "Balance_Sheet": ["totalAssets", "totalStockholderEquity", "shortLongTermDebtTotal", "cash"],
    "Cash_Flow": ["totalCashFromOperatingActivities", "capitalExpenditures", "freeCashFlow"],
}


def _period_summary(periods: dict | None, fields: list[str]) -> dict[str, Any]:
    if not isinstance(periods, dict) or not periods:
        return {"count": 0}
    rows = [r for r in periods.values() if isinstance(r, dict)]
    dates = sorted(str(r.get("date") or k) for k, r in periods.items() if isinstance(r, dict))
    with_filing = sum(1 for r in rows if r.get("filing_date"))
    latest = max(rows, key=lambda r: str(r.get("date", ""))) if rows else {}
    return {
        "count": len(rows),
        "earliest": dates[0] if dates else None,
        "latest": dates[-1] if dates else None,
        "with_filing_date": with_filing,
        "latest_fields_present": [f for f in fields if latest.get(f) not in (None, "", "0")],
        "latest_fields_missing": [f for f in fields if latest.get(f) in (None, "", "0")],
    }


def summarize_fundamentals(payload: dict) -> dict[str, Any]:
    general = payload.get("General") or {}
    highlights = payload.get("Highlights") or {}
    valuation = payload.get("Valuation") or {}
    financials = payload.get("Financials") or {}
    earnings = payload.get("Earnings") or {}

    statements = {}
    for name, fields in STATEMENT_FIELDS.items():
        block = financials.get(name) or {}
        statements[name] = {
            "quarterly": _period_summary(block.get("quarterly"), fields),
            "yearly": _period_summary(block.get("yearly"), fields),
        }

    return {
        "name": general.get("Name"),
        "sector": general.get("Sector"),
        "industry": general.get("Industry"),
        "currency": general.get("CurrencyCode"),
        "headline_present": [f for f in HEADLINE_FIELDS if highlights.get(f) not in (None, "", 0)],
        "headline_missing": [f for f in HEADLINE_FIELDS if highlights.get(f) in (None, "", 0)],
        "valuation_present": [f for f in VALUATION_FIELDS if valuation.get(f) not in (None, "", 0)],
        "statements": statements,
        "earnings_history_quarters": len(earnings.get("History") or {}),
    }


def _get(client: httpx.Client, path: str, token: str) -> httpx.Response:
    return client.get(f"{BASE}/{path}", params={"api_token": token, "fmt": "json"})


def _describe_error(resp: httpx.Response) -> str:
    hint = {
        401: "key rejected (check the EODHD_API_KEY secret)",
        402: "not included in this plan (paid plan needed)",
        403: "forbidden — endpoint/ticker not covered by this plan",
        429: "daily API limit exhausted",
    }.get(resp.status_code, "")
    body = resp.text[:200].replace("\n", " ")
    return f"HTTP {resp.status_code} {hint} — {body}"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--tickers", default="HDFCBANK,DIXON",
                   help="Comma-separated NSE symbols (each fundamentals call costs ~10 API credits)")
    args = p.parse_args()

    token = os.environ.get("EODHD_API_KEY", "").strip()
    if not token:
        print("ERROR: EODHD_API_KEY not set")
        sys.exit(1)

    logging.getLogger("httpx").setLevel(logging.WARNING)  # httpx INFO logs include the full URL (and token)
    lines: list[str] = ["## EODHD coverage probe", ""]

    with httpx.Client(timeout=30.0, follow_redirects=True) as client:
        resp = _get(client, "user", token)
        if resp.status_code == 200:
            acct = resp.json()
            lines.append(
                f"**Plan:** {acct.get('subscriptionType')} · daily limit {acct.get('dailyRateLimit')} · "
                f"used today {acct.get('apiRequests')}"
            )
        else:
            lines.append(f"**Account:** {_describe_error(resp)}")
        lines.append("")

        any_ok = False
        for sym in [t.strip().upper() for t in args.tickers.split(",") if t.strip()]:
            lines.append(f"### {sym}.NSE")
            resp = _get(client, f"fundamentals/{sym}.NSE", token)
            if resp.status_code != 200:
                lines.append(f"- {_describe_error(resp)}")
                lines.append("")
                continue
            payload = resp.json()
            if not isinstance(payload, dict) or not payload:
                lines.append("- Empty response (ticker not covered)")
                lines.append("")
                continue
            any_ok = True
            s = summarize_fundamentals(payload)
            lines.append(f"- {s['name']} · {s['sector']} / {s['industry']} · {s['currency']}")
            lines.append(f"- Highlights present: {', '.join(s['headline_present']) or 'none'}")
            if s["headline_missing"]:
                lines.append(f"- Highlights missing: {', '.join(s['headline_missing'])}")
            lines.append(f"- Valuation present: {', '.join(s['valuation_present']) or 'none'}")
            for stmt, periods in s["statements"].items():
                q, y = periods["quarterly"], periods["yearly"]
                lines.append(
                    f"- {stmt}: {q['count']} quarters ({q.get('earliest')} → {q.get('latest')}, "
                    f"{q.get('with_filing_date', 0)} with filing_date), {y['count']} years"
                )
                if q.get("latest_fields_missing"):
                    lines.append(f"  - latest quarter missing: {', '.join(q['latest_fields_missing'])}")
            lines.append(f"- Earnings history: {s['earnings_history_quarters']} quarters")
            lines.append("")

    report = "\n".join(lines)
    print(report)
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a") as f:
            f.write(report + "\n")
    if not any_ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
