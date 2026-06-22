import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import PageFooter from "../components/PageFooter";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtInr(n) {
  if (n == null || isNaN(n)) return "—";
  if (n >= 10_000_000) return `₹${(n / 10_000_000).toFixed(2)} Cr`;
  if (n >= 100_000)    return `₹${(n / 100_000).toFixed(1)}L`;
  if (n >= 1_000)      return `₹${(n / 1_000).toFixed(0)}K`;
  return `₹${Math.round(n)}`;
}
function fmtPct(v) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}
function pctCls(v) {
  return (v ?? 0) >= 0 ? "text-green-400" : "text-red-400";
}
function scoreCls(s) {
  if (s >= 70) return "bg-green-900/60 text-green-300 border border-green-700/50";
  if (s >= 45) return "bg-amber-900/60 text-amber-300 border border-amber-700/50";
  return "bg-red-900/60 text-red-300 border border-red-700/50";
}
function scoreEmoji(s) {
  return s >= 70 ? "🔥" : s >= 45 ? "📈" : "📉";
}
// ─── MF scoring — identical to MfPicks.jsx ───────────────────────────────────
// conviction multiplier: z-score gates the overall score holistically
function convictionMult(z) {
  if (z >= 1.5)  return 1.00;
  if (z >= 0.5)  return 0.92;
  if (z >= -0.5) return 0.82;
  if (z >= -1.5) return 0.68;
  return 0.55;
}
function computeRawScore(fund, catZ) {
  const base =
    (fund.ret1w  ?? 0) * 0.25 +
    (fund.ret1m  ?? 0) * 0.20 +
    (fund.ret3m  ?? 0) * 0.15 +
    (fund.ret6m  ?? 0) * 0.10 +
    (fund.ret1y  ?? 0) * 0.10 +
    (fund.cagr5y ?? 0) * 0.05 +
    Math.min(Math.max(fund.sharpe ?? 0, 0), 2) * 5 * 0.05;
  return base * convictionMult(catZ ?? 0);
}
// verdict contribution — same 65/35 blend as MfPicks
function verdictScore(verdict, confidence) {
  const base = { "Strong Buy": 100, "Buy": 80, "Hold": 50, "Avoid": 15 }[verdict] ?? 50;
  const mult = { "High": 1.00, "Medium": 0.875, "Low": 0.70 }[confidence] ?? 0.875;
  return Math.round(base * mult);
}
function resolveVerdict(code, ruleMap, aiMap) {
  const src = ruleMap?.[code] ?? aiMap?.[code] ?? null;
  return {
    verdict:    src?.analysis?.verdict    ?? null,
    confidence: src?.analysis?.confidence ?? null,
  };
}

// ─── Auto-generate "why" text from live signal data ───────────────────────

function genMfWhy(fund) {
  const parts = [];
  const z = fund.z1w ?? fund.catZ ?? 0;
  if (z >= 1.5) parts.push(`Exceptional 1W momentum (z-score ${z.toFixed(1)})`);
  else if (z >= 0.5) parts.push(`Above-average 1W momentum (z-score ${z.toFixed(1)})`);
  else if (z >= -0.5) parts.push(`Neutral short-term momentum (z-score ${z.toFixed(1)})`);

  if ((fund.ret1y ?? 0) >= 30) parts.push(`${fund.ret1y.toFixed(1)}% 1Y return — strong outperformance`);
  else if ((fund.ret1y ?? 0) >= 15) parts.push(`${fund.ret1y.toFixed(1)}% 1Y return`);

  if ((fund.cagr5y ?? 0) >= 20) parts.push(`${fund.cagr5y.toFixed(1)}% 5Y CAGR — proven long-term compounder`);
  else if ((fund.cagr5y ?? 0) >= 12) parts.push(`${fund.cagr5y.toFixed(1)}% 5Y CAGR`);

  if ((fund.sharpe ?? 0) >= 1.0) parts.push(`Sharpe ${fund.sharpe.toFixed(2)} — excellent risk-adjusted returns`);

  if ((fund.catZ ?? 0) >= 1.0)
    parts.push(`Category ${fund.category} is hot (category z ${fund.catZ.toFixed(1)}) — conviction boost applied`);

  if (parts.length === 0) parts.push(`Consistent performer in the ${fund.category} category`);
  return parts.join(". ") + ".";
}

function genStockWhy(stock) {
  const sigs = [];
  if (stock.goldenCross) sigs.push("Golden cross — 50 DMA crossed above 200 DMA");
  if (stock.macdBullish) sigs.push("MACD bullish crossover");
  if (stock.above200DMA && stock.above50DMA && stock.above20DMA) sigs.push("Above all major moving averages (20/50/200 DMA)");
  else if (stock.above200DMA && stock.above50DMA) sigs.push("Above 50 and 200 DMA — strong structural trend");
  if (stock.volumeShock?.fired) sigs.push(`Volume surge ${stock.volumeShock.ratio?.toFixed(1)}× 20-day average — institutional activity`);
  if (stock.near52wHigh?.fired) sigs.push(`Trading near 52-week high (${((100 - (stock.near52wHigh.distancePct ?? 0))).toFixed(1)}% from peak)`);
  if (stock.breakout20d?.fired) sigs.push("20-day price breakout confirmed");
  if (stock.breakout50d?.fired) sigs.push("50-day price breakout confirmed");
  if (stock.gapUp?.fired) sigs.push(`Gap-up opening (${stock.gapUp.gapPct?.toFixed(1)}%)`);
  if (stock.rsiSignal === "oversold") sigs.push("RSI in oversold zone — potential mean reversion bounce");
  const f = stock.fundamentals;
  if ((f?.earningsGrowth ?? 0) >= 20) sigs.push(`${f.earningsGrowth.toFixed(0)}% earnings growth`);
  if ((f?.returnOnEquity ?? 0) >= 20) sigs.push(`High RoE ${f.returnOnEquity.toFixed(0)}%`);
  if (sigs.length === 0) sigs.push("Strong composite momentum across multiple signals");
  return sigs.join(". ") + `. Composite score: ${stock.compositeScore}/100.`;
}

// ─── Shared investment horizon options ───────────────────────────────────────

const HORIZONS = [
  { label: "1 Year",   years: 1  },
  { label: "3 Years",  years: 3  },
  { label: "5 Years",  years: 5  },
  { label: "10 Years", years: 10 },
];

// Compound growth helper
function compoundGrowth(corpus, annualRate, years) {
  return corpus * Math.pow(1 + annualRate, years);
}

// ─── Persona configuration ────────────────────────────────────────────────────

