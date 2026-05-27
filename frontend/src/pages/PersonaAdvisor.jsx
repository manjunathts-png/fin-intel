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
// Map MF z-score → 0-99 display score
function zToScore(z) {
  return Math.max(10, Math.min(99, Math.round((z ?? 0) * 20 + 50)));
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
    horizon: "1–3 Years",
    expectedReturn: "18–30% p.a.",
    volatility: "Very High (σ > 30%)",
    drawdown: "Can tolerate –40% or more",
    liquidity: "High — active rebalancing",
    tax: "STCG heavy (< 1 yr)",
    alloc: [
      { l: "Small & Mid Cap Equity", pct: 60, hex: "#ef4444" },
      { l: "Large Cap Equity",       pct: 20, hex: "#f97316" },
      { l: "Gold / Commodities",     pct:  5, hex: "#fbbf24" },
      { l: "Debt / Liquid",          pct:  5, hex: "#818cf8" },
      { l: "Cash Buffer",            pct: 10, hex: "#4b5563" },
    ],
    outcome: {
      loMult: 1.30, hiMult: 1.80,
      horizon: "2–3 yrs", maxDD: "–40%", sharpe: "0.6–0.9", ret: "18–30% p.a.",
      note: "High upside, very high variance. A 40% drawdown is plausible in a bear market — position sizing and stop-losses are critical.",
    },
    mfCategories: ["Small Cap", "Mid Cap"],
    mfCount: 4,
    mfAllocs: [0.20, 0.15, 0.15, 0.10],
    stockCount: 4,
    stockAllocs: [0.10, 0.075, 0.075, 0.05],
    stockMinScore: 60,
    stockSectors: null, // any sector
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
    horizon: "5–7 Years",
    expectedReturn: "14–20% p.a.",
    volatility: "High (σ 20–30%)",
    drawdown: "Comfortable with –25% to –35%",
    liquidity: "Medium — quarterly review",
    tax: "LTCG optimised (> 1 yr)",
    alloc: [
      { l: "Flexi / Multi Cap MF",  pct: 35, hex: "#f59e0b" },
      { l: "Mid Cap Equity",        pct: 25, hex: "#ef4444" },
      { l: "Large Cap Equity",      pct: 20, hex: "#f97316" },
      { l: "International MF",      pct: 10, hex: "#06b6d4" },
      { l: "Debt / Liquid",         pct: 10, hex: "#818cf8" },
    ],
    outcome: {
      loMult: 1.20, hiMult: 1.50,
      horizon: "5–7 yrs", maxDD: "–30%", sharpe: "0.8–1.1", ret: "14–20% p.a.",
      note: "Reasonable wealth creation over 5+ years with manageable drawdowns. Best for goals like home purchase or retirement corpus.",
    },
    mfCategories: ["Flexi Cap", "Mid Cap", "Large & Mid Cap"],
    mfCount: 4,
    mfAllocs: [0.25, 0.15, 0.10, 0.05],
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
    horizon: "3–5 Years",
    expectedReturn: "10–14% p.a.",
    volatility: "Moderate (σ 12–20%)",
    drawdown: "Can bear –15% to –20%",
    liquidity: "Medium — semi-annual review",
    tax: "Mix of STCG & LTCG",
    alloc: [
      { l: "Large Cap / Nifty Index", pct: 35, hex: "#3b82f6" },
      { l: "Flexi Cap MF",            pct: 20, hex: "#f59e0b" },
      { l: "Corporate Bond Fund",     pct: 20, hex: "#818cf8" },
      { l: "Gold ETF / SGBs",         pct: 15, hex: "#fbbf24" },
      { l: "Cash / Liquid",           pct: 10, hex: "#4b5563" },
    ],
    outcome: {
      loMult: 1.10, hiMult: 1.35,
      horizon: "3–5 yrs", maxDD: "–18%", sharpe: "0.9–1.3", ret: "10–14% p.a.",
      note: "Steady compounder with capital protection. Suitable for 3–5 year goals — home down-payment, child education, or a growing emergency fund.",
    },
    mfCategories: ["Large Cap", "Flexi Cap", "Gold"],
    mfCount: 3,
    mfAllocs: [0.25, 0.15, 0.15],
    stockCount: 3,
    stockAllocs: [0.20, 0.10, 0.15],
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
    horizon: "2–4 Years",
    expectedReturn: "8–12% p.a.",
    volatility: "Low (σ < 12%)",
    drawdown: "Prefer < –10% drawdown",
    liquidity: "High — monthly monitoring",
    tax: "Debt LTCG + indexation",
    alloc: [
      { l: "Large Cap / Nifty 50",    pct: 30, hex: "#22c55e" },
      { l: "Short Duration Debt",     pct: 30, hex: "#818cf8" },
      { l: "Gold ETF / SGBs",         pct: 20, hex: "#fbbf24" },
      { l: "Arbitrage / Liquid",      pct: 15, hex: "#06b6d4" },
      { l: "Cash",                    pct:  5, hex: "#4b5563" },
    ],
    outcome: {
      loMult: 1.08, hiMult: 1.25,
      horizon: "2–4 yrs", maxDD: "–10%", sharpe: "1.0–1.4", ret: "8–12% p.a.",
      note: "Capital preservation priority. Modest growth with minimal drawdowns. Best for near-term goals or investors who lose sleep over volatility.",
    },
    mfCategories: ["Large Cap", "Gold"],
    mfCount: 3,
    mfAllocs: [0.20, 0.15, 0.20],
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
    horizon: "5+ Years",
    expectedReturn: "10–15% p.a.",
    volatility: "Moderate (σ 12–18%)",
    drawdown: "Comfortable with –15%",
    liquidity: "Low — hold and collect",
    tax: "Dividend taxed at income slab",
    alloc: [
      { l: "Dividend Yield Stocks",  pct: 40, hex: "#a78bfa" },
      { l: "Dividend Yield MF",      pct: 25, hex: "#818cf8" },
      { l: "REITs / InvITs",         pct: 15, hex: "#f59e0b" },
      { l: "Short Duration Debt",    pct: 15, hex: "#06b6d4" },
      { l: "Cash",                   pct:  5, hex: "#4b5563" },
    ],
    outcome: {
      loMult: 1.10, hiMult: 1.40,
      horizon: "5+ yrs", maxDD: "–15%", sharpe: "0.9–1.2", ret: "10–15% p.a.",
      note: "Yield on corpus ≈ 3–5% per year = ₹30K–₹50K annual income on ₹10L invested, plus capital appreciation over 5+ years.",
    },
    mfCategories: ["Value", "Large Cap"],
    mfCount: 3,
    mfAllocs: [0.15, 0.10, 0.10],
    stockCount: 4,
    stockAllocs: [0.15, 0.125, 0.10, 0.10],
    stockMinScore: 45,
    stockSectors: ["Power", "Mining", "FMCG", "Utilities", "Energy"],
    preferDefensive: true,
  },
];

