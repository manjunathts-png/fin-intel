"use strict";

/**
 * Rule-based rationale generator for top stock picks.
 * Derives verdict + bull/bear cases from the technical signals.
 *
 * Called by refresh-cache.js after stock_signals leaderboard is built.
 */

// ─── Static sector themes ────────────────────────────────────────────────────

const SECTOR_THEMES = {
  "IT":
    "Indian IT is navigating a US discretionary spend recovery. AI services pipelines are filling, while INR weakness boosts export margins. Demand from BFSI clients in US/Europe is the swing factor.",
  "Banking - Private":
    "Private banks remain in a constructive credit cycle — loan growth at 12–15%, NPAs at decade lows, CASA stable. Margins compress when RBI cuts rates but volume growth offsets.",
  "Banking - PSU":
    "PSU banks re-rated sharply on improved asset quality and government recap support. Higher leverage to credit growth than private peers, with attractive dividend yields.",
  "Auto & EV":
    "Festive demand, lower commodity costs, and the EV transition are driving auto OEMs. Premiumisation (SUVs, electric 2W) is structurally accretive to margins.",
  "Pharma":
    "Pharma is benefitting from a cleared US FDA inspection cycle and stronger generics pricing. Domestic formulations growth at 10%+ provides earnings stability.",
  "FMCG":
    "FMCG is a defensive consumption play — rural recovery improves volume growth, while urban premiumisation aids margins. Commodity tailwinds support gross margins.",
  "Metals & Mining":
    "Metals are a cyclical bet — China stimulus, infrastructure capex, and EV-driven copper/aluminium demand are the macro drivers. Steel benefits from China property recovery.",
  "Energy & Oil":
    "Energy spans upstream (ONGC), downstream (BPCL/IOC), and utilities (NTPC, Power Grid, Tata Power). Renewables capex and grid modernisation drive multi-year visibility.",
  "Capital Goods & Defence":
    "India's capex cycle (infra + defence) is in a multi-year uptrend. Order books for L&T, ABB, Siemens at records; defence PSUs benefit from 50%+ indigenisation mandate.",
  "Finance - NBFC":
    "NBFCs are extending credit into under-served segments. Asset quality is stable, growth runway is long, but funding costs and regulatory tightening are key risks.",
  "Real Estate":
    "Indian real estate is in a multi-year recovery — inventory at decade-low, pre-sales at records, and consolidation favouring listed developers like DLF, Godrej, Oberoi.",
  "Telecom":
    "Telecom tariff hikes and 5G monetisation are driving Airtel's ARPU growth. Industry has consolidated to a 3-player market with pricing power.",
  "Consumption & Retail":
    "Indian consumption is bifurcated — premium segments (Trent, Titan, DMart) growing strongly; mass-market under pressure. K-shaped recovery favours listed organised retail.",
};

const DEFAULT_THEME = "This sector is benefiting from India's broader economic growth, government capex, and rising domestic consumption.";

// ─── Signal narratives ──────────────────────────────────────────────────────

function fmtVol(n) {
  if (n == null) return "—";
  if (n >= 1e7) return `${(n / 1e7).toFixed(1)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toString();
}

function fmtPct(v) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

// ─── Verdict logic ────────────────────────────────────────────────────────────

function verdict(sig) {
  const score = sig.compositeScore;
  if (score >= 60) return "Strong Buy";
  if (score >= 40) return "Buy";
  if (score >= 25) return "Watch";
  return "Avoid";
}

function confidence(sig) {
  const score = sig.compositeScore;
  const signalCount = sig.signalCount;
  // High when score is strong AND multiple independent signals fired
  if (score >= 55 && signalCount >= 4) return "High";
  if (score >= 35 && signalCount >= 2) return "Medium";
  return "Low";
}

function confidenceReason(sig, conf) {
  const sc = sig.compositeScore, n = sig.signalCount;
  if (conf === "High")
    return `Composite score ${sc}/100 backed by ${n} independent bullish signals — multi-factor confirmation.`;
  if (conf === "Medium")
    return `Composite score ${sc}/100 with ${n} signal${n === 1 ? "" : "s"} — directional but not multi-confirmed.`;
  return `Limited signal density (${n} fired, score ${sc}/100) — wait for stronger setup or use small position size.`;
}

// ─── Bull case builder ───────────────────────────────────────────────────────

function buildBullCase(sig) {
  const cases = [];

  if (sig.volumeShock.fired) {
    cases.push(
      `Volume shocker: today's volume of ${fmtVol(sig.volumeShock.volume)} is ${sig.volumeShock.ratio}× the 20-day average — strong conviction buying or accumulation`
    );
  }
  if (sig.near52wHigh.fired && sig.near52wHigh.distancePct >= -0.5) {
    cases.push(
      `At or above 52-week high (₹${sig.near52wHigh.high52w}) — momentum is breaking out, not consolidating`
    );
  } else if (sig.near52wHigh.fired) {
    cases.push(
      `Within ${Math.abs(sig.near52wHigh.distancePct).toFixed(1)}% of 52-week high — testing key resistance`
    );
  }
  if (sig.breakout20d.fired) {
    cases.push(
      `Breaking above 20-day high (₹${sig.breakout20d.bandHigh}) — short-term trend turning up`
    );
  }
  if (sig.goldenCross) {
    cases.push(
      "Golden Cross fired — 50-day moving average just crossed above 200-day, historically a bullish long-term signal"
    );
  }
  if (sig.macdBullish) {
    cases.push("MACD line crossed above signal line in last 3 sessions — momentum turning positive on the indicator");
  }
  if (sig.bullishEngulfing) {
    cases.push("Bullish Engulfing candle today — buyers overwhelmed yesterday's selling pressure, classic reversal pattern");
  }
  if (sig.hammer) {
    cases.push("Hammer candle today — sellers tried to push down but buyers stepped in, often a short-term bottom signal");
  }
  if (sig.gapUp.fired) {
    cases.push(`Gap up of ${fmtPct(sig.gapUp.gapPct)} at open — likely overnight news or institutional buying interest`);
  }
  if (sig.highDelivery) {
    cases.push(
      `High delivery percentage (${sig.deliveryPct}%) — buyers are taking actual delivery, not just intraday trading, signalling conviction`
    );
  }
  if (sig.rsiSignal === "oversold") {
    cases.push(`RSI at ${sig.rsi14} — technically oversold, mean-reversion bounce setup`);
  }
  if (sig.above20DMA && sig.above50DMA && sig.above200DMA) {
    cases.push("Trading above all three key moving averages (20/50/200 DMA) — uptrend intact across all timeframes");
  }
  return cases.slice(0, 4);
}

