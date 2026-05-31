"""
One-Time Database Setup Helper
================================

Prints the SQL that needs to be run in the Supabase SQL editor, then verifies
the tables exist after you've run it.

Usage:
    python setup_db.py           # print instructions + check current state
    python setup_db.py --check   # just check if tables exist (no instructions)

Env:
    SUPABASE_URL
    SUPABASE_SERVICE_KEY
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()
load_dotenv(Path(__file__).parent.parent / "backend" / ".env", override=False)

SETUP_SQL    = Path(__file__).parent / "setup.sql"
MIGRATE_SQL  = Path(__file__).parent / "migrate_001_sentiment.sql"
MIGRATE_006  = Path(__file__).parent / "migrate_006_category_groups.sql"

REQUIRED_TABLES = [
    "mf_features", "mf_predictions", "mf_model_runs",
    "stock_features", "stock_predictions", "stock_model_runs",
]
OPTIONAL_TABLES = ["mf_sentiment"]


def check_table(client, table_name: str) -> bool:
    try:
        client.table(table_name).select("*").limit(0).execute()
        return True
    except Exception:
        return False


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--check", action="store_true", help="Only check, don't print instructions")
    args = p.parse_args()

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)

    client = create_client(url, key)

    print(f"\nChecking Supabase tables at {url[:40]}...\n")

    missing = []
    for table in REQUIRED_TABLES + OPTIONAL_TABLES:
        exists = check_table(client, table)
        status = "✓" if exists else "✗ MISSING"
        print(f"  {status}  {table}")
        if not exists and table in REQUIRED_TABLES:
            missing.append(table)

    if not missing:
        print("\n✅ All required tables exist. You can run the ML pipeline.\n")
        print("MF pipeline:")
        print("  python extract_features.py --backfill 365")
        print("  python macro_features.py --backfill 365 --skip-regression")
        print("  python label_targets.py")
        print("  python train.py --dry-run")
        print()
        print("Stock pipeline:")
        print("  python extract_stock_features.py --backfill 730")
        print("  python label_stock_targets.py")
        print("  python train_stock.py --dry-run")
        print("  python train_stock.py\n")
        return

    print(f"\n⚠️  {len(missing)} required table(s) missing: {missing}\n")

    if args.check:
        sys.exit(1)

    print("─" * 70)
    print("ACTION REQUIRED: Run the following SQL in the Supabase SQL Editor")
    print(f"  Dashboard → {url} → SQL Editor → New Query → paste below → Run")
    print("─" * 70)
    print()
    print("-- STEP 1: Create all ML tables (MF + Stock)")
    print(SETUP_SQL.read_text())
    print()
    print("-- STEP 2: Add sentiment columns (run after Step 1 succeeds)")
    print(MIGRATE_SQL.read_text())
    print()
    print("-- STEP 3: Add category-group columns (migration 006)")
    print(MIGRATE_006.read_text())
    print("─" * 70)
    print()
    print("After running the SQL, re-run this script to verify:")
    print("  python setup_db.py --check\n")


if __name__ == "__main__":
    main()
