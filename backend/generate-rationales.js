"use strict";
/**
 * Rule-based rationale generator for top 10 MF picks.
 * No external API needed — derives verdict, bull/bear cases, and comparison
 * purely from momentum data + a static macro theme lookup per category.
 *
 * Called automatically by refresh-cache.js after mf_radar is built.
 * Can be overridden any day by running seed-rationales.js (AI-generated).
 */

// ─── Static macro themes per category ────────────────────────────────────────
// Update these when the macro story changes (quarterly or on major events).

const MACRO_THEMES = {
  "Defence":
    "India's defence sector is in a structural upcycle driven by the government's indigenisation mandate (50%+ target), record defence budgets growing at 8–10% CAGR, and geopolitical pressure to accelerate domestic procurement across HAL, BEL, Bharat Dynamics, and Cochin Shipyard.",
  "Micro Cap":
    "Microcap is recovering from a sharp H2 FY25 correction. Rural consumption revival, record GST collections, and steady SIP inflows are driving a broad-based bounce across domestic-focused small businesses.",
  "Small Cap":
    "Small caps are benefiting from India's domestic growth story — GST formalisation, credit availability for MSMEs, and strong SIP flows creating consistent demand. Recovery from FY25 correction is broadening across sectors.",
  "Pharma & Healthcare":
    "India's pharma sector is benefiting from a recovering US FDA approval pipeline, strong generic export volumes, and accelerating domestic formulations growth driven by insurance penetration and hospital expansion.",
  "Infrastructure":
    "India's ₹111 lakh crore National Infrastructure Pipeline and government capex of ₹11+ lakh crore annually is translating into multi-year order flows for power, roads, railways, and industrial construction.",
  "Manufacturing":
    "PLI schemes across 14 sectors are pulling large-scale manufacturing capex into India. China+1 diversification — led by electronics, semiconductors, and auto components — is creating structural demand for India-made goods.",
  "Mid Cap":
    "Mid caps are supported by the strongest SIP flows in Indian equity history and solid corporate earnings growth. They offer a balance between the stability of large caps and the upside potential of small caps.",
  "ELSS":
    "ELSS funds offer the dual benefit of equity market exposure and Section 80C tax deductions up to ₹1.5 lakh. The 3-year lock-in aligns well with equity investment horizons.",
  "Energy":
    "India's energy transition is creating multi-year capex in renewables, grid modernisation, and green hydrogen. Domestic oil & gas upstream is also recovering as ONGC and Reliance expand production capacity.",
  "PSU":
    "PSU stocks re-rated significantly in FY24 on disinvestment optimism and strong government capex. Dividend yields and sovereign backing provide downside cushion, though the pace of reform has moderated.",
  "Large Cap":
    "Large caps provide stability and liquidity in volatile markets. Nifty 50 constituents are seeing earnings growth supported by domestic consumption, IT services exports, and financial sector credit expansion.",
  "Flexi Cap":
    "Flexi cap funds dynamically allocate across market caps, giving fund managers flexibility to rotate into wherever momentum and value intersect — currently favouring mid and small cap recovery plays.",
  "Technology":
    "Indian IT sector is navigating a demand recovery in the US after post-COVID discretionary spending cuts. AI adoption is creating incremental revenue streams while cost efficiencies are protecting margins.",
  "Banking & Finance":
    "Indian banks are in a healthy credit cycle with NPAs at decade-lows, strong CASA ratios, and loan growth of 12–15%. NBFCs are expanding into under-served segments with improving asset quality.",
};

const DEFAULT_MACRO = "This category is benefiting from India's broad economic growth, strong domestic consumption, and continued government focus on infrastructure and manufacturing.";

// ─── Category-specific risk factors ──────────────────────────────────────────

