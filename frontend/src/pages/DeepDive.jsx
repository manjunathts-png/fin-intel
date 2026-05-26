import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";

// ── constants ─────────────────────────────────────────────────────────────────

const RISK_FREE = 7; // India 10Y G-Sec proxy (annual %)
const SIP_AMOUNT = 10000; // ₹10K/mo for historical SIP calc

// ── pick builder (same as Simulator) ─────────────────────────────────────────

function buildTopPicks(mfData) {
  return mfData.categories
    .map((cat) => {
      const catZ = cat.median.z1w ?? 0;
      return [...cat.funds]
        .map((f) => ({ ...f, catZ, category: cat.category,
          score: (f.ret1w??0)*0.4+(f.ret1m??0)*0.3+(f.ret3m??0)*0.2+catZ*5*0.1 }))
        .sort((a, b) => b.score - a.score)[0];
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

// ── formatters ────────────────────────────────────────────────────────────────

function fmtInr(n) {
  const neg = n < 0, a = Math.abs(n), s = neg ? "-" : "";
  if (a >= 1e7) return `${s}₹${(a/1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${s}₹${(a/1e5).toFixed(2)} L`;
  return `${s}₹${Math.round(a).toLocaleString("en-IN")}`;
}
function fmtPct(v, d=1) {
  if (v==null) return "—";
  return `${v>=0?"+":""}${v.toFixed(d)}%`;
}
function pctColor(v) { return (v??0) >= 0 ? "text-green-400" : "text-red-400"; }

// ── NAV date parser ───────────────────────────────────────────────────────────

function parseDate(str) { // "DD-MM-YYYY"
  const [d,m,y] = str.split("-");
  return new Date(`${y}-${m}-${d}`);
}

// ── fetch full NAV history ────────────────────────────────────────────────────

async function fetchNavs(code) {
  const res = await fetch(`https://api.mfapi.in/mf/${code}`);
  const json = await res.json();
  // newest first → reverse to oldest first
  const navs = (json.data ?? []).reverse();
  return navs.map(e => ({ date: parseDate(e.date), nav: parseFloat(e.nav) }));
}

// ── analytics ─────────────────────────────────────────────────────────────────

// Monthly return series from daily navs (oldest-first input)
function monthlyReturns(navs) {
  const byMonth = new Map();
  navs.forEach(({ date, nav }) => {
    const key = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;
    byMonth.set(key, nav); // last value per month = month-end
  });
  const sorted = [...byMonth.entries()].sort(([a],[b]) => a.localeCompare(b));
  const rets = [], dates = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][1] > 0 && sorted[i-1][1] > 0) {
      rets.push(sorted[i][1] / sorted[i-1][1] - 1);
      dates.push(sorted[i][0]);
    }
  }
  return { rets, dates };
}

// Rolling CAGR — one data point per month, windows of `months` duration
function rollingReturns(navs, windowMonths) {
  const { rets, dates } = monthlyReturns(navs);
  const results = [];
  for (let i = windowMonths; i <= rets.length; i++) {
    // compound the window
    const compound = rets.slice(i - windowMonths, i)
      .reduce((acc, r) => acc * (1 + r), 1);
    const cagr = (Math.pow(compound, 12 / windowMonths) - 1) * 100;
    results.push({ date: dates[i - 1], cagr });
  }
  return results;
}

