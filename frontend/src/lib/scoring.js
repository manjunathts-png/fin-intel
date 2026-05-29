/**
 * Unified Fund / ETF Scoring Engine — frontend.
 *
 * Pure JS, no I/O. Mirrors the structure used in MfPicks.jsx's inline
 * computeRawScore + the kite-portfolio scoring.js. Adapted for instruments
 * where cagr5y and sharpe aren't always available (ETFs).
 *
 * scoreInstrument(stats, typeZ, { liquidityFlag, ter, premiumPct })
 *   → { rawScore, compositeScore, verdict, confidence, recommendable }
 *
 *   stats     — { ret1w, ret1m, ret3m, ret6m, ret1y, z1w, cagr5y?, sharpe? }
 *   typeZ     — peer-group z1w (category for MFs, type for ETFs)
 *   options   — instrument-specific gates:
 *                 liquidityFlag — "ok" | "small" | "thin" | "tiny" | "unknown"
 *                 ter           — total expense ratio %
 *                 premiumPct    — ETF premium/discount to NAV %
 */

// ─── Tunables ────────────────────────────────────────────────────────────────

// 5-window weighting (renormalised from fin-intel's MF formula when cagr5y/sharpe missing)
const WINDOW_WEIGHTS_BASIC = {
  ret1w: 0.30, ret1m: 0.25, ret3m: 0.20, ret6m: 0.15, ret1y: 0.10,
};

// 7-window weighting (matches MfPicks.jsx exactly — used when extras are present)
const WINDOW_WEIGHTS_FULL = {
  ret1w: 0.25, ret1m: 0.20, ret3m: 0.15, ret6m: 0.10, ret1y: 0.10,
  cagr5y: 0.05, sharpe: 0.05,
};

const VERDICT_SCORE_BASE = {
  "Strong Buy": 10, "Buy": 6, "Hold": 2, "Watch": -3, "Avoid": -8,
};

const CONFIDENCE_MULT = { "High": 1.00, "Medium": 0.75, "Low": 0.50 };
const BLEND_RAW = 0.65;
const BLEND_VERDICT = 0.35;

// ─── Conviction multiplier (same as fin-intel + kite-portfolio) ──────────────

export function convictionMult(z) {
  if (z == null)  return 0.82;
  if (z >=  1.50) return 1.00;
  if (z >=  0.50) return 0.92;
  if (z >= -0.50) return 0.82;
  if (z >= -1.50) return 0.68;
  return                0.55;
}

// ─── Raw multi-window score ──────────────────────────────────────────────────

export function computeRawScore(stats, typeZ) {
  if (!stats) return 0;
  const hasFull = stats.cagr5y != null || stats.sharpe != null;
  const weights = hasFull ? WINDOW_WEIGHTS_FULL : WINDOW_WEIGHTS_BASIC;
  let score = 0;
  for (const [k, w] of Object.entries(weights)) {
    if (k === "sharpe") {
      const s = Math.min(Math.max(stats.sharpe ?? 0, 0), 2) * 5;
      score += s * w;
    } else {
      score += (stats[k] ?? 0) * w;
    }
  }
  return score * convictionMult(typeZ);
}

// ─── Verdict derivation ──────────────────────────────────────────────────────

export function deriveVerdict(rawScore, stats, typeZ) {
  const z1w = stats?.z1w;
  if (z1w != null && z1w <= -1)      return { verdict: "Avoid", confidence: "High" };
  if (z1w != null && z1w <= -0.5)    return { verdict: "Watch", confidence: "Medium" };
  if (typeZ != null && typeZ <= -0.5) return { verdict: "Watch", confidence: "Medium" };

  const windows = ["ret1w", "ret1m", "ret3m", "ret6m", "ret1y"];
  const present = windows.map((w) => stats?.[w]).filter((v) => v != null);
  const positive = present.filter((v) => v > 0).length;
  const total = present.length;
  const agreement = total > 0 ? positive / total : 0;

  let confidence = "Low";
  if (total >= 4 && agreement >= 0.8 && typeZ != null && typeZ >= 0.5) confidence = "High";
  else if (total >= 3 && agreement >= 0.6) confidence = "Medium";

  let verdict;
  if (rawScore >= 5 && z1w != null && z1w >= 0.5 && typeZ != null && typeZ >= 0.5) verdict = "Strong Buy";
  else if (rawScore >= 2 && (z1w == null || z1w >= 0)) verdict = "Buy";
  else if (rawScore <= -2) verdict = "Watch";
  else verdict = "Hold";

  return { verdict, confidence };
}