const PERSONAS = [
  {
    id: "aggressive",
    name: "Aggressive Trader",
    icon: "🚀",
    tagline: "Momentum & small caps",
    riskLabel: "Very High",
    riskBadgeCls: "bg-red-900 text-red-300",
    riskPct: 95,
    riskGrad: "linear-gradient(90deg,#fbbf24,#ef4444)",
    riskColor: "#ef4444",
    approach: "Momentum + Breakouts",
    expectedReturn: "18–30% p.a.",
    annualReturnLo: 0.18,
    annualReturnHi: 0.30,
    volatility: "Very High (σ > 30%)",
    drawdown: "Can tolerate –40% or more",
    liquidity: "High — active rebalancing",
    tax: "STCG heavy (< 1 yr)",
    // mfCategory on a slot → picks the best fund in that radar category at that exact %
    alloc: [
      { l: "Small Cap MF",      pct: 35, hex: "#ef4444", mfCategory: "Small Cap" },
      { l: "Mid Cap MF",        pct: 25, hex: "#f97316", mfCategory: "Mid Cap"   },
      { l: "Large Cap Stocks",  pct: 20, hex: "#fbbf24" }, // served by stock picks
      { l: "Gold MF",           pct:  5, hex: "#eab308", mfCategory: "Gold"      },
      { l: "Debt / Liquid",     pct:  5, hex: "#818cf8" },
      { l: "Cash Buffer",       pct: 10, hex: "#4b5563" },
    ],
    outcome: {
      maxDD: "–40%", sharpe: "0.6–0.9",
      note: "High upside, very high variance. A 40% drawdown is plausible in a bear market — position sizing and stop-losses are critical.",
    },
    stockCount: 4,
    stockAllocs: [0.10, 0.075, 0.075, 0.05],
    stockMinScore: 60,
    stockSectors: null,
  },
  {
    id: "growth",
    name: "Growth Investor",
    icon: "📈",
    tagline: "Quality mid & flexi cap",
    riskLabel: "High",
    riskBadgeCls: "bg-amber-900 text-amber-300",
    riskPct: 72,
    riskGrad: "linear-gradient(90deg,#34d399,#f59e0b)",
    riskColor: "#f59e0b",
    approach: "Quality Growth + Flexi Cap",
    expectedReturn: "14–20% p.a.",
    annualReturnLo: 0.14,
    annualReturnHi: 0.20,
    volatility: "High (σ 20–30%)",
    drawdown: "Comfortable with –25% to –35%",
    liquidity: "Medium — quarterly review",
    tax: "LTCG optimised (> 1 yr)",
    alloc: [
      { l: "Flexi / Multi Cap MF", pct: 35, hex: "#f59e0b", mfCategory: "Flexi Cap"  },
      { l: "Mid Cap MF",           pct: 25, hex: "#ef4444", mfCategory: "Mid Cap"    },
      { l: "Large Cap MF",         pct: 20, hex: "#f97316", mfCategory: "Large Cap"  },
      { l: "International MF",     pct: 10, hex: "#06b6d4" }, // no radar coverage
      { l: "Debt / Liquid",        pct: 10, hex: "#818cf8" },
    ],
    outcome: {
      maxDD: "–30%", sharpe: "0.8–1.1",
      note: "Reasonable wealth creation over 5+ years with manageable drawdowns. Best for goals like home purchase or retirement corpus.",
    },
    stockCount: 4,
    stockAllocs: [0.15, 0.10, 0.10, 0.05],
    stockMinScore: 55,
    stockSectors: null,
  },
  {
    id: "balanced",
    name: "Balanced",
    icon: "⚖️",
    tagline: "Equity + debt hybrid",
    riskLabel: "Medium",
    riskBadgeCls: "bg-blue-900 text-blue-300",
    riskPct: 50,
    riskGrad: "linear-gradient(90deg,#34d399,#3b82f6,#a78bfa)",
    riskColor: "#3b82f6",
    approach: "Diversified Equity + Debt Hybrid",
    expectedReturn: "10–14% p.a.",
    annualReturnLo: 0.10,
    annualReturnHi: 0.14,
    volatility: "Moderate (σ 12–20%)",
    drawdown: "Can bear –15% to –20%",
    liquidity: "Medium — semi-annual review",
    tax: "Mix of STCG & LTCG",
    alloc: [
      { l: "Large Cap / Nifty Index", pct: 35, hex: "#3b82f6", mfCategory: "Large Cap" },
      { l: "Flexi Cap MF",            pct: 20, hex: "#f59e0b", mfCategory: "Flexi Cap" },
      { l: "Corporate Bond Fund",     pct: 20, hex: "#818cf8" },
      { l: "Gold ETF / SGBs",         pct: 15, hex: "#fbbf24", mfCategory: "Gold"      },
      { l: "Cash / Liquid",           pct: 10, hex: "#4b5563" },
    ],
    outcome: {
      maxDD: "–18%", sharpe: "0.9–1.3",
      note: "Steady compounder with capital protection. Suitable for 3–5 year goals — home down-payment, child education, or a growing emergency fund.",
    },
    stockCount: 3,
    stockAllocs: [0.15, 0.10, 0.075],
    stockMinScore: 50,
    stockSectors: null,
    preferLargeCap: true,
  },
  {
    id: "conservative",
    name: "Conservative",
    icon: "🛡️",
    tagline: "Capital safety first",
    riskLabel: "Low",
    riskBadgeCls: "bg-green-900 text-green-300",
    riskPct: 25,
    riskGrad: "linear-gradient(90deg,#22c55e,#34d399)",
    riskColor: "#22c55e",
    approach: "Capital Protection First",
    expectedReturn: "8–12% p.a.",
    annualReturnLo: 0.08,
    annualReturnHi: 0.12,
    volatility: "Low (σ < 12%)",
    drawdown: "Prefer < –10% drawdown",
    liquidity: "High — monthly monitoring",
    tax: "Debt LTCG + indexation",
    alloc: [
      { l: "Large Cap / Nifty 50", pct: 30, hex: "#22c55e", mfCategory: "Large Cap" },
      { l: "Short Duration Debt",  pct: 30, hex: "#818cf8" },
      { l: "Gold ETF / SGBs",      pct: 20, hex: "#fbbf24", mfCategory: "Gold"      },
      { l: "Arbitrage / Liquid",   pct: 15, hex: "#06b6d4" },
      { l: "Cash",                 pct:  5, hex: "#4b5563" },
    ],
    outcome: {
      maxDD: "–10%", sharpe: "1.0–1.4",
      note: "Capital preservation priority. Modest growth with minimal drawdowns. Best for near-term goals or investors who lose sleep over volatility.",
    },
    stockCount: 3,
    stockAllocs: [0.15, 0.10, 0.10],
    stockMinScore: 45,
    stockSectors: ["FMCG", "Power", "Utilities", "Pharma", "Banking"],
    preferLargeCap: true,
    preferDefensive: true,
  },
  {
    id: "dividend",
    name: "Dividend Seeker",
    icon: "💰",
    tagline: "Regular income focus",
    riskLabel: "Low–Medium",
    riskBadgeCls: "bg-purple-900 text-purple-300",
    riskPct: 38,
    riskGrad: "linear-gradient(90deg,#22c55e,#a78bfa)",
    riskColor: "#a78bfa",
    approach: "Yield + Steady Appreciation",
    expectedReturn: "10–15% p.a.",
    annualReturnLo: 0.10,
    annualReturnHi: 0.15,
    volatility: "Moderate (σ 12–18%)",
    drawdown: "Comfortable with –15%",
    liquidity: "Low — hold and collect",
    tax: "Dividend taxed at income slab",
    alloc: [
      { l: "Dividend Yield Stocks", pct: 40, hex: "#a78bfa" }, // served by stock picks
      { l: "Value / Dividend MF",   pct: 25, hex: "#818cf8", mfCategory: "Value"     },
      { l: "Large Cap MF",          pct: 10, hex: "#9ca3af", mfCategory: "Large Cap" },
      { l: "REITs / InvITs",        pct: 10, hex: "#f59e0b" },
      { l: "Short Duration Debt",   pct: 10, hex: "#06b6d4" },
      { l: "Cash",                  pct:  5, hex: "#4b5563" },
    ],
    outcome: {
      maxDD: "–15%", sharpe: "0.9–1.2",
      note: "Yield on corpus ≈ 3–5% per year = ₹30K–₹50K annual income on ₹10L invested, plus capital appreciation.",
    },
    stockCount: 4,
    stockAllocs: [0.15, 0.125, 0.10, 0.10],
    stockMinScore: 45,
    stockSectors: ["Power", "Mining", "FMCG", "Utilities", "Energy"],
    preferDefensive: true,
  },
];

