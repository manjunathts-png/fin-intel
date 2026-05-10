import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../hooks/useAuth";

// ── constants ─────────────────────────────────────────────────────────────────

const HORIZONS = [1, 3, 5, 10];
const N_SIMS   = 800;

const CAT_SIGMA = {
  "Defence": 28, "Micro Cap": 30, "Small Cap": 26,
  "Pharma & Healthcare": 22, "Infrastructure": 24, "Manufacturing": 22,
  "Mid Cap": 20, "ELSS": 21, "Energy": 25, "PSU": 23,
  "Large Cap": 16, "Flexi Cap": 18, "Technology": 20, "Banking & Finance": 18,
};
const DEFAULT_SIGMA = 22;

const PALETTE = [
  "bg-blue-500", "bg-emerald-500", "bg-violet-500", "bg-amber-500",
  "bg-rose-500",  "bg-cyan-500",   "bg-orange-500", "bg-pink-500",
  "bg-teal-500",  "bg-indigo-500",
];

// ── pick builder ──────────────────────────────────────────────────────────────

function momentumScore(f, catZ) {
  return (f.ret1w ?? 0) * 0.4 + (f.ret1m ?? 0) * 0.3
       + (f.ret3m ?? 0) * 0.2 + (catZ    ?? 0) * 5 * 0.1;
}

function buildTopPicks(mfData) {
  return mfData.categories
    .map((cat) => {
      const catZ = cat.median.z1w ?? 0;
      return [...cat.funds]
        .map((f) => ({ ...f, score: momentumScore(f, catZ), catZ, category: cat.category }))
        .sort((a, b) => b.score - a.score)[0];
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

// ── formatters ────────────────────────────────────────────────────────────────

function fmtInr(n) {
  const neg = n < 0;
  const a   = Math.abs(n);
  const s   = neg ? "-" : "";
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)} L`;
  return `${s}₹${Math.round(a).toLocaleString("en-IN")}`;
}
function fmtPct(v, d = 1) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
}
function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60)    return "just now";
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

// ── NAV fetching & return computation ─────────────────────────────────────────

function parseNavDate(str) {
  const [d, m, y] = str.split("-");
  return `${y}-${m}`; // "YYYY-MM" key
}

function computeMonthlyReturns(navs) {
  // navs: [{date:"DD-MM-YYYY", nav:"123.45"}] newest first
  // group by month → take first entry seen (= last day of month since newest first)
  const byMonth = new Map();
  for (const { date, nav } of navs) {
    const key = parseNavDate(date);
    if (!byMonth.has(key)) byMonth.set(key, parseFloat(nav));
  }
  const sorted = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));
  const returns = [], dates = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][1] > 0 && sorted[i - 1][1] > 0) {
      returns.push(sorted[i][1] / sorted[i - 1][1] - 1);
      dates.push(sorted[i][0]);
    }
  }
  return { returns, dates };
}

async function fetchFundHistory(code) {
  try {
    const res  = await fetch(`https://api.mfapi.in/mf/${code}`);
    if (!res.ok) return null;
    const json = await res.json();
    const navs = json.data;
    if (!navs || navs.length < 30) return null;

    const latest = parseFloat(navs[0].nav);
    function parseDate(str) { const [d, m, y] = str.split("-"); return new Date(`${y}-${m}-${d}`); }
    function navAgo(n) {
      const t = new Date(); t.setFullYear(t.getFullYear() - n);
      for (const e of navs) if (parseDate(e.date) <= t) return parseFloat(e.nav);
      return null;
    }
    function cagr(p, y) { return p && p > 0 ? (Math.pow(latest / p, 1 / y) - 1) * 100 : null; }

    const { returns, dates } = computeMonthlyReturns(navs);

    return {
      ret5y:  cagr(navAgo(5),  5),
      ret10y: cagr(navAgo(10), 10),
      ret15y: cagr(navAgo(15), 15),
      returns,  // monthly return series
      dates,    // "YYYY-MM" aligned to returns
      count: navs.length,
    };
  } catch { return null; }
}

// ── best long-term mean estimate ──────────────────────────────────────────────

function bestMeanReturn(fund, hist) {
  const r1y = fund.ret1y ?? 0;
  if (!hist || hist === "loading") return r1y;
  const { ret5y, ret10y, ret15y } = hist;
  if (ret15y != null && ret10y != null && ret5y != null)
    return ret15y * 0.35 + ret10y * 0.35 + ret5y * 0.20 + r1y * 0.10;
  if (ret10y != null && ret5y != null)
    return ret10y * 0.45 + ret5y * 0.30 + r1y * 0.25;
  if (ret5y != null)
    return ret5y * 0.55 + r1y * 0.45;
  return r1y;
}

// ── MODEL A: log-normal Monte Carlo ──────────────────────────────────────────

