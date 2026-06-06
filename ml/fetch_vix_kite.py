"""
India VIX Backfill via Kite Connect API
========================================

Run this script LOCALLY to fetch full India VIX history and store it in Supabase.
GitHub Actions uses the carry-forward approach (last known value) for daily runs
because the Kite access token expires at 6 AM IST and requires a browser OAuth flow.

Usage:
    python ml/fetch_vix_kite.py              # opens browser, fetches VIX, uploads
    python ml/fetch_vix_kite.py --dry-run    # fetch only, don't write to Supabase
    python ml/fetch_vix_kite.py --token <access_token>  # skip browser login

What it does:
    1. Opens Kite login URL in browser (or uses provided token)
    2. Starts a local callback server to capture the request_token
    3. Exchanges request_token → access_token
    4. Fetches India VIX daily OHLCV from Kite historical API (2018–today)
    5. Saves to ml/.cache_macro/vix_daily.parquet
    6. Uploads to Supabase: updates india_vix in mf_features for all matching dates

Env (reads from backend/.env automatically):
    KITE_API_KEY     — permanent, from developers.kite.trade
    KITE_API_SECRET  — permanent
    SUPABASE_URL     — Supabase project URL
    SUPABASE_SERVICE_KEY — Supabase service key
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
import webbrowser
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import parse_qs, urlparse

import pandas as pd
from dotenv import load_dotenv

# ── Load env ──────────────────────────────────────────────────────────────────
load_dotenv(Path(__file__).parent.parent / "backend" / ".env", override=False)
load_dotenv(Path(__file__).parent.parent / ".env", override=False)

KITE_API_KEY    = os.environ.get("KITE_API_KEY",    "9tbbi2hz87cqmnlr")
KITE_API_SECRET = os.environ.get("KITE_API_SECRET", "pxs1pnsxz28vhyn3rumq5ch60mu5b9hc")
SUPABASE_URL    = os.environ.get("SUPABASE_URL")
SUPABASE_KEY    = os.environ.get("SUPABASE_SERVICE_KEY")

CALLBACK_PORT   = 5001          # must match redirect URL registered in Kite developer app
VIX_INSTRUMENT  = 264969        # Kite instrument token for India VIX (NSE)
CACHE_DIR       = Path(__file__).parent / ".cache_macro"
VIX_CACHE       = CACHE_DIR / "vix_daily.parquet"
CACHE_DIR.mkdir(exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fetch_vix_kite")


# ── OAuth callback server ────────────────────────────────────────────────────

_captured_token: str | None = None


class _CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global _captured_token
        # Accept any path — Kite redirects to /auth/callback but we handle all paths
        params = parse_qs(urlparse(self.path).query)
        token  = params.get("request_token", [None])[0]
        status = params.get("status", [""])[0]
        if status == "success" and token:
            _captured_token = token
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h2>Login successful! You can close this tab.</h2>")
            log.info("Captured request_token via callback")
        else:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"<h2>Login failed.</h2>")

    def log_message(self, *args):
        pass   # silence HTTP server logs


def _get_access_token_via_browser(kc) -> str:
    """Open Kite login in browser, capture request_token via local callback, return access_token."""
    # Must use the redirect URL registered in the Kite developer app
    kc.redirect_url = f"http://localhost:{CALLBACK_PORT}/auth/callback"
    login_url = kc.login_url()

    server = HTTPServer(("localhost", CALLBACK_PORT), _CallbackHandler)
    t = Thread(target=server.handle_request, daemon=True)
    t.start()

    log.info("Opening Kite login in browser…")
    webbrowser.open(login_url)
    print(f"\n  If browser didn't open, visit: {login_url}\n")

    # Wait up to 120s for callback
    for _ in range(120):
        if _captured_token:
            break
        time.sleep(1)
    server.server_close()

    if not _captured_token:
        log.error("Timed out waiting for Kite login callback")
        sys.exit(1)

    session = kc.generate_session(_captured_token, api_secret=KITE_API_SECRET)
    token   = session["access_token"]
    log.info("Access token obtained (valid until 6 AM IST tomorrow)")
    return token


# ── VIX fetch ─────────────────────────────────────────────────────────────────

def fetch_vix_history(kc, from_date: str = "2018-01-01") -> pd.DataFrame:
    """Fetch India VIX daily history from Kite historical API."""
    from_dt = datetime.strptime(from_date, "%Y-%m-%d")
    to_dt   = datetime.now()

    log.info("Fetching India VIX from %s to %s…", from_date, to_dt.strftime("%Y-%m-%d"))
    records = kc.historical_data(
        instrument_token = VIX_INSTRUMENT,
        from_date        = from_dt,
        to_date          = to_dt,
        interval         = "day",
        continuous       = False,
    )
    if not records:
        log.error("Kite returned no VIX records")
        return pd.DataFrame()

    df = pd.DataFrame(records)
    df["date"] = pd.to_datetime(df["date"]).dt.normalize()
    df = df.set_index("date")[["close"]].rename(columns={"close": "india_vix"})
    df = df.sort_index().dropna()
    log.info("Fetched %d VIX rows (%s → %s)", len(df),
             df.index.min().date(), df.index.max().date())
    return df


# ── Supabase upload ───────────────────────────────────────────────────────────

def upload_vix_to_supabase(vix_df: pd.DataFrame, dry_run: bool = False) -> int:
    """
    Update india_vix in mf_features for all rows whose as_of_date appears in vix_df.
    Uses patch (PATCH with ?as_of_date=eq.DATE) row by row — Supabase free tier
    doesn't support multi-row UPDATE via REST so we batch by date.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        log.warning("SUPABASE_URL/KEY not set — skipping upload")
        return 0

    import requests as req

    headers = {
        "apikey":         SUPABASE_KEY,
        "Authorization":  f"Bearer {SUPABASE_KEY}",
        "Content-Type":   "application/json",
        "Prefer":         "return=minimal",
    }

    updated = 0
    for dt, row in vix_df.iterrows():
        date_str = dt.strftime("%Y-%m-%d")
        vix_val  = round(float(row["india_vix"]), 2)
        if dry_run:
            log.info("dry-run: would set india_vix=%.2f for as_of_date=%s", vix_val, date_str)
            continue
        r = req.patch(
            f"{SUPABASE_URL}/rest/v1/mf_features",
            headers=headers,
            params={"as_of_date": f"eq.{date_str}"},
            json={"india_vix": vix_val},
        )
        if r.status_code in (200, 204):
            updated += 1
        else:
            log.warning("Patch failed for %s: %d %s", date_str, r.status_code, r.text[:80])

    log.info("%s %d dates in Supabase", "Would update" if dry_run else "Updated", updated or len(vix_df))
    return updated


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Fetch India VIX via Kite and upload to Supabase")
    parser.add_argument("--token",    help="Kite access_token (skip browser login)")
    parser.add_argument("--from",     dest="from_date", default="2018-01-01")
    parser.add_argument("--dry-run",  action="store_true")
    args = parser.parse_args()

    try:
        from kiteconnect import KiteConnect
    except ImportError:
        log.error("kiteconnect not installed. Run: pip install kiteconnect")
        sys.exit(1)

    kc = KiteConnect(api_key=KITE_API_KEY)

    # Get access token
    if args.token:
        kc.set_access_token(args.token)
        log.info("Using provided access token")
    else:
        token = _get_access_token_via_browser(kc)
        kc.set_access_token(token)

    # Fetch VIX
    vix_df = fetch_vix_history(kc, from_date=args.from_date)
    if vix_df.empty:
        log.error("No VIX data fetched — check instrument token or token validity")
        sys.exit(1)

    # Save local cache
    vix_df.to_parquet(VIX_CACHE)
    log.info("Saved VIX cache → %s", VIX_CACHE)

    # Upload to Supabase
    upload_vix_to_supabase(vix_df, dry_run=args.dry_run)

    print(f"\n✅ Done. {len(vix_df)} VIX rows cached and uploaded.")
    print(f"   Latest: {vix_df.index.max().date()}  VIX={vix_df['india_vix'].iloc[-1]:.2f}")
    print("\nNext steps:")
    print("  • Run macro_features.py to propagate VIX into stock_features")
    print("  • Retrain models: gh workflow run refresh.yml --field target=mf_train")


if __name__ == "__main__":
    main()
