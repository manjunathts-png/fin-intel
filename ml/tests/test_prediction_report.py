import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from prediction_report import summarize


def test_summarize_groups_by_version_and_flags_low_probabilities():
    rows = [
        {"symbol": "A", "model_version": "v3m", "p_top_quartile_3m": 0.30, "p_top_sharpe_q_3m": 0.25},
        {"symbol": "B", "model_version": "v3m", "p_top_quartile_3m": 0.0, "p_top_sharpe_q_3m": 0.20},
        {"symbol": "C", "model_version": "v1m", "p_top_quartile_1m": 0.22},
    ]
    lines, low = summarize(rows)
    text = "\n".join(lines)
    assert "`v1m`: 1 rows" in text
    assert "`v3m`: 2 rows" in text
    assert "p_top_quartile_3m: n=2 min=0.0000" in text
    assert [r["symbol"] for r in low] == ["B"]