// ─── Derive recommendations from live data ────────────────────────────────────

function buildMfPicks(persona, mfData) {
  if (!mfData?.categories) return [];
  const funds = [];
  mfData.categories.forEach((cat) => {
    const catMatch = persona.mfCategories.some((c) =>
      cat.category.toLowerCase().includes(c.toLowerCase())
    );
    if (!catMatch) return;
    const catZ = cat.median?.z1w ?? 0;
    cat.funds.forEach((f) => {
      funds.push({
        ...f,
        category: cat.category,
        catZ,
        score: zToScore(f.z1w ?? catZ),
      });
    });
  });
  // Sort by score desc, dedupe by name prefix
  funds.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const deduped = funds.filter((f) => {
    const key = f.label?.slice(0, 12);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return deduped.slice(0, persona.mfCount).map((f, i) => ({
    ...f,
    allocation: persona.mfAllocs[i] ?? 0.10,
    why: genMfWhy(f),
  }));
}

function buildStockPicks(persona, stockData) {
  if (!stockData?.picks) return [];
  let candidates = [...(stockData.picks ?? [])];

  // Filter by sector if persona specifies
  if (persona.stockSectors) {
    const sectorFiltered = candidates.filter((s) =>
      persona.stockSectors.some((sec) =>
        (s.sector ?? "").toLowerCase().includes(sec.toLowerCase())
      )
    );
    // If enough matches, use them; otherwise fall back to all
    if (sectorFiltered.length >= persona.stockCount) candidates = sectorFiltered;
  }

  // Prefer large cap for balanced/conservative
  if (persona.preferLargeCap) {
    const largeCap = candidates.filter(
      (s) => (s.fundamentals?.marketCapCr ?? 0) >= 10_000
    );
    if (largeCap.length >= persona.stockCount) candidates = largeCap;
  }

  // Filter by min score
  const scoreFiltered = candidates.filter((s) => s.compositeScore >= persona.stockMinScore);
  const pool = scoreFiltered.length >= persona.stockCount ? scoreFiltered : candidates;

  return pool.slice(0, persona.stockCount).map((s, i) => ({
    ...s,
    allocation: persona.stockAllocs[i] ?? 0.05,
    why: genStockWhy(s),
  }));
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScorePill({ score }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-bold ${scoreCls(score)}`}>
      {scoreEmoji(score)} {score}
    </span>
  );
}

function RecRow({ item, type, rank, corpus, alloc, onFullAnalysis }) {
  const [expanded, setExpanded] = useState(false);
  const ret = type === "mf" ? item.ret1y : item.ret3m;
  const name = type === "mf" ? item.label : (item.name || item.symbol);
  const meta = type === "mf"
    ? item.category
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
          <div className="truncate text-xs font-semibold text-gray-100">{name}</div>
          <div className="truncate text-[10px] text-gray-500">{meta}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ScorePill score={type === "mf" ? item.score : item.compositeScore} />
          <div className="text-right">
            <div className={`text-xs font-bold tabular-nums ${pctCls(ret)}`}>{fmtPct(ret)}</div>
            <div className="text-[10px] text-gray-500">{fmtInr(corpus * alloc)}</div>
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

          {/* Why */}
          <div className="rounded-lg bg-blue-950/40 border border-blue-900/40 p-2.5 mb-2.5">
            <div className="text-[9px] font-bold uppercase tracking-wider text-blue-400 mb-1">💡 Why recommended?</div>
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

  const [personaIdx, setPersonaIdx] = useState(0);
  const [corpus, setCorpus]         = useState(1_000_000);
  const [inputVal, setInputVal]     = useState("10,00,000");

  const [detail, setDetail]         = useState(null); // { item, type }
  const detailRef                   = useRef(null);

  // Fetch both data sources in parallel
  useEffect(() => {
    setLoading(true);
    Promise.all([
      supabase.from("radar_cache").select("data").eq("key", "mf_radar").single(),
      supabase.from("radar_cache").select("data").eq("key", "stock_picks").single(),
    ]).then(([mfRes, stRes]) => {
      if (mfRes.error)  setError(mfRes.error.message);
      else              setMfData(mfRes.data?.data);
      if (!stRes.error) setStockData(stRes.data?.data);
      setLoading(false);
    });
  }, []);

  const persona = PERSONAS[personaIdx];
  const mfPicks    = buildMfPicks(persona, mfData);
  const stockPicks = buildStockPicks(persona, stockData);

  const plo = persona.outcome.loMult * corpus;
  const phi = persona.outcome.hiMult * corpus;
  const gainPctLo = Math.round((plo - corpus) / corpus * 100);
  const gainPctHi = Math.round((phi - corpus) / corpus * 100);
  const barPct = Math.min(90, Math.round((gainPctLo + gainPctHi) / 2 * 1.5));

  function handleCorpusChange() {
    const raw = parseInt(inputVal.replace(/[^0-9]/g, "")) || 1_000_000;
    setCorpus(raw);
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

      {/* Persona selector */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {PERSONAS.map((p, i) => (
          <button
            key={p.id}
            onClick={() => { setPersonaIdx(i); setDetail(null); }}
            className={`flex-1 min-w-[140px] rounded-2xl border px-3 py-3 text-center transition-all ${
              i === personaIdx
                ? "border-blue-600 bg-blue-900/30 shadow shadow-blue-900/50"
                : "border-gray-800 bg-gray-900 hover:border-gray-700 hover:bg-gray-800/50"
            }`}
          >
            <div className="text-2xl mb-1">{p.icon}</div>
            <div className="text-xs font-bold text-gray-100">{p.name}</div>
            <div className="text-[10px] text-gray-500 mt-0.5 leading-snug">{p.tagline}</div>
            <div className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${p.riskBadgeCls}`}>
              {p.riskLabel} Risk
            </div>
          </button>
        ))}
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
              ["⏱ Horizon",           persona.horizon,         "text-blue-400"],
              ["📈 Expected Return",   persona.expectedReturn,  "text-green-400"],
              ["📉 Max Drawdown",      persona.drawdown,        "text-red-400"],
              ["〰️ Volatility",        persona.volatility,      "text-amber-400"],
              ["💧 Liquidity",         persona.liquidity,       "text-gray-300"],
              ["🧾 Tax",               persona.tax,             "text-gray-300"],
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
              🎯 Potential Outcome — {fmtInr(corpus)} invested
            </p>
            <div className="flex flex-wrap items-end gap-5 mb-4">
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">Expected corpus range</div>
                <div className="text-3xl font-extrabold text-green-400 tracking-tight">
                  {fmtInr(plo)} – {fmtInr(phi)}
                </div>
              </div>
              <div className="pb-0.5">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">Potential gain</div>
                <div className="text-xl font-extrabold text-emerald-300">
                  +{fmtInr(plo - corpus)} → +{fmtInr(phi - corpus)}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  +{gainPctLo}% to +{gainPctHi}% total return
                </div>
              </div>
            </div>
            {/* Progress bar */}
            <div className="mb-1 h-2 overflow-hidden rounded-full border border-blue-900/60 bg-gray-950">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${barPct}%`, background: "linear-gradient(90deg,#34d399,#3b82f6,#a78bfa)" }}
              />
            </div>
            <div className="mb-4 flex justify-between text-[10px] text-gray-600">
              <span>₹0 gain</span>
              <span>Target over {persona.outcome.horizon}</span>
            </div>
            {/* 4 outcome boxes */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                [persona.outcome.horizon, "Investment Horizon",    "text-blue-300"],
                [persona.outcome.maxDD,   "Worst-Case Drawdown",   "text-red-400"],
                [persona.outcome.sharpe,  "Sharpe Ratio Range",    "text-amber-300"],
                [persona.outcome.ret,     "Expected Annual Return", "text-purple-300"],
              ].map(([v, l, cls]) => (
                <div key={l} className="rounded-xl border border-blue-900/40 bg-black/30 p-2.5">
                  <div className={`text-sm font-bold ${cls}`}>{v}</div>
                  <div className="text-[10px] text-gray-600 mt-0.5">{l}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 border-t border-blue-900/40 pt-2.5 text-[11px] italic text-gray-500">
              ℹ️ {persona.outcome.note}
            </p>
          </div>

          {/* Recommendations — MF + Stocks side by side */}
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
            <p className="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-gray-500">Recommended Portfolio</p>
            <p className="mb-3 text-[10px] text-gray-600">
              Ranked by live momentum scores · click any row to expand · {fmtInr(corpus)} to invest
            </p>

            {(mfPicks.length === 0 && stockPicks.length === 0) ? (
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