// ─── ETF-specific adjustments ────────────────────────────────────────────────

const LIQUIDITY_PENALTY = { ok: 0, small: -1, thin: -3, tiny: -5, unknown: -0.5 };

export function etfAdjustments({ liquidityFlag, ter, premiumPct }) {
  let adj = 0;
  if (liquidityFlag) adj += LIQUIDITY_PENALTY[liquidityFlag] ?? 0;
  // Premium/discount penalty: anything > 0.5% absolute is a tax on entry
  if (premiumPct != null) {
    const abs = Math.abs(premiumPct);
    if (abs > 1.0)      adj -= 3;
    else if (abs > 0.5) adj -= 1;
  }
  // TER penalty (vs ETF baseline 0.5%): higher TER = lower score
  if (ter != null) {
    if (ter > 1.0)      adj -= 1.5;
    else if (ter > 0.7) adj -= 0.5;
    else if (ter < 0.2) adj += 0.5; // bonus for ultra-cheap
  }
  return adj;
}

// ─── Blended composite score ─────────────────────────────────────────────────

function verdictScore(verdict, confidence) {
  const base = VERDICT_SCORE_BASE[verdict] ?? 0;
  const mult = CONFIDENCE_MULT[confidence] ?? 0.75;
  return base * mult;
}

export function blendScore(rawScore, verdict, confidence) {
  return rawScore * BLEND_RAW + verdictScore(verdict, confidence) * BLEND_VERDICT;
}

// ─── Recommendation gate ─────────────────────────────────────────────────────

export function isRecommendable({ verdict, confidence }, typeZ) {
  if (verdict === "Avoid") return false;
  if (verdict === "Watch") return false;
  if (verdict === "Buy" && confidence === "Low") return false;
  if (typeZ != null && typeZ <= -0.5) return false;
  return true;
}

// ─── Single-call envelope ────────────────────────────────────────────────────

export function scoreInstrument(stats, typeZ, etfOpts = {}) {
  const rawScore = computeRawScore(stats, typeZ);
  const { verdict, confidence } = deriveVerdict(rawScore, stats, typeZ);
  const blendedScore = blendScore(rawScore, verdict, confidence);
  const adj = etfOpts && Object.keys(etfOpts).length > 0 ? etfAdjustments(etfOpts) : 0;
  const compositeScore = blendedScore + adj;
  return {
    rawScore: Number(rawScore.toFixed(2)),
    compositeScore: Number(compositeScore.toFixed(2)),
    verdict,
    confidence,
    adjustment: Number(adj.toFixed(2)),
    recommendable: isRecommendable({ verdict, confidence }, typeZ),
  };
}

// ─── UI helpers ──────────────────────────────────────────────────────────────

export function verdictChipClass(verdict) {
  switch (verdict) {
    case "Strong Buy": return "bg-emerald-600 text-white border-emerald-500/40";
    case "Buy":        return "bg-green-600/90 text-white border-green-500/40";
    case "Hold":       return "bg-gray-600/80 text-gray-100 border-gray-500/40";
    case "Watch":      return "bg-yellow-600/80 text-white border-yellow-500/40";
    case "Avoid":      return "bg-red-600/80 text-white border-red-500/40";
    default:           return "bg-gray-700 text-gray-300 border-gray-600/40";
  }
}

export function scoreGradient(score) {
  if (score >= 8)  return "from-emerald-500 to-green-500";
  if (score >= 4)  return "from-green-600 to-emerald-500";
  if (score >= 0)  return "from-yellow-600 to-amber-500";
  if (score >= -3) return "from-orange-600 to-orange-500";
  return                  "from-red-700 to-red-600";
}