// ─── Bear case builder ───────────────────────────────────────────────────────

function buildBearCase(sig) {
  const cases = [];

  if (sig.rsiSignal === "overbought") {
    cases.push(`RSI at ${sig.rsi14} — technically overbought, near-term pullback risk elevated`);
  }
  if (sig.near52wHigh.fired) {
    cases.push("Near 52-week high — failure to break out cleanly often triggers profit-taking and a 3-7% pullback");
  }
  if (sig.gapUp.fired && sig.gapUp.gapPct > 4) {
    cases.push(`Large gap up (${fmtPct(sig.gapUp.gapPct)}) — unfilled gaps often act as magnets for price to return and fill`);
  }
  if (!sig.above200DMA) {
    cases.push("Trading below 200-day moving average — long-term trend is still down or uncertain, signal may be a counter-trend bounce");
  }
  if (sig.compositeScore < 40) {
    cases.push("Composite score is modest — wait for additional signals to align before sizing up");
  }
  if (cases.length === 0) {
    cases.push("Stock is in a strong technical setup — at this level the main risk is broader market correction dragging it down");
  }
  return cases.slice(0, 3);
}

// ─── Key signals chips (for compact display) ─────────────────────────────────

function buildSignalChips(sig) {
  const chips = [];
  if (sig.volumeShock.fired)   chips.push({ label: `🔊 ${sig.volumeShock.ratio}× Volume`, type: "volume" });
  if (sig.near52wHigh.fired)   chips.push({ label: "📈 52W High", type: "breakout" });
  if (sig.breakout20d.fired)   chips.push({ label: "↗ 20D Breakout", type: "breakout" });
  if (sig.breakout50d.fired)   chips.push({ label: "⇗ 50D Breakout", type: "breakout" });
  if (sig.goldenCross)         chips.push({ label: "✨ Golden Cross", type: "trend" });
  if (sig.macdBullish)         chips.push({ label: "📊 MACD Bull", type: "indicator" });
  if (sig.bullishEngulfing)    chips.push({ label: "🟢 Bull Engulf", type: "pattern" });
  if (sig.hammer)              chips.push({ label: "🔨 Hammer", type: "pattern" });
  if (sig.gapUp.fired)         chips.push({ label: `↑ Gap ${sig.gapUp.gapPct}%`, type: "gap" });
  if (sig.rsiSignal === "oversold")   chips.push({ label: `RSI ${sig.rsi14}`, type: "rsi-oversold" });
  if (sig.rsiSignal === "overbought") chips.push({ label: `RSI ${sig.rsi14}`, type: "rsi-overbought" });
  if (sig.highDelivery)        chips.push({ label: `📦 ${sig.deliveryPct}% Deliv`, type: "delivery" });
  return chips;
}

// ─── Main builder ────────────────────────────────────────────────────────────

function buildRationale(sig, nextPick) {
  const v    = verdict(sig);
  const conf = confidence(sig);
  const cReason = confidenceReason(sig, conf);

  let vsNext;
  if (nextPick) {
    const scoreDiff = sig.compositeScore - nextPick.compositeScore;
    vsNext = `${sig.label} leads ${nextPick.label} (${nextPick.sector}) by ${scoreDiff} composite points. ` +
      (sig.sector !== nextPick.sector
        ? `Different sectors — owning both gives some diversification.`
        : `Same sector — choose based on liquidity and your preferred fundamental quality.`);
  } else {
    vsNext = "Last pick in current radar — no direct comparison.";
  }

  return {
    macro_theme:       SECTOR_THEMES[sig.sector] ?? DEFAULT_THEME,
    bull_case:         buildBullCase(sig),
    bear_case:         buildBearCase(sig),
    vs_next_pick:      vsNext,
    verdict:           v,
    confidence:        conf,
    confidence_reason: cReason,
    signal_chips:      buildSignalChips(sig),
    source:            "rule_based",
  };
}

function generateStockRationales(picks, n = 10) {
  const top = picks.slice(0, n);
  return top.map((sig, i) => ({
    symbol:     sig.symbol,
    stock_name: sig.label,
    sector:     sig.sector,
    rank:       i + 1,
    composite_score: sig.compositeScore,
    analysis:   buildRationale(sig, top[i + 1] ?? null),
  }));
}

module.exports = { generateStockRationales };
