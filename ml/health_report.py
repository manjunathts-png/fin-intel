"""
Nightly System Health Digest
============================

Rolls every monitoring signal the pipeline already produces into ONE place,
so a degrading system is noticed in days, not weeks:

  - source connectivity   (source_status.json from probe_sources.py)
  - data freshness        (max as_of_date in stock_features)
  - signal IC drift       (signal_ic_history sign flips)
  - model validation      (latest oos_auc vs cv_auc gap per model table)
  - realized performance  (pick_history 21d hit rate, last 60 days)

Output:
  1. Markdown digest appended to $GITHUB_STEP_SUMMARY (visible on the
     Actions run page) and logged to stdout.
  2. One row per component upserted into system_health (migration 013) —
     queryable history of how the system degraded over time. Degrades
     gracefully with a warning if the table doesn't exist yet.

Never fails the workflow: always exits 0.

Usage:
    python health_report.py

Env:
    SUPABASE_URL, SUPABASE_SERVICE_KEY
    GITHUB_STEP_SUMMARY   (optional; set by GitHub Actions)
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from config import ROUND_TRIP_COST_PCT

load_dotenv()
load_dotenv(Path(__file__).parent.parent / "backend" / ".env", override=False)
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("health_report")

SOURCE_STATUS_PATH = Path(__file__).parent / "source_status.json"

# Thresholds
FRESHNESS_MAX_AGE_DAYS = 4      # > 4d stale features (covers weekend + 1 holiday)
OOS_CV_GAP_WARN        = 0.10   # cv_auc − oos_auc above this = likely overfit CV
OOS_AUC_FLOOR          = 0.51   # below this the model has no live edge (matches ml_blend.js AUC_GATE)
HIT_RATE_WARN_PCT      = 45.0   # top-50 21d hit rate below this = review signals
HIT_RATE_MIN_N         = 50     # don't judge hit rate on fewer resolved picks

STATUS_ORDER = {"ok": 0, "unknown": 1, "warn": 2, "critical": 3}
STATUS_ICON  = {"ok": "✅", "unknown": "❔", "warn": "⚠️", "critical": "🔴"}


def section(component: str, status: str, detail: str, metrics: dict | None = None) -> dict:
    return {"component": component, "status": status, "detail": detail,
            "metrics": metrics or {}}


# ─── Collectors ───────────────────────────────────────────────────────────────

def check_sources(path: Path = SOURCE_STATUS_PATH) -> dict:
    """Summarize the pre-flight probe results written by probe_sources.py."""
    if not path.exists():
        return section("sources", "unknown", "source_status.json not found (probe didn't run)")
    try:
        data = json.loads(path.read_text())
    except Exception as e:
        return section("sources", "unknown", f"source_status.json unreadable: {e}")
    # probe_sources writes plain string statuses: {"sources": {"stooq": "ok", ...}}
    statuses = {name: (s if isinstance(s, str) else "unknown")
                for name, s in data.get("sources", {}).items()}
    down     = sorted(n for n, s in statuses.items() if s == "down")
    degraded = sorted(n for n, s in statuses.items() if s == "degraded")
    if len(down) >= 2:
        status, detail = "critical", f"{len(down)} sources down: {', '.join(down)}"
    elif down:
        status, detail = "warn", f"down: {down[0]}" + (f" · degraded: {', '.join(degraded)}" if degraded else "")
    elif degraded:
        status, detail = "warn", f"degraded: {', '.join(degraded)}"
    else:
        status, detail = "ok", f"all {len(statuses)} sources reachable"
    return section("sources", status, detail, {"statuses": statuses})


def check_freshness(supabase) -> dict:
    """stock_features must have been written within the last few days."""
    try:
        resp = (supabase.table("stock_features").select("as_of_date")
                .order("as_of_date", desc=True).limit(1).execute())
        rows = resp.data or []
        if not rows:
            return section("freshness", "warn", "stock_features is empty")
        latest = date.fromisoformat(str(rows[0]["as_of_date"])[:10])
        age = (date.today() - latest).days
        status = "ok" if age <= FRESHNESS_MAX_AGE_DAYS else "warn"
        return section("freshness", status,
                       f"latest stock_features = {latest} ({age}d old)",
                       {"latest": str(latest), "age_days": age})
    except Exception as e:
        return section("freshness", "unknown", f"query failed: {e}")


def check_ic_drift(supabase) -> dict:
    """Any calibrated reversal signal with a significant sign flip?"""
    try:
        # Fetch the latest run_date first, then pull all signals for that date.
        # A limit(50) scan is fragile once signal count grows past the page size.
        date_resp = (supabase.table("signal_ic_history")
                     .select("run_date")
                     .order("run_date", desc=True).limit(1).execute())
        date_rows = date_resp.data or []
        if not date_rows:
            return section("ic_drift", "unknown", "no signal_ic_history rows yet")
        latest = date_rows[0]["run_date"]
        resp = (supabase.table("signal_ic_history")
                .select("run_date,horizon,signal,ic_mean,ic_tstat,sign_flipped")
                .eq("run_date", latest).execute())
        latest_rows = resp.data or []
        flipped = [r for r in latest_rows if r.get("sign_flipped")]
        if flipped:
            names = ", ".join(f"{r['signal']} (t={r.get('ic_tstat', 0):+.1f})" for r in flipped)
            return section("ic_drift", "warn",
                           f"{len(flipped)} signal(s) flipped sign as of {latest}: {names}",
                           {"run_date": str(latest), "flipped": [r["signal"] for r in flipped]})
        return section("ic_drift", "ok",
                       f"{len(latest_rows)} signals tracked as of {latest}, no sign flips",
                       {"run_date": str(latest), "n_signals": len(latest_rows)})
    except Exception as e:
        return section("ic_drift", "unknown", f"query failed: {e}")


def check_model(supabase, table: str, label: str) -> dict:
    """Latest model run: does it have OOS metrics, and do they hold up vs CV?"""
    try:
        resp = (supabase.table(table)
                .select("model_version,trained_at,cv_auc,oos_auc,oos_samples")
                .order("trained_at", desc=True).limit(1).execute())
        rows = resp.data or []
        if not rows:
            return section(label, "unknown", f"no rows in {table}")
        r = rows[0]
        cv, oos = r.get("cv_auc"), r.get("oos_auc")
        trained = str(r.get("trained_at", ""))[:10]
        metrics = {"trained_at": trained, "model_version": r.get("model_version"),
                   "cv_auc": cv, "oos_auc": oos, "oos_samples": r.get("oos_samples")}
        if oos is None:
            return section(label, "unknown",
                           f"latest run {trained} has no oos_auc (short history or pre-migration)",
                           metrics)
        if oos < OOS_AUC_FLOOR:
            return section(label, "warn",
                           f"oos_auc={oos:.3f} < {OOS_AUC_FLOOR} — no live edge, ML blend should stay gated",
                           metrics)
        if cv is not None and (cv - oos) > OOS_CV_GAP_WARN:
            return section(label, "warn",
                           f"cv_auc={cv:.3f} vs oos_auc={oos:.3f} — gap {cv - oos:.3f} suggests overfit CV",
                           metrics)
        return section(label, "ok", f"oos_auc={oos:.3f}" + (f" (cv={cv:.3f})" if cv is not None else ""), metrics)
    except Exception as e:
        return section(label, "unknown", f"query failed: {e}")


# 60d window is intentionally shorter than report_summary's 120d — catches recent
# regime drift earlier at the cost of higher variance.

def check_outcomes(supabase) -> dict:
    """Realized top-50 hit rate (net of round-trip cost) over the last 60 days."""
    try:
        resp = (supabase.table("pick_history")
                .select("rank,ret_21d")
                .not_.is_("ret_21d", "null")
                .lte("rank", 50)
                .gte("pick_date", str(date.today() - timedelta(days=60)))
                .execute())
        rows = resp.data or []
        if len(rows) < HIT_RATE_MIN_N:
            return section("outcomes", "unknown",
                           f"only {len(rows)} resolved top-50 picks in 60d (need {HIT_RATE_MIN_N})",
                           {"n": len(rows)})
        rets = [r["ret_21d"] for r in rows]
        gross_hit = 100.0 * sum(1 for x in rets if x > 0) / len(rets)
        net_hit   = 100.0 * sum(1 for x in rets if x > ROUND_TRIP_COST_PCT) / len(rets)
        mean = sum(rets) / len(rets)
        status = "ok" if net_hit >= HIT_RATE_WARN_PCT else "warn"
        return section("outcomes", status,
                       f"top-50 21d: net-hit={net_hit:.0f}% gross-hit={gross_hit:.0f}% mean={mean:+.2f}% (n={len(rets)})",
                       {"hit_rate_pct": round(net_hit, 1), "gross_hit_rate_pct": round(gross_hit, 1),
                        "mean_ret": round(mean, 2), "n": len(rets)})
    except Exception as e:
        return section("outcomes", "unknown", f"query failed: {e}")


def check_mfapi_data() -> dict:
    """Fetch a known fund's full NAV history and validate the response body.

    probe_sources.py checks HTTP 200 for /mf/<code>/latest; this checks that
    the full history endpoint actually returns nav rows — catching cases where
    the API is reachable but serving empty or malformed responses.
    """
    url = "https://api.mfapi.in/mf/119598"  # Mirae Asset Large Cap — a stable, long-history fund
    ua  = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        data = json.loads(body)
        nav_rows = data.get("data", [])
        if not nav_rows:
            return section("mfapi_data", "warn",
                           "mfapi.in responded HTTP 200 but returned 0 NAV rows — Deep Dive will show empty",
                           {"fund_code": 119598, "nav_count": 0})
        return section("mfapi_data", "ok",
                       f"mfapi.in returned {len(nav_rows)} NAV rows for fund 119598",
                       {"fund_code": 119598, "nav_count": len(nav_rows)})
    except urllib.error.HTTPError as e:
        return section("mfapi_data", "critical",
                       f"mfapi.in HTTP {e.code} — Deep Dive NAV fetch will fail for all funds",
                       {"http_status": e.code})
    except Exception as e:
        return section("mfapi_data", "critical",
                       f"mfapi.in unreachable: {e} — Deep Dive NAV fetch will fail",
                       {"error": str(e)[:120]})


# ─── Aggregation + output ─────────────────────────────────────────────────────

def overall_status(sections: list[dict]) -> str:
    """Worst real status wins; 'unknown' never escalates beyond itself."""
    worst = "ok"
    for s in sections:
        if STATUS_ORDER.get(s["status"], 1) > STATUS_ORDER[worst]:
            worst = s["status"]
    return worst


def build_markdown(sections: list[dict], run_date: date | None = None) -> str:
    run_date = run_date or date.today()
    overall = overall_status(sections)
    lines = [
        f"## {STATUS_ICON[overall]} System Health — {run_date} ({overall.upper()})",
        "",
        "| Component | Status | Detail |",
        "|---|---|---|",
    ]
    for s in sections:
        lines.append(f"| {s['component']} | {STATUS_ICON[s['status']]} {s['status']} | {s['detail']} |")
    return "\n".join(lines) + "\n"


def write_step_summary(md: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    try:
        with open(path, "a") as f:
            f.write(md + "\n")
    except Exception as e:
        log.warning("Could not write GITHUB_STEP_SUMMARY: %s", e)


def persist(supabase, sections: list[dict]) -> None:
    rows = [{
        "run_date":  str(date.today()),
        "component": s["component"],
        "status":    s["status"],
        "detail":    s["detail"][:500],
        "metrics":   s["metrics"],
    } for s in sections]
    try:
        supabase.table("system_health").upsert(rows, on_conflict="run_date,component", returning="minimal").execute()
        log.info("Persisted %d health rows to system_health", len(rows))
    except Exception as e:
        log.warning("system_health upsert failed (run migrate_013?): %s", e)


def main():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    supabase = None
    if url and key:
        from supabase import create_client
        supabase = create_client(url, key)
    else:
        log.warning("SUPABASE_URL/SUPABASE_SERVICE_KEY not set — DB checks will be 'unknown'")

    sections = [check_sources(), check_mfapi_data()]
    if supabase is not None:
        sections += [
            check_freshness(supabase),
            check_ic_drift(supabase),
            check_model(supabase, "stock_model_runs", "stock_model"),
            check_model(supabase, "mf_model_runs", "mf_model"),
            check_outcomes(supabase),
        ]

    md = build_markdown(sections)
    print(md)
    write_step_summary(md)
    if supabase is not None:
        persist(supabase, sections)

    overall = overall_status(sections)
    if overall in ("warn", "critical"):
        log.warning("Overall system health: %s", overall.upper())
    else:
        log.info("Overall system health: %s", overall.upper())


if __name__ == "__main__":
    from script_runner import run
    run(main)
