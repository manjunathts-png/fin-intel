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
function fmtNum(v, d = 2) {
  if (v == null) return "—";
  return v.toFixed(d);
}
function fmtPP(v, d = 1) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(d)}pp`;
}
function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
function fundAge(navStartDate) {
  if (!navStartDate) return null;
  const start = new Date(navStartDate);
  const years = (Date.now() - start.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  return years.toFixed(1);
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

function sharpeColor(s) {
  if (s == null) return "text-gray-500";
  if (s >= 1.5) return "text-green-400";
  if (s >= 1)   return "text-green-500";
  if (s >= 0.5) return "text-yellow-400";
  if (s >= 0)   return "text-orange-400";
  return "text-red-400";
}
function ddColor(dd) {
  if (dd == null) return "text-gray-500";
  if (dd >= -10) return "text-green-400";
  if (dd >= -20) return "text-yellow-400";
  if (dd >= -30) return "text-orange-400";
  return "text-red-400";
}
function consColor(c) {
  if (c == null) return "text-gray-500";
  if (c >= 80) return "text-green-400";
  if (c >= 60) return "text-yellow-400";
  if (c >= 40) return "text-orange-400";
  return "text-red-400";
}
function alphaColor(a) {
  if (a == null) return "text-gray-500";
  if (a >= 5)  return "text-lime-400 font-semibold";
  if (a >= 0)  return "text-green-400";
  if (a >= -5) return "text-orange-400";
  return "text-red-400";
}
function cagrColor(v) {
  if (v == null) return "text-gray-500";
  if (v >= 18) return "text-green-400 font-semibold";
  if (v >= 12) return "text-green-400";
  if (v >= 8)  return "text-yellow-400";
  if (v >= 0)  return "text-orange-400";
  return "text-red-400";
}

// ─── Tab navigation ───────────────────────────────────────────────────────────

const TABS = [
  { key: "category",   label: "📊 Category Radar",     desc: "Categories ranked by long-term return & risk" },
  { key: "riskAdj",    label: "🎯 Risk-Adjusted",      desc: "All funds sorted by Sharpe / Calmar / Consistency" },
  { key: "compounders",label: "🏆 Long-Term Compounders", desc: "Funds with the highest 5Y/10Y CAGR" },
];

// ─── Tab 1: Category Radar (enhanced) ─────────────────────────────────────────

function CategoryRow({ cat, isExpanded, onToggle }) {
  const m = cat.median;
  const b = cat.benchmark;
  const badge = zBadge(m.z1w);
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer border-t border-gray-700 bg-gray-900 hover:bg-gray-800/70">
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <span className={`text-xs transition-transform ${isExpanded ? "rotate-90" : ""}`}>▶</span>
            <span className="font-semibold text-gray-100">{cat.category}</span>
            {badge && <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${badge.cls}`}>{badge.label}</span>}
            <span className="text-xs text-gray-600">({cat.fundCount})</span>
          </div>
          {b && (
            <div className="mt-0.5 text-[10px] text-gray-600">
              vs <span className="text-gray-500">{b.label}</span>
            </div>
          )}
        </td>
        {/* Short-term momentum (recent trend) */}
        <td className={`px-2 py-3 text-center tabular-nums text-xs font-medium ${heatColor(m.ret1w, 5)}`}>{fmt(m.ret1w)}</td>
        <td className={`px-2 py-3 text-center tabular-nums text-xs font-medium ${heatColor(m.ret1m, 10)}`}>{fmt(m.ret1m)}</td>
        <td className={`px-2 py-3 text-center tabular-nums text-xs font-medium ${heatColor(m.ret3m, 18)}`}>{fmt(m.ret3m)}</td>
        <td className={`px-2 py-3 text-center tabular-nums text-xs font-medium ${heatColor(m.ret6m, 25)}`}>{fmt(m.ret6m)}</td>
        {/* Long-term CAGR */}
        <td className={`px-2 py-3 text-center tabular-nums text-sm font-medium ${heatColor(m.ret1y, 25)}`}>{fmt(m.ret1y)}</td>
        <td className={`px-2 py-3 text-center tabular-nums text-sm font-medium ${heatColor(m.cagr3y, 25)}`}>{fmt(m.cagr3y)}</td>
        <td className={`px-2 py-3 text-center tabular-nums text-sm font-medium ${heatColor(m.cagr5y, 25)}`}>{fmt(m.cagr5y)}</td>
        <td className={`px-2 py-3 text-center tabular-nums text-sm font-medium ${heatColor(m.cagr10y, 25)}`}>{fmt(m.cagr10y)}</td>
        {/* Risk / quality */}
        <td className={`px-2 py-3 text-center tabular-nums text-sm font-bold ${sharpeColor(m.sharpe)}`}>{fmtNum(m.sharpe)}</td>
        <td className={`px-2 py-3 text-center tabular-nums text-sm ${ddColor(m.maxDd)}`}>{fmt(m.maxDd)}</td>
        <td className={`px-2 py-3 text-center tabular-nums text-sm ${consColor(m.consistency)}`}>{fmtNum(m.consistency, 0)}%</td>
        <td className={`px-2 py-3 text-center tabular-nums text-sm font-medium ${alphaColor(m.alpha5y)}`}>{fmtPP(m.alpha5y)}</td>
      </tr>
      {isExpanded && cat.funds.map((f) => (
        <FundExpandedRow key={f.code} fund={f} />
      ))}
    </>
  );
}