const CATEGORY_RISKS = {
  "Defence":            "Concentrated sector with only ~15 liquid stocks; valuations stretched at 40–60x PE for several PSUs",
  "Micro Cap":          "Liquidity risk — microcaps can fall 30–50% quickly in risk-off environments; 6M return shows how fast the category can reverse",
  "Small Cap":          "High beta — small caps underperform sharply when FII selling or credit tightening resumes",
  "Pharma & Healthcare":"US FDA import alerts on Indian facilities remain a tail risk; domestic hospital valuations are elevated",
  "Infrastructure":     "Execution delays are endemic in Indian infra; project slippage regularly disappoints quarterly earnings",
  "Manufacturing":      "Theme is well-owned — limited fresh catalyst needed; INR appreciation hurts export-linked manufacturers",
  "Mid Cap":            "Valuations historically stretched; this segment is most sensitive to earnings disappointments",
  "ELSS":               "3-year lock-in reduces flexibility; category median performance has been weak recently",
  "Energy":             "Global crude price volatility creates sharp NAV swings; renewable transition timelines can slip",
  "PSU":                "Disinvestment pipeline has slowed; government prefers stake dilution over strategic sales",
  "Large Cap":          "Limited alpha potential vs passive index funds; upside is capped relative to smaller cap categories",
  "Flexi Cap":          "Performance is highly fund-manager-dependent; allocation shifts can introduce unintended sector concentration",
  "Technology":         "INR appreciation erodes export revenue; any US macro slowdown directly impacts IT deal signings",
  "Banking & Finance":  "RBI rate cycles and regulatory tightening can compress margins; credit quality can deteriorate quickly in a slowdown",
};

const DEFAULT_RISK = "Sectoral concentration risk — any policy change or macro shift specific to this theme can cause sharp drawdowns";

// ─── Scoring helpers ──────────────────────────────────────────────────────────

function momentumScore(f, catZ) {
  return (f.ret1w ?? 0) * 0.4
       + (f.ret1m ?? 0) * 0.3
       + (f.ret3m ?? 0) * 0.2
       + (catZ    ?? 0) * 5  * 0.1;
}

function verdict(score, z) {
  if (score >= 9  && z >= 0.8) return "Strong Buy";
  if (score >= 6  || z >= 1.0) return "Buy";
  if (score >= 4  || z >= 0.3) return "Hold";
  return "Avoid";
}

function confidence(score, z, fund) {
  // Check consistency across timeframes
  const returns = [fund.ret1w, fund.ret1m, fund.ret3m, fund.ret6m, fund.ret1y].filter((v) => v != null);
  const allPositive = returns.every((v) => v > 0);
  if (z >= 1.5 && allPositive && score >= 8) return "High";
  if (z >= 0.5 && score >= 5)               return "Medium";
  return "Low";
}

function confidenceReason(conf, score, z, fund) {
  if (conf === "High")
    return `Strong z-score (${z.toFixed(2)}) with consistent positive returns across all timeframes and momentum score of ${score.toFixed(1)}.`;
  if (conf === "Medium")
    return `Moderate momentum (z=${z.toFixed(2)}, score=${score.toFixed(1)}) — setup is positive but not uniformly strong across all windows.`;
  return `Weak z-score (${z.toFixed(2)}) and momentum score (${score.toFixed(1)}) signal limited near-term conviction.`;
}

