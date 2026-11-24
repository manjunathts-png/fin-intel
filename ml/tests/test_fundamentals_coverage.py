import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from fundamentals_coverage import distinct_values, parse_total, weekdays_between


def test_parse_total_handles_postgrest_content_range():
    assert parse_total("0-0/1234") == 1234
    assert parse_total("*/0") == 0
    assert parse_total(None) == 0
    assert parse_total("0-0/*") == 0


def test_weekdays_between_skips_weekends():
    days = weekdays_between(date(2026, 11, 20), date(2026, 11, 24))  # Fri → Tue
    assert days == [date(2026, 11, 20), date(2026, 11, 23), date(2026, 11, 24)]


def test_distinct_values_ignores_nulls_and_float_noise():
    assert distinct_values([18.2, 18.20000001, None, 19.5]) == 2
    assert distinct_values([None, None]) == 0