function FundExpandedRow({ fund }) {
  const age = fundAge(fund.navStartDate);
  return (
    <tr className="border-t border-gray-800/60 bg-gray-900/40 hover:bg-gray-800/40">
      <td className="py-2.5 pl-10 pr-3">
        <div className="flex flex-col">
          <span className="text-xs font-medium text-gray-200">{fund.label}</span>
          <div className="flex gap-2 text-[10px] text-gray-600">
            {age && <span>{age}Y history</span>}
            {fund.latestNav && <span>NAV ₹{fund.latestNav.toFixed(2)}</span>}
            {fund.benchmarkLabel && <span className="text-gray-700">vs {fund.benchmarkLabel}</span>}
          </div>
        </div>
      </td>
      <td className={`px-2 py-2.5 text-center tabular-nums text-[11px] ${cagrColor(fund.ret1w)}`}>{fmt(fund.ret1w)}</td>
      <td className={`px-2 py-2.5 text-center tabular-nums text-[11px] ${cagrColor(fund.ret1m)}`}>{fmt(fund.ret1m)}</td>
      <td className={`px-2 py-2.5 text-center tabular-nums text-[11px] ${cagrColor(fund.ret3m)}`}>{fmt(fund.ret3m)}</td>
      <td className={`px-2 py-2.5 text-center tabular-nums text-[11px] ${cagrColor(fund.ret6m)}`}>{fmt(fund.ret6m)}</td>
      <td className={`px-2 py-2.5 text-center tabular-nums text-xs ${cagrColor(fund.ret1y)}`}>{fmt(fund.ret1y)}</td>
      <td className={`px-2 py-2.5 text-center tabular-nums text-xs ${cagrColor(fund.cagr3y)}`}>{fmt(fund.cagr3y)}</td>
      <td className={`px-2 py-2.5 text-center tabular-nums text-xs ${cagrColor(fund.cagr5y)}`}>{fmt(fund.cagr5y)}</td>
      <td className={`px-2 py-2.5 text-center tabular-nums text-xs ${cagrColor(fund.cagr10y)}`}>{fmt(fund.cagr10y)}</td>
      <td className={`px-2 py-2.5 text-center tabular-nums text-xs ${sharpeColor(fund.sharpe)}`}>{fmtNum(fund.sharpe)}</td>
      <td className={`px-2 py-2.5 text-center tabular-nums text-xs ${ddColor(fund.maxDd)}`}>{fmt(fund.maxDd)}</td>
      <td className={`px-2 py-2.5 text-center tabular-nums text-xs ${consColor(fund.consistency)}`}>{fmtNum(fund.consistency, 0)}%</td>
      <td className={`px-2 py-2.5 text-center tabular-nums text-xs ${alphaColor(fund.alpha5y)}`}>{fmtPP(fund.alpha5y)}</td>
    </tr>
  );
}

