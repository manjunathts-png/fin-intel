import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../hooks/useAuth";
import { trackEvent } from "../lib/analytics";

// ─── Shared utilities ─────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function fmt(v, d = 1) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
}
function fmtPrice(v) { return v == null ? "—" : `₹${v.toLocaleString("en-IN")}`; }
function fmtMcap(cr) {
  if (cr == null) return "—";
  if (cr >= 1e5) return `₹${(cr / 1e5).toFixed(2)}L Cr`;
  if (cr >= 1e3) return `₹${(cr / 1e3).toFixed(1)}K Cr`;
  return `₹${cr.toLocaleString("en-IN")} Cr`;
}
function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
function median(arr) {
  const s = [...arr].filter((v) => v != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(arr) {
  const s = arr.filter((v) => v != null);
  return s.length ? s.reduce((x, y) => x + y, 0) / s.length : null;
}

function heatColor(value, range) {
  if (value == null) return "bg-gray-800 text-gray-500";
  const ratio = clamp(value / range, -1, 1);
  if (ratio >= 0.6)  return "bg-green-700 text-green-100";
  if (ratio >= 0.25) return "bg-green-800 text-green-200";
  if (ratio >= 0.05) return "bg-green-900/70 text-green-300";
  if (ratio <= -0.6) return "bg-red-700 text-red-100";
  if (ratio <= -0.25)return "bg-red-800 text-red-200";
  if (ratio <= -0.05)return "bg-red-900/70 text-red-300";
  return "bg-gray-800 text-gray-400";
}
function zBadge(z) {
  if (z == null) return null;
  if (z >= 2)  return { label: "🔥 Hot",   cls: "bg-orange-500 text-white" };
  if (z >= 1)  return { label: "↑ Rising", cls: "bg-green-700 text-green-100" };
  if (z <= -2) return { label: "❄ Cold",   cls: "bg-blue-800 text-blue-200" };
  if (z <= -1) return { label: "↓ Fading", cls: "bg-red-800 text-red-200" };
  return null;
}
function scoreColor(s) {
  if (s == null) return "text-gray-400";
  if (s >= 75) return "text-green-400";
  if (s >= 50) return "text-yellow-400";
  if (s >= 25) return "text-blue-400";
  return "text-gray-500";
}
function scoreBg(s) {
  if (s == null) return "bg-gray-800";
  if (s >= 75) return "bg-gradient-to-br from-green-700 to-green-500";
  if (s >= 50) return "bg-gradient-to-br from-yellow-700 to-yellow-500";
  if (s >= 25) return "bg-gradient-to-br from-blue-700 to-blue-500";
  return "bg-gradient-to-br from-gray-700 to-gray-600";
}

const WINDOWS = [
  { key: "ret1w", label: "1W",  range: 5  },
  { key: "ret1m", label: "1M",  range: 15 },
  { key: "ret3m", label: "3M",  range: 25 },
  { key: "ret6m", label: "6M",  range: 40 },
  { key: "ret1y", label: "1Y",  range: 60 },
];

// ─── Signal definitions (used by Hotspots + All Stocks filter) ────────────────

const SIGNAL_DEFS = [
  { key: "volumeShock",      label: "🔊 Volume Shock",  test: (p) => p.volumeShock?.fired,        chipColor: "bg-orange-500/20 text-orange-300 border-orange-600/40" },
  { key: "near52wHigh",      label: "📈 At/near 52W Hi", test: (p) => p.near52wHigh?.fired,        chipColor: "bg-green-500/20 text-green-300 border-green-600/40" },
  { key: "breakout20d",      label: "↗ 20D Breakout",   test: (p) => p.breakout20d?.fired,        chipColor: "bg-green-500/20 text-green-300 border-green-600/40" },
  { key: "breakout50d",      label: "⇗ 50D Breakout",   test: (p) => p.breakout50d?.fired,        chipColor: "bg-emerald-500/20 text-emerald-200 border-emerald-600/40" },
  { key: "goldenCross",      label: "✨ Golden Cross",   test: (p) => p.goldenCross,               chipColor: "bg-emerald-500/20 text-emerald-200 border-emerald-600/40" },
  { key: "macdBullish",      label: "📊 MACD Bull",     test: (p) => p.macdBullish,               chipColor: "bg-cyan-500/20 text-cyan-300 border-cyan-600/40" },
  { key: "bullishEngulfing", label: "🟢 Bull Engulf",   test: (p) => p.bullishEngulfing,          chipColor: "bg-purple-500/20 text-purple-300 border-purple-600/40" },
  { key: "hammer",           label: "🔨 Hammer",        test: (p) => p.hammer,                    chipColor: "bg-purple-500/20 text-purple-300 border-purple-600/40" },
  { key: "gapUp",            label: "↑ Gap Up",        test: (p) => p.gapUp?.fired,              chipColor: "bg-yellow-500/20 text-yellow-200 border-yellow-600/40" },
  { key: "rsiOversold",      label: "RSI Oversold",    test: (p) => p.rsiSignal === "oversold",  chipColor: "bg-blue-500/20 text-blue-300 border-blue-600/40" },
  { key: "highDelivery",     label: "📦 Hi Delivery",   test: (p) => p.highDelivery,              chipColor: "bg-teal-500/20 text-teal-300 border-teal-600/40" },
  { key: "in52wHi",          label: "🚀 NSE 52W Hi",    test: (p) => p.disc?.in52wHi,             chipColor: "bg-pink-500/20 text-pink-200 border-pink-600/50" },
  { key: "blockBuy",         label: "💼 Block Buy",    test: (p) => p.disc?.blockBuy,            chipColor: "bg-fuchsia-500/20 text-fuchsia-200 border-fuchsia-600/50" },
  { key: "bulkBuy",          label: "📦 Bulk Buy",     test: (p) => p.disc?.bulkBuy,             chipColor: "bg-fuchsia-500/20 text-fuchsia-200 border-fuchsia-600/50" },
  { key: "oiLong",           label: "📈 OI Long",      test: (p) => p.disc?.oiLong,              chipColor: "bg-indigo-500/20 text-indigo-300 border-indigo-600/40" },
  { key: "rsVsNifty1M",      label: "≥Nifty 1M",      test: (p) => (p.rsVsNifty1M ?? 0) >= 5,   chipColor: "bg-lime-500/20 text-lime-300 border-lime-600/40" },
  { key: "rsVsNifty3M",      label: "≥Nifty 3M",      test: (p) => (p.rsVsNifty3M ?? 0) >= 10,  chipColor: "bg-lime-500/20 text-lime-300 border-lime-600/40" },
];

function signalChipsForPick(pick, max = 3) {
  return SIGNAL_DEFS.filter((s) => s.test(pick)).slice(0, max);
}

// ─── Build sector aggregates from picks data (Nifty 500 view) ─────────────────

function buildSectorView(allPicks) {
  if (!allPicks?.length) return [];
  const bySector = {};
  for (const p of allPicks) {
    const k = p.sector || "Other";
    if (!bySector[k]) bySector[k] = [];
    bySector[k].push(p);
  }
  const sectors = Object.entries(bySector).map(([sector, stocks]) => {
    // Derive returns from price action (we don't have ret1w/etc per stock in picks
    // payload — but we have changePct (today's %) and ret1w. Other windows we use
    // rsVsNifty bands to estimate sector strength.)
    const med = {
      ret1w: median(stocks.map((s) => s.ret1w)),
      // RS-derived sector momentum
      rs1M:  median(stocks.map((s) => s.rsVsNifty1M)),
      rs3M:  median(stocks.map((s) => s.rsVsNifty3M)),
      rs1Y:  median(stocks.map((s) => s.rsVsNifty1Y)),
    };
    const avgScore = Math.round(mean(stocks.map((s) => s.compositeScore)) ?? 0);
    const topStock = [...stocks].sort((a, b) => b.compositeScore - a.compositeScore)[0];
    // Signal density: count of stocks with score >= 50
    const strongCount = stocks.filter((s) => s.compositeScore >= 50).length;
    const at52wHi     = stocks.filter((s) => s.disc?.in52wHi || s.near52wHigh?.fired).length;
    const outperformingNifty = stocks.filter((s) => (s.rsVsNifty1M ?? 0) >= 5).length;

    return {
      sector,
      stockCount: stocks.length,
      median: med,
      avgScore,
      strongCount,
      at52wHi,
      outperformingNifty,
      topStock,
      stocks: [...stocks].sort((a, b) => b.compositeScore - a.compositeScore),
    };
  });
  // Sort by avg score (signal-weighted hot sectors first)
  return sectors.sort((a, b) => b.avgScore - a.avgScore);
}

// ─── Tab navigation ───────────────────────────────────────────────────────────

const TABS = [
  { key: "sector",   label: "🗺 Sector Radar",    desc: "Sectors ranked by signal density" },
  { key: "all",      label: "🔍 All Stocks",      desc: "Sortable + filterable table" },
  { key: "hotspots", label: "🔥 Signal Hotspots", desc: "Sectors × signals matrix" },
];

// ─── Tab 1: Sector Radar (enhanced) ───────────────────────────────────────────

function SectorRow({ sec, isExpanded, onToggle }) {
  const badge = zBadge(sec.median?.rs1M != null ? sec.median.rs1M / 5 : null);
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer border-t border-gray-700 bg-gray-900 hover:bg-gray-800/70">
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <span className={`text-xs transition-transform ${isExpanded ? "rotate-90" : ""}`}>▶</span>
            <span className="font-semibold text-gray-100">{sec.sector}</span>
            {badge && <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${badge.cls}`}>{badge.label}</span>}
            <span className="text-xs text-gray-600">({sec.stockCount})</span>
          </div>
          {sec.topStock && (
            <div className="mt-0.5 text-[10px] text-gray-600">
              Top: <span className="text-gray-400">{sec.topStock.label}</span>
              <span className={`ml-2 ${scoreColor(sec.topStock.compositeScore)} font-semibold`}>{sec.topStock.compositeScore}</span>
            </div>
          )}
        </td>
        <td className={`px-3 py-3 text-center tabular-nums text-sm font-bold ${scoreColor(sec.avgScore)}`}>
          {sec.avgScore}
        </td>
        <td className="px-3 py-3 text-center tabular-nums text-xs">
          <span className="text-green-400 font-semibold">{sec.strongCount}</span>
          <span className="text-gray-600">/{sec.stockCount}</span>
        </td>
        <td className="px-3 py-3 text-center tabular-nums text-xs">
          {sec.at52wHi > 0 ? <span className="text-pink-300">{sec.at52wHi}</span> : <span className="text-gray-700">—</span>}
        </td>
        <td className="px-3 py-3 text-center tabular-nums text-xs">
          {sec.outperformingNifty > 0
            ? <span className="text-lime-300">{sec.outperformingNifty}</span>
            : <span className="text-gray-700">—</span>}
        </td>
        <td className={`px-3 py-3 text-center tabular-nums text-sm font-medium ${heatColor(sec.median?.rs1M, 10)}`}>
          {fmt(sec.median?.rs1M)}
        </td>
        <td className={`px-3 py-3 text-center tabular-nums text-sm font-medium ${heatColor(sec.median?.rs3M, 20)}`}>
          {fmt(sec.median?.rs3M)}
        </td>
      </tr>
      {isExpanded && sec.stocks.map((s) => (
        <tr key={s.symbol} className="border-t border-gray-800/60 bg-gray-900/40 hover:bg-gray-800/40">
          <td className="py-2.5 pl-10 pr-3">
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-200">{s.label}</span>
                <span className="text-[9px] font-mono text-gray-600">{s.symbol?.replace(".NS","")}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {signalChipsForPick(s, 4).map((sig) => (
                  <span key={sig.key} className={`rounded-full border px-1.5 py-0 text-[9px] font-medium ${sig.chipColor}`}>
                    {sig.label}
                  </span>
                ))}
              </div>
            </div>
          </td>
          <td className={`px-3 py-2.5 text-center tabular-nums text-sm font-bold ${scoreColor(s.compositeScore)}`}>
            {s.compositeScore}
          </td>
          <td className="px-3 py-2.5 text-center tabular-nums text-xs text-gray-500">
            {s.signalCount}
          </td>
          <td className="px-3 py-2.5 text-center tabular-nums text-xs">
            {s.disc?.in52wHi ? <span className="text-pink-300">✓</span> : s.near52wHigh?.fired ? <span className="text-green-400">~</span> : <span className="text-gray-700">—</span>}
          </td>
          <td className="px-3 py-2.5 text-center tabular-nums text-xs">
            {(s.rsVsNifty1M ?? 0) >= 5 ? <span className="text-lime-300">✓</span> : <span className="text-gray-700">—</span>}
          </td>
          <td className={`px-3 py-2.5 text-center tabular-nums text-xs ${(s.rsVsNifty1M ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
            {fmt(s.rsVsNifty1M)}
          </td>
          <td className={`px-3 py-2.5 text-center tabular-nums text-xs ${(s.rsVsNifty3M ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
            {fmt(s.rsVsNifty3M)}
          </td>
        </tr>
      ))}
    </>
  );
}

function SectorRadar({ sectors }) {
  const [expanded, setExpanded] = useState(new Set());
  if (!sectors.length) return <EmptyState msg="Sector view requires stock_picks data. Run the refresh job first." />;

  // Hot sectors strip (top 3 by avg score)
  const hot  = sectors.slice(0, 3);
  const cold = [...sectors].sort((a, b) => a.avgScore - b.avgScore).slice(0, 3);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-green-800/50 bg-green-900/15 p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-green-400">
            🔥 Top sectors by signal density
          </div>
          {hot.map((s) => (
            <div key={s.sector} className="flex items-center justify-between border-t border-green-900/30 py-1.5 first:border-0">
              <span className="text-sm text-gray-200">{s.sector}</span>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-gray-500">{s.strongCount} strong</span>
                <span className={`font-bold tabular-nums ${scoreColor(s.avgScore)}`}>{s.avgScore}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="rounded-2xl border border-red-900/50 bg-red-900/15 p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-red-400">
            ❄ Weakest sectors by signal density
          </div>
          {cold.map((s) => (
            <div key={s.sector} className="flex items-center justify-between border-t border-red-900/30 py-1.5 first:border-0">
              <span className="text-sm text-gray-200">{s.sector}</span>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-gray-500">{s.strongCount} strong</span>
                <span className={`font-bold tabular-nums ${scoreColor(s.avgScore)}`}>{s.avgScore}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-800 shadow-xl">
        <table className="w-full border-collapse text-sm min-w-[820px]">
          <thead className="bg-gray-800/80">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Sector</th>
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-400" title="Average composite score across sector">Avg Score</th>
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-400" title="Stocks with composite ≥ 50">Strong</th>
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-400" title="At or near 52W high">52W Hi</th>
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-400" title="Outperforming Nifty by ≥5pp over 1M">{">"} Nifty</th>
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-400">RS 1M</th>
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-400">RS 3M</th>
            </tr>
          </thead>
          <tbody>
            {sectors.map((s) => (
              <SectorRow
                key={s.sector}
                sec={s}
                isExpanded={expanded.has(s.sector)}
                onToggle={() => setExpanded((p) => {
                  const n = new Set(p);
                  n.has(s.sector) ? n.delete(s.sector) : n.add(s.sector);
                  return n;
                })}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Tab 2: All Stocks (sortable + filterable table) ──────────────────────────

function AllStocks({ picks, sectors }) {
  const [sort,         setSort]         = useState({ key: "compositeScore", dir: "desc" });
  const [sectorFilter, setSectorFilter] = useState("");
  const [minScore,     setMinScore]     = useState(0);
  const [signalFilter, setSignalFilter] = useState(new Set());
  const [expanded,     setExpanded]     = useState(new Set());
  const [pageSize,     setPageSize]     = useState(50);

  const sectorOptions = useMemo(() => {
    const set = new Set(picks.map((p) => p.sector).filter(Boolean));
    return [...set].sort();
  }, [picks]);

  const filtered = useMemo(() => {
    let r = picks;
    if (sectorFilter) r = r.filter((p) => p.sector === sectorFilter);
    if (minScore > 0) r = r.filter((p) => (p.compositeScore ?? 0) >= minScore);
    if (signalFilter.size > 0) {
      r = r.filter((p) => [...signalFilter].every((sig) => {
        const def = SIGNAL_DEFS.find((s) => s.key === sig);
        return def?.test(p);
      }));
    }
    const dir = sort.dir === "desc" ? -1 : 1;
    return [...r].sort((a, b) => {
      const av = getSortVal(a, sort.key);
      const bv = getSortVal(b, sort.key);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return av.localeCompare(bv) * dir;
      return (bv - av) * (dir === 1 ? -1 : 1);
    });
  }, [picks, sectorFilter, minScore, signalFilter, sort]);

  const visible = filtered.slice(0, pageSize);

  function getSortVal(p, key) {
    switch (key) {
      case "label":           return p.label;
      case "sector":          return p.sector;
      case "compositeScore":  return p.compositeScore;
      case "signalCount":     return p.signalCount;
      case "close":           return p.close;
      case "changePct":       return p.changePct;
      case "ret1w":           return p.ret1w;
      case "rsVsNifty1M":     return p.rsVsNifty1M;
      case "rsVsNifty3M":     return p.rsVsNifty3M;
      case "marketCap":       return p.fundamentals?.marketCapCr;
      case "pe":              return p.fundamentals?.trailingPE;
      case "epsGrowth":       return p.fundamentals?.earningsGrowth;
      default: return null;
    }
  }

  function clickHeader(key) {
    setSort((prev) => prev.key === key ? { key, dir: prev.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  }
  function SortArrow({ col }) {
    if (sort.key !== col) return <span className="ml-0.5 text-gray-600">⇅</span>;
    return <span className="ml-0.5 text-blue-400">{sort.dir === "desc" ? "↓" : "↑"}</span>;
  }
  function toggleSignal(key) {
    setSignalFilter((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }
  function toggleRow(sym) {
    setExpanded((s) => {
      const n = new Set(s);
      n.has(sym) ? n.delete(sym) : n.add(sym);
      return n;
    });
  }

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="rounded-2xl border border-gray-800 bg-gray-900 p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={sectorFilter}
            onChange={(e) => setSectorFilter(e.target.value)}
            className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">All sectors</option>
            {sectorOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">Min score</label>
            <input
              type="range" min="0" max="100" step="5" value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              className="w-32 accent-blue-500"
            />
            <span className="w-6 text-xs tabular-nums text-blue-400">{minScore}</span>
          </div>

          <div className="ml-auto text-xs text-gray-500">
            {filtered.length} stock{filtered.length === 1 ? "" : "s"} match · showing {Math.min(visible.length, filtered.length)}
          </div>
        </div>

        {/* Signal filter chips */}
        <div>
          <div className="mb-1.5 text-[10px] text-gray-500 uppercase tracking-wider">Filter by signals (all selected must fire)</div>
          <div className="flex flex-wrap gap-1.5">
            {SIGNAL_DEFS.map((s) => (
              <button
                key={s.key}
                onClick={() => toggleSignal(s.key)}
                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition ${
                  signalFilter.has(s.key)
                    ? s.chipColor
                    : "border-gray-700 bg-gray-800/40 text-gray-500 hover:bg-gray-800"
                }`}
              >
                {s.label}
              </button>
            ))}
            {signalFilter.size > 0 && (
              <button
                onClick={() => setSignalFilter(new Set())}
                className="rounded-full border border-red-800/40 bg-red-900/20 px-2 py-0.5 text-[10px] text-red-400 hover:text-red-300"
              >
                ✕ clear ({signalFilter.size})
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-2xl border border-gray-800">
        <table className="w-full border-collapse text-xs min-w-[920px]">
          <thead className="bg-gray-800/80">
            <tr>
              <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider text-[10px] text-gray-400">#</th>
              <th onClick={() => clickHeader("label")} className="cursor-pointer px-3 py-2 text-left font-semibold uppercase tracking-wider text-[10px] text-gray-400 hover:text-white">Stock<SortArrow col="label" /></th>
              <th onClick={() => clickHeader("sector")} className="cursor-pointer px-3 py-2 text-left font-semibold uppercase tracking-wider text-[10px] text-gray-400 hover:text-white">Sector<SortArrow col="sector" /></th>
              <th onClick={() => clickHeader("compositeScore")} className="cursor-pointer px-3 py-2 text-center font-semibold uppercase tracking-wider text-[10px] text-gray-400 hover:text-white">Score<SortArrow col="compositeScore" /></th>
              <th onClick={() => clickHeader("signalCount")} className="cursor-pointer px-3 py-2 text-center font-semibold uppercase tracking-wider text-[10px] text-gray-400 hover:text-white">Sigs<SortArrow col="signalCount" /></th>
              <th onClick={() => clickHeader("close")} className="cursor-pointer px-3 py-2 text-right font-semibold uppercase tracking-wider text-[10px] text-gray-400 hover:text-white">Price<SortArrow col="close" /></th>
              <th onClick={() => clickHeader("changePct")} className="cursor-pointer px-3 py-2 text-right font-semibold uppercase tracking-wider text-[10px] text-gray-400 hover:text-white">Day<SortArrow col="changePct" /></th>
              <th onClick={() => clickHeader("ret1w")} className="cursor-pointer px-3 py-2 text-right font-semibold uppercase tracking-wider text-[10px] text-gray-400 hover:text-white">1W<SortArrow col="ret1w" /></th>
              <th onClick={() => clickHeader("rsVsNifty1M")} className="cursor-pointer px-3 py-2 text-right font-semibold uppercase tracking-wider text-[10px] text-gray-400 hover:text-white">RS 1M<SortArrow col="rsVsNifty1M" /></th>
              <th onClick={() => clickHeader("rsVsNifty3M")} className="cursor-pointer px-3 py-2 text-right font-semibold uppercase tracking-wider text-[10px] text-gray-400 hover:text-white">RS 3M<SortArrow col="rsVsNifty3M" /></th>
              <th onClick={() => clickHeader("marketCap")} className="cursor-pointer px-3 py-2 text-right font-semibold uppercase tracking-wider text-[10px] text-gray-400 hover:text-white">M.Cap<SortArrow col="marketCap" /></th>
              <th onClick={() => clickHeader("pe")} className="cursor-pointer px-3 py-2 text-right font-semibold uppercase tracking-wider text-[10px] text-gray-400 hover:text-white">P/E<SortArrow col="pe" /></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p, i) => (
              <RowGroup
                key={p.symbol}
                p={p} rank={i + 1}
                expanded={expanded.has(p.symbol)}
                onToggle={() => toggleRow(p.symbol)}
              />
            ))}
            {visible.length === 0 && (
              <tr><td colSpan="11" className="px-3 py-12 text-center text-gray-600 text-sm">No stocks match the current filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {pageSize < filtered.length && (
        <div className="flex justify-center pt-2">
          <button
            onClick={() => setPageSize((p) => Math.min(p + 50, filtered.length))}
            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
          >
            Show 50 more ({filtered.length - pageSize} remaining)
          </button>
        </div>
      )}
    </div>
  );
}

function RowGroup({ p, rank, expanded, onToggle }) {
  const dayCol = (p.changePct ?? 0) >= 0 ? "text-green-400" : "text-red-400";
  return (
    <>
      <tr className="border-t border-gray-800/60 hover:bg-gray-800/40 cursor-pointer" onClick={onToggle}>
        <td className="px-3 py-2 tabular-nums text-gray-600">{rank}</td>
        <td className="px-3 py-2">
          <div className="flex flex-col">
            <span className="font-medium text-gray-200">{p.label}</span>
            <span className="text-[9px] text-gray-600 font-mono">{p.symbol?.replace(".NS","")}</span>
          </div>
        </td>
        <td className="px-3 py-2 text-gray-500 text-[11px]">{p.sector}</td>
        <td className={`px-3 py-2 text-center tabular-nums font-bold ${scoreColor(p.compositeScore)}`}>{p.compositeScore}</td>
        <td className="px-3 py-2 text-center tabular-nums text-gray-400">{p.signalCount}</td>
        <td className="px-3 py-2 text-right tabular-nums text-gray-300">{fmtPrice(p.close)}</td>
        <td className={`px-3 py-2 text-right tabular-nums ${dayCol}`}>{fmt(p.changePct, 2)}</td>
        <td className={`px-3 py-2 text-right tabular-nums ${(p.ret1w ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>{fmt(p.ret1w)}</td>
        <td className={`px-3 py-2 text-right tabular-nums ${(p.rsVsNifty1M ?? 0) >= 5 ? "text-lime-400 font-semibold" : (p.rsVsNifty1M ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
          {p.rsVsNifty1M != null ? `${p.rsVsNifty1M >= 0 ? "+" : ""}${p.rsVsNifty1M.toFixed(1)}` : "—"}
        </td>
        <td className={`px-3 py-2 text-right tabular-nums ${(p.rsVsNifty3M ?? 0) >= 10 ? "text-lime-400 font-semibold" : (p.rsVsNifty3M ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
          {p.rsVsNifty3M != null ? `${p.rsVsNifty3M >= 0 ? "+" : ""}${p.rsVsNifty3M.toFixed(1)}` : "—"}
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-gray-400">{fmtMcap(p.fundamentals?.marketCapCr)}</td>
        <td className="px-3 py-2 text-right tabular-nums text-gray-400">{p.fundamentals?.trailingPE?.toFixed(0) ?? "—"}</td>
      </tr>
      {expanded && (
        <tr className="bg-gray-900/40">
          <td colSpan="11" className="px-4 py-3 border-t border-gray-800/50">
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex flex-wrap gap-1.5">
                {signalChipsForPick(p, 99).map((sig) => (
                  <span key={sig.key} className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${sig.chipColor}`}>
                    {sig.label}
                  </span>
                ))}
                {signalChipsForPick(p, 99).length === 0 && (
                  <span className="text-[10px] text-gray-600 italic">No bullish signals firing.</span>
                )}
              </div>
              <div className="ml-auto text-[10px] text-gray-500 flex flex-wrap gap-3">
                {p.fundamentals?.earningsGrowth != null && <span>EPS Growth <span className="text-gray-300 tabular-nums">{p.fundamentals.earningsGrowth}%</span></span>}
                {p.fundamentals?.returnOnEquity != null && <span>ROE <span className="text-gray-300 tabular-nums">{p.fundamentals.returnOnEquity}%</span></span>}
                {p.deliveryPct != null && <span>Delivery <span className="text-gray-300 tabular-nums">{p.deliveryPct}%</span></span>}
                {p.rsi14 != null && <span>RSI <span className="text-gray-300 tabular-nums">{p.rsi14.toFixed(0)}</span></span>}
                <span>20DMA {p.above20DMA ? <span className="text-green-400">✓</span> : <span className="text-red-400">✕</span>}</span>
                <span>50DMA {p.above50DMA ? <span className="text-green-400">✓</span> : <span className="text-red-400">✕</span>}</span>
                <span>200DMA {p.above200DMA ? <span className="text-green-400">✓</span> : <span className="text-red-400">✕</span>}</span>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Tab 3: Signal Hotspots (sectors × signals heatmap) ───────────────────────

function SignalHotspots({ picks }) {
  const matrix = useMemo(() => {
    const sectors = [...new Set(picks.map((p) => p.sector).filter(Boolean))].sort();
    // For each (sector, signal) cell, count stocks firing
    const cells = {};
    let maxCount = 0;
    for (const sig of SIGNAL_DEFS) {
      cells[sig.key] = {};
      for (const sec of sectors) {
        const cnt = picks.filter((p) => p.sector === sec && sig.test(p)).length;
        cells[sig.key][sec] = cnt;
        if (cnt > maxCount) maxCount = cnt;
      }
    }
    return { sectors, cells, maxCount };
  }, [picks]);

  const [selected, setSelected] = useState(null);

  if (!matrix.sectors.length) return <EmptyState msg="No data to build hotspots." />;

  function cellColor(count) {
    if (!count) return "bg-gray-900";
    const ratio = matrix.maxCount > 0 ? count / matrix.maxCount : 0;
    if (ratio >= 0.75) return "bg-orange-600 text-white";
    if (ratio >= 0.5)  return "bg-orange-700 text-orange-100";
    if (ratio >= 0.25) return "bg-orange-800 text-orange-200";
    return "bg-gray-800 text-gray-400";
  }

  const drilldown = selected
    ? picks.filter((p) => p.sector === selected.sector && SIGNAL_DEFS.find((s) => s.key === selected.sig).test(p))
    : [];

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        Each cell shows how many stocks in that sector are firing that signal. Click any cell to drill down.
      </p>

      <div className="overflow-x-auto rounded-2xl border border-gray-800">
        <table className="border-collapse text-xs">
          <thead className="bg-gray-800/80">
            <tr>
              <th className="sticky left-0 z-10 bg-gray-800 px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">Signal</th>
              {matrix.sectors.map((s) => (
                <th key={s} className="px-2 py-2 text-center text-[9px] font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap">
                  {s.length > 14 ? s.slice(0, 13) + "…" : s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SIGNAL_DEFS.map((sig) => (
              <tr key={sig.key} className="border-t border-gray-800/40">
                <td className="sticky left-0 z-10 bg-gray-900 px-3 py-1.5 text-[11px] text-gray-300 whitespace-nowrap">{sig.label}</td>
                {matrix.sectors.map((sec) => {
                  const cnt = matrix.cells[sig.key][sec];
                  const isSelected = selected?.sig === sig.key && selected?.sector === sec;
                  return (
                    <td
                      key={sec}
                      onClick={() => cnt > 0 && setSelected(isSelected ? null : { sig: sig.key, sector: sec })}
                      className={`px-2 py-1.5 text-center tabular-nums text-xs font-semibold ${cnt > 0 ? "cursor-pointer hover:ring-2 hover:ring-blue-400 hover:ring-inset" : ""} ${cellColor(cnt)} ${isSelected ? "ring-2 ring-blue-400 ring-inset" : ""}`}
                    >
                      {cnt || ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Drill-down */}
      {selected && drilldown.length > 0 && (
        <div className="rounded-2xl border border-blue-800/40 bg-blue-900/10 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-blue-300">
              {SIGNAL_DEFS.find((s) => s.key === selected.sig)?.label} in {selected.sector}
              <span className="ml-2 text-xs text-gray-500">({drilldown.length} stocks)</span>
            </div>
            <button onClick={() => setSelected(null)} className="text-xs text-gray-500 hover:text-gray-300">✕ close</button>
          </div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 md:grid-cols-3">
            {drilldown.slice(0, 20).map((s) => (
              <div key={s.symbol} className="flex items-center justify-between rounded-lg bg-gray-900/60 px-3 py-1.5">
                <div className="min-w-0">
                  <div className="truncate text-xs text-gray-200">{s.label}</div>
                  <div className="text-[9px] font-mono text-gray-600">{s.symbol?.replace(".NS","")}</div>
                </div>
                <div className={`shrink-0 text-sm font-bold tabular-nums ${scoreColor(s.compositeScore)}`}>
                  {s.compositeScore}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────────

function EmptyState({ msg }) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-800 p-8 text-center text-sm text-gray-600">
      {msg}
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function StockRadar() {
  const { user } = useAuth();
  const [picksData, setPicksData] = useState(null);
  const [builtAt,   setBuiltAt]   = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [tab,       setTab]       = useState("sector");

  useEffect(() => {
    supabase.from("radar_cache").select("data,built_at").eq("key", "stock_picks").maybeSingle()
      .then(({ data, error: e }) => {
        if (e) { setError(e.message); return; }
        if (data) {
          setPicksData(data.data);
          setBuiltAt(data.built_at);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  function switchTab(k) {
    setTab(k);
    trackEvent(user, `tab:${k}`, "/stocks");
  }

  const sectors = useMemo(() => buildSectorView(picksData?.all ?? []), [picksData]);
  const picks   = picksData?.all ?? [];

  if (loading) return (
    <div className="flex flex-col items-center justify-center gap-3 py-24">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      <p className="text-sm text-gray-400">Loading…</p>
    </div>
  );
  if (error) return <EmptyState msg={`Error: ${error}`} />;
  if (!picksData) return <EmptyState msg="No data yet — run the stock signals refresh job." />;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Stock Momentum Radar</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            {picks.length} stocks scanned · {sectors.length} sectors · {Object.keys(picksData?.discovery?.highs52w?.reduce((a, x) => ({...a, [x.symbol]: 1}), {}) ?? {}).length} at 52W high
            {builtAt && <> · updated {timeAgo(builtAt)}</>}
          </p>
        </div>
      </div>

      <div className="flex gap-1 rounded-xl bg-gray-900 p-1 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => switchTab(t.key)}
            title={t.desc}
            className={`flex-1 shrink-0 rounded-lg py-2 px-3 text-sm font-medium transition whitespace-nowrap ${
              tab === t.key ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "sector"   && <SectorRadar    sectors={sectors} />}
      {tab === "all"      && <AllStocks      picks={picks} sectors={sectors} />}
      {tab === "hotspots" && <SignalHotspots picks={picks} />}
    </div>
  );
}
