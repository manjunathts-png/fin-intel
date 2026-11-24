import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from eodhd_probe import summarize_fundamentals


def _payload():
    return {
        "General": {"Name": "HDFC Bank", "Sector": "Financial Services",
                    "Industry": "Banks - Regional", "CurrencyCode": "INR"},
        "Highlights": {"MarketCapitalization": 1.2e13, "PERatio": 19.5, "PEGRatio": None,
                       "ReturnOnEquityTTM": 0.16},
        "Valuation": {"TrailingPE": 19.5, "PriceBookMRQ": 2.7},
        "Financials": {
            "Income_Statement": {
                "quarterly": {
                    "2026-06-30": {"date": "2026-06-30", "filing_date": "2026-07-19",
                                   "totalRevenue": "500", "netIncome": "160", "ebitda": None},
                    "2026-03-31": {"date": "2026-03-31", "totalRevenue": "480", "netIncome": "150"},
                },
                "yearly": {"2026-03-31": {"date": "2026-03-31", "totalRevenue": "1900"}},
            },
        },
        "Earnings": {"History": {"2026-06-30": {}, "2026-03-31": {}}},
    }


def test_summarize_counts_quarters_and_filing_dates():
    s = summarize_fundamentals(_payload())
    q = s["statements"]["Income_Statement"]["quarterly"]
    assert q["count"] == 2
    assert (q["earliest"], q["latest"]) == ("2026-03-31", "2026-06-30")
    assert q["with_filing_date"] == 1
    assert "ebitda" in q["latest_fields_missing"]
    assert "totalRevenue" in q["latest_fields_present"]
    assert s["statements"]["Income_Statement"]["yearly"]["count"] == 1
    assert s["earnings_history_quarters"] == 2


def test_summarize_flags_missing_headline_and_absent_statements():
    s = summarize_fundamentals(_payload())
    assert "PERatio" in s["headline_present"]
    assert "PEGRatio" in s["headline_missing"]
    assert s["valuation_present"] == ["TrailingPE", "PriceBookMRQ"]
    assert s["statements"]["Cash_Flow"]["quarterly"] == {"count": 0}


def test_summarize_tolerates_empty_payload():
    s = summarize_fundamentals({})
    assert s["name"] is None
    assert s["statements"]["Balance_Sheet"]["quarterly"]["count"] == 0
