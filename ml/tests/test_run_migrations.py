"""
Tests for the migration runner (ml/run_migrations.py).

The runner re-applies every ml/migrate_*.sql file on each `target=migrate`
run (there is no applied-migrations ledger), so:
  - discovery must pick up every file, in order, with no hand-kept list to
    forget to update;
  - every migration must be idempotent. The lint below catches the common
    ways a migration fails on its second run.
"""

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from run_migrations import ML_DIR, discover_migrations

MIGRATIONS = discover_migrations()


def _strip_comments(sql: str) -> str:
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    return re.sub(r"--[^\n]*", " ", sql)


def idempotency_problems(sql: str) -> list[str]:
    """Return a description of each statement that would fail or misbehave on re-run."""
    s = _strip_comments(sql)
    problems = []

    for m in re.finditer(r"\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)(\S+)", s, re.I):
        problems.append(f"CREATE TABLE {m.group(1)} without IF NOT EXISTS")

    for m in re.finditer(
        r"\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?!IF\s+NOT\s+EXISTS)(\S+)", s, re.I
    ):
        problems.append(f"CREATE INDEX {m.group(1)} without IF NOT EXISTS")

    if not re.search(r"\bduplicate_column\b", s, re.I):
        for m in re.finditer(r"\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)(\S+)", s, re.I):
            problems.append(f"ADD COLUMN {m.group(1)} without IF NOT EXISTS")

    if re.search(r"\bADD\s+CONSTRAINT\b", s, re.I) and not re.search(
        r"\bpg_constraint\b|\bduplicate_object\b", s, re.I
    ):
        problems.append("ADD CONSTRAINT without a pg_constraint / duplicate_object guard")

    # CREATE POLICY has no IF NOT EXISTS: each policy must be dropped first
    # or checked against pg_policies.
    for m in re.finditer(r'\bCREATE\s+POLICY\s+"([^"]+)"', s, re.I):
        name = re.escape(m.group(1))
        dropped = re.search(rf'DROP\s+POLICY\s+IF\s+EXISTS\s+"{name}"', s, re.I)
        checked = re.search(rf"policyname\s*=\s*'{name}'", s, re.I)
        if not (dropped or checked):
            problems.append(f'CREATE POLICY "{m.group(1)}" without DROP POLICY IF EXISTS or pg_policies guard')

    for m in re.finditer(r"\bDROP\s+(TABLE|COLUMN|INDEX|VIEW|POLICY)\s+(?!IF\s+EXISTS)(\S+)", s, re.I):
        problems.append(f"DROP {m.group(1).upper()} {m.group(2)} without IF EXISTS")

    for m in re.finditer(r"\bINSERT\s+INTO\b[^;]*;", s, re.I):
        if not re.search(r"\bON\s+CONFLICT\b", m.group(0), re.I):
            problems.append("INSERT without ON CONFLICT (would duplicate rows on re-run)")

    if re.search(r"\bTRUNCATE\b", s, re.I):
        problems.append("TRUNCATE (destroys data on every migrate run)")

    return problems


class TestDiscovery:

    def test_finds_every_migration_file(self):
        on_disk = {p.name for p in ML_DIR.glob("migrate_*.sql")}
        assert {p.name for p in MIGRATIONS} == on_disk
        assert len(MIGRATIONS) > 0

    def test_includes_migrations_the_old_hardcoded_list_missed(self):
        names = {p.name for p in MIGRATIONS}
        for expected in (
            "migrate_014_pick_ai_rationales.sql",
            "migrate_015_pick_history_rls.sql",
            "migrate_016_macro_flows.sql",
        ):
            assert expected in names

    def test_ordered_by_migration_number(self):
        numbers = [int(re.match(r"migrate_(\d+)_", p.name).group(1)) for p in MIGRATIONS]
        assert numbers == sorted(numbers)

    def test_ignores_non_migration_files(self, tmp_path):
        for name in ("migrate_002_b.sql", "migrate_001_a.sql", "setup.sql", "migrate_003_c.txt", "notes.md"):
            (tmp_path / name).write_text("-- x")
        assert [p.name for p in discover_migrations(tmp_path)] == [
            "migrate_001_a.sql",
            "migrate_002_b.sql",
        ]


@pytest.mark.parametrize("path", MIGRATIONS, ids=lambda p: p.name)
def test_migration_is_idempotent(path):
    problems = idempotency_problems(path.read_text())
    assert not problems, (
        f"{path.name} is re-applied on every `target=migrate` run and must be safe to re-run:\n  - "
        + "\n  - ".join(problems)
    )


class TestIdempotencyLint:
    """The lint itself must flag real mistakes, or the test above proves nothing."""

    @pytest.mark.parametrize("sql", [
        "CREATE TABLE foo (id int);",
        "CREATE INDEX idx_foo ON foo (id);",
        "CREATE UNIQUE INDEX idx_foo ON foo (id);",
        "ALTER TABLE foo ADD COLUMN bar int;",
        "ALTER TABLE foo ADD CONSTRAINT foo_key UNIQUE (id);",
        'CREATE POLICY "p" ON foo FOR SELECT USING (true);',
        "DROP TABLE foo;",
        "INSERT INTO foo (id) VALUES (1);",
        "TRUNCATE foo;",
    ])
    def test_flags_non_idempotent_sql(self, sql):
        assert idempotency_problems(sql)

    @pytest.mark.parametrize("sql", [
        "CREATE TABLE IF NOT EXISTS foo (id int);",
        "CREATE INDEX IF NOT EXISTS idx_foo ON foo (id);",
        "ALTER TABLE foo ADD COLUMN IF NOT EXISTS bar int;",
        "DO $$ BEGIN ALTER TABLE foo ADD COLUMN bar int; EXCEPTION WHEN duplicate_column THEN NULL; END $$;",
        'DROP POLICY IF EXISTS "p" ON foo; CREATE POLICY "p" ON foo FOR SELECT USING (true);',
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'p') THEN "
        "EXECUTE 'CREATE POLICY \"p\" ON foo FOR SELECT USING (true)'; END IF; END $$;",
        "INSERT INTO foo (id) VALUES (1) ON CONFLICT DO NOTHING;",
        "-- CREATE TABLE foo (id int);  (only a comment)",
    ])
    def test_accepts_idempotent_sql(self, sql):
        assert idempotency_problems(sql) == []
