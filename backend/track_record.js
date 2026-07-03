"use strict";

/**
 * Track Record — realized performance of published stock picks.
 *
 * Reads pick_history (daily top-100 snapshots backfilled with forward returns
 * by ml/track_pick_outcomes.py) and aggregates it into a radar_cache blob the
 * UI can render without touching the table: cohort forward-return series,
 * hit rates by horizon and rank band, a per-pick return distribution, and a
 * non-overlapping 21-day rotation equity curve vs Nifty.
 *
 * Return semantics mirror track_pick_outcomes.py exactly: entry is the first
 * close strictly AFTER pick_date, exit is entry + N trading days. "Net" means
 * net of ROUND_TRIP_COST_PCT per round trip.
 *
 * Output blob (radar_cache key `track_record`):
 * {
 *   asOf, params: { costPct, windowDays },
 *   summary: { ret_5d|ret_10d|ret_21d: { top10: {...stats}, top50: {...stats} } },
 *   rankBands: [{ band, n, meanNet, hitRateNet }],          // 21d
 *   series: [{ date, top10, top50, nifty }],                // mean net 21d per cohort
 *   distribution: [{ label, count }],                       // per-pick net 21d
 *   rotation: [{ date, strategy, nifty }],                  // indexed to 100
 * }
 */

const { round2, mean, median } = require("./utils");
const { getNiftyHistory } = require("./nifty_benchmark");

// Keep in sync with ROUND_TRIP_COST_PCT in ml/config.py
const ROUND_TRIP_COST_PCT = 0.30;

const HORIZONS = { ret_5d: 5, ret_10d: 10, ret_21d: 21 };

// ─── pick_history fetch (paginated — PostgREST caps at 1000 rows) ────────────

