"""
Regression test for the 2026-09-19 through 2026-09-24 incident: every `all`
trigger's "Label MF targets" step crashed with
`TypeError: Object of type bool_ is not JSON serializable` inside
label_targets.py's compute_labels(), which cascaded into skipping every
downstream step (MF/stock training, backfills, GDELT sentiment) for the
rest of that day's job, day after day.

Root cause: _assign_quartiles()'s single-item-category branch stored
`val > 0` directly — a numpy.bool_ when val is a numpy scalar (the normal
case, since fund_fwd_rets/fund_fwd_sharpes are built from pandas/numpy
arithmetic) — which httpx's default JSON encoder cannot serialize. The
qcut-based branches were already safe because they cast through int()
first (`q == 1` on two Python ints yields a native bool).
"""

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from label_targets import _assign_quartiles


def test_single_item_category_top_flag_is_json_serializable():
    # A category with exactly one fund — the len(items) < 2 branch — with a
    # numpy scalar value, exactly as fund_fwd_rets/fund_fwd_sharpes produce.
    cat_map = {"Sectoral - Defence": [("SCHEME1", np.float64(3.5))]}
    _, top_map = _assign_quartiles(cat_map)

    assert isinstance(top_map["SCHEME1"], bool), (
        f"expected a native bool, got {type(top_map['SCHEME1'])}"
    )
    json.dumps({"fwd_top_q_3m": top_map["SCHEME1"]})  # must not raise


def test_single_item_category_negative_value():
    cat_map = {"Sectoral - Defence": [("SCHEME1", np.float64(-1.2))]}
    _, top_map = _assign_quartiles(cat_map)

    assert top_map["SCHEME1"] is False
    json.dumps({"fwd_top_q_3m": top_map["SCHEME1"]})


def test_qcut_branch_top_flags_are_json_serializable():
    # >=2 items still routes through pd.qcut — already safe, but pin it too.
    cat_map = {
        "Large Cap": [(f"S{i}", np.float64(v)) for i, v in enumerate([5.0, 3.0, 1.0, -1.0])]
    }
    _, top_map = _assign_quartiles(cat_map)
    for v in top_map.values():
        assert isinstance(v, bool) or v is None
        json.dumps({"flag": v})