function randn() {
  let u; do { u = Math.random(); } while (u === 0);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

function logNormalMC(principal, muPct, sigPct, nSims = N_SIMS) {
  const mu = muPct / 100, sig = sigPct / 100;
  const maxY = Math.max(...HORIZONS);
  const buckets = Object.fromEntries(HORIZONS.map((y) => [y, []]));
  for (let s = 0; s < nSims; s++) {
    let val = principal;
    for (let y = 1; y <= maxY; y++) {
      val *= Math.exp(Math.log(1 + mu) - 0.5 * sig * sig + sig * randn());
      if (buckets[y]) buckets[y].push(val);
    }
  }
  return buildPercentiles(buckets);
}

// ── MODEL B: historical bootstrap + momentum regime ───────────────────────────
//
// How it works:
//  1. Uses actual historical monthly returns → preserves fat tails, crash clusters
//  2. Blended portfolio: samples the SAME calendar month across all funds
//     → preserves cross-fund correlation (crashes hit all equity funds together)
//  3. Regime detection: splits historical months into bull/neutral/bear terciles
//  4. Current z-score biases first-year sampling toward the matching regime
//  5. Beyond year 1: uniform bootstrap (no signal predictive power long-term)

function buildBlendedSeries(selList, navHistory) {
  // Find months where ALL selected funds have data
  const series = selList.map(({ fund }) => navHistory[fund.code]);
  if (series.some((h) => !h || !h.returns)) return null;

  // Identify which fund has the least history (bottleneck)
  const minFund = selList.reduce((min, cur) => {
    const h = navHistory[cur.fund.code];
    return (!min || (h?.dates?.length ?? 0) < (navHistory[min.fund.code]?.dates?.length ?? 0)) ? cur : min;
  }, null);

  // Intersection of date sets
  const dateSet = series.reduce((acc, h) => {
    const s = new Set(h.dates);
    return acc ? new Set([...acc].filter((d) => s.has(d))) : s;
  }, null);
  if (!dateSet || dateSet.size < 12) return null; // need ≥ 12 months overlap

  const commonDates = [...dateSet].sort();
  const blended = commonDates.map((date) =>
    selList.reduce((sum, { fund, pct }) => {
      const h   = navHistory[fund.code];
      const idx = h.dates.indexOf(date);
      return sum + (idx >= 0 ? h.returns[idx] * (pct / 100) : 0);
    }, 0)
  );

  // Identify the fund limiting the overlap
  const bottleneck = selList.reduce((min, cur) => {
    const len = navHistory[cur.fund.code]?.dates?.length ?? 0;
    return (!min || len < (navHistory[min.fund.code]?.dates?.length ?? 0)) ? cur : min;
  }, null);

  return {
    blended,
    commonDates,
    months:      commonDates.length,
    limited:     commonDates.length < 36,   // warn if under 3 years
    bottleneck:  bottleneck?.fund?.label ?? null,
    bottleneckMonths: navHistory[bottleneck?.fund?.code]?.dates?.length ?? 0,
  };
}

function bootstrapMC(principal, blended, blendedZ, nSims = N_SIMS) {
  if (!blended || blended.length < 12) return null;

  // Sort for regime tercile thresholds
  const sorted = [...blended].sort((a, b) => a - b);
  const n      = sorted.length;
  const p33    = sorted[Math.floor(n * 0.33)];
  const p67    = sorted[Math.floor(n * 0.66)];

  const bullPool    = blended.filter((r) => r >= p67);
  const bearPool    = blended.filter((r) => r <= p33);

  // z-score → regime
  const isBull = blendedZ > 0.8;
  const isBear = blendedZ < -0.5;

  const maxMonths = Math.max(...HORIZONS) * 12;
  const buckets   = Object.fromEntries(HORIZONS.map((y) => [y, []]));

  for (let s = 0; s < nSims; s++) {
    let val = principal;
    for (let mo = 1; mo <= maxMonths; mo++) {
      let pool = blended;
      if (mo <= 12) {
        // First year: 65% momentum-biased, 35% random
        if      (isBull && Math.random() < 0.65) pool = bullPool;
        else if (isBear && Math.random() < 0.65) pool = bearPool;
      }
      // For months 13–18 fade: 30% bias
      else if (mo <= 18) {
        if      (isBull && Math.random() < 0.30) pool = bullPool;
        else if (isBear && Math.random() < 0.30) pool = bearPool;
      }
      val *= 1 + pool[Math.floor(Math.random() * pool.length)];
      const yr = Math.ceil(mo / 12);
      if (HORIZONS.includes(yr) && mo === yr * 12) buckets[yr].push(val);
    }
  }
  return buildPercentiles(buckets);
}

function buildPercentiles(buckets) {
  const pct = (arr, p) => arr[Math.max(0, Math.ceil((p / 100) * arr.length) - 1)];
  const result = {};
  HORIZONS.forEach((y) => {
    const s = [...buckets[y]].sort((a, b) => a - b);
    result[y] = { p10: pct(s, 10), p25: pct(s, 25), p50: pct(s, 50), p75: pct(s, 75), p90: pct(s, 90) };
  });
  return result;
}

// ── allocation helpers ────────────────────────────────────────────────────────

function redistribute(sel) {
  const codes = Object.keys(sel);
  if (!codes.length) return sel;
  const eq = parseFloat((100 / codes.length).toFixed(1));
  const out = {};
  codes.forEach((c, i) => {
    out[c] = { ...sel[c], pct: i === codes.length - 1 ? parseFloat((100 - eq * (codes.length - 1)).toFixed(1)) : eq };
  });
  return out;
}

// ── SIP / lump-sum projections ────────────────────────────────────────────────

function lumpsumFV(p, rPct, t) { return p * Math.pow(1 + rPct / 100, t); }
function sipFV(m, rPct, t) {
  const r = rPct / 100 / 12, n = t * 12;
  return r === 0 ? m * n : m * ((Math.pow(1 + r, n) - 1) / r) * (1 + r);
}

// ── shared MC chart & table ───────────────────────────────────────────────────

function MCPanel({ mc, invested, mode, title, badge, color, extra }) {
  const W = 340, H = 160, P = { t: 12, r: 12, b: 28, l: 52 };
  const cW = W - P.l - P.r, cH = H - P.t - P.b;

  const allV  = HORIZONS.flatMap((y) => [mc[y].p10, mc[y].p90]);
  const maxV  = Math.max(...allV) * 1.05;
  const minV  = Math.min(invested, ...allV) * 0.92;
  const xOf   = (i) => P.l + (i / (HORIZONS.length - 1)) * cW;
  const yOf   = (v)  => P.t + cH - ((v - minV) / (maxV - minV)) * cH;
  const pts   = (k)  => HORIZONS.map((y, i) => `${xOf(i)},${yOf(mc[y][k])}`).join(" ");
  const band  = (k1, k2) =>
    HORIZONS.map((y, i) => `${xOf(i)},${yOf(mc[y][k1])}`).join(" ") + " " +
    [...HORIZONS].reverse().map((y, i) => `${xOf(HORIZONS.length - 1 - i)},${yOf(mc[y][k2])}`).join(" ");

  const fillC  = color === "indigo" ? "#4f46e5" : "#0d9488";
  const lineC  = color === "indigo" ? "#818cf8" : "#2dd4bf";
  const dashC  = color === "indigo" ? "#6366f1" : "#14b8a6";
  const borderC = color === "indigo" ? "border-indigo-900/40" : "border-teal-900/40";
  const badgeC  = color === "indigo" ? "bg-indigo-900/40 text-indigo-400" : "bg-teal-900/40 text-teal-400";

  return (
    <div className={`rounded-2xl border ${borderC} bg-gray-900 p-4`}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-gray-300">{title}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] ${badgeC}`}>{badge}</span>
        {extra}
      </div>

      <div className="mb-4 overflow-x-auto">
        <svg width={W} height={H} className="text-gray-800">
          {[0.25, 0.5, 0.75, 1].map((t) => {
            const y = P.t + cH * (1 - t);
            return (
              <g key={t}>
                <line x1={P.l} x2={W - P.r} y1={y} y2={y} stroke="currentColor" strokeWidth="0.5" />
                <text x={P.l - 4} y={y + 3} textAnchor="end" fontSize="8" fill="#4b5563">
                  {fmtInr(minV + (maxV - minV) * t)}
                </text>
              </g>
            );
          })}
          {HORIZONS.map((yr, i) => (
            <text key={yr} x={xOf(i)} y={H - 6} textAnchor="middle" fontSize="9" fill="#6b7280">{yr}Y</text>
          ))}
          <polygon points={band("p10", "p90")} fill={fillC} opacity="0.12" />
          <polygon points={band("p25", "p75")} fill={fillC} opacity="0.22" />
          <polyline points={pts("p10")} fill="none" stroke={dashC} strokeWidth="1" strokeDasharray="3,2" opacity="0.6" />
          <polyline points={pts("p90")} fill="none" stroke={dashC} strokeWidth="1" strokeDasharray="3,2" opacity="0.6" />
          <polyline points={pts("p50")} fill="none" stroke={lineC} strokeWidth="2" />
          <line x1={P.l} x2={W - P.r} y1={yOf(invested)} y2={yOf(invested)}
            stroke="#374151" strokeWidth="1" strokeDasharray="4,3" />
          <text x={P.l + 4} y={yOf(invested) - 3} fontSize="8" fill="#4b5563">Invested</text>
        </svg>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500">
              <th className="pb-2 text-left font-medium">Horizon</th>
              <th className="pb-2 text-right font-medium text-red-400/80">Bear (10th)</th>
              <th className="pb-2 text-right font-medium text-gray-300">Base (50th)</th>
              <th className="pb-2 text-right font-medium text-green-400/80">Bull (90th)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/60">
            {HORIZONS.map((y) => {
              const { p10, p50, p90 } = mc[y];
              const inv = mode === "lump" ? invested : invested * 12 * y;
              return (
                <tr key={y} className="hover:bg-gray-800/30">
                  <td className="py-2.5 font-semibold text-gray-200">{y}Y</td>
                  <td className="py-2.5 text-right tabular-nums text-red-400">
                    {fmtInr(p10)} <span className="text-[10px] text-gray-600">({(p10/inv).toFixed(1)}x)</span>
                  </td>
                  <td className="py-2.5 text-right tabular-nums font-bold text-white">
                    {fmtInr(p50)} <span className="text-[10px] text-gray-600">({(p50/inv).toFixed(1)}x)</span>
                  </td>
                  <td className="py-2.5 text-right tabular-nums text-green-400">
                    {fmtInr(p90)} <span className="text-[10px] text-gray-600">({(p90/inv).toFixed(1)}x)</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── momentum signal badge ─────────────────────────────────────────────────────

function MomentumSignal({ z, dataMonths }) {
  const label = z > 0.8  ? { text: "🔥 Bull momentum", cls: "bg-orange-900/30 text-orange-300 border-orange-800/40" }
              : z < -0.5 ? { text: "❄️ Bear momentum", cls: "bg-blue-900/30 text-blue-300 border-blue-800/40" }
              :             { text: "→ Neutral",        cls: "bg-gray-800 text-gray-400 border-gray-700/40" };

  const impact = z > 0.8
    ? "First-year sampling biased 65% toward historically strong months, fading to 30% by month 18."
    : z < -0.5
    ? "First-year sampling biased 65% toward historically weak months, fading to 30% by month 18."
    : "No regime bias — uniform sampling from full historical return distribution.";

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-800/30 p-3 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Momentum signal</span>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${label.cls}`}>{label.text}</span>
        <span className="text-[10px] text-gray-600">z = {z.toFixed(2)}</span>
        <span className="text-[10px] text-gray-600">· {dataMonths} months of history</span>
      </div>
      <p className="text-[10px] text-gray-600">{impact}</p>
    </div>
  );
}

// ── model comparison table ────────────────────────────────────────────────────

// Horizons where bootstrap is reliable given the available months of data
function reliableBootstrapHorizons(months) {
  if (months >= 60) return [1, 3, 5, 10]; // 5+ years — trust all horizons
  if (months >= 36) return [1, 3, 5];     // 3+ years — trust up to 5Y
  if (months >= 12) return [1];           // <3 years — only trust 1Y
  return [];
}

function ModelComparison({ mcSimple, mcBoot, bootMonths }) {
  if (!mcSimple || !mcBoot) return null;

  const reliable    = new Set(reliableBootstrapHorizons(bootMonths));
  const isLimited   = bootMonths < 60;
  const cycleYears  = Math.floor(bootMonths / 12);

  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4 space-y-3">
      <div>
        <div className="mb-1 text-sm font-semibold text-gray-300">Which model should you use?</div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 text-xs">
          <div className="rounded-xl border border-indigo-800/30 bg-indigo-900/10 p-3 space-y-1">
            <div className="font-semibold text-indigo-300">Log-Normal · trust for all horizons</div>
            <p className="text-gray-500">Uses your funds' 5Y–15Y CAGR as the mean — spans multiple bull and bear cycles. More representative for 3Y+ projections.</p>
          </div>
          <div className={`rounded-xl p-3 space-y-1 ${isLimited ? "border border-yellow-800/30 bg-yellow-900/10" : "border border-teal-800/30 bg-teal-900/10"}`}>
            <div className={`font-semibold ${isLimited ? "text-yellow-300" : "text-teal-300"}`}>
              Bootstrap · {isLimited ? `only trust 1Y (${bootMonths}mo of data)` : "trust up to 5Y"}
            </div>
            <p className="text-gray-500">
              {isLimited
                ? `Sampling from ${cycleYears} year${cycleYears !== 1 ? "s" : ""} of data — likely a single market regime (no crash periods). 3Y+ projections are unreliable.`
                : "Uses real return distribution including crash months. Better for 1–3Y where distribution shape matters more than long-run mean."}
            </p>
          </div>
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs font-semibold text-gray-500">Median (50th pct) comparison</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500">
                <th className="pb-2 text-left font-medium">Horizon</th>
                <th className="pb-2 text-right font-medium text-indigo-400">Log-Normal ✓</th>
                <th className="pb-2 text-right font-medium text-teal-400">Bootstrap</th>
                <th className="pb-2 text-right font-medium">Δ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/60">
              {HORIZONS.map((y) => {
                const s     = mcSimple[y].p50;
                const b     = mcBoot[y].p50;
                const delta = b - s;
                const trust = reliable.has(y);
                return (
                  <tr key={y} className={`hover:bg-gray-800/30 ${!trust ? "opacity-40" : ""}`}>
                    <td className="py-2 font-semibold text-gray-200">
                      {y}Y {!trust && <span className="text-[9px] text-yellow-600">bootstrap unreliable</span>}
                    </td>
                    <td className="py-2 text-right tabular-nums text-indigo-300">{fmtInr(s)}</td>
                    <td className={`py-2 text-right tabular-nums ${trust ? "text-teal-300" : "text-gray-600"}`}>{fmtInr(b)}</td>
                    <td className={`py-2 text-right tabular-nums font-medium ${!trust ? "text-gray-600" : delta >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {delta >= 0 ? "+" : ""}{fmtInr(delta)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {isLimited && (
          <p className="mt-2 text-[10px] text-yellow-700">
            Bootstrap 3Y+ rows are greyed out — {bootMonths} months of data doesn't cover a full market cycle.
            Remove new funds (e.g. Defence, launched 2024) for longer reliable bootstrap horizons.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Goal Calculator ───────────────────────────────────────────────────────────
//
// Reverse simulation: "I need ₹X in Y years — what do I invest?"
// Lump-sum requirement = Goal / wealth_multiple from log-normal MC distribution
// SIP requirement = analytic formula at rate ± sigma band for confidence levels

function inverseSip(goal, annualRatePct, years) {
  if (years <= 0 || annualRatePct < 0) return null;
  const r = annualRatePct / 100 / 12;
  const n = years * 12;
  if (r === 0) return goal / n;
  return goal * r / ((Math.pow(1 + r, n) - 1) * (1 + r));
}

function GoalCalculator({ mcSimple, blendedMean, blendedSigma, simAmount }) {
  const [goalAmount, setGoalAmount] = useState(5000000);
  const [goalYears,  setGoalYears]  = useState(5);

  if (!mcSimple || blendedMean == null || blendedSigma == null) return null;

  const mc = mcSimple[goalYears];
  if (!mc) return null;

  // Wealth multiples at selected horizon (simulation ran with simAmount)
  const wm25 = mc.p25 / simAmount;
  const wm50 = mc.p50 / simAmount;
  const wm75 = mc.p75 / simAmount;

  // Required lump-sum for each confidence level
  const lumpConservative = goalAmount / wm25; // 75% confidence (p25 scenario still hits goal)
  const lumpBase         = goalAmount / wm50;
  const lumpOptimistic   = goalAmount / wm75;

  // SIP rates: use blended mean ± 0.5σ for conservative/optimistic bands
  const rateCons = Math.max(1, blendedMean - blendedSigma * 0.5);
  const rateBase = blendedMean;
  const rateOpt  = blendedMean + blendedSigma * 0.5;

  const sipCons = inverseSip(goalAmount, rateCons, goalYears);
  const sipBase = inverseSip(goalAmount, rateBase, goalYears);
  const sipOpt  = inverseSip(goalAmount, rateOpt,  goalYears);

  // How much does the goal grow beyond invested amount?
  const gainPct = (val, invested) => ((val - invested) / invested * 100).toFixed(0);

  return (
    <div className="rounded-2xl border border-purple-900/40 bg-gray-900 p-4 space-y-4">
      <div>
        <div className="text-sm font-semibold text-gray-300">🎯 Goal Calculator</div>
        <p className="mt-0.5 text-[10px] text-gray-500">
          Reverse simulation — how much do you need to invest to reach a target corpus?
        </p>
      </div>

      {/* inputs */}
      <div className="flex flex-wrap gap-4 items-end">
        <div>
          <label className="mb-1 block text-[10px] text-gray-500 uppercase tracking-wide">Target corpus</label>
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-gray-500">₹</span>
            <input type="number" min="100000" step="100000" value={goalAmount}
              onChange={(e) => setGoalAmount(Math.max(100000, Number(e.target.value)))}
              className="w-36 rounded-xl border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-white tabular-nums focus:outline-none focus:ring-1 focus:ring-purple-500" />
          </div>
          <div className="mt-0.5 text-[10px] text-purple-400 font-medium">{fmtInr(goalAmount)}</div>
        </div>
        <div>
          <label className="mb-1 block text-[10px] text-gray-500 uppercase tracking-wide">Time horizon</label>
          <div className="flex overflow-hidden rounded-xl border border-gray-700">
            {HORIZONS.map((y) => (
              <button key={y} onClick={() => setGoalYears(y)}
                className={`px-3 py-1.5 text-xs font-medium transition ${
                  goalYears === y ? "bg-purple-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"
                }`}>
                {y}Y
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* results table */}
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-xs min-w-[520px]">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="pb-2 text-left font-medium text-gray-500">Required investment</th>
              <th className="pb-2 text-right font-medium">
                <span className="text-red-400">Conservative</span>
                <div className="text-[9px] font-normal text-gray-600">75% chance of success</div>
              </th>
              <th className="pb-2 text-right font-medium">
                <span className="text-gray-200">Base case</span>
                <div className="text-[9px] font-normal text-gray-600">50% chance of success</div>
              </th>
              <th className="pb-2 text-right font-medium">
                <span className="text-green-400">Optimistic</span>
                <div className="text-[9px] font-normal text-gray-600">25% chance of success</div>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/60">
            {/* Lump-sum row */}
            <tr className="hover:bg-gray-800/30">
              <td className="py-3">
                <div className="font-medium text-gray-300">💰 Lump Sum</div>
                <div className="text-[10px] text-gray-600">one-time investment today</div>
              </td>
              <td className="py-3 text-right">
                <div className="tabular-nums font-bold text-red-300">{fmtInr(lumpConservative)}</div>
                <div className="text-[10px] text-gray-600">{gainPct(goalAmount, lumpConservative)}% gain</div>
              </td>
              <td className="py-3 text-right">
                <div className="tabular-nums font-bold text-white">{fmtInr(lumpBase)}</div>
                <div className="text-[10px] text-gray-600">{gainPct(goalAmount, lumpBase)}% gain</div>
              </td>
              <td className="py-3 text-right">
                <div className="tabular-nums font-bold text-green-300">{fmtInr(lumpOptimistic)}</div>
                <div className="text-[10px] text-gray-600">{gainPct(goalAmount, lumpOptimistic)}% gain</div>
              </td>
            </tr>

            {/* SIP row */}
            <tr className="hover:bg-gray-800/30">
              <td className="py-3">
                <div className="font-medium text-gray-300">📅 Monthly SIP</div>
                <div className="text-[10px] text-gray-600">{goalYears}Y · {goalYears * 12} installments</div>
              </td>
              <td className="py-3 text-right">
                <div className="tabular-nums font-bold text-red-300">{sipCons ? `${fmtInr(sipCons)}/mo` : "—"}</div>
                <div className="text-[10px] text-gray-600">{sipCons ? `total ${fmtInr(sipCons * 12 * goalYears)}` : ""}</div>
              </td>
              <td className="py-3 text-right">
                <div className="tabular-nums font-bold text-white">{sipBase ? `${fmtInr(sipBase)}/mo` : "—"}</div>
                <div className="text-[10px] text-gray-600">{sipBase ? `total ${fmtInr(sipBase * 12 * goalYears)}` : ""}</div>
              </td>
              <td className="py-3 text-right">
                <div className="tabular-nums font-bold text-green-300">{sipOpt ? `${fmtInr(sipOpt)}/mo` : "—"}</div>
                <div className="text-[10px] text-gray-600">{sipOpt ? `total ${fmtInr(sipOpt * 12 * goalYears)}` : ""}</div>
              </td>
            </tr>

            {/* SIP return rate assumption row */}
            <tr className="bg-gray-800/20">
              <td className="py-2 text-[10px] text-gray-600">SIP return assumption</td>
              <td className="py-2 text-right text-[10px] text-gray-600">{fmtPct(rateCons)} p.a.</td>
              <td className="py-2 text-right text-[10px] text-gray-600">{fmtPct(rateBase)} p.a.</td>
              <td className="py-2 text-right text-[10px] text-gray-600">{fmtPct(rateOpt)} p.a.</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* footnote */}
      <div className="rounded-xl bg-gray-800/40 px-3 py-2.5 text-[10px] text-gray-600 space-y-1.5">
        <div>
          <span className="text-red-400">Conservative</span> — works even in a below-average market (25th percentile MC outcome).
          Best for non-negotiable goals like retirement corpus or child education.
        </div>
        <div>
          <span className="text-green-400">Optimistic</span> — assumes above-average returns (75th percentile).
          Only suitable when the goal is flexible or you can top up later.
        </div>
        <div>
          Lump-sum confidence uses Log-Normal Monte Carlo ({N_SIMS} sims).
          SIP confidence uses analytic formula at mean ± ½σ ({fmtPct(blendedSigma)} σ).
        </div>
      </div>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export default function Simulator() {
  const { user } = useAuth();
  const [picks,   setPicks]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const [selected,   setSelected]   = useState({});
  const [amount,     setAmount]     = useState(100000);
  const [mode,       setMode]       = useState("lump");

  const [savedConfig, setSavedConfig] = useState(null);
  const [showRestore, setShowRestore] = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [lastSaved,   setLastSaved]   = useState(null);

  // { [code]: { ret5y, ret10y, ret15y, returns[], dates[] } | "loading" | null }
  const [navHistory, setNavHistory] = useState({});

  const saveTimer = useRef(null);

  // ── load ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    async function init() {
      const [{ data: cache, error: ce }, { data: saved }] = await Promise.all([
        supabase.from("radar_cache").select("data").eq("key", "mf_radar").single(),
        user
          ? supabase.from("user_simulations").select("config,saved_at").eq("user_id", user.id).single()
          : Promise.resolve({ data: null }),
      ]);
      if (ce) { setError(ce.message); return; }
      setPicks(buildTopPicks(cache.data));
      if (saved?.config) { setSavedConfig(saved); setShowRestore(true); }
    }
    init().finally(() => setLoading(false));
  }, [user]);

  // ── auto-save ──────────────────────────────────────────────────────────────

  const triggerSave = useCallback(() => {
    if (!user || !Object.keys(selected).length) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      const config = {
        selections: Object.values(selected).map(({ fund, pct }) => ({
          code: fund.code, label: fund.label, category: fund.category, pct,
        })),
        amount, mode,
      };
      const { error: e } = await supabase.from("user_simulations").upsert(
        { user_id: user.id, config, saved_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );
      if (!e) setLastSaved(new Date().toISOString());
      setSaving(false);
    }, 2000);
  }, [user, selected, amount, mode]);

  useEffect(() => { triggerSave(); }, [selected, amount, mode, triggerSave]);

  // ── restore / reset ────────────────────────────────────────────────────────

  function applySaved(cfg) {
    if (!cfg?.selections) return;
    const restored = {};
    cfg.selections.forEach(({ code, label, category, pct }) => {
      const fund = picks.find((p) => p.code === code) ?? { code, label, category };
      restored[code] = { fund, pct };
    });
    setSelected(restored);
    setAmount(cfg.amount ?? 100000);
    setMode(cfg.mode ?? "lump");
    setShowRestore(false);
    // Kick off history fetch for restored funds
    cfg.selections.forEach(({ code }) => kickFetchHistory(code));
  }

  async function resetSaved() {
    if (user) await supabase.from("user_simulations").delete().eq("user_id", user.id);
    setSavedConfig(null); setShowRestore(false);
    setSelected({}); setAmount(100000); setMode("lump"); setLastSaved(null);
  }

  // ── fund toggle + history fetch ────────────────────────────────────────────

  function kickFetchHistory(code) {
    setNavHistory((prev) => {
      if (prev[code] !== undefined) return prev;
      fetchFundHistory(code).then((hist) =>
        setNavHistory((p) => ({ ...p, [code]: hist }))
      );
      return { ...prev, [code]: "loading" };
    });
  }

  const toggleFund = useCallback((fund) => {
    setSelected((prev) => {
      if (prev[fund.code]) {
        const next = { ...prev }; delete next[fund.code];
        return redistribute(next);
      }
      if (Object.keys(prev).length >= 5) return prev;
      return redistribute({ ...prev, [fund.code]: { fund, pct: 0 } });
    });
    kickFetchHistory(fund.code);
  }, []); // eslint-disable-line

  const setPct = (code, val) => {
    const n = Math.max(0, Math.min(100, Number(val)));
    setSelected((prev) => ({ ...prev, [code]: { ...prev[code], pct: n } }));
  };

  // ── derived / computed ─────────────────────────────────────────────────────

  const selList  = Object.values(selected);
  const totalPct = selList.reduce((s, v) => s + (v.pct || 0), 0);
  const pctOk    = Math.abs(totalPct - 100) < 0.5;

  const blended1Y = pctOk && selList.length
    ? selList.reduce((s, { fund, pct }) => s + (fund.ret1y ?? 0) * (pct / 100), 0) : null;

  const blendedMean = pctOk && selList.length
    ? selList.reduce((s, { fund, pct }) => {
        const h = navHistory[fund.code];
        return s + bestMeanReturn(fund, h === "loading" ? null : h) * (pct / 100);
      }, 0) : null;

  const blendedSigma = pctOk && selList.length
    ? selList.reduce((s, { fund, pct }) => s + (CAT_SIGMA[fund.category] ?? DEFAULT_SIGMA) * (pct / 100), 0) : null;

  const blendedZ = pctOk && selList.length
    ? selList.reduce((s, { fund, pct }) => s + (fund.catZ ?? 0) * (pct / 100), 0) : null;

  const allHistLoaded = selList.length > 0 && selList.every(({ fund }) => navHistory[fund.code] !== "loading");

  // Bootstrap blended series
  const blendedSeries = useMemo(() => {
    if (!pctOk || !allHistLoaded || !selList.length) return null;
    const hists = selList.map(({ fund }) => navHistory[fund.code]);
    if (hists.some((h) => !h || !h.returns)) return null;
    return buildBlendedSeries(selList, navHistory);
  }, [pctOk, allHistLoaded, JSON.stringify(selList.map((s) => s.fund.code + s.pct))]); // eslint-disable-line

  // History depth label
  const histLabel = useMemo(() => {
    if (!selList.length || !allHistLoaded) return "1Y";
    const hists = selList.map(({ fund }) => navHistory[fund.code]);
    if (hists.every((h) => h?.ret15y != null)) return "15Y";
    if (hists.every((h) => h?.ret10y != null)) return "10Y";
    if (hists.every((h) => h?.ret5y  != null)) return "5Y";
    return "1Y";
  }, [selList, allHistLoaded, navHistory]);

  // Run both models
  const mcSimple = pctOk && blendedMean != null && blendedSigma != null && allHistLoaded
    ? logNormalMC(amount, blendedMean, blendedSigma) : null;

  const mcBoot = pctOk && blendedSeries?.blended && blendedZ != null
    ? bootstrapMC(amount, blendedSeries.blended, blendedZ) : null;

  // Projections (simple 1Y-rate table)
  const proj = useMemo(() => {
    if (!pctOk || !selList.length) return null;
    return HORIZONS.map((yrs) => {
      let total = 0;
      selList.forEach(({ fund, pct }) => {
        const slice = amount * (pct / 100);
        total += mode === "lump" ? lumpsumFV(slice, fund.ret1y ?? 0, yrs) : sipFV(slice, fund.ret1y ?? 0, yrs);
      });
      const invested = mode === "lump" ? amount : amount * 12 * yrs;
      return { yrs, total, invested, gain: total - invested };
    });
  }, [pctOk, selList, amount, mode]); // eslint-disable-line

  // ── render ─────────────────────────────────────────────────────────────────

  if (loading) return <div className="flex h-60 items-center justify-center"><div className="h-7 w-7 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" /></div>;
  if (error)   return <div className="rounded-xl border border-red-800 bg-red-900/20 p-4 text-sm text-red-400">{error}</div>;

  return (
    <div className="space-y-6">

      {/* header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Portfolio Simulator</h1>
          <p className="mt-0.5 text-xs text-gray-500">Select up to 5 funds · dual-model forecast · auto-saved</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {saving  && <span className="text-[10px] text-gray-600 animate-pulse">Saving…</span>}
          {!saving && lastSaved && <span className="text-[10px] text-gray-600">✓ Saved {timeAgo(lastSaved)}</span>}
          {selList.length > 0 && <button onClick={resetSaved} className="text-[10px] text-red-500 hover:text-red-400">↺ Reset</button>}
        </div>
      </div>

      {/* restore banner */}
      {showRestore && savedConfig && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-blue-800/50 bg-blue-900/10 px-4 py-3">
          <div>
            <div className="text-xs font-semibold text-blue-300">📌 Saved simulation</div>
            <div className="mt-0.5 text-[10px] text-gray-500">
              {savedConfig.config.selections?.length} funds · {fmtInr(savedConfig.config.amount ?? 0)}
              {" · "}{savedConfig.config.mode === "sip" ? "Monthly SIP" : "Lump Sum"}
              {" · "}saved {timeAgo(savedConfig.saved_at)}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <button onClick={() => applySaved(savedConfig.config)}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500">
              Restore
            </button>
            <button onClick={() => setShowRestore(false)}
              className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs text-gray-400 hover:text-white">
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* fund picker */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-300">Select funds (max 5)</span>
          <span className="text-xs text-gray-600">{selList.length}/5 selected</span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {picks.map((fund, i) => {
            const isSel = !!selected[fund.code];
            const hist  = navHistory[fund.code];
            return (
              <button key={fund.code} onClick={() => toggleFund(fund)}
                disabled={!isSel && selList.length >= 5}
                className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                  isSel ? "border-blue-600/60 bg-blue-900/20 text-white"
                        : "border-gray-800 bg-gray-900 text-gray-400 hover:border-gray-700 hover:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                }`}>
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${isSel ? PALETTE[i % PALETTE.length] : "bg-gray-700"}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium leading-snug">{fund.label}</div>
                  <div className="text-[10px] text-gray-500">{fund.category}</div>
                </div>
                <div className="shrink-0 space-y-0.5 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    {hist === "loading" && <span className="h-3 w-3 animate-spin rounded-full border border-gray-600 border-t-transparent" />}
                    {hist && hist !== "loading" && hist.ret10y != null && <span className="text-[9px] text-gray-600">{fmtPct(hist.ret10y)} 10Y</span>}
                    {hist && hist !== "loading" && hist.ret5y  != null && <span className="text-[9px] text-gray-600">{fmtPct(hist.ret5y)} 5Y</span>}
                    {hist && hist !== "loading" && !hist.ret5y && hist.dates?.length > 0 && (
                      <span className="text-[9px] text-yellow-600">{hist.dates.length}mo ⚠</span>
                    )}
                  </div>
                  <div className={`text-xs font-bold tabular-nums ${(fund.ret1y ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {fmtPct(fund.ret1y)} <span className="text-[9px] font-normal text-gray-600">1Y</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {selList.length > 0 && (
        <div className="space-y-4">

          {/* allocations */}
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-300">Allocation</span>
              <span className={`text-xs font-bold tabular-nums ${pctOk ? "text-green-400" : "text-red-400"}`}>
                {totalPct.toFixed(1)}% {pctOk ? "✓" : "(must = 100%)"}
              </span>
            </div>
            <div className="mb-4 flex h-3 overflow-hidden rounded-full bg-gray-800">
              {selList.map(({ fund, pct }) => (
                <div key={fund.code}
                  className={`h-full transition-all ${PALETTE[picks.findIndex((p) => p.code === fund.code) % PALETTE.length]}`}
                  style={{ width: `${pct}%` }} />
              ))}
            </div>
            <div className="space-y-3">
              {selList.map(({ fund, pct }) => {
                const palIdx = picks.findIndex((p) => p.code === fund.code);
                const hist   = navHistory[fund.code];
                const mean   = bestMeanReturn(fund, hist === "loading" ? null : hist);
                return (
                  <div key={fund.code}>
                    <div className="flex items-center gap-3">
                      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${PALETTE[palIdx % PALETTE.length]}`} />
                      <span className="flex-1 truncate text-xs text-gray-300">{fund.label}</span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <input type="range" min="0" max="100" step="0.5" value={pct}
                          onChange={(e) => setPct(fund.code, e.target.value)}
                          className="w-24 accent-blue-500" />
                        <input type="number" min="0" max="100" step="0.5" value={pct}
                          onChange={(e) => setPct(fund.code, e.target.value)}
                          className="w-14 rounded-lg border border-gray-700 bg-gray-800 px-2 py-1 text-center text-xs text-white tabular-nums focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <span className="text-xs text-gray-600">%</span>
                      </div>
                    </div>
                    {hist && hist !== "loading" && (
                      <div className="ml-5 mt-0.5 flex flex-wrap gap-2 text-[9px] text-gray-600">
                        {hist.ret15y != null && <span>15Y {fmtPct(hist.ret15y)}</span>}
                        {hist.ret10y != null && <span>10Y {fmtPct(hist.ret10y)}</span>}
                        {hist.ret5y  != null && <span>5Y {fmtPct(hist.ret5y)}</span>}
                        {hist.returns?.length > 0 && <span className="text-gray-700">{hist.returns.length} monthly data pts</span>}
                        <span className="text-indigo-500">MC mean {fmtPct(mean)}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <button onClick={() => setSelected((p) => redistribute(p))}
              className="mt-3 text-[10px] text-blue-500 hover:text-blue-400">
              ↺ Auto-equalise
            </button>
          </div>

          {/* investment */}
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
            <div className="mb-3 text-sm font-semibold text-gray-300">Investment</div>
            <div className="flex flex-wrap gap-3">
              <div className="flex overflow-hidden rounded-xl border border-gray-700">
                {[["lump", "Lump Sum"], ["sip", "Monthly SIP"]].map(([k, label]) => (
                  <button key={k} onClick={() => setMode(k)}
                    className={`px-3 py-1.5 text-xs font-medium transition ${mode === k ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"}`}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">₹</span>
                <input type="number" min="1000" step="1000" value={amount}
                  onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))}
                  className="w-36 rounded-xl border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-white tabular-nums focus:outline-none focus:ring-1 focus:ring-blue-500" />
                <span className="text-xs text-gray-500">{mode === "sip" ? "/mo" : "total"}</span>
              </div>
            </div>
          </div>

          {/* results */}
          {pctOk && proj && (
            <div className="space-y-3">

              {/* blended portfolio */}
              <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
                <div className="mb-3 text-sm font-semibold text-gray-300">Blended Portfolio</div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {selList.map(({ fund, pct }) => (
                    <div key={fund.code} className="rounded-xl bg-gray-800/60 p-3">
                      <div className="mb-1 truncate text-[10px] text-gray-500">{fund.category}</div>
                      <div className="text-xs font-medium text-gray-300">{pct}%</div>
                      <div className={`text-sm font-bold tabular-nums ${(fund.ret1y ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {fmtPct(fund.ret1y)} <span className="text-[10px] font-normal text-gray-600">1Y</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <div className="flex flex-1 items-center gap-2 rounded-xl border border-blue-800/40 bg-blue-900/20 px-3 py-2">
                    <span className="text-xs text-blue-400">Weighted 1Y</span>
                    <span className={`ml-auto text-lg font-bold tabular-nums ${(blended1Y ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtPct(blended1Y)}</span>
                  </div>
                  {blendedMean !== blended1Y && (
                    <div className="flex flex-1 items-center gap-2 rounded-xl border border-indigo-800/40 bg-indigo-900/10 px-3 py-2">
                      <span className="text-xs text-indigo-400">Long-term mean ({histLabel})</span>
                      <span className={`ml-auto text-lg font-bold tabular-nums ${(blendedMean ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtPct(blendedMean)}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* deterministic projection */}
              <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
                <div className="mb-1 text-sm font-semibold text-gray-300">Simple Projection (1Y rate, no uncertainty)</div>
                <p className="mb-4 text-[10px] text-gray-600">Straight-line compounding at 1Y historical return. No randomness modelled.</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-800 text-gray-500">
                        <th className="pb-2 text-left font-medium">Horizon</th>
                        <th className="pb-2 text-right font-medium">Invested</th>
                        <th className="pb-2 text-right font-medium">Value</th>
                        <th className="pb-2 text-right font-medium">Gain</th>
                        <th className="pb-2 text-right font-medium">Multiple</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800/60">
                      {proj.map(({ yrs, total, invested, gain }) => (
                        <tr key={yrs} className="hover:bg-gray-800/30">
                          <td className="py-2.5 font-semibold text-gray-200">{yrs}Y</td>
                          <td className="py-2.5 text-right tabular-nums text-gray-400">{fmtInr(invested)}</td>
                          <td className="py-2.5 text-right tabular-nums font-bold text-white">{fmtInr(total)}</td>
                          <td className={`py-2.5 text-right tabular-nums font-medium ${gain >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {gain >= 0 ? "+" : ""}{fmtInr(gain)}
                          </td>
                          <td className="py-2.5 text-right tabular-nums text-gray-300">{(total / invested).toFixed(2)}x</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* loading state */}
              {!allHistLoaded && (
                <div className="flex items-center gap-2 rounded-2xl border border-gray-800 bg-gray-900 p-4 text-xs text-gray-500">
                  <div className="h-4 w-4 animate-spin rounded-full border border-gray-600 border-t-indigo-400" />
                  Fetching NAV history for probability models…
                </div>
              )}

              {/* MODEL A: Log-normal MC */}
              {mcSimple && (
                <MCPanel mc={mcSimple} invested={amount} mode={mode}
                  title="Model A · Log-Normal Monte Carlo"
                  badge={`800 sims · ${histLabel} mean · fixed σ`}
                  color="indigo"
                  extra={<span className="text-[10px] text-gray-600">Assumes normal return distribution</span>}
                />
              )}

              {/* MODEL B: Bootstrap MC + momentum signal */}
              {allHistLoaded && (
                mcBoot ? (
                  <>
                    {blendedZ != null && blendedSeries && (
                      <MomentumSignal z={blendedZ} dataMonths={blendedSeries.commonDates?.length ?? 0} />
                    )}
                    <MCPanel mc={mcBoot} invested={amount} mode={mode}
                      title="Model B · Historical Bootstrap"
                      badge={`800 sims · ${blendedSeries?.months ?? 0} real months · momentum regime`}
                      color="teal"
                      extra={
                        blendedSeries?.limited
                          ? <span className="rounded-full bg-yellow-900/40 px-2 py-0.5 text-[10px] text-yellow-400">
                              ⚠ Limited history — {blendedSeries.bottleneck} only has {blendedSeries.bottleneckMonths} months
                            </span>
                          : <span className="text-[10px] text-gray-600">Samples actual return distribution · preserves crash correlation</span>
                      }
                    />
                    <ModelComparison mcSimple={mcSimple} mcBoot={mcBoot} bootMonths={blendedSeries?.months ?? 0} />
                  </>
                ) : (
                  <div className="rounded-2xl border border-dashed border-gray-800 bg-gray-900 p-4 space-y-1.5 text-xs text-gray-600">
                    <div className="font-medium text-gray-500">Bootstrap model unavailable for this combination</div>
                    <p>Needs ≥ 12 months of overlapping NAV history across all selected funds. Some funds in your selection are too new.</p>
                    <div className="mt-2 space-y-1">
                      {selList.map(({ fund }) => {
                        const h = navHistory[fund.code];
                        const months = h?.dates?.length ?? 0;
                        const oldest = h?.dates?.[0] ?? null;
                        return (
                          <div key={fund.code} className="flex items-center gap-2">
                            <span className={`h-1.5 w-1.5 rounded-full ${months >= 36 ? "bg-green-500" : months >= 12 ? "bg-yellow-500" : "bg-red-500"}`} />
                            <span className="truncate">{fund.label}</span>
                            <span className="ml-auto shrink-0 tabular-nums">
                              {h === "loading" ? "loading…" : months > 0 ? `${months} months${oldest ? ` (from ${oldest})` : ""}` : "no data"}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )
              )}

              {/* ── Goal Calculator ────────────────────────────────────────── */}
              {mcSimple && (
                <GoalCalculator
                  mcSimple={mcSimple}
                  blendedMean={blendedMean}
                  blendedSigma={blendedSigma}
                  simAmount={amount}
                />
              )}
            </div>
          )}
        </div>
      )}

      {selList.length === 0 && !showRestore && (
        <div className="rounded-2xl border border-dashed border-gray-800 p-8 text-center text-sm text-gray-600">
          Select 1–5 funds above to start simulating
        </div>
      )}
    </div>
  );
}
