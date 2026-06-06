"""
Migration runner — applies pending SQL migration files to Supabase.

Uses the Supabase Management API (preferred) or direct psql (fallback).

Env vars (one of the two must be set):
    SUPABASE_ACCESS_TOKEN   — personal access token from app.supabase.com
    SUPABASE_DB_URL         — full postgres:// connection string (Settings > Database)

Always needed:
    SUPABASE_URL            — e.g. https://xyzxyz.supabase.co
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import httpx

MIGRATIONS = [
    "migrate_006_category_groups.sql",
    "migrate_007_stock_improvements.sql",
    "migrate_008_cat_rel_risk.sql",
    "migrate_009_stock_sentiment_gdelt.sql",
    "migrate_010_stock_feature_enhancements.sql",
]

ML_DIR = Path(__file__).parent


def _project_ref(supabase_url: str) -> str:
    m = re.match(r"https://([^.]+)\.supabase\.co", supabase_url)
    if not m:
        raise ValueError(f"Cannot parse project ref from {supabase_url}")
    return m.group(1)


def run_via_management_api(sql: str, project_ref: str, access_token: str) -> None:
    url = f"https://api.supabase.com/v1/projects/{project_ref}/database/query"
    resp = httpx.post(
        url,
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={"query": sql},
        timeout=30,
    )
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"Management API error {resp.status_code}: {resp.text}")


def run_via_psql(sql: str, db_url: str) -> None:
    result = subprocess.run(
        ["psql", db_url, "-c", sql],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"psql error: {result.stderr}")


def main() -> None:
    supabase_url    = os.environ.get("SUPABASE_URL", "")
    access_token    = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
    db_url          = os.environ.get("SUPABASE_DB_URL", "")

    if not access_token and not db_url:
        print("ERROR: set SUPABASE_ACCESS_TOKEN or SUPABASE_DB_URL")
        sys.exit(1)

    project_ref = _project_ref(supabase_url) if supabase_url else ""

    for migration_file in MIGRATIONS:
        path = ML_DIR / migration_file
        if not path.exists():
            print(f"SKIP  {migration_file} (file not found)")
            continue

        sql = path.read_text()
        print(f"Applying {migration_file} …", end=" ", flush=True)
        try:
            if access_token and project_ref:
                run_via_management_api(sql, project_ref, access_token)
            else:
                run_via_psql(sql, db_url)
            print("OK")
        except Exception as e:
            print(f"FAILED: {e}")
            sys.exit(1)

    print("All migrations applied.")


if __name__ == "__main__":
    main()
