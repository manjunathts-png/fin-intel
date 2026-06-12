"use strict";

/**
 * Market-regime filter for stock picks.
 *
 * Momentum / breakout signals work in trending, risk-on tapes and bleed in
 * choppy or falling ones — breakouts fail, and stocks below their 200DMA keep
 * sliding. This module reads the regime from cheap, robust gauges and, when
 * the tape is weak, penalises falling-knife names so picks concentrate in the
 * resilient leaders.
 *
 * Gauges (all optional — missing data degrades gracefully):
 *   • Breadth    — % of the scanned universe above its own 200DMA
 *                  (already on every signal as `above200DMA`).
 *   • Nifty 3M   — index trend/momentum from the benchmark returns.
 *   • India VIX  — implied vol; >22 = stressed, >28 = panic, <15 = calm.
 *   • FII 5d net — foreign institutional flows (₹ Cr, 5-day rolling sum);
 *                  sustained selling (≤ -8,000 Cr) marks risk-off episodes.
 *
 * Classification is vote-based:
 *   bearScore ≥ 2            → risk_off  (penalise weak names + amplify
 *                                          overextension docks — mean
 *                                          reversion accelerates in stress)
 *   bullScore ≥ 3 & bear 0   → risk_on   (let momentum run)
 *   otherwise                → neutral   (small penalty on weak names)
 *
 * Backward compatible: each legacy hard trigger (narrow breadth, index down
 * >5% over 3M) alone is worth 2 bear votes → still forces risk_off on its own.
 */

const { round2 } = require("./utils");

const BREADTH_BULL = 0.55;   // ≥55% above 200DMA = healthy participation
const BREADTH_BEAR = 0.40;   // <40% above 200DMA = narrow / risk-off
const NIFTY_BEAR_3M = -5;    // index down >5% over 3M = risk-off
const VIX_BULL  = 15;        // calm tape
const VIX_BEAR  = 22;        // stressed
const VIX_PANIC = 28;        // panic — forces risk_off on its own (2 bear votes)
const FII_BULL_5D =  4000;   // ₹ Cr net buying over 5d
const FII_BEAR_5D = -8000;   // ₹ Cr sustained net selling over 5d
const MACRO_MAX_AGE_DAYS = 7; // ignore VIX/FII snapshots older than this
const PENALTY_RISK_OFF = 12; // points docked from weak names in a risk-off tape
const PENALTY_NEUTRAL  = 4;
const OVEREXT_AMP_RISK_OFF = 0.5; // extra fraction of the overextension dock in risk_off

/** Classify the regime from the scanned universe + benchmark + macro. Pure — unit tested. */
function computeRegime({ stocks = [], niftyReturns = null, macro = null } = {}) {
  const withFlag = stocks.filter((s) => typeof s.above200DMA === "boolean");
  const breadth = withFlag.length
    ? withFlag.filter((s) => s.above200DMA).length / withFlag.length
    : null;
  const niftyRet3m = niftyReturns?.ret3m ?? null;
  const niftyRet1m = niftyReturns?.ret1m ?? null;

  // Macro snapshot is only trusted when fresh — a week-old VIX says nothing.
  let indiaVix = null, fiiNet5d = null;
  if (macro && (macro.ageDays == null || macro.ageDays <= MACRO_MAX_AGE_DAYS)) {
    indiaVix = macro.indiaVix ?? null;
    fiiNet5d = macro.fiiNet5d ?? null;
  }

  let bearScore = 0;
  if (breadth != null && breadth < BREADTH_BEAR)            bearScore += 2; // legacy hard trigger
  if (niftyRet3m != null && niftyRet3m <= NIFTY_BEAR_3M)    bearScore += 2; // legacy hard trigger
  if (indiaVix != null && indiaVix >= VIX_PANIC)            bearScore += 2;
  else if (indiaVix != null && indiaVix >= VIX_BEAR)        bearScore += 1;
  if (fiiNet5d != null && fiiNet5d <= FII_BEAR_5D)          bearScore += 1;

  let bullScore = 0;
  if (breadth != null && breadth >= BREADTH_BULL)           bullScore += 2;
  if (niftyRet3m != null && niftyRet3m >= 0)                bullScore += 1;
  if (indiaVix != null && indiaVix <= VIX_BULL)             bullScore += 1;
  if (fiiNet5d != null && fiiNet5d >= FII_BULL_5D)          bullScore += 1;

  let regime = "neutral";
  if (bearScore >= 2)                      regime = "risk_off";
  else if (bullScore >= 3 && bearScore === 0) regime = "risk_on";

  const weakPenalty =
    regime === "risk_off" ? PENALTY_RISK_OFF :
    regime === "neutral"  ? PENALTY_NEUTRAL  : 0;

  return {
    regime,
    breadthPct: breadth != null ? round2(breadth * 100) : null,
    niftyRet3m,
    niftyRet1m,
    indiaVix,
    fiiNet5d,
    // macroStale=true when macro was provided but filtered out as too old.
    // Distinguishes "data unavailable" (macroStale=false, vix=null) from
    // "data present but stale" (macroStale=true, vix=null) for ops debugging.
    macroStale: macro != null && (macro.ageDays != null && macro.ageDays > MACRO_MAX_AGE_DAYS),
    bearScore,
    bullScore,
    weakPenalty,
    universe: withFlag.length,
  };
}

/**
 * Apply the regime to scores, in place. Two effects:
 *
 *  1. Weak names (below 200DMA, or lagging the index by >10% over 3M) are
 *     docked by weakPenalty. Strong uptrending leaders are never docked.
 *  2. In risk_off only: the overextension dock is amplified by 50% — mean
 *     reversion accelerates under stress, so already-stretched names carry
 *     extra entry-timing risk precisely when the tape can't absorb it.
 *
 * Annotates regimePenalty + regimeOverextPenalty on every stock.
 * @returns {number} how many stocks were penalised (either effect)
 */
function applyRegime(stocks, info) {
  if (!Array.isArray(stocks)) return 0;
  const pen = info?.weakPenalty ?? 0;
  const riskOff = info?.regime === "risk_off";
  let n = 0;
  for (const s of stocks) {
    let hit = false;
    const weak = s.above200DMA === false || (s.rsVsNifty3M ?? 0) < -10;
    if (pen > 0 && weak && s.compositeScore != null) {
      s.regimePenalty = pen;
      s.compositeScore = Math.max(0, s.compositeScore - pen);
      hit = true;
    } else {
      s.regimePenalty = 0;
    }
    const overext = s.overextensionPenalty ?? 0;   // negative when stretched
    if (riskOff && overext < 0 && s.compositeScore != null) {
      const extra = Math.round(-overext * OVEREXT_AMP_RISK_OFF);
      s.regimeOverextPenalty = extra;
      s.compositeScore = Math.max(0, s.compositeScore - extra);
      hit = true;
    } else {
      s.regimeOverextPenalty = 0;
    }
    if (hit) n++;
  }
  return n;
}

module.exports = {
  computeRegime,
  applyRegime,
  _config: {
    BREADTH_BULL, BREADTH_BEAR, NIFTY_BEAR_3M,
    VIX_BULL, VIX_BEAR, VIX_PANIC, FII_BULL_5D, FII_BEAR_5D,
    MACRO_MAX_AGE_DAYS, PENALTY_RISK_OFF, PENALTY_NEUTRAL, OVEREXT_AMP_RISK_OFF,
  },
};
