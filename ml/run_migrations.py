"""
Migration runner — applies every ml/migrate_*.sql file to Supabase, in
filename order.

There is no record of which migrations have already run, so every file is
re-applied on every run. Each migration MUST therefore be idempotent
(CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, guarded CREATE POLICY,
no unguarded data changes). tests/test_run_migrations.py enforces the common
cases.

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

ML_DIR = Path(__file__).parent


def discover_migrations(ml_dir: Path = ML_DIR) -> list[Path]:
    """All migrate_NNN_*.sql files, ordered by filename (NNN is zero-padded)."""
    return sorted(ml_dir.glob("migrate_*.sql"), key=lambda p: p.name)


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

    migrations = discover_migrations()
    if not migrations:
        print(f"ERROR: no migrate_*.sql files found in {ML_DIR}")
        sys.exit(1)
    print(f"Found {len(migrations)} migrations: {migrations[0].name} … {migrations[-1].name}")

    for path in migrations:
        sql = path.read_text()
        print(f"Applying {path.name} …", end=" ", flush=True)
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