function HotColdStrip({ categories }) {
  // Top performers by 5Y (durable winners)
  const top5y = [...categories].sort((a, b) => (b.median.cagr5y ?? -99) - (a.median.cagr5y ?? -99)).slice(0, 3);
  // Top performers by 1M / 3M (recent momentum)
  const topRecent = [...categories]
    .filter((c) => c.median.ret3m != null)
    .sort((a, b) => (b.median.ret3m ?? -99) - (a.median.ret3m ?? -99))
    .slice(0, 3);
  // Categories where recent has diverged from long-term: 5Y > 12% but 3M < 0
  // (these are the "MFs may not be preferred anymore" candidates)
  const reversing = [...categories]
    .filter((c) => (c.median.cagr5y ?? 0) >= 12 && (c.median.ret3m ?? 0) <= -1)
    .sort((a, b) => (a.median.ret3m ?? 0) - (b.median.ret3m ?? 0))
    .slice(0, 4);

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <div className="rounded-xl border border-green-800/50 bg-green-900/15 p-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-green-400">
          🏆 Top categories by 5Y CAGR
        </div>
        {top5y.map((c) => (
          <div key={c.category} className="flex items-center justify-between border-t border-green-900/30 py-1.5 first:border-0">
            <span className="text-sm text-gray-200">{c.category}</span>
            <div className="flex items-center gap-3 text-xs">
              <span className={alphaColor(c.median.alpha5y)}>{fmtPP(c.median.alpha5y)}α</span>
              <span className={`font-semibold tabular-nums ${cagrColor(c.median.cagr5y)}`}>{fmt(c.median.cagr5y)}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-blue-800/50 bg-blue-900/15 p-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-blue-400">
          ⚡ Hottest recent (3M)
        </div>
        {topRecent.map((c) => (
          <div key={c.category} className="flex items-center justify-between border-t border-blue-900/30 py-1.5 first:border-0">
            <span className="text-sm text-gray-200">{c.category}</span>
            <div className="flex items-center gap-3 text-xs">
              <span className={`tabular-nums ${cagrColor(c.median.ret1m)}`}>{fmt(c.median.ret1m)} 1M</span>
              <span className={`font-semibold tabular-nums ${cagrColor(c.median.ret3m)}`}>{fmt(c.median.ret3m)}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-amber-800/50 bg-amber-900/15 p-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-400">
          ⚠ Long-term winners losing steam (5Y ≥ 12%, 3M ≤ −1%)
        </div>
        {reversing.length === 0 ? (
          <div className="py-1.5 text-xs text-gray-600 italic">No category is clearly reversing right now.</div>
        ) : reversing.map((c) => (
          <div key={c.category} className="flex items-center justify-between border-t border-amber-900/30 py-1.5 first:border-0">
            <span className="text-sm text-gray-200">{c.category}</span>
            <div className="flex items-center gap-3 text-xs">
              <span className="tabular-nums text-gray-500">{fmt(c.median.cagr5y)} 5Y</span>
              <span className={`font-semibold tabular-nums ${cagrColor(c.median.ret3m)}`}>{fmt(c.median.ret3m)} 3M</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CategoryRadar({ categories }) {
  const [expanded, setExpanded] = useState(new Set());
  const [sort, setSort] = useState({ key: "cagr5y", dir: "desc" });

  const sorted = useMemo(() => {
    return [...categories].sort((a, b) => {
      const av = a.median?.[sort.key] ?? -Infinity;
      const bv = b.median?.[sort.key] ?? -Infinity;
      return sort.dir === "desc" ? bv - av : av - bv;
    });
  }, [categories, sort]);

  function clickHeader(key) {
    setSort((prev) => prev.key === key ? { key, dir: prev.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  }
  function SortArrow({ col }) {
    if (sort.key !== col) return <span className="ml-0.5 text-gray-600">⇅</span>;
    return <span className="ml-0.5 text-blue-400">{sort.dir === "desc" ? "↓" : "↑"}</span>;
  }

  return (
    <div className="space-y-4">
      <HotColdStrip categories={categories} />

      <div className="overflow-x-auto rounded-xl border border-gray-800 shadow-xl">
        <table className="w-full border-collapse text-sm min-w-[1280px]">
          <thead className="bg-gray-800/80">
            <tr>
              <th rowSpan="2" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 border-r border-gray-700/50">Category</th>
              <th colSpan="4" className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-wider text-blue-400/80 border-b border-gray-700/40">Recent trend</th>
              <th colSpan="4" className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-wider text-purple-400/80 border-b border-gray-700/40">Long-term CAGR</th>
              <th colSpan="4" className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-wider text-emerald-400/80 border-b border-gray-700/40">Risk & alpha</th>
            </tr>
            <tr>
              <th onClick={() => clickHeader("ret1w")}     className="cursor-pointer px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white">1W<SortArrow col="ret1w" /></th>
              <th onClick={() => clickHeader("ret1m")}     className="cursor-pointer px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white">1M<SortArrow col="ret1m" /></th>
              <th onClick={() => clickHeader("ret3m")}     className="cursor-pointer px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white">3M<SortArrow col="ret3m" /></th>
              <th onClick={() => clickHeader("ret6m")}     className="cursor-pointer px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white">6M<SortArrow col="ret6m" /></th>
              <th onClick={() => clickHeader("ret1y")}     className="cursor-pointer px-2 py-2 text-center text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-white">1Y<SortArrow col="ret1y" /></th>
              <th onClick={() => clickHeader("cagr3y")}    className="cursor-pointer px-2 py-2 text-center text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-white">3Y CAGR<SortArrow col="cagr3y" /></th>
              <th onClick={() => clickHeader("cagr5y")}    className="cursor-pointer px-2 py-2 text-center text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-white">5Y CAGR<SortArrow col="cagr5y" /></th>
              <th onClick={() => clickHeader("cagr10y")}   className="cursor-pointer px-2 py-2 text-center text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-white">10Y CAGR<SortArrow col="cagr10y" /></th>
              <th onClick={() => clickHeader("sharpe")}    className="cursor-pointer px-2 py-2 text-center text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-white" title="Sharpe Ratio (>1 = good, vs 7% risk-free)">Sharpe<SortArrow col="sharpe" /></th>
              <th onClick={() => clickHeader("maxDd")}     className="cursor-pointer px-2 py-2 text-center text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-white" title="Max Drawdown over last 5Y">Max DD<SortArrow col="maxDd" /></th>
              <th onClick={() => clickHeader("consistency")} className="cursor-pointer px-2 py-2 text-center text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-white" title="% of rolling 12M periods with CAGR ≥ 12%">Consis.<SortArrow col="consistency" /></th>
              <th onClick={() => clickHeader("alpha5y")}   className="cursor-pointer px-2 py-2 text-center text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-white" title="5Y CAGR minus benchmark CAGR (alpha)">α 5Y<SortArrow col="alpha5y" /></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <CategoryRow
                key={c.category}
                cat={c}
                isExpanded={expanded.has(c.category)}
                onToggle={() => setExpanded((p) => {
                  const n = new Set(p);
                  n.has(c.category) ? n.delete(c.category) : n.add(c.category);
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

// ─── Tab 2: Risk-Adjusted (sortable + filterable fund table) ─────────────────

function RiskAdjusted({ categories }) {
  const [sort,         setSort]         = useState({ key: "sharpe", dir: "desc" });
  const [catFilter,    setCatFilter]    = useState("");
  const [minSharpe,    setMinSharpe]    = useState(0);
  const [minConsis,    setMinConsis]    = useState(0);
  const [pageSize,     setPageSize]     = useState(50);

  // Flatten all funds with category attached
  const funds = useMemo(() => {
    const out = [];
    for (const c of categories) {
      for (const f of c.funds) out.push({ ...f, category: c.category });
    }
    return out;
  }, [categories]);

  const filtered = useMemo(() => {
    let r = funds;
    if (catFilter)    r = r.filter((f) => f.category === catFilter);
    if (minSharpe > 0) r = r.filter((f) => (f.sharpe ?? -99) >= minSharpe);
    if (minConsis > 0) r = r.filter((f) => (f.consistency ?? 0) >= minConsis);
    const dir = sort.dir === "desc" ? -1 : 1;
    return [...r].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return av.localeCompare(bv) * dir;
      return (bv - av) * (dir === 1 ? -1 : 1);
    });
  }, [funds, catFilter, minSharpe, minConsis, sort]);

  const visible = filtered.slice(0, pageSize);

  function clickHeader(key) {
    setSort((prev) => prev.key === key ? { key, dir: prev.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  }
  function SortArrow({ col }) {
    if (sort.key !== col) return <span className="ml-0.5 text-gray-600">⇅</span>;
    return <span className="ml-0.5 text-blue-400">{sort.dir === "desc" ? "↓" : "↑"}</span>;
  }

  const categoryOpts = useMemo(() => [...new Set(funds.map((f) => f.category))].sort(), [funds]);

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-gray-800 bg-gray-900 p-3 flex flex-wrap items-center gap-3">
        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
          className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">All categories</option>
          {categoryOpts.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500">Min Sharpe</label>
          <input
            type="range" min="0" max="2" step="0.1" value={minSharpe}
            onChange={(e) => setMinSharpe(Number(e.target.value))}
            className="w-28 accent-blue-500"
          />
          <span className="w-8 text-xs tabular-nums text-blue-400">{minSharpe.toFixed(1)}</span>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500">Min Consistency</label>
          <input
            type="range" min="0" max="100" step="5" value={minConsis}
            onChange={(e) => setMinConsis(Number(e.target.value))}
            className="w-28 accent-blue-500"
          />
          <span className="w-10 text-xs tabular-nums text-blue-400">{minConsis}%</span>
        </div>

        <div className="ml-auto text-xs text-gray-500">
          {filtered.length} fund{filtered.length === 1 ? "" : "s"} match · showing {visible.length}
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-gray-800">
        <table className="w-full border-collapse text-xs min-w-[1400px]">
          <thead className="bg-gray-800/80">
            <tr>
              <th className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">#</th>
              <th onClick={() => clickHeader("label")}      className="cursor-pointer px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white">Fund<SortArrow col="label" /></th>
              <th onClick={() => clickHeader("category")}   className="cursor-pointer px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white">Category<SortArrow col="category" /></th>
              <th onClick={() => clickHeader("ret1w")}      className="cursor-pointer px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-blue-400/80 hover:text-white">1W<SortArrow col="ret1w" /></th>
              <th onClick={() => clickHeader("ret1m")}      className="cursor-pointer px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-blue-400/80 hover:text-white">1M<SortArrow col="ret1m" /></th>
              <th onClick={() => clickHeader("ret3m")}      className="cursor-pointer px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-blue-400/80 hover:text-white">3M<SortArrow col="ret3m" /></th>
              <th onClick={() => clickHeader("ret6m")}      className="cursor-pointer px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-blue-400/80 hover:text-white">6M<SortArrow col="ret6m" /></th>
              <th onClick={() => clickHeader("ret1y")}      className="cursor-pointer px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white">1Y<SortArrow col="ret1y" /></th>
              <th onClick={() => clickHeader("cagr3y")}     className="cursor-pointer px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white">3Y<SortArrow col="cagr3y" /></th>
              <th onClick={() => clickHeader("cagr5y")}     className="cursor-pointer px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white">5Y<SortArrow col="cagr5y" /></th>
              <th onClick={() => clickHeader("cagr10y")}    className="cursor-pointer px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white">10Y<SortArrow col="cagr10y" /></th>
              <th onClick={() => clickHeader("sharpe")}     className="cursor-pointer px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white" title="Sharpe Ratio (>1 = good)">Sharpe<SortArrow col="sharpe" /></th>
              <th onClick={() => clickHeader("sortino")}    className="cursor-pointer px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white" title="Sortino (downside-only)">Sortino<SortArrow col="sortino" /></th>
              <th onClick={() => clickHeader("calmar")}     className="cursor-pointer px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white" title="Calmar = return ÷ max DD">Calmar<SortArrow col="calmar" /></th>
              <th onClick={() => clickHeader("maxDd")}      className="cursor-pointer px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white" title="Max Drawdown (5Y)">MaxDD<SortArrow col="maxDd" /></th>
              <th onClick={() => clickHeader("volatility")} className="cursor-pointer px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white" title="Annualized volatility">σ<SortArrow col="volatility" /></th>
              <th onClick={() => clickHeader("consistency")} className="cursor-pointer px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white" title="% rolling 12M >= 12%">Consis.<SortArrow col="consistency" /></th>
              <th onClick={() => clickHeader("alpha5y")}    className="cursor-pointer px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-400 hover:text-white">α 5Y<SortArrow col="alpha5y" /></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((f, i) => (
              <tr key={f.code} className="border-t border-gray-800/60 hover:bg-gray-800/40">
                <td className="px-2 py-2 tabular-nums text-gray-600">{i + 1}</td>
                <td className="px-2 py-2">
                  <div className="text-gray-200 text-[11px]">{f.label}</div>
                  {f.navStartDate && (
                    <div className="text-[9px] text-gray-600">{fundAge(f.navStartDate)}Y history</div>
                  )}
                </td>
                <td className="px-2 py-2 text-gray-500 text-[10px]">{f.category}</td>
                <td className={`px-2 py-2 text-right tabular-nums ${cagrColor(f.ret1w)}`}>{fmt(f.ret1w)}</td>
                <td className={`px-2 py-2 text-right tabular-nums ${cagrColor(f.ret1m)}`}>{fmt(f.ret1m)}</td>
                <td className={`px-2 py-2 text-right tabular-nums ${cagrColor(f.ret3m)}`}>{fmt(f.ret3m)}</td>
                <td className={`px-2 py-2 text-right tabular-nums ${cagrColor(f.ret6m)}`}>{fmt(f.ret6m)}</td>
                <td className={`px-2 py-2 text-right tabular-nums ${cagrColor(f.ret1y)}`}>{fmt(f.ret1y)}</td>
                <td className={`px-2 py-2 text-right tabular-nums ${cagrColor(f.cagr3y)}`}>{fmt(f.cagr3y)}</td>
                <td className={`px-2 py-2 text-right tabular-nums ${cagrColor(f.cagr5y)}`}>{fmt(f.cagr5y)}</td>
                <td className={`px-2 py-2 text-right tabular-nums ${cagrColor(f.cagr10y)}`}>{fmt(f.cagr10y)}</td>
                <td className={`px-2 py-2 text-right tabular-nums font-bold ${sharpeColor(f.sharpe)}`}>{fmtNum(f.sharpe)}</td>
                <td className={`px-2 py-2 text-right tabular-nums ${sharpeColor(f.sortino)}`}>{fmtNum(f.sortino)}</td>
                <td className="px-2 py-2 text-right tabular-nums text-gray-300">{fmtNum(f.calmar)}</td>
                <td className={`px-2 py-2 text-right tabular-nums ${ddColor(f.maxDd)}`}>{fmt(f.maxDd)}</td>
                <td className="px-2 py-2 text-right tabular-nums text-gray-400">{fmtNum(f.volatility, 1)}%</td>
                <td className={`px-2 py-2 text-right tabular-nums ${consColor(f.consistency)}`}>{fmtNum(f.consistency, 0)}%</td>
                <td className={`px-2 py-2 text-right tabular-nums ${alphaColor(f.alpha5y)}`}>{fmtPP(f.alpha5y)}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan="18" className="px-3 py-12 text-center text-gray-600 text-sm">No funds match the filters.</td></tr>
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

// ─── Tab 3: Long-Term Compounders ─────────────────────────────────────────────

function Compounders({ categories }) {
  const [horizon,      setHorizon]      = useState("cagr10y"); // cagr5y | cagr10y
  const [minConsis,    setMinConsis]    = useState(50);

  const funds = useMemo(() => {
    const out = [];
    for (const c of categories) for (const f of c.funds) out.push({ ...f, category: c.category });
    return out;
  }, [categories]);

  const ranked = useMemo(() => {
    return funds
      .filter((f) => f[horizon] != null && f[horizon] > 0)
      .filter((f) => (f.consistency ?? 0) >= minConsis)
      .sort((a, b) => (b[horizon] ?? 0) - (a[horizon] ?? 0));
  }, [funds, horizon, minConsis]);

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-purple-900/40 bg-purple-900/10 p-4 space-y-2">
        <div className="text-sm font-semibold text-purple-200">🏆 Long-Term Compounders</div>
        <p className="text-xs text-gray-500">
          Funds with the highest long-term CAGR <strong>and</strong> high rolling-period consistency.
          A high CAGR with weak consistency means lucky timing — both together signal durable compounding.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <div className="flex overflow-hidden rounded-xl border border-purple-700/40">
            {[["cagr10y","10Y CAGR"], ["cagr5y","5Y CAGR"]].map(([k, label]) => (
              <button key={k} onClick={() => setHorizon(k)}
                className={`px-3 py-1.5 text-xs font-medium transition ${horizon === k ? "bg-purple-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">Min Consistency</label>
            <input type="range" min="0" max="100" step="5" value={minConsis}
              onChange={(e) => setMinConsis(Number(e.target.value))}
              className="w-32 accent-purple-500" />
            <span className="w-10 text-xs tabular-nums text-purple-300">{minConsis}%</span>
          </div>
          <div className="ml-auto text-xs text-gray-500">{ranked.length} funds match</div>
        </div>
      </div>

      <div className="space-y-2">
        {ranked.slice(0, 25).map((f, i) => (
          <div key={f.code} className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-bold text-purple-400">#{i + 1}</span>
                  <span className="font-semibold text-gray-100">{f.label}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400">{f.category}</span>
                  {f.navStartDate && (
                    <span className="text-[10px] text-gray-600">{fundAge(f.navStartDate)}Y track record</span>
                  )}
                  {f.benchmarkLabel && (
                    <span className="text-[10px] text-gray-700">vs {f.benchmarkLabel}</span>
                  )}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className={`text-2xl font-bold tabular-nums ${cagrColor(f[horizon])}`}>
                  {fmt(f[horizon])}
                </div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wider">{horizon === "cagr10y" ? "10Y" : "5Y"} CAGR</div>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2 text-[10px] sm:grid-cols-6">
              <Stat label="1Y" value={fmt(f.ret1y)} color={cagrColor(f.ret1y)} />
              <Stat label="3Y CAGR" value={fmt(f.cagr3y)} color={cagrColor(f.cagr3y)} />
              <Stat label="Sharpe" value={fmtNum(f.sharpe)} color={sharpeColor(f.sharpe)} />
              <Stat label="Max DD" value={fmt(f.maxDd)} color={ddColor(f.maxDd)} />
              <Stat label="Consistency" value={`${fmtNum(f.consistency, 0)}%`} color={consColor(f.consistency)} />
              <Stat label="α 5Y" value={fmtPP(f.alpha5y)} color={alphaColor(f.alpha5y)} />
            </div>
          </div>
        ))}
        {ranked.length === 0 && (
          <EmptyState msg="No funds match — try lowering the consistency filter." />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div className="rounded-lg bg-gray-800/50 px-2 py-1.5">
      <div className="text-[9px] text-gray-600 uppercase tracking-wider">{label}</div>
      <div className={`text-xs font-bold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function EmptyState({ msg }) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-800 p-8 text-center text-sm text-gray-600">{msg}</div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function MfRadar() {
  const { user } = useAuth();
  const [data,    setData]    = useState(null);
  const [builtAt, setBuiltAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [tab,     setTab]     = useState("category");

  useEffect(() => {
    supabase.from("radar_cache").select("data,built_at").eq("key", "mf_radar").single()
      .then(({ data: row, error: err }) => {
        if (err) { setError(err.message); return; }
        setData(row.data);
        setBuiltAt(row.built_at);
      })
      .finally(() => setLoading(false));
  }, []);

  function switchTab(k) {
    setTab(k);
    trackEvent(user, `tab:${k}`, "/mf");
  }

  if (loading) return (
    <div className="flex flex-col items-center justify-center gap-3 py-24">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      <p className="text-sm text-gray-400">Loading…</p>
    </div>
  );
  if (error) return <EmptyState msg={`Error: ${error}`} />;
  if (!data) return <EmptyState msg="No data yet — run the MF refresh job." />;

  const fundCount = data.categories.reduce((s, c) => s + c.fundCount, 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">MF Momentum Radar</h1>
        <p className="mt-0.5 text-xs text-gray-500">
          {fundCount} funds · {data.categories.length} categories · benchmarks: {Object.keys(data.benchmarks ?? {}).filter((k) => data.benchmarks[k]).length}
          {builtAt && <> · updated {timeAgo(builtAt)}</>}
        </p>
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

      {tab === "category"    && <CategoryRadar categories={data.categories} />}
      {tab === "riskAdj"     && <RiskAdjusted  categories={data.categories} />}
      {tab === "compounders" && <Compounders   categories={data.categories} />}

      {data.warnings?.length > 0 && (
        <details className="text-xs text-gray-600">
          <summary className="cursor-pointer hover:text-gray-400">{data.warnings.length} warning(s)</summary>
          <ul className="mt-2 list-disc pl-5">
            {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