async function fetchPickHistory(supabase, { maxAgeDays = 365 } = {}) {
  const oldest = new Date();
  oldest.setDate(oldest.getDate() - maxAgeDays);
  const rows = [];
  const pageSize = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("pick_history")
      .select("pick_date,symbol,rank,ret_5d,ret_10d,ret_21d")
      .lte("rank", 50)
      .gte("pick_date", oldest.toISOString().slice(0, 10))
      .order("pick_date", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`pick_history fetch failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

// ─── Nifty forward return with the same entry/exit semantics ──────────────────

function niftyForwardReturn(niftyPrices, pickDate, tradingDays) {
  if (!niftyPrices?.length) return null;
  const idx = niftyPrices.findIndex((p) => p.date > pickDate);
  if (idx < 0) return null;
  const exitIdx = idx + tradingDays;
  if (exitIdx >= niftyPrices.length) return null;
  const entry = niftyPrices[idx].close;
  if (!entry || entry <= 0) return null;
  return (niftyPrices[exitIdx].close / entry - 1) * 100;
}

// ─── Aggregation (pure — unit tested) ─────────────────────────────────────────

function stats(rets, costPct) {
  if (!rets.length) return null;
  const net = rets.map((r) => r - costPct);
  return {
    n:          rets.length,
    mean:       round2(mean(rets)),
    median:     round2(median(rets)),
    hitRate:    round2((rets.filter((r) => r > 0).length / rets.length) * 100),
    meanNet:    round2(mean(net)),
    hitRateNet: round2((net.filter((r) => r > 0).length / net.length) * 100),
  };
}

const DIST_BUCKETS = [
  { label: "< −10%",    lo: -Infinity, hi: -10 },
  { label: "−10 – −5%", lo: -10,       hi: -5 },
  { label: "−5 – 0%",   lo: -5,        hi: 0 },
  { label: "0 – 5%",    lo: 0,         hi: 5 },
  { label: "5 – 10%",   lo: 5,         hi: 10 },
  { label: "10 – 20%",  lo: 10,        hi: 20 },
  { label: "> 20%",     lo: 20,        hi: Infinity },
];

/**
 * Aggregate pick_history rows + Nifty closes into the track_record blob.
 * Pure function of its inputs so it can be unit tested without Supabase.
 */
function buildTrackRecord(rows, niftyPrices, { costPct = ROUND_TRIP_COST_PCT } = {}) {
  // Group by pick_date
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.pick_date)) byDate.set(r.pick_date, []);
    byDate.get(r.pick_date).push(r);
  }
  const dates = [...byDate.keys()].sort();

  // Per-horizon summary for top-10 and top-50 cohorts (pooled per-pick returns)
  const summary = {};
  for (const [col] of Object.entries(HORIZONS)) {
    const top10 = [], top50 = [];
    for (const r of rows) {
      if (r[col] == null) continue;
      top50.push(r[col]);
      if (r.rank <= 10) top10.push(r[col]);
    }
    summary[col] = { top10: stats(top10, costPct), top50: stats(top50, costPct) };
  }

  // Rank bands, 21d — does concentration in the very top pay?
  const bands = [
    { band: "1–10",  lo: 1,  hi: 10 },
    { band: "11–25", lo: 11, hi: 25 },
    { band: "26–50", lo: 26, hi: 50 },
  ];
  const rankBands = bands.map(({ band, lo, hi }) => {
    const rets = rows.filter((r) => r.rank >= lo && r.rank <= hi && r.ret_21d != null).map((r) => r.ret_21d);
    const s = stats(rets, costPct);
    return { band, n: s?.n ?? 0, meanNet: s?.meanNet ?? null, hitRateNet: s?.hitRateNet ?? null };
  });

  // Cohort series: mean net 21d return per pick_date, with the Nifty same-window baseline
  const series = [];
  for (const d of dates) {
    const cohort = byDate.get(d).filter((r) => r.ret_21d != null);
    if (!cohort.length) continue;
    const top10 = cohort.filter((r) => r.rank <= 10).map((r) => r.ret_21d - costPct);
    const top50 = cohort.map((r) => r.ret_21d - costPct);
    series.push({
      date:   d,
      top10:  top10.length ? round2(mean(top10)) : null,
      top50:  round2(mean(top50)),
      nifty:  round2(niftyForwardReturn(niftyPrices, d, HORIZONS.ret_21d)),
    });
  }

  // Distribution of individual top-50 net 21d returns
  const perPick = rows.filter((r) => r.ret_21d != null).map((r) => r.ret_21d - costPct);
  const distribution = DIST_BUCKETS.map((b) => ({
    label: b.label,
    count: perPick.filter((r) => r >= b.lo && r < b.hi).length,
  }));

  // Rotation equity curve: every ~21 trading days (~30 calendar), buy the
  // top-10 cohort, hold to resolution, compound. Non-overlapping so the
  // compounding is honest. Nifty compounds over the same windows.
  const rotation = [];
  let stratLevel = 100, niftyLevel = 100;
  let nextEligible = null;
  const plus30 = (dateStr) => {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 30);
    return d.toISOString().slice(0, 10);
  };
  for (const s of series) {
    if (s.top10 == null) continue;
    if (nextEligible && s.date < nextEligible) continue;
    if (!rotation.length) rotation.push({ date: s.date, strategy: 100, nifty: 100 });
    stratLevel *= 1 + s.top10 / 100;
    niftyLevel *= 1 + (s.nifty ?? 0) / 100;
    nextEligible = plus30(s.date);
    // Each leg's post-return level lands at its ~resolution date, so the
    // curve has strictly increasing dates (no duplicate-date verticals).
    rotation.push({ date: nextEligible, strategy: round2(stratLevel), nifty: round2(niftyLevel) });
  }

  return {
    asOf: new Date().toISOString(),
    params: { costPct, windowDays: 365 },
    cohorts: dates.length,
    summary,
    rankBands,
    series,
    distribution,
    rotation: rotation.length >= 3 ? rotation : [],  // need a few points to be meaningful
  };
}

/** Fetch + aggregate + return the blob (caller upserts to radar_cache). */
async function computeTrackRecord(supabase) {
  const rows = await fetchPickHistory(supabase);
  let niftyPrices = null;
  try {
    niftyPrices = await getNiftyHistory();
  } catch (e) {
    console.warn(`  ⚠ track record: Nifty baseline unavailable (${e.message})`);
  }
  return buildTrackRecord(rows, niftyPrices);
}

module.exports = { computeTrackRecord, buildTrackRecord, niftyForwardReturn, _config: { ROUND_TRIP_COST_PCT } };
