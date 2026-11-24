"""
Temporary probe: why does Yahoo quoteSummary return 429 to Python from
GitHub Actions while yahoo-finance2 (Node) succeeds on the same runner?
Compares plain requests vs curl_cffi Chrome impersonation, each with the
fc.yahoo.com cookie + getcrumb flow, on a handful of NSE symbols.
"""

from __future__ import annotations

import time
from collections import Counter

SYMBOLS = ["TCS", "HDFCBANK", "RELIANCE", "INFY", "DIXON", "TATASTEEL", "ITC", "LT"]
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
}
CRUMB_URLS = ["https://query1.finance.yahoo.com/v1/test/getcrumb",
              "https://query2.finance.yahoo.com/v1/test/getcrumb"]
SUMMARY = "https://{host}/v10/finance/quoteSummary/{sym}.NS"


def run(name: str, session, use_headers: bool) -> None:
    kw = {"headers": HEADERS} if use_headers else {}
    print(f"\n=== {name} ===")
    try:
        r = session.get("https://fc.yahoo.com", timeout=10, allow_redirects=True, **kw)
        print(f"fc.yahoo.com: HTTP {r.status_code}; cookies: {sorted(session.cookies.keys())}")
    except Exception as e:
        print(f"fc.yahoo.com: {type(e).__name__}: {e}")

    crumb = None
    for url in CRUMB_URLS:
        try:
            r = session.get(url, timeout=10, **kw)
            body = r.text.strip()
            print(f"getcrumb {url.split('/')[2]}: HTTP {r.status_code}; body len {len(body)}; looks valid: {r.status_code == 200 and '<' not in body and len(body) < 40}")
            if r.status_code == 200 and "<" not in body and len(body) < 40 and not crumb:
                crumb = body
        except Exception as e:
            print(f"getcrumb {url}: {type(e).__name__}: {e}")

    for host in ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]:
        statuses: Counter = Counter()
        for sym in SYMBOLS:
            params = {"modules": "summaryDetail,financialData,defaultKeyStatistics"}
            if crumb:
                params["crumb"] = crumb
            try:
                r = session.get(SUMMARY.format(host=host, sym=sym), params=params, timeout=15, **kw)
                ok = r.status_code == 200 and bool(r.json().get("quoteSummary", {}).get("result"))
                statuses["OK" if ok else f"HTTP {r.status_code}"] += 1
            except Exception as e:
                statuses[type(e).__name__] += 1
            time.sleep(0.3)
        print(f"quoteSummary via {host} (crumb={'yes' if crumb else 'no'}): {dict(statuses)}")


def main() -> None:
    import requests
    run("requests", requests.Session(), use_headers=True)

    try:
        from curl_cffi import requests as cffi
        run("curl_cffi impersonate=chrome", cffi.Session(impersonate="chrome"), use_headers=False)
    except ImportError as e:
        print(f"curl_cffi unavailable: {e}")


if __name__ == "__main__":
    main()
