"use strict";

/**
 * ML prediction blend for stock picks.
 *
 * Two independent alpha sources exist in this codebase:
 *   1. the technical composite score (stock_signals.js) — a momentum/entry model
 *   2. the LightGBM model (stock_predictions)           — a forward-return model
 *
 * Historically only (1) reached the UI. This module blends (2) into the score —
 * but ONLY when the model has demonstrated out-of-sample edge. A model that
 * scores at chance (CV AUC ≈ 0.50) must never move the picks, or it just adds
 * noise. The blend weight therefore scales with measured edge and is gated off
 * entirely below AUC_GATE:
 *
 *     auc < AUC_GATE            → weight 0   (ignored)
 *     AUC_FLOOR ≤ auc ≤ AUC_FULL → weight ramps 0 → MAX_WEIGHT
 *     auc ≥ AUC_FULL            → weight MAX_WEIGHT
 *
 * It prefers the risk-adjusted probability (p_top_sharpe_q_3m) over the raw
 * return probability (p_top_quartile_3m): the Sharpe-quartile target de-emphasises
 * high-beta names that post big raw returns but round-trip — exactly the names
 * that hurt on a short holding period.
 */

const AUC_GATE   = 0.55;   // below this, ML is ignored entirely
const AUC_FLOOR  = 0.55;   // auc at which blend weight starts ramping
const AUC_FULL   = 0.62;   // auc at which blend weight is maxed
const MAX_WEIGHT = 0.35;   // ceiling on ML influence over the final score
const FRESH_DAYS = 5;      // predictions older than this (calendar days) are ignored
const MIN_PREDS  = 30;     // need at least this many scored stocks to blend

/** Map a measured CV AUC to a blend weight in [0, MAX_WEIGHT]. Pure — unit tested. */
function blendWeightForAuc(auc) {
  if (auc == null || !isFinite(auc) || auc < AUC_GATE) return 0;
  const frac = Math.max(0, Math.min(1, (auc - AUC_FLOOR) / (AUC_FULL - AUC_FLOOR)));
  return Math.round(MAX_WEIGHT * frac * 1000) / 1000;
}

/** Convert a list of {symbol, prob} to symbol → cross-sectional percentile (0–100). */
function toPercentileMap(scored) {
  const valid = scored.filter((s) => s.prob != null && isFinite(s.prob));
  const byProb = [...valid].sort((a, b) => a.prob - b.prob);
  const n = byProb.length;
  const map = new Map();
  byProb.forEach((s, i) => {
    map.set(s.symbol, n > 1 ? Math.round((i / (n - 1)) * 100) : 50);
  });
  return map;
}

function daysBetween(aIso, b = new Date()) {
  const a = new Date(aIso + "T00:00:00Z");
  return Math.abs((b.getTime() - a.getTime()) / 86400000);
}

/**
 * Load the gated ML blend from Supabase. Never throws — on any problem it
 * returns a zero-weight blend so the pick build proceeds untouched.
 *
 * @returns {Promise<{weight:number, bySymbol:Map<string,number>, meta:object}>}
 */
async function loadMlBlend(supabase) {
  const inert = (reason, extra = {}) => ({
    weight: 0, bySymbol: new Map(), meta: { active: false, reason, ...extra },
  });
  try {
    // 1. Latest prediction date
    const { data: latest, error: e1 } = await supabase
      .from("stock_predictions")
      .select("prediction_date")
      .order("prediction_date", { ascending: false })
      .limit(1);
    if (e1) return inert(`query error: ${e1.message}`);
    if (!latest?.length) return inert("no stock_predictions rows");

    const predDate = latest[0].prediction_date;
    const age = daysBetween(predDate);
    if (age > FRESH_DAYS) return inert(`predictions stale (${age.toFixed(0)}d old)`, { predDate });

    // 2. Scored rows for that date (prefer risk-adjusted prob)
    const { data: rows, error: e2 } = await supabase
      .from("stock_predictions")
      .select("symbol,p_top_sharpe_q_3m,p_top_quartile_3m")
      .eq("prediction_date", predDate);
    if (e2) return inert(`prediction fetch error: ${e2.message}`);

    let probCol = "p_top_sharpe_q_3m";
    let scored = (rows ?? [])
      .map((r) => ({ symbol: r.symbol, prob: r.p_top_sharpe_q_3m }))
      .filter((s) => s.prob != null);
    if (scored.length < MIN_PREDS) {
      // Fall back to raw-return probability if the Sharpe model didn't populate.
      probCol = "p_top_quartile_3m";
      scored = (rows ?? [])
        .map((r) => ({ symbol: r.symbol, prob: r.p_top_quartile_3m }))
        .filter((s) => s.prob != null);
    }
    if (scored.length < MIN_PREDS) return inert(`too few scored stocks (${scored.length})`, { predDate });

    // 3. Measured edge — best CV AUC among recent model runs
    const { data: runs, error: e3 } = await supabase
      .from("stock_model_runs")
      .select("cv_auc,trained_at")
      .order("trained_at", { ascending: false })
      .limit(8);
    if (e3) return inert(`model_runs error: ${e3.message}`, { predDate });
    const aucs = (runs ?? []).map((r) => r.cv_auc).filter((a) => a != null && isFinite(a));
    const bestAuc = aucs.length ? Math.max(...aucs) : null;

    const weight = blendWeightForAuc(bestAuc);
    const bySymbol = toPercentileMap(scored);
    return {
      weight,
      bySymbol,
      meta: {
        active: weight > 0,
        reason: weight > 0 ? "blended" : `AUC ${bestAuc?.toFixed(3) ?? "n/a"} < gate ${AUC_GATE}`,
        predDate, probCol, cvAuc: bestAuc, scored: scored.length, weight,
      },
    };
  } catch (e) {
    return inert(`exception: ${e.message}`);
  }
}

/**
 * Blend ML percentile into each stock's compositeScore in place.
 * Always annotates mlScore / mlBlendWeight for UI transparency.
 * @returns {number} how many stocks were actually blended
 */
function applyMlBlend(stocks, blend) {
  if (!Array.isArray(stocks)) return 0;
  const w = blend?.weight ?? 0;
  const map = blend?.bySymbol ?? new Map();
  let n = 0;
  for (const s of stocks) {
    const ml = map.has(s.symbol) ? map.get(s.symbol) : null;
    s.mlScore = ml;
    if (w > 0 && ml != null && s.compositeScore != null) {
      s.mlBlendWeight = w;
      s.compositeScore = Math.max(0, Math.min(100,
        Math.round((1 - w) * s.compositeScore + w * ml)));
      n++;
    } else {
      s.mlBlendWeight = 0;
    }
  }
  return n;
}

module.exports = {
  loadMlBlend,
  applyMlBlend,
  blendWeightForAuc,
  toPercentileMap,
  // exported for tuning/tests
  _config: { AUC_GATE, AUC_FLOOR, AUC_FULL, MAX_WEIGHT, FRESH_DAYS, MIN_PREDS },
};
