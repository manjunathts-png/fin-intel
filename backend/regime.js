"use strict";

/**
 * Market-regime filter for stock picks.
 *
 * Momentum / breakout signals work in trending, risk-on tapes and bleed in
 * choppy or falling ones — breakouts fail, and stocks below their 200DMA keep
 * sliding. This module reads the regime from data already computed during the
 * scan (no extra fetch) and, when the tape is weak, penalises falling-knife
 * names so picks concentrate in the resilient leaders.
 *
 * Regime is read from two free, robust gauges:
 *   • Breadth   — % of the scanned universe trading above its own 200DMA
 *                 (already on every signal as `above200DMA`).
 *   • Nifty 3M  — index trend/momentum from the benchmark returns.
 *
 *   risk_on  : broad participation + index not falling  → let momentum run
 *   risk_off : narrow breadth OR index down hard         → penalise weak names
 *   neutral  : in between                                → small penalty
 */

const { round2 } = require("./utils");

const BREADTH_BULL = 0.55;   // ≥55% above 200DMA = healthy participation
const BREADTH_BEAR = 0.40;   // <40% above 200DMA = narrow / risk-off
const NIFTY_BEAR_3M = -5;    // index down >5% over 3M = risk-off
const PENALTY_RISK_OFF = 12; // points docked from weak names in a risk-off tape
const PENALTY_NEUTRAL  = 4;

/** Classify the regime from the scanned universe + benchmark. Pure — unit tested. */
function computeRegime({ stocks = [], niftyReturns = null } = {}) {
  const withFlag = stocks.filter((s) => typeof s.above200DMA === "boolean");
  const breadth = withFlag.length
    ? withFlag.filter((s) => s.above200DMA).length / withFlag.length
    : null;
  const niftyRet3m = niftyReturns?.ret3m ?? null;
  const niftyRet1m = niftyReturns?.ret1m ?? null;

  let regime = "neutral";
  if (breadth != null) {
    const bullish = breadth >= BREADTH_BULL && (niftyRet3m == null || niftyRet3m >= 0);
    const bearish = breadth < BREADTH_BEAR || (niftyRet3m != null && niftyRet3m <= NIFTY_BEAR_3M);
    if (bearish) regime = "risk_off";
    else if (bullish) regime = "risk_on";
  }

  const weakPenalty =
    regime === "risk_off" ? PENALTY_RISK_OFF :
    regime === "neutral"  ? PENALTY_NEUTRAL  : 0;

  return {
    regime,
    breadthPct: breadth != null ? round2(breadth * 100) : null,
    niftyRet3m,
    niftyRet1m,
    weakPenalty,
    universe: withFlag.length,
  };
}

/**
 * Dock weak names (below 200DMA, or lagging the index by >10% over 3M) by the
 * regime penalty, in place. Annotates regimePenalty on every stock for
 * transparency. Strong uptrending leaders are never penalised.
 * @returns {number} how many stocks were penalised
 */
function applyRegime(stocks, info) {
  if (!Array.isArray(stocks)) return 0;
  const pen = info?.weakPenalty ?? 0;
  let n = 0;
  for (const s of stocks) {
    const weak = s.above200DMA === false || (s.rsVsNifty3M ?? 0) < -10;
    if (pen > 0 && weak && s.compositeScore != null) {
      s.regimePenalty = pen;
      s.compositeScore = Math.max(0, s.compositeScore - pen);
      n++;
    } else {
      s.regimePenalty = 0;
    }
  }
  return n;
}

module.exports = {
  computeRegime,
  applyRegime,
  _config: { BREADTH_BULL, BREADTH_BEAR, NIFTY_BEAR_3M, PENALTY_RISK_OFF, PENALTY_NEUTRAL },
};