function fmtPct(v) {
  if (v == null) return "N/A";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

// ─── Bull case builder ────────────────────────────────────────────────────────

function buildBullCase(fund, catMedian) {
  const cases = [];

  // 1. Short-term momentum vs category
  if ((fund.ret1w ?? 0) > 0) {
    const vsMedian = (fund.ret1w ?? 0) - (catMedian.ret1w ?? 0);
    if (vsMedian > 0.3) {
      cases.push(`Leading its category this week — 1W return of ${fmtPct(fund.ret1w)} vs category median ${fmtPct(catMedian.ret1w)} (+${vsMedian.toFixed(2)}pp ahead)`);
    } else {
      cases.push(`Positive 1W momentum (${fmtPct(fund.ret1w)}) in line with a broadly rising category`);
    }
  }

  // 2. Monthly strength
  if ((fund.ret1m ?? 0) >= 8) {
    cases.push(`Strong 1-month return of ${fmtPct(fund.ret1m)} — broad-based buying, not just a single-week spike`);
  } else if ((fund.ret1m ?? 0) > 0) {
    cases.push(`Positive 1-month return (${fmtPct(fund.ret1m)}) confirms the short-term trend has some duration`);
  }

  // 3. Multi-timeframe consistency
  const positiveWindows = ["ret3m", "ret6m", "ret1y"].filter((k) => (fund[k] ?? 0) > 0).length;
  if (positiveWindows === 3) {
    cases.push(`Returns are positive across all timeframes (3M: ${fmtPct(fund.ret3m)}, 6M: ${fmtPct(fund.ret6m)}, 1Y: ${fmtPct(fund.ret1y)}) — sustained trend, not just a recent bounce`);
  } else if (fund.ret1y != null && fund.ret1y > 15) {
    cases.push(`Strong 1-year return of ${fmtPct(fund.ret1y)} validates the longer-term thesis even amid short-term volatility`);
  }

  // Ensure at least 3 points
  if (cases.length < 3) {
    cases.push(`Category z-score of ${fund.catZ?.toFixed(2) ?? "N/A"} indicates this week's momentum is statistically above the trailing 90-day average`);
  }

  return cases.slice(0, 3);
}

// ─── Bear case builder ────────────────────────────────────────────────────────

function buildBearCase(fund, catMedian) {
  const cases = [];

  // 1. Any negative return window
  if ((fund.ret6m ?? 0) < 2) {
    cases.push(`6-month return of ${fmtPct(fund.ret6m)} is weak — the recent rally may be recovering lost ground rather than breaking into new highs`);
  } else if ((fund.ret3m ?? 0) < (fund.ret1m ?? 0) * 0.5) {
    cases.push(`3-month return (${fmtPct(fund.ret3m)}) is low relative to 1-month gain — momentum may have started late in the window`);
  }

  // 2. Category-specific risk
  cases.push(CATEGORY_RISKS[fund.category] ?? DEFAULT_RISK);

  return cases.slice(0, 2);
}

// ─── vs Next Pick builder ─────────────────────────────────────────────────────

function buildVsNextPick(pick, nextPick) {
  if (!nextPick) return "This is the last pick in the current radar — no direct next alternative to compare against.";

  const scoreDiff = (pick.score - nextPick.score).toFixed(1);
  const zDiff     = ((pick.catZ ?? 0) - (nextPick.catZ ?? 0)).toFixed(2);
  const ret1wDiff = ((pick.ret1w ?? 0) - (nextPick.ret1w ?? 0)).toFixed(2);

  let comparison = `${pick.label} leads ${nextPick.label} (${nextPick.category}) by ${scoreDiff} momentum score points. `;

  if (Math.abs(pick.catZ - nextPick.catZ) > 0.3) {
    if (pick.catZ > nextPick.catZ) {
      comparison += `Its category z-score (${pick.catZ?.toFixed(2)}) is stronger than ${nextPick.label}'s (${nextPick.catZ?.toFixed(2)}), indicating broader institutional momentum. `;
    } else {
      comparison += `Note: ${nextPick.label} has a stronger category z-score (${nextPick.catZ?.toFixed(2)} vs ${pick.catZ?.toFixed(2)}) — if z-score is your primary signal, the next pick competes closely. `;
    }
  }

  if (pick.category !== nextPick.category) {
    comparison += `These are different sector bets (${pick.category} vs ${nextPick.category}) so position sizing both as diversification is valid.`;
  } else {
    comparison += `Both are in the same category — choose based on fund manager track record and expense ratio.`;
  }

  return comparison;
}

// ─── Main builder ─────────────────────────────────────────────────────────────

function buildRationale(pick, nextPick, rank) {
  const z     = pick.catZ ?? 0;
  const sc    = pick.score;
  const v     = verdict(sc, z);
  const conf  = confidence(sc, z, pick);

  return {
    macro_theme:       MACRO_THEMES[pick.category] ?? DEFAULT_MACRO,
    bull_case:         buildBullCase(pick, pick.catMedian ?? {}),
    bear_case:         buildBearCase(pick, pick.catMedian ?? {}),
    vs_next_pick:      buildVsNextPick(pick, nextPick),
    verdict:           v,
    confidence:        conf,
    confidence_reason: confidenceReason(conf, sc, z, pick),
    source:            "rule_based",
  };
}

// ─── Exported function ────────────────────────────────────────────────────────

function generateRationales(mfData, n = 10) {
  function score(f, catZ) { return momentumScore(f, catZ); }

  const picks = mfData.categories
    .map((cat) => {
      const catZ = cat.median.z1w ?? 0;
      const top  = [...cat.funds]
        .map((f) => ({ ...f, score: score(f, catZ), catZ, category: cat.category, catMedian: cat.median }))
        .sort((a, b) => b.score - a.score)[0];
      return top ?? null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);

  return picks.map((pick, i) => ({
    fund_code: pick.code,
    fund_name: pick.name ?? pick.label,
    category:  pick.category,
    rank:      i + 1,
    score:     pick.score,
    analysis:  buildRationale(pick, picks[i + 1] ?? null, i + 1),
  }));
}

module.exports = { generateRationales };