// Max drawdown + drawdown series from daily navs
function drawdownAnalysis(navs) {
  let peak = 0, maxDd = 0, ddStart = null, maxDdStart = null, maxDdEnd = null;
  const series = [];
  const periods = []; // { start, trough, depth, recoveryDate }
  let inDd = false, currentDdStart = null, currentTrough = 0, currentTroughDate = null;

  navs.forEach(({ date, nav }) => {
    if (nav > peak) {
      if (inDd && currentTrough / peak - 1 < -0.05) {
        periods.push({
          start: currentDdStart, trough: currentTroughDate,
          depth: (currentTrough / peak - 1) * 100, recovered: date,
          daysToRecover: Math.round((date - currentDdStart) / 86400000),
        });
      }
      peak = nav; inDd = false; currentTrough = nav;
    } else {
      if (!inDd) { inDd = true; currentDdStart = date; currentTrough = nav; currentTroughDate = date; }
      if (nav < currentTrough) { currentTrough = nav; currentTroughDate = date; }
    }
    const dd = peak > 0 ? (nav / peak - 1) * 100 : 0;
    if (dd < maxDd) { maxDd = dd; maxDdStart = currentDdStart; maxDdEnd = date; }
    series.push({ date, dd });
  });

  return { series, maxDd, maxDdStart, maxDdEnd, periods: periods.slice(-8) };
}

// Sharpe & Sortino from monthly returns
function riskMetrics(rets) {
  if (!rets.length) return null;
  const mean = rets.reduce((s,r) => s+r, 0) / rets.length;
  const annMean = (Math.pow(1 + mean, 12) - 1) * 100;
  const variance = rets.reduce((s,r) => s + Math.pow(r - mean, 2), 0) / rets.length;
  const stddev = Math.sqrt(variance);
  const annStd = stddev * Math.sqrt(12) * 100;
  const rfMonthly = RISK_FREE / 100 / 12;
  const sharpe = annStd > 0 ? (annMean - RISK_FREE) / annStd : null;

  const downside = rets.filter(r => r < rfMonthly);
  const downVar = downside.length
    ? downside.reduce((s,r) => s + Math.pow(r - rfMonthly, 2), 0) / rets.length : 0;
  const annDown = Math.sqrt(downVar) * Math.sqrt(12) * 100;
  const sortino = annDown > 0 ? (annMean - RISK_FREE) / annDown : null;

  return { annMean, annStd, sharpe, sortino };
}

// Historical SIP XIRR using Newton-Raphson
function computeXirr(cashflows, dates) {
  const base = dates[0];
  const t = dates.map(d => (d - base) / (365.25 * 86400000));
  function npv(r) { return cashflows.reduce((s,cf,i) => s + cf / Math.pow(1+r, t[i]), 0); }
  function dnpv(r) { return cashflows.reduce((s,cf,i) => s - t[i]*cf / Math.pow(1+r, t[i]+1), 0); }
  let rate = 0.15;
  for (let i = 0; i < 200; i++) {
    const f = npv(rate), df = dnpv(rate);
    if (Math.abs(df) < 1e-14) break;
    const nr = rate - f/df;
    if (Math.abs(nr - rate) < 1e-9) return nr * 100;
    rate = Math.max(-0.99, nr);
  }
  return rate * 100;
}

function historicalSip(navs, years) {
  if (!navs.length) return null;
  const end = navs[navs.length - 1].date;
  const start = new Date(end); start.setFullYear(start.getFullYear() - years);
  const startIdx = navs.findIndex(n => n.date >= start);
  if (startIdx < 0 || navs.length - startIdx < years * 10) return null;

  // find closest NAV to a given date
  function closestNav(d) {
    let best = navs[startIdx];
    for (let i = startIdx; i < navs.length; i++) {
      if (Math.abs(navs[i].date - d) < Math.abs(best.date - d)) best = navs[i];
      if (navs[i].date > d) break;
    }
    return best.nav;
  }

  const cfs = [], cfDates = [];
  let units = 0, months = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const nav = closestNav(new Date(cur));
    units += SIP_AMOUNT / nav;
    cfs.push(-SIP_AMOUNT); cfDates.push(new Date(cur));
    cur.setMonth(cur.getMonth() + 1); months++;
  }
  const finalNav = navs[navs.length-1].nav;
  const value = units * finalNav;
  cfs.push(value); cfDates.push(new Date(end));

  return {
    invested: SIP_AMOUNT * months,
    value,
    gain: value - SIP_AMOUNT * months,
    xirr: computeXirr(cfs, cfDates),
    months,
  };
}

// ── sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }) {
  return (
    <div className="rounded-xl bg-gray-800/60 p-3">
      <div className="mb-1 text-[10px] text-gray-500">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${color ?? "text-white"}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-600 mt-0.5">{sub}</div>}
    </div>
  );
}

function RollingSection({ navs, windowMonths, label }) {
  const data = rollingReturns(navs, windowMonths);
  if (!data.length) return <p className="text-xs text-gray-600">Not enough history for {label} rolling.</p>;

  const cagrs = data.map(d => d.cagr);
  const min = Math.min(...cagrs), max = Math.max(...cagrs);
  const mean = cagrs.reduce((s,v)=>s+v,0) / cagrs.length;
  const pctPos = cagrs.filter(c=>c>0).length / cagrs.length * 100;
  const pct12  = cagrs.filter(c=>c>12).length  / cagrs.length * 100;
  const pct15  = cagrs.filter(c=>c>15).length  / cagrs.length * 100;
  const pct18  = cagrs.filter(c=>c>18).length  / cagrs.length * 100;

  // Bucket histogram: <0, 0-10, 10-15, 15-20, 20-30, >30
  const buckets = [
    { label:"<0%",    count: cagrs.filter(c=>c<0).length    },
    { label:"0–10%",  count: cagrs.filter(c=>c>=0&&c<10).length },
    { label:"10–15%", count: cagrs.filter(c=>c>=10&&c<15).length },
    { label:"15–20%", count: cagrs.filter(c=>c>=15&&c<20).length },
    { label:"20–30%", count: cagrs.filter(c=>c>=20&&c<30).length },
    { label:">30%",   count: cagrs.filter(c=>c>=30).length   },
  ];
  const maxCount = Math.max(...buckets.map(b=>b.count));

  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard label="Average CAGR" value={fmtPct(mean)} color={pctColor(mean)} />
        <StatCard label="Best window" value={fmtPct(max)} color="text-green-400" />
        <StatCard label="Worst window" value={fmtPct(min)} color="text-red-400" />
        <StatCard label="Windows sampled" value={data.length} sub={`each ~${windowMonths}mo`} />
      </div>

      {/* consistency badges */}
      <div className="mb-3 flex flex-wrap gap-2">
        {[["Positive return", pctPos], [">12% CAGR", pct12], [">15% CAGR", pct15], [">18% CAGR", pct18]].map(([lbl,pct]) => (
          <div key={lbl} className="rounded-lg bg-gray-800 px-2.5 py-1.5 text-center">
            <div className={`text-sm font-bold tabular-nums ${pct>=70?"text-green-400":pct>=50?"text-yellow-400":"text-red-400"}`}>
              {pct.toFixed(0)}%
            </div>
            <div className="text-[10px] text-gray-500">{lbl}</div>
          </div>
        ))}
      </div>

      {/* distribution histogram */}
      <div className="space-y-1.5">
        {buckets.map(({ label: bl, count }) => (
          <div key={bl} className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-right text-[10px] text-gray-500">{bl}</span>
            <div className="flex-1 rounded-full bg-gray-800 h-4 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${bl==="<0%"?"bg-red-500/60":bl.startsWith("0")?"bg-yellow-500/60":"bg-green-500/60"}`}
                style={{ width: `${maxCount ? (count/maxCount)*100 : 0}%` }}
              />
            </div>
            <span className="w-8 shrink-0 text-[10px] text-gray-500 tabular-nums">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DrawdownChart({ series }) {
  if (!series.length) return null;
  // Sample for performance: take every Nth point
  const step = Math.max(1, Math.floor(series.length / 120));
  const pts  = series.filter((_,i) => i % step === 0);
  const W = 320, H = 80, PL = 36, PR = 8, PT = 8, PB = 16;
  const cW = W - PL - PR, cH = H - PT - PB;

  const minDd = Math.min(...pts.map(p=>p.dd));
  const xOf = (i) => PL + (i / (pts.length-1)) * cW;
  const yOf = (v) => PT + (1 - v / minDd) * cH;

  const polyline = pts.map((p,i) => `${xOf(i)},${yOf(p.dd)}`).join(" ");
  const area = `${PL},${PT+cH} ` + polyline + ` ${PL+cW},${PT+cH}`;

  // Year labels (date is a Date object, use getFullYear())
  const firstYear = pts[0]?.date?.getFullYear();
  const lastYear  = pts[pts.length-1]?.date?.getFullYear();

  return (
    <svg width={W} height={H} className="text-gray-800 w-full max-w-xs">
      <line x1={PL} x2={PL} y1={PT} y2={PT+cH} stroke="currentColor" strokeWidth="0.5" />
      <line x1={PL} x2={PL+cW} y1={PT+cH} y2={PT+cH} stroke="currentColor" strokeWidth="0.5" />
      {[0, 0.5, 1].map(t => {
        const v = minDd * t, y = yOf(v);
        return <text key={t} x={PL-3} y={y+3} textAnchor="end" fontSize="7" fill="#4b5563">{v.toFixed(0)}%</text>;
      })}
      <text x={PL} y={H-2} fontSize="7" fill="#4b5563">{firstYear}</text>
      <text x={PL+cW} y={H-2} fontSize="7" fill="#4b5563" textAnchor="end">{lastYear}</text>
      <polygon points={area} fill="#ef4444" opacity="0.2" />
      <polyline points={polyline} fill="none" stroke="#ef4444" strokeWidth="1.5" />
    </svg>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export default function DeepDive() {
  const [searchParams] = useSearchParams();
  const incomingCode   = searchParams.get("code");

  const deepDiveRef = useRef(null);   // ref for the analysis section to scroll to

  const [picks,      setPicks]      = useState([]);
  const [allFunds,   setAllFunds]   = useState([]);   // full universe for code lookup
  const [loadingInit,setLoadingInit]= useState(true);
  const [selected,   setSelected]   = useState(null);
  const [navs,       setNavs]       = useState(null);   // oldest-first
  const [loadingNav, setLoadingNav] = useState(false);
  const [error,      setError]      = useState(null);

  // Call this on explicit user clicks — selects fund AND scrolls to analysis
  function selectAndScroll(fund) {
    setSelected(fund);
    setTimeout(() => {
      if (!deepDiveRef.current) return;
      // getBoundingClientRect gives position relative to viewport;
      // add window.scrollY to get the absolute page offset, then scroll so
      // the ref sits flush at the top of the page (force scroll even if visible).
      const top = deepDiveRef.current.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top, behavior: "smooth" });
    }, 80);
  }

  useEffect(() => {
    supabase.from("radar_cache").select("data").eq("key","mf_radar").single()
      .then(({ data, error: e }) => {
        if (e) { setError(e.message); return; }
        const mfData = data.data;

        // Build top picks for the selector grid
        const p = buildTopPicks(mfData);
        setPicks(p);

        // Build full fund universe for code-based lookup
        const universe = [];
        for (const cat of mfData.categories) {
          for (const f of cat.funds) universe.push({ ...f, category: cat.category });
        }
        setAllFunds(universe);

        // If navigated with ?code=, find that fund; else default to #1 pick
        if (incomingCode) {
          const match = universe.find((f) => String(f.code) === String(incomingCode));
          setSelected(match ?? p[0]);
        } else {
          setSelected(p[0]);
        }
      })
      .finally(() => setLoadingInit(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) return;
    setNavs(null); setLoadingNav(true);
    fetchNavs(selected.code)
      .then(setNavs)
      .catch(() => setNavs([]))
      .finally(() => setLoadingNav(false));
  }, [selected]);

  // computed analytics (only when navs loaded)
  const monthly  = navs?.length ? monthlyReturns(navs) : null;
  const metrics  = monthly ? riskMetrics(monthly.rets) : null;
  const ddData   = navs?.length ? drawdownAnalysis(navs) : null;
  const calmar   = metrics && ddData?.maxDd ? Math.abs(metrics.annMean / ddData.maxDd) : null;

  const sip3  = navs?.length ? historicalSip(navs, 3)  : null;
  const sip5  = navs?.length ? historicalSip(navs, 5)  : null;
  const sip10 = navs?.length ? historicalSip(navs, 10) : null;

  if (loadingInit) return (
    <div className="flex h-60 items-center justify-center">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
    </div>
  );
  if (error) return <div className="rounded-xl border border-red-800 bg-red-900/20 p-4 text-sm text-red-400">{error}</div>;

  return (
    <div className="space-y-6">

      {/* header */}
      <div>
        <h1 className="text-xl font-bold">Fund Deep Dive</h1>
        <p className="mt-0.5 text-xs text-gray-500">Rolling returns · drawdown · risk ratios · historical SIP performance</p>
      </div>

      {/* fund selector — top picks + the inbound fund if not already in picks */}
      {(() => {
        const inboundNotInPicks = selected && !picks.find((p) => p.code === selected.code);
        const selectorFunds = inboundNotInPicks ? [selected, ...picks] : picks;
        return (
          <div className="space-y-2">
            {inboundNotInPicks && (
              <div className="text-[11px] text-blue-400 px-1">
                ↗ Navigated from radar · showing this fund + top momentum picks below
              </div>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {selectorFunds.map((fund, i) => (
                <button key={fund.code} onClick={() => selectAndScroll(fund)}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition ${
                    selected?.code === fund.code
                      ? "border-blue-600/60 bg-blue-900/20 text-white"
                      : "border-gray-800 bg-gray-900 text-gray-400 hover:border-gray-700 hover:text-gray-200"
                  }`}>
                  <span className="text-xs font-bold text-blue-400 w-5 shrink-0">
                    {inboundNotInPicks && i === 0 ? "↗" : `#${inboundNotInPicks ? i : i + 1}`}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{fund.label}</div>
                    <div className="text-[10px] text-gray-500">{fund.category}</div>
                  </div>
                  <span className={`shrink-0 text-xs font-bold tabular-nums ${pctColor(fund.ret1y)}`}>
                    {fmtPct(fund.ret1y)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ── deep dive analysis section — scroll target ── */}
      <div ref={deepDiveRef} />

      {/* loading nav */}
      {loadingNav && (
        <div className="flex items-center gap-2 rounded-2xl border border-gray-800 bg-gray-900 p-4 text-xs text-gray-500">
          <div className="h-4 w-4 animate-spin rounded-full border border-gray-600 border-t-blue-400" />
          Fetching NAV history for {selected?.label}…
        </div>
      )}

      {navs && !loadingNav && (
        <div className="space-y-4">

          {/* overview bar */}
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
            <div className="mb-2 text-sm font-semibold text-gray-300">{selected?.label}</div>
            <div className="mb-3 flex flex-wrap gap-2 text-[10px] text-gray-500">
              <span>{selected?.category}</span>
              <span>·</span>
              <span>{monthly?.rets.length ?? 0} months of data</span>
              <span>·</span>
              <span>{navs.length} daily NAVs</span>
              {navs[0] && <span>· from {navs[0].date.toLocaleDateString("en-IN",{month:"short",year:"numeric"})}</span>}
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {[
                { l:"1W", v:selected?.ret1w }, { l:"1M", v:selected?.ret1m },
                { l:"3M", v:selected?.ret3m }, { l:"6M", v:selected?.ret6m },
                { l:"1Y", v:selected?.ret1y },
              ].map(({ l, v }) => (
                <div key={l} className="rounded-xl bg-gray-800/60 p-2 text-center">
                  <div className="text-[10px] text-gray-500">{l}</div>
                  <div className={`text-sm font-bold tabular-nums ${pctColor(v)}`}>{fmtPct(v)}</div>
                </div>
              ))}
            </div>
          </div>

          {/* risk metrics */}
          {metrics && (
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
              <div className="mb-3 text-sm font-semibold text-gray-300">Risk Metrics</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="Ann. Return" value={fmtPct(metrics.annMean)}
                  color={pctColor(metrics.annMean)} sub="from monthly returns" />
                <StatCard label="Volatility (σ)" value={fmtPct(metrics.annStd)}
                  color={metrics.annStd > 25 ? "text-red-400" : metrics.annStd > 18 ? "text-yellow-400" : "text-green-400"}
                  sub="annualised std dev" />
                <StatCard label="Sharpe Ratio"
                  value={metrics.sharpe != null ? metrics.sharpe.toFixed(2) : "—"}
                  color={metrics.sharpe >= 1 ? "text-green-400" : metrics.sharpe >= 0.5 ? "text-yellow-400" : "text-red-400"}
                  sub={`rf = ${RISK_FREE}%`} />
                <StatCard label="Sortino Ratio"
                  value={metrics.sortino != null ? metrics.sortino.toFixed(2) : "—"}
                  color={metrics.sortino >= 1.5 ? "text-green-400" : metrics.sortino >= 0.8 ? "text-yellow-400" : "text-red-400"}
                  sub="downside risk only" />
              </div>
              {calmar != null && (
                <div className="mt-3 rounded-xl border border-gray-800 bg-gray-800/40 px-3 py-2 flex items-center gap-3">
                  <div className="text-xs text-gray-500">Calmar Ratio</div>
                  <div className={`text-sm font-bold tabular-nums ${calmar >= 0.5 ? "text-green-400" : "text-yellow-400"}`}>
                    {calmar.toFixed(2)}
                  </div>
                  <div className="text-[10px] text-gray-600">= {fmtPct(metrics.annMean)} return ÷ {fmtPct(Math.abs(ddData.maxDd))} max drawdown. Higher is better — measures return earned per unit of worst-case loss.</div>
                </div>
              )}
              <div className="mt-3 text-[10px] text-gray-600">
                Sharpe {'>'} 1 = good · Sortino {'>'} 1.5 = excellent · both use {RISK_FREE}% risk-free rate (India 10Y G-Sec proxy)
              </div>
            </div>
          )}

          {/* drawdown */}
          {ddData && (
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
              <div className="mb-3 text-sm font-semibold text-gray-300">Drawdown Analysis</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 mb-4">
                <StatCard label="Max Drawdown" value={fmtPct(ddData.maxDd,1)} color="text-red-400"
                  sub="peak-to-trough worst fall" />
                <StatCard label="Avg Drawdown"
                  value={fmtPct(ddData.periods.length ? ddData.periods.reduce((s,p)=>s+p.depth,0)/ddData.periods.length : 0, 1)}
                  color="text-orange-400" sub="avg of significant dips" />
                <StatCard label="Significant Dips" value={ddData.periods.length}
                  sub=">5% peak-to-trough events" />
              </div>

              <DrawdownChart series={ddData.series} />

              {ddData.periods.length > 0 && (
                <div className="mt-4">
                  <div className="mb-2 text-xs font-semibold text-gray-500">Notable Drawdown Periods</div>
                  <div className="space-y-1.5">
                    {[...ddData.periods].sort((a,b) => a.depth - b.depth).slice(0,5).map((p, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-red-400 font-bold tabular-nums w-14">{fmtPct(p.depth,1)}</span>
                        <span className="text-gray-400">
                          {p.start?.toLocaleDateString("en-IN",{month:"short",year:"numeric"})}
                          {" → "}
                          {p.trough?.toLocaleDateString("en-IN",{month:"short",year:"numeric"})}
                        </span>
                        {p.recovered && (
                          <span className="text-gray-600">
                            · recovered in ~{Math.round(p.daysToRecover/30)}mo
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* rolling returns */}
          {monthly && (
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4 space-y-5">
              <div className="text-sm font-semibold text-gray-300">Rolling Returns — Consistency</div>
              <div>
                <div className="mb-2 text-xs font-semibold text-gray-500">1-Year Rolling Windows</div>
                <RollingSection navs={navs} windowMonths={12} label="1Y" />
              </div>
              {(monthly.rets.length >= 36) && (
                <div className="border-t border-gray-800 pt-4">
                  <div className="mb-2 text-xs font-semibold text-gray-500">3-Year Rolling Windows</div>
                  <RollingSection navs={navs} windowMonths={36} label="3Y" />
                </div>
              )}
              {(monthly.rets.length >= 60) && (
                <div className="border-t border-gray-800 pt-4">
                  <div className="mb-2 text-xs font-semibold text-gray-500">5-Year Rolling Windows</div>
                  <RollingSection navs={navs} windowMonths={60} label="5Y" />
                </div>
              )}
              <p className="text-[10px] text-gray-600">
                Each window = one hypothetical investor who bought and held for that period.
                Consistency % shows how often this fund would have met your return expectation.
              </p>
            </div>
          )}

          {/* historical SIP */}
          {(sip3 || sip5 || sip10) && (
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
              <div className="mb-1 text-sm font-semibold text-gray-300">Historical SIP Performance</div>
              <p className="mb-4 text-[10px] text-gray-600">
                ₹10,000/month SIP invested in this fund — actual historical NAVs, not projected.
              </p>
              <div className="space-y-3">
                {[sip10, sip5, sip3].filter(Boolean).map((s) => {
                  const yrs = s.months >= 114 ? 10 : s.months >= 54 ? 5 : 3;
                  const gain = s.value - s.invested;
                  return (
                    <div key={yrs} className="rounded-xl border border-gray-800 bg-gray-800/40 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-sm font-semibold text-gray-200">{yrs}-Year SIP</span>
                        <span className={`text-lg font-bold tabular-nums ${pctColor(s.xirr)}`}>
                          {fmtPct(s.xirr,2)} XIRR
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div className="text-center">
                          <div className="text-gray-500 text-[10px]">Invested</div>
                          <div className="font-semibold text-gray-300 tabular-nums">{fmtInr(s.invested)}</div>
                        </div>
                        <div className="text-center">
                          <div className="text-gray-500 text-[10px]">Value</div>
                          <div className="font-bold text-white tabular-nums">{fmtInr(s.value)}</div>
                        </div>
                        <div className="text-center">
                          <div className="text-gray-500 text-[10px]">Gain</div>
                          <div className={`font-bold tabular-nums ${pctColor(gain)}`}>
                            {gain >= 0 ? "+" : ""}{fmtInr(gain)}
                          </div>
                        </div>
                      </div>
                      {/* wealth ratio bar */}
                      <div className="mt-2 relative h-2 overflow-hidden rounded-full bg-gray-700">
                        <div className="absolute inset-y-0 left-0 rounded-full bg-blue-500"
                          style={{ width: `${Math.min(100, (s.invested/s.value)*100)}%` }} />
                      </div>
                      <div className="mt-0.5 flex justify-between text-[9px] text-gray-600">
                        <span>Invested portion</span>
                        <span>{((s.value/s.invested)).toFixed(2)}x wealth multiple</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-[10px] text-gray-600">
                XIRR accounts for the timing of each monthly investment. More accurate than simple CAGR for SIP investors.
              </p>
            </div>
          )}

          {navs.length === 0 && (
            <div className="rounded-2xl border border-dashed border-gray-800 p-8 text-center text-sm text-gray-600">
              Could not fetch NAV history for this fund.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