// ─── Derive recommendations from live data ────────────────────────────────────

function buildMfPicks(persona, mfData, mfRuleMap = {}, mfAiMap = {}) {
  if (!mfData?.categories) return { picks: [], skipped: [] };

  // Build category → { catZ, funds[] } map
  const catMap = {};
  mfData.categories.forEach((cat) => {
    const catZ = cat.median?.z1w ?? 0;
    const scored = cat.funds
      .map((f) => ({ ...f, category: cat.category, catZ, rawScore: computeRawScore(f, catZ) }))
      .sort((a, b) => b.rawScore - a.rawScore);
    catMap[cat.category.toLowerCase()] = { catZ, funds: scored };
  });

  // One pick per alloc slot that has mfCategory — preserves allocation %
  const picks     = [];   // actionable recommendations
  const skipped   = [];   // slots skipped due to weak category momentum
  const usedCodes = new Set();

  persona.alloc.forEach((slot) => {
    if (!slot.mfCategory) return;
    const needle = slot.mfCategory.toLowerCase();
    const key = Object.keys(catMap).find(
      (k) => k.includes(needle) || needle.includes(k)
    );
    if (!key) return;

    const { catZ, funds } = catMap[key];

    // Gate 1: category-level — skip if Cool (z < −0.5) or Cold
    if (catZ < -0.5) {
      skipped.push({ ...slot, catZ, strength: catZ < -1.5 ? "Cold ❄️" : "Cool 📉" });
      return;
    }

    // Gate 2: individual fund — must have z1w >= −0.5 (not individually declining)
    //          not Avoid, not Low-confidence Buy
    // No unsafe fallback: if nothing clears all bars, the slot is skipped.
    const isRecommendable = (f) => {
      if (usedCodes.has(f.code)) return false;
      if ((f.z1w ?? 0) < -0.5) return false;          // fund's own momentum gate
      const { verdict, confidence } = resolveVerdict(f.code, mfRuleMap, mfAiMap);
      if (verdict === "Avoid") return false;
      if ((verdict === "Buy" || verdict === "Strong Buy") && confidence === "Low") return false;
      return true;
    };
    // Fallback only for funds with NO verdict yet (not yet analyzed), still z1w-gated
    const isUnanalyzed = (f) =>
      !usedCodes.has(f.code) &&
      (f.z1w ?? 0) >= -0.5 &&
      resolveVerdict(f.code, mfRuleMap, mfAiMap).verdict === null;

    const fund = funds.find(isRecommendable) ?? funds.find(isUnanalyzed);
    if (!fund) {
      // All funds in this category failed the momentum/verdict gates → skip slot
      skipped.push({ ...slot, catZ, strength: "Weak fund momentum 📉" });
      return;
    }
    usedCodes.add(fund.code);
    picks.push({ ...fund, allocPct: slot.pct, allocLabel: slot.l, allocHex: slot.hex });
  });

  // Normalise rawScore → displayScore 0–100 across picks
  if (picks.length > 0) {
    const rawScores = picks.map((f) => f.rawScore);
    const minS = Math.min(...rawScores);
    const maxS = Math.max(...rawScores);
    const range = maxS - minS || 1;
    picks.forEach((f, i) => {
      const displayScore = Math.round(((f.rawScore - minS) / range) * 100);
      const { verdict, confidence } = resolveVerdict(f.code, mfRuleMap, mfAiMap);
      const vPart = verdict ? verdictScore(verdict, confidence) : displayScore;
      picks[i] = {
        ...f,
        displayScore,
        verdict,
        confidence,
        score:      Math.round(displayScore * 0.65 + vPart * 0.35),
        allocation: f.allocPct / 100,
        why:        genMfWhy(f),
      };
    });
  }

  return { picks, skipped };
}

