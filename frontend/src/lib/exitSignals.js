// Exit / hold verdicts for user holdings, derived from the stock_picks blob.
//
// The scoring pipeline only ever recommends entries; this module closes the
// other half of the decision. All inputs come from data already published in
// radar_cache.stock_picks — no extra fetches.
//
// Verdict ladder (first match wins within each severity):
//   EXIT   — the system would not hold this today
//   TRIM   — keep the position but take partial profits / tighten stops
//   REVIEW — deteriorating or invisible to the system; look at it this week
//   HOLD   — still ranked; no action needed
//   ADD    — Core pick (7+ days in top 50) in a non-risk_off tape

const LTCG_DAYS = 365;

export function normalizeSymbol(sym) {
  return (sym ?? "").trim().toUpperCase().replace(/\.NS$/i, "");
}

/** Build symbol → pick lookup from the stock_picks blob (all = top 200). */
export function buildPickMap(data) {
  const map = new Map();
  for (const p of data?.all ?? []) {
    map.set(normalizeSymbol(p.symbol), p);
  }
  return map;
}

/**
 * Evaluate one holding against today's published picks.
 * @param holding {{symbol: string, buyPrice?: number, buyDate?: string}}
 * @param pickMap Map from buildPickMap
 * @param regime  data.regime from the stock_picks blob (may be null)
 * @returns {{verdict, severity, reasons: string[], pick, ltcg}}
 */
export function evaluateHolding(holding, pickMap, regime) {
  const sym = normalizeSymbol(holding.symbol);
  const pick = pickMap.get(sym) ?? null;
  const reasons = [];
  const riskOff = regime?.regime === "risk_off";

  // LTCG context (India: >12 months = long-term) — informational, not a verdict
  let ltcg = null;
  if (holding.buyDate) {
    const held = Math.floor((Date.now() - new Date(holding.buyDate).getTime()) / 86400000);
    if (held >= LTCG_DAYS) ltcg = { status: "long_term", heldDays: held };
    else ltcg = { status: "short_term", heldDays: held, daysToLtcg: LTCG_DAYS - held };
  }

  if (!pick) {
    return {
      verdict: "REVIEW",
      severity: 2,
      reasons: [
        "Not in today's top-200 radar — either it dropped out of the ranked universe or it isn't in the Nifty 500 scan.",
        "The system has no current signal on this name; re-underwrite the position on its own merits.",
      ],
      pick: null,
      ltcg,
    };
  }

  const weak = pick.above200DMA === false;
  const laggard = (pick.rsVsNifty3M ?? 0) < -10;
  const stretched = (pick.overextensionPenalty ?? 0) <= -10;

  // ── EXIT ────────────────────────────────────────────────────────────────
  if (riskOff && (weak || laggard)) {
    reasons.push("Regime is risk_off and this name is on the weak list " +
      (weak ? "(below its 200DMA)" : "(lagging Nifty by >10pp over 3M)") +
      " — exactly the cohort the system docks hardest in stress.");
    return { verdict: "EXIT", severity: 4, reasons, pick, ltcg };
  }
  if (pick.rank > 100) {
    reasons.push(`Ranked #${pick.rank} today — fell out of the top 100. Momentum thesis is no longer intact.`);
    if (weak) reasons.push("Also trading below its 200DMA.");
    return { verdict: "EXIT", severity: 4, reasons, pick, ltcg };
  }

  // ── TRIM ────────────────────────────────────────────────────────────────
  if (stretched) {
    reasons.push(`Overextension penalty is ${pick.overextensionPenalty} — overbought RSI / stretched vs 50DMA / recent spike. Historically this cohort mean-reverts over 1–3 months.`);
    if (riskOff) reasons.push("Risk_off regime amplifies the mean-reversion risk.");
    return { verdict: "TRIM", severity: 3, reasons, pick, ltcg };
  }

  // ── REVIEW ──────────────────────────────────────────────────────────────
  if (pick.rank > 50) {
    reasons.push(`Ranked #${pick.rank} — outside the published top 50 but still on the radar.`);
    if (weak) reasons.push("Below its 200DMA.");
    return { verdict: "REVIEW", severity: 2, reasons, pick, ltcg };
  }
  if (weak || laggard) {
    reasons.push(weak
      ? "In the top 50 but trading below its 200DMA — watch for a regime change."
      : "In the top 50 but lagging Nifty by >10pp over 3M.");
    return { verdict: "REVIEW", severity: 2, reasons, pick, ltcg };
  }

  // ── ADD / HOLD ──────────────────────────────────────────────────────────
  if ((pick.daysInTop50 ?? 0) >= 7 && !riskOff) {
    reasons.push(`Core pick — #${pick.rank}, ${pick.daysInTop50} consecutive days in the top 50 with ${pick.signalCount ?? 0} active signals.`);
    return { verdict: "ADD", severity: 0, reasons, pick, ltcg };
  }
  reasons.push(`Ranked #${pick.rank} in today's top 50${pick.daysInTop50 ? ` (${pick.daysInTop50}d)` : ""}.`);
  if (riskOff) reasons.push("Tape is risk_off — hold but don't add.");
  return { verdict: "HOLD", severity: 1, reasons, pick, ltcg };
}

export const VERDICT_META = {
  ADD:    { label: "Add",    cls: "bg-green-900/30 text-green-400 border-green-700/40" },
  HOLD:   { label: "Hold",   cls: "bg-blue-900/30 text-blue-400 border-blue-700/40" },
  REVIEW: { label: "Review", cls: "bg-yellow-900/30 text-yellow-400 border-yellow-700/40" },
  TRIM:   { label: "Trim",   cls: "bg-orange-900/30 text-orange-400 border-orange-700/40" },
  EXIT:   { label: "Exit",   cls: "bg-red-900/30 text-red-400 border-red-700/40" },
};