function buildStockPicks(persona, stockData, stRuleMap = {}, stAiMap = {}) {
  if (!stockData?.picks) return [];
  let candidates = [...(stockData.picks ?? [])];

  // Filter by sector if persona specifies
  if (persona.stockSectors) {
    const sectorFiltered = candidates.filter((s) =>
      persona.stockSectors.some((sec) =>
        (s.sector ?? "").toLowerCase().includes(sec.toLowerCase())
      )
    );
    if (sectorFiltered.length >= persona.stockCount) candidates = sectorFiltered;
  }

  // Prefer large cap for balanced/conservative
  if (persona.preferLargeCap) {
    const largeCap = candidates.filter(
      (s) => (s.fundamentals?.marketCapCr ?? 0) >= 10_000
    );
    if (largeCap.length >= persona.stockCount) candidates = largeCap;
  }

  // Filter by min score; fall back to top-N if not enough
  const scoreFiltered = candidates.filter((s) => s.compositeScore >= persona.stockMinScore);
  const pool = scoreFiltered.length >= persona.stockCount ? scoreFiltered : candidates;

  // Exclude Avoid and Low-confidence Buys (same rule as Stock Picks page)
  const actionable = pool.filter((s) => {
    const { verdict, confidence } = resolveVerdict(s.symbol, stRuleMap, stAiMap);
    if (verdict === "Avoid") return false;
    if ((verdict === "Buy" || verdict === "Strong Buy") && confidence === "Low") return false;
    return true;
  });

  // Prefer Core (stable for 7+ days in top 50) — only act on persona recs that won't churn next week.
  // Fall back to the broader actionable pool if not enough Core picks satisfy the persona's needs.
  const corePicks = actionable.filter((s) => (s.daysInTop50 ?? 0) >= 7);
  const stablePool = corePicks.length >= persona.stockCount ? corePicks : actionable;
  const finalPool = stablePool.length >= persona.stockCount ? stablePool : pool;

  return finalPool.slice(0, persona.stockCount).map((s, i) => {
    const { verdict, confidence } = resolveVerdict(s.symbol, stRuleMap, stAiMap);
    return {
      ...s,
      verdict,
      confidence,
      allocation: persona.stockAllocs[i] ?? 0.05,
      why: genStockWhy(s),
    };
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const VERDICT_CLS = {
  "Strong Buy": "bg-green-500/20 text-green-300 border border-green-600/40",
  "Buy":        "bg-green-800/30 text-green-400 border border-green-700/40",
  "Hold":       "bg-yellow-500/20 text-yellow-300 border border-yellow-600/40",
  "Watch":      "bg-blue-500/20 text-blue-300 border border-blue-600/40",
  "Avoid":      "bg-red-500/20 text-red-300 border border-red-600/40",
};

function ScorePill({ score }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-bold ${scoreCls(score)}`}>
      {scoreEmoji(score)} {score}
    </span>
  );
}

function VerdictBadge({ verdict, confidence }) {
  if (!verdict) return null;
  const cls = VERDICT_CLS[verdict] ?? "bg-gray-700/30 text-gray-400 border border-gray-600/40";
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${cls}`}>
      {verdict}
    </span>
  );
}

function RecRow({ item, type, rank, corpus, alloc, onFullAnalysis }) {
  const [expanded, setExpanded] = useState(false);
  const ret = type === "mf" ? item.ret1y : item.ret3m;
  const name = type === "mf" ? item.label : (item.name || item.symbol);
  const meta = type === "mf"
    ? `${item.category}${item.allocPct ? ` · ${item.allocPct}% of portfolio` : ""}`
    : `${item.sector ?? ""}${item.fundamentals?.marketCapCr ? ` · MCap ₹${item.fundamentals.marketCapCr >= 1e5 ? (item.fundamentals.marketCapCr / 1e5).toFixed(1) + "L" : item.fundamentals.marketCapCr.toLocaleString("en-IN")} Cr` : ""}`;

  return (
    <div
      className={`rounded-xl border transition-colors cursor-pointer ${
        expanded ? "border-blue-600/60 bg-gray-950" : "border-gray-800 bg-gray-950 hover:border-gray-700"
      }`}
      onClick={() => setExpanded((v) => !v)}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="w-5 shrink-0 text-center text-xs font-bold text-blue-400">#{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="truncate text-xs font-semibold text-gray-100">{name}</span>
            {item.verdict && <VerdictBadge verdict={item.verdict} confidence={item.confidence} />}
          </div>
          <div className="truncate text-[10px] text-gray-500">{meta}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ScorePill score={type === "mf" ? item.score : item.compositeScore} />
          <div className="text-right">
            <div className={`text-xs font-bold tabular-nums ${pctCls(ret)}`}>{fmtPct(ret)}</div>
            <div className="text-[11px] font-semibold text-gray-200">{fmtInr(corpus * alloc)}</div>
          </div>
          <span className={`text-[10px] text-gray-600 transition-transform ${expanded ? "rotate-180 text-blue-400" : ""}`}>▼</span>
        </div>
      </div>

      {/* Expanded */}
      {expanded && (
        <div className="border-t border-gray-800 px-3 pb-3 pt-2.5" onClick={(e) => e.stopPropagation()}>
          {type === "mf" ? (
            <div className="grid grid-cols-4 gap-1.5 mb-2.5">
              {[["1W", item.ret1w], ["1M", item.ret1m], ["3M", item.ret3m], ["1Y", item.ret1y]].map(([l, v]) => (
                <div key={l} className="rounded-lg bg-gray-900 p-1.5 text-center">
                  <div className="text-[9px] text-gray-500">{l}</div>
                  <div className={`text-xs font-bold tabular-nums ${pctCls(v)}`}>{fmtPct(v)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mb-2.5 flex flex-wrap gap-1">
              {[
                item.goldenCross      && { k: "Golden Cross",    cls: "bg-emerald-900/60 text-emerald-300 border-emerald-700/50" },
                item.macdBullish      && { k: "MACD Bullish",    cls: "bg-cyan-900/60 text-cyan-300 border-cyan-700/50" },
                item.above200DMA      && { k: "Above 200 DMA",   cls: "bg-teal-900/60 text-teal-300 border-teal-700/50" },
                item.above50DMA       && { k: "Above 50 DMA",    cls: "bg-teal-900/40 text-teal-400 border-teal-700/40" },
                item.volumeShock?.fired && { k: `Vol ${item.volumeShock.ratio?.toFixed(1)}×`, cls: "bg-orange-900/60 text-orange-300 border-orange-700/50" },
                item.near52wHigh?.fired && { k: "Near 52W High", cls: "bg-yellow-900/60 text-yellow-300 border-yellow-700/50" },
                item.breakout20d?.fired && { k: "20D Breakout",  cls: "bg-green-900/60 text-green-300 border-green-700/50" },
                item.breakout50d?.fired && { k: "50D Breakout",  cls: "bg-green-900/50 text-green-400 border-green-700/40" },
                item.oiBuildupLong    && { k: "OI Long Buildup", cls: "bg-purple-900/60 text-purple-300 border-purple-700/50" },
              ].filter(Boolean).map(({ k, cls }) => (
                <span key={k} className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>{k}</span>
              ))}
            </div>
          )}

          {/* Score bar */}
          <div className="flex items-center gap-2 mb-2.5">
            <span className="w-16 text-[10px] text-gray-500 shrink-0">Score</span>
            <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${type === "mf" ? item.score : item.compositeScore}%`,
                  background: (type === "mf" ? item.score : item.compositeScore) >= 70
                    ? "#34d399" : (type === "mf" ? item.score : item.compositeScore) >= 45
                    ? "#fbbf24" : "#ef4444",
                }}
              />
            </div>
            <span className="w-8 text-right text-[10px] font-semibold text-gray-300">
              {type === "mf" ? item.score : item.compositeScore}/100
            </span>
          </div>

          {/* Verdict + why */}
          <div className="rounded-lg bg-blue-950/40 border border-blue-900/40 p-2.5 mb-2.5">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="text-[9px] font-bold uppercase tracking-wider text-blue-400">💡 Why recommended?</div>
              {item.verdict && (
                <VerdictBadge verdict={item.verdict} confidence={item.confidence} />
              )}
              {item.confidence && (
                <span className="text-[9px] text-gray-600">{item.confidence} confidence</span>
              )}
            </div>
            <div className="text-[11px] text-blue-200 leading-relaxed">{item.why}</div>
          </div>

          <button
            className="w-full rounded-lg border border-blue-800/50 bg-blue-950/30 py-1.5 text-xs text-blue-300 hover:bg-blue-900/30 transition-colors"
            onClick={() => onFullAnalysis(item, type)}
          >
            📊 Full Analysis ↓
          </button>
        </div>
      )}
    </div>
  );
}

// Full analysis panel
function DetailPanel({ item, type, onClose, panelRef }) {
  if (!item) return null;
  const name = type === "mf" ? item.label : (item.name || item.symbol);
  const isStock = type === "stock";
  const sc = type === "mf" ? item.score : item.compositeScore;

  return (
    <div ref={panelRef} className="rounded-2xl border border-blue-800/50 bg-gray-950 p-5 mt-4">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-base font-bold text-white">{name}</div>
          <div className="text-xs text-gray-400 mt-0.5">
            {type === "mf" ? item.category : item.sector}
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700"
        >
          ✕ Close
        </button>
      </div>

      {/* Stats grid */}
      {type === "mf" ? (
        <>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 mb-3">
            {[["1W", item.ret1w], ["1M", item.ret1m], ["3M", item.ret3m], ["6M", item.ret6m], ["1Y", item.ret1y]].map(([l, v]) => (
              <div key={l} className="rounded-xl bg-gray-900 border border-gray-800 p-2.5 text-center">
                <div className="text-[10px] text-gray-500">{l}</div>
                <div className={`text-sm font-bold tabular-nums ${pctCls(v)}`}>{fmtPct(v)}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 mb-3">
            {[
              ["5Y CAGR", fmtPct(item.cagr5y), pctCls(item.cagr5y)],
              ["Sharpe", item.sharpe?.toFixed(2) ?? "—", "text-green-400"],
              ["Max DD", item.maxDD != null ? fmtPct(-item.maxDD) : "—", "text-red-400"],
              ["Score", `${sc}/100`, sc >= 70 ? "text-green-400" : sc >= 45 ? "text-amber-400" : "text-red-400"],
            ].map(([l, v, cls]) => (
              <div key={l} className="rounded-xl bg-gray-900 border border-gray-800 p-2.5 text-center">
                <div className={`text-sm font-bold ${cls}`}>{v}</div>
                <div className="text-[10px] text-gray-500 mt-0.5">{l}</div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 mb-3">
            {[
              ["1W", fmtPct(item.ret1w), pctCls(item.ret1w)],
              ["1M", fmtPct(item.ret1m), pctCls(item.ret1m)],
              ["3M", fmtPct(item.ret3m), pctCls(item.ret3m)],
              ["RS 3M", item.rsVsNifty3m != null ? fmtPct(item.rsVsNifty3m) : "—", pctCls(item.rsVsNifty3m)],
              ["Delivery", item.deliveryPct != null ? `${item.deliveryPct.toFixed(0)}%` : "—", "text-teal-400"],
            ].map(([l, v, cls]) => (
              <div key={l} className="rounded-xl bg-gray-900 border border-gray-800 p-2.5 text-center">
                <div className={`text-sm font-bold ${cls}`}>{v}</div>
                <div className="text-[10px] text-gray-500 mt-0.5">{l}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 mb-3">
            {[
              ["PE", item.fundamentals?.trailingPE?.toFixed(1) ?? "—", "text-amber-400"],
              ["RoE", item.fundamentals?.returnOnEquity != null ? `${item.fundamentals.returnOnEquity.toFixed(1)}%` : "—", "text-green-400"],
              ["MCap", item.fundamentals?.marketCapCr != null ? fmtInr(item.fundamentals.marketCapCr * 1e5) : "—", "text-blue-300"],
              ["Score", `${sc}/100`, sc >= 70 ? "text-green-400" : sc >= 45 ? "text-amber-400" : "text-red-400"],
            ].map(([l, v, cls]) => (
              <div key={l} className="rounded-xl bg-gray-900 border border-gray-800 p-2.5 text-center">
                <div className={`text-sm font-bold ${cls}`}>{v}</div>
                <div className="text-[10px] text-gray-500 mt-0.5">{l}</div>
              </div>
            ))}
          </div>
          {/* Active signals */}
          <div className="mb-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Active Signals</div>
            <div className="flex flex-wrap gap-1">
              {[
                [item.goldenCross,       "Golden Cross",     "bg-emerald-900/60 text-emerald-300 border-emerald-700/50"],
                [item.macdBullish,       "MACD Bullish",     "bg-cyan-900/60 text-cyan-300 border-cyan-700/50"],
                [item.above200DMA,       "Above 200 DMA",    "bg-teal-900/60 text-teal-300 border-teal-700/50"],
                [item.above50DMA,        "Above 50 DMA",     "bg-teal-900/40 text-teal-400 border-teal-700/40"],
                [item.above20DMA,        "Above 20 DMA",     "bg-teal-900/30 text-teal-500 border-teal-700/30"],
                [item.volumeShock?.fired,"Volume Surge",     "bg-orange-900/60 text-orange-300 border-orange-700/50"],
                [item.near52wHigh?.fired,"Near 52W High",    "bg-yellow-900/60 text-yellow-300 border-yellow-700/50"],
                [item.breakout20d?.fired,"20D Breakout",     "bg-green-900/60 text-green-300 border-green-700/50"],
                [item.breakout50d?.fired,"50D Breakout",     "bg-green-900/50 text-green-400 border-green-700/40"],
                [item.oiBuildupLong,     "OI Long Buildup",  "bg-purple-900/60 text-purple-300 border-purple-700/50"],
              ].map(([active, label, cls]) =>
                active ? (
                  <span key={label} className={`rounded-md border px-2 py-0.5 text-xs font-medium ${cls}`}>✓ {label}</span>
                ) : null
              )}
            </div>
          </div>
        </>
      )}

      {/* Score breakdown */}
      <div className="mb-3">
        <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">Score Breakdown</div>
        {[
          ["Short-term (1W)", Math.round(sc * 0.32), "#34d399"],
          ["Medium-term (1M+)", Math.round(sc * 0.28), "#60a5fa"],
          ["Long-term (1Y+)", Math.round(sc * 0.22), "#a78bfa"],
          ["Risk / Quality", Math.round(sc * 0.18), "#fbbf24"],
        ].map(([l, v, c]) => (
          <div key={l} className="flex items-center gap-2 mb-1.5">
            <span className="w-32 text-[10px] text-gray-500 shrink-0">{l}</span>
            <div className="flex-1 h-1 rounded-full bg-gray-800 overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${v}%`, background: c }} />
            </div>
            <span className="w-6 text-right text-[10px] text-gray-400">{v}</span>
          </div>
        ))}
      </div>

      {/* Why */}
      <div className="rounded-xl bg-blue-950/40 border border-blue-900/40 p-3">
        <div className="text-[10px] font-bold uppercase tracking-wider text-blue-400 mb-1.5">💡 Why Recommended?</div>
        <div className="text-xs text-blue-200 leading-relaxed">{item.why}</div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

const FOOTER = [
  {
    title: "Data Sources",
    items: [
      "MF data from AMFI NAVAll.txt + mfapi.in NAV history",
      "Stock data from NSE bhavcopy, EOD price feeds",
      "Refreshed nightly · intraday score updates 5× daily",
    ],
  },
  {
    title: "Scoring",
    items: [
      "MF score: z-score × conviction multiplier (0.55–1.00× based on category heat)",
      "Stock score: EOD signals (golden cross, MACD, DMA, RS) + intraday blend",
      "EMA smoothing α=0.6 applied day-to-day to reduce volatility",
    ],
  },
  {
    title: "Disclaimer",
    items: [
      "Persona allocations are illustrative — not tailored financial advice",
      "Past returns ≠ future performance",
      "Consult a SEBI-registered advisor before investing",
    ],
  },
];

export default function PersonaAdvisor() {
  const [mfData, setMfData]       = useState(null);
  const [stockData, setStockData] = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  // Rationale maps — keyed by fund_code / symbol
  const [mfRuleMap, setMfRuleMap]   = useState({});
  const [mfAiMap,   setMfAiMap]     = useState({});
  const [stRuleMap, setStRuleMap]   = useState({});
  const [stAiMap,   setStAiMap]     = useState({});

  const [personaIdx, setPersonaIdx] = useState(0);
  const [horizonIdx, setHorizonIdx] = useState(3); // default: 10 Years

  // Persist corpus in localStorage so it survives page reloads
  const savedCorpus = parseInt(localStorage.getItem("persona_corpus")) || 10_000_000;
  const [corpus, setCorpus] = useState(savedCorpus);
  const [inputVal, setInputVal] = useState(
    savedCorpus.toLocaleString("en-IN")
  );

  const [detail, setDetail]         = useState(null); // { item, type }
  const detailRef                   = useRef(null);

  // Fetch radar data + rationale tables in parallel
  useEffect(() => {
    setLoading(true);
    Promise.all([
      supabase.from("radar_cache").select("data").eq("key", "mf_radar").single(),
      supabase.from("radar_cache").select("data").eq("key", "stock_picks").single(),
      supabase.from("pick_rationales").select("fund_code,analysis").order("run_date", { ascending: false }).limit(200),
      supabase.from("pick_ai_rationales").select("fund_code,analysis"),
      supabase.from("stock_pick_rationales").select("symbol,analysis").order("run_date", { ascending: false }).limit(200),
      supabase.from("stock_pick_ai_rationales").select("symbol,analysis"),
    ]).then(([mfRes, stRes, mfRule, mfAi, stRule, stAi]) => {
      if (mfRes.error) setError(mfRes.error.message);
      else             setMfData(mfRes.data?.data);
      if (!stRes.error) setStockData(stRes.data?.data);

      // Build keyed maps (first entry per code wins — most recent run_date first)
      if (!mfRule.error && mfRule.data) {
        const m = {};
        mfRule.data.forEach((r) => { if (!m[r.fund_code]) m[r.fund_code] = r; });
        setMfRuleMap(m);
      }
      if (!mfAi.error && mfAi.data) {
        const m = {};
        mfAi.data.forEach((r) => { m[r.fund_code] = r; });
        setMfAiMap(m);
      }
      if (!stRule.error && stRule.data) {
        const m = {};
        stRule.data.forEach((r) => { if (!m[r.symbol]) m[r.symbol] = r; });
        setStRuleMap(m);
      }
      if (!stAi.error && stAi.data) {
        const m = {};
        stAi.data.forEach((r) => { m[r.symbol] = r; });
        setStAiMap(m);
      }

      setLoading(false);
    });
  }, []);

  const persona = PERSONAS[personaIdx];
  const { picks: mfPicks, skipped: mfSkipped } = buildMfPicks(persona, mfData, mfRuleMap, mfAiMap) ?? { picks: [], skipped: [] };
  const stockPicks = buildStockPicks(persona, stockData, stRuleMap, stAiMap);

  const horizonYears = HORIZONS[horizonIdx].years;
  const plo = compoundGrowth(corpus, persona.annualReturnLo, horizonYears);
  const phi = compoundGrowth(corpus, persona.annualReturnHi, horizonYears);
  const gainPctLo = Math.round((plo - corpus) / corpus * 100);
  const gainPctHi = Math.round((phi - corpus) / corpus * 100);
  // Bar: aggressive at 10yr could be 1,378%; cap visual at 100%, scale relative
  const barPct = Math.min(96, Math.round(gainPctLo / (gainPctHi * 1.1) * 85));

  function handleCorpusChange() {
    const raw = parseInt(inputVal.replace(/[^0-9]/g, "")) || 1_000_000;
    setCorpus(raw);
    localStorage.setItem("persona_corpus", raw);
    setDetail(null);
  }

  function openDetail(item, type) {
    setDetail({ item, type });
    setTimeout(() => {
      if (!detailRef.current) return;
      let absTop = 0, el = detailRef.current;
      while (el) { absTop += el.offsetTop; el = el.offsetParent; }
      window.scrollTo({ top: Math.max(0, absTop - 72), behavior: "smooth" });
    }, 80);
  }

  if (loading) return (
    <div className="flex flex-col items-center justify-center gap-3 py-24">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      <p className="animate-pulse text-sm text-gray-400">Loading persona data…</p>
    </div>
  );
  if (error) return <p className="text-red-400 text-sm py-8">Error: {error}</p>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">🧭 Investor Persona Advisor</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            Pick your investor type · get a personalised allocation plan with live momentum scores
          </p>
        </div>
        {/* Corpus input */}
        <div className="flex items-center gap-2 rounded-full border border-gray-700 bg-gray-900 px-4 py-1.5">
          <span className="text-xs text-gray-500">Invest ₹</span>
          <input
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCorpusChange()}
            className="w-28 bg-transparent text-sm font-bold text-white outline-none text-right"
          />
          <button
            onClick={handleCorpusChange}
            className="rounded-full bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-500"
          >
            Recalculate ↺
          </button>
        </div>
      </div>

      {/* Horizon + persona selector row */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Horizon pills */}
        <div className="flex items-center gap-1.5 rounded-full border border-gray-700 bg-gray-900 p-1 shrink-0">
          <span className="pl-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Horizon</span>
          {HORIZONS.map((h, i) => (
            <button
              key={h.label}
              onClick={() => setHorizonIdx(i)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-all ${
                i === horizonIdx
                  ? "bg-blue-600 text-white shadow"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {h.label}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-gray-600 hidden sm:block">← same horizon applied to all personas for a fair comparison</span>
      </div>

      {/* Persona selector */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {PERSONAS.map((p, i) => {
          const yrs = horizonYears;
          const pLo = compoundGrowth(corpus, p.annualReturnLo, yrs);
          const pHi = compoundGrowth(corpus, p.annualReturnHi, yrs);
          const gLo = Math.round((pLo - corpus) / corpus * 100);
          const gHi = Math.round((pHi - corpus) / corpus * 100);
          return (
            <button
              key={p.id}
              onClick={() => { setPersonaIdx(i); setDetail(null); }}
              className={`flex-1 min-w-[148px] rounded-2xl border px-3 py-3 text-center transition-all ${
                i === personaIdx
                  ? "border-blue-600 bg-blue-900/30 shadow shadow-blue-900/50"
                  : "border-gray-800 bg-gray-900 hover:border-gray-700 hover:bg-gray-800/50"
              }`}
            >
              <div className="text-2xl mb-1">{p.icon}</div>
              <div className="text-xs font-bold text-gray-100">{p.name}</div>
              <div className="text-[10px] text-gray-500 mt-0.5 leading-snug">{p.tagline}</div>
              {/* Projected growth for selected horizon — the key comparison number */}
              <div className="mt-2 rounded-lg bg-gray-950/60 py-1.5 px-2">
                <div className="text-[10px] text-gray-500 mb-0.5">In {HORIZONS[horizonIdx].label}</div>
                <div className="text-sm font-extrabold text-green-400">+{gLo}% – +{gHi}%</div>
                <div className="text-[10px] text-gray-500">{fmtInr(pLo)} – {fmtInr(pHi)}</div>
              </div>
              <div className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${p.riskBadgeCls}`}>
                {p.riskLabel} Risk
              </div>
            </button>
          );
        })}
      </div>

      {/* 2-column main body */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[290px_1fr]">

        {/* ── Left: Profile + Allocation ── */}
        <div className="space-y-3">
          {/* Profile card */}
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
            <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-gray-500">Persona Profile</p>
            <div className="mb-4 flex items-center gap-3">
              <span className="text-3xl">{persona.icon}</span>
              <div>
                <div className="font-bold text-white">{persona.name}</div>
                <div className="text-[11px] text-gray-500">{persona.approach}</div>
              </div>
            </div>
            {/* Risk meter */}
            <div className="mb-1 flex justify-between text-[10px]">
              <span className="text-gray-500">Risk Level</span>
              <span className="font-semibold" style={{ color: persona.riskColor }}>{persona.riskLabel}</span>
            </div>
            <div className="mb-1 h-2 overflow-hidden rounded-full bg-gray-800">
              <div className="h-full rounded-full" style={{ width: `${persona.riskPct}%`, background: persona.riskGrad }} />
            </div>
            <div className="mb-3 flex justify-between text-[9px] text-gray-600">
              <span>Low</span><span>Medium</span><span>High</span><span>Very High</span>
            </div>
            {/* Attributes */}
            {[
              ["⏱ Horizon",           HORIZONS[horizonIdx].label, "text-blue-400"],
              ["📈 Expected Return",   persona.expectedReturn,     "text-green-400"],
              ["📉 Max Drawdown",      persona.drawdown,           "text-red-400"],
              ["〰️ Volatility",        persona.volatility,         "text-amber-400"],
              ["💧 Liquidity",         persona.liquidity,          "text-gray-300"],
              ["🧾 Tax",               persona.tax,                "text-gray-300"],
            ].map(([label, val, cls]) => (
              <div key={label} className="flex justify-between border-t border-gray-800 py-1.5">
                <span className="text-[11px] text-gray-500">{label}</span>
                <span className={`text-right text-[11px] font-semibold ${cls}`}>{val}</span>
              </div>
            ))}
          </div>

          {/* Allocation card */}
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-500">
              Asset Allocation — {fmtInr(corpus)}
            </p>
            {/* Bar */}
            <div className="flex h-3 gap-0.5 overflow-hidden rounded-full mb-3">
              {persona.alloc.map((a) => (
                <div
                  key={a.l}
                  style={{ flex: a.pct, background: a.hex }}
                  title={`${a.l} ${a.pct}%`}
                  className="rounded-sm"
                />
              ))}
            </div>
            {/* Legend */}
            <div className="space-y-1.5">
              {persona.alloc.map((a) => (
                <div key={a.l} className="flex items-center gap-2 text-[11px] text-gray-300">
                  <div className="h-2 w-2 shrink-0 rounded-sm" style={{ background: a.hex }} />
                  <strong className="text-gray-100">{a.pct}%</strong>
                  <span className="flex-1 text-gray-400">{a.l}</span>
                  <span className="font-semibold text-gray-500">{fmtInr(corpus * a.pct / 100)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Right: Outcome + Recs ── */}
        <div className="space-y-4">

          {/* Outcome hero */}
          <div className="rounded-2xl border border-blue-900/60 p-5"
               style={{ background: "linear-gradient(135deg,#0c1a2e,#102040,#0f1e3d)" }}>
            <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-blue-400">
              🎯 Potential Outcome — {fmtInr(corpus)} over {HORIZONS[horizonIdx].label}
            </p>

            {/* Two equal-weight stat blocks */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="rounded-xl border border-blue-900/40 bg-black/30 p-3">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Expected Corpus</div>
                <div className="text-xl font-extrabold text-white tracking-tight leading-snug">
                  {fmtInr(plo)}<span className="text-gray-500 font-normal text-sm"> – </span>{fmtInr(phi)}
                </div>
                <div className="mt-1 text-[11px] text-gray-500">
                  +{fmtInr(plo - corpus)} → +{fmtInr(phi - corpus)} gain
                </div>
              </div>
              <div className="rounded-xl border border-green-900/50 bg-green-950/20 p-3">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Total % Growth</div>
                <div className="text-xl font-extrabold text-green-400 tracking-tight leading-snug">
                  +{gainPctLo}%<span className="text-green-700 font-normal text-sm"> – </span>+{gainPctHi}%
                </div>
                <div className="mt-1 text-[11px] text-gray-500">
                  {persona.expectedReturn} · compounded {HORIZONS[horizonIdx].label}
                </div>
              </div>
            </div>

            {/* Compact stat row */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500 border-t border-blue-900/30 pt-2.5">
              <span>📉 Max DD <strong className="text-red-400">{persona.outcome.maxDD}</strong></span>
              <span>📈 Return <strong className="text-purple-300">{persona.expectedReturn}</strong></span>
              <span>⚡ Sharpe <strong className="text-amber-300">{persona.outcome.sharpe}</strong></span>
            </div>
          </div>

          {/* Recommendations — MF + Stocks side by side */}
          <div className="rounded-2xl border border-gray-700 bg-gray-900 p-4">
            <p className="mb-0.5 text-sm font-bold text-white">Recommended Portfolio</p>
            <p className="mb-3 text-[11px] text-gray-400">
              Ranked by live momentum scores · click any row to expand · {fmtInr(corpus)} to invest
            </p>

            {(mfPicks.length === 0 && stockPicks.length === 0 && mfSkipped.length === 0) ? (
              <p className="text-xs text-gray-500 py-4 text-center">No data available — run the nightly refresh job.</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {/* MF column */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Mutual Funds</span>
                    <div className="flex-1 h-px bg-gray-800" />
                  </div>
                  <div className="space-y-1.5">
                    {mfPicks.map((f, i) => (
                      <RecRow
                        key={f.code}
                        item={f}
                        type="mf"
                        rank={i + 1}
                        corpus={corpus}
                        alloc={f.allocation}
                        onFullAnalysis={openDetail}
                      />
                    ))}
                    {mfPicks.length === 0 && (
                      <p className="text-xs text-gray-600 py-2">No MF data — refresh pending.</p>
                    )}
                    {/* Skipped slots — category momentum too weak */}
                    {mfSkipped.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {mfSkipped.map((s) => (
                          <div key={s.l} className="flex items-center gap-2 rounded-lg border border-gray-800/60 bg-gray-950/40 px-3 py-2">
                            <span className="text-[10px]">⏸</span>
                            <div className="flex-1 min-w-0">
                              <span className="text-[10px] text-gray-600 line-through">{s.l}</span>
                              <span className="ml-1.5 text-[10px] text-gray-600">({s.pct}%)</span>
                            </div>
                            <span className="text-[10px] text-amber-600/80 shrink-0">
                              {s.strength} · category momentum weak — skipped
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Stocks column */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Stocks</span>
                    <div className="flex-1 h-px bg-gray-800" />
                  </div>
                  <div className="space-y-1.5">
                    {stockPicks.map((s, i) => (
                      <RecRow
                        key={s.symbol}
                        item={s}
                        type="stock"
                        rank={i + 1}
                        corpus={corpus}
                        alloc={s.allocation}
                        onFullAnalysis={openDetail}
                      />
                    ))}
                    {stockPicks.length === 0 && (
                      <p className="text-xs text-gray-600 py-2">No stock data — refresh pending.</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Full analysis detail panel */}
      {detail && (
        <DetailPanel
          item={detail.item}
          type={detail.type}
          onClose={() => setDetail(null)}
          panelRef={detailRef}
        />
      )}

      {/* Scoring explanation */}
      <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-gray-500">📊 How Momentum Scores Work</p>
        <p className="mb-4 text-xs text-gray-400 leading-relaxed">
          Each fund and stock is scored <strong className="text-gray-200">0–100</strong> daily using price momentum signals.
          Higher score = stronger momentum. Recommendations are ranked by score within each persona's eligible universe.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: "📅", title: "1W Z-Score", desc: "How this week's return compares to the 90-day average. z > 1 = unusual short-term strength.", weight: "25% of MF base score" },
            { icon: "📆", title: "1M & 3M Returns", desc: "Medium-term momentum. Filters one-week flukes and confirms trend quality.", weight: "20% + 15%" },
            { icon: "🎯", title: "Category Conviction", desc: "Multiplier based on how hot the fund's category is. Surging category (z > 1.5) boosts scores by 45%.", weight: "Multiplier: 0.55× – 1.00×" },
            { icon: "🔦", title: "Technical Signals", desc: "Golden cross, MACD, DMA positioning, volume surge, delivery %, OI buildup, 52W highs.", weight: "EOD + intraday blend" },
            { icon: "🏭", title: "Fundamentals Bonus", desc: "Large caps (MCap > ₹5K Cr) +3 pts. Earnings growth ≥ 20% adds +5. High RoE ≥ 20% adds +3.", weight: "Up to +11 pts" },
            { icon: "🌊", title: "EMA Smoothing", desc: "Today's score = 60% today + 40% yesterday. Prevents a single volatile day from dominating.", weight: "α = 0.6 · 3-day memory" },
            { icon: "📈", title: "1Y + 5Y CAGR", desc: "Long-term performance quality. Rewards proven compounders across market cycles.", weight: "10% + 5%" },
            { icon: "⚡", title: "Sharpe Ratio", desc: "Return per unit of risk (risk-free = 7%). Sharpe > 1.0 = more excess return than volatility taken.", weight: "5% of base score" },
          ].map(({ icon, title, desc, weight }) => (
            <div key={title} className="rounded-xl border border-gray-800 bg-gray-950 p-3">
              <div className="text-lg mb-1.5">{icon}</div>
              <div className="text-xs font-semibold text-gray-200 mb-1">{title}</div>
              <div className="text-[11px] text-gray-500 leading-relaxed">{desc}</div>
              <div className="mt-2 text-[10px] font-semibold text-blue-400">{weight}</div>
            </div>
          ))}
        </div>
      </div>

      <PageFooter sections={FOOTER} />
    </div>
  );
}
