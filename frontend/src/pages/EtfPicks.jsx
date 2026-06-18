import { useEffect, useState, useMemo } from "react";
import { supabase } from "../lib/supabase";
import PageFooter from "../components/PageFooter";
import InstrumentDrawer from "../components/InstrumentDrawer";
import { scoreInstrument, verdictChipClass, scoreGradient } from "../lib/scoring";

// ─── Display helpers ──────────────────────────────────────────────────────────

function fmtPct(v, digits = 2) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function fmtInr(v) {
  if (v == null) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e7) return `₹${(v / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `₹${(v / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `₹${(v / 1e3).toFixed(0)}k`;
  return `₹${Math.round(v)}`;
}

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function zLabel(z) {
  if (z == null) return null;
  if (z >= 1.5)  return { text: "🔥 Hot",    bg: "bg-orange-500/20 text-orange-300 border-orange-600/40" };
  if (z >= 0.5)  return { text: "↑ Warm",   bg: "bg-yellow-500/20 text-yellow-300 border-yellow-600/40" };
  if (z >= -0.5) return { text: "→ Neutral", bg: "bg-gray-600/30  text-gray-400   border-gray-600/40"   };
  if (z >= -1.5) return { text: "↓ Cool",   bg: "bg-blue-500/20  text-blue-300   border-blue-600/40"   };
  return                 { text: "❄ Cold",   bg: "bg-indigo-500/20 text-indigo-300 border-indigo-600/40" };
}

function liquidityChip(flag) {
  switch (flag) {
    case "ok":     return { text: "Liquid",    cls: "bg-green-500/20 text-green-300 border-green-600/40" };
    case "small":  return { text: "Small AUM", cls: "bg-yellow-500/20 text-yellow-300 border-yellow-600/40" };
    case "thin":   return { text: "Thin Vol",  cls: "bg-orange-500/20 text-orange-300 border-orange-600/40" };
    case "tiny":   return { text: "Tiny",      cls: "bg-red-500/20 text-red-300 border-red-600/40" };
    default:       return { text: "Unknown",   cls: "bg-gray-700/40 text-gray-300 border-gray-600/40" };
  }
}

function premiumChip(pct) {
  if (pct == null) return null;
  if (Math.abs(pct) <= 0.3)  return { text: `${fmtPct(pct, 2)} at NAV`, cls: "bg-green-500/20 text-green-300 border-green-600/40" };
  if (Math.abs(pct) <= 1.0)  return { text: `${fmtPct(pct, 2)}`,        cls: "bg-yellow-500/20 text-yellow-300 border-yellow-600/40" };
  return                            { text: `${fmtPct(pct, 2)}`,        cls: "bg-red-500/20 text-red-300 border-red-600/40" };
}

const RETURN_WINDOWS = [
  { label: "1W", key: "ret1w" },
  { label: "1M", key: "ret1m" },
  { label: "3M", key: "ret3m" },
  { label: "6M", key: "ret6m" },
  { label: "1Y", key: "ret1y" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EtfPicks() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeType, setActiveType] = useState("All");
  const [drawer, setDrawer] = useState(null);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("radar_cache")
      .select("data, built_at")
      .eq("key", "etf_picks")
      .single()
      .then(({ data: row, error }) => {
        if (cancelled) return;
        if (error) { setError(error.message); setLoading(false); return; }
        setData({ ...row.data, builtAt: row.built_at });
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Attach composite score + verdict to every ETF, then build ranked views
  const scored = useMemo(() => {
    if (!data?.types) return null;
    const allEtfs = [];
    const typesWithScores = data.types.map((typeBlock) => {
      const typeZ = typeBlock.median?.z1w;
      const enriched = typeBlock.etfs.map((etf) => {
        const result = scoreInstrument(etf, typeZ, {
          liquidityFlag: etf.liquidityFlag,
          ter:           etf.ter,
          premiumPct:    etf.premiumPct,
        });
        const out = { ...etf, ...result };
        allEtfs.push(out);
        return out;
      });
      // Sort within type by composite score (best first)
      enriched.sort((a, b) => (b.compositeScore ?? -Infinity) - (a.compositeScore ?? -Infinity));
      // Rank within type
      enriched.forEach((e, i) => { e.typeRank = i + 1; });
      return { ...typeBlock, etfs: enriched };
    });

    // Global ranking by composite score
    const overallRanked = [...allEtfs].sort((a, b) => (b.compositeScore ?? -Infinity) - (a.compositeScore ?? -Infinity));
    overallRanked.forEach((e, i) => { e.overallRank = i + 1; });
    // Mirror overallRank back onto the type-scoped instances
    const rankByTicker = Object.fromEntries(overallRanked.map((e, i) => [e.ticker, i + 1]));
    for (const tb of typesWithScores) {
      for (const e of tb.etfs) e.overallRank = rankByTicker[e.ticker];
    }

    return { types: typesWithScores, overallRanked };
  }, [data]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24">
        <div className="h-9 w-9 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
        <p className="animate-pulse text-sm text-gray-400">Loading ETF momentum…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-6 text-red-300">
        <p className="font-semibold">Could not load ETF picks</p>
        <p className="mt-2 text-sm">{error}</p>
        <p className="mt-3 text-xs text-red-400/70">
          If you're seeing this on first deploy, the etf_picks cache key needs to be built.
          Run the workflow manually: GitHub Actions → Refresh Radar Cache → Run workflow → target=all
        </p>
      </div>
    );
  }

  if (!data || !scored) return null;

  const types = scored.types;
  const allTypes = ["All", ...types.map((t) => t.type)];
  const filtered = activeType === "All" ? types : types.filter((t) => t.type === activeType);

  // Two hot strips — max 2 per type to prevent commodity runs from sweeping all 10 slots
  const topByScore = (() => {
    const typeCounts = {};
    const result = [];
    for (const etf of scored.overallRanked) {
      if (result.length >= 10) break;
      if (!etf.recommendable) continue;
      const count = typeCounts[etf.type] ?? 0;
      if (count >= 2) continue;
      typeCounts[etf.type] = count + 1;
      result.push(etf);
    }
    return result;
  })();

  const topByRet1w = [...scored.overallRanked]
    .filter((e) => e.ret1w != null)
    .sort((a, b) => (b.ret1w ?? -Infinity) - (a.ret1w ?? -Infinity))
    .slice(0, 5);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">ETF Picks</h1>
        <p className="mt-1 text-sm text-gray-500">
          Exchange-traded funds across equity, commodity, and international markets ·
          {types.reduce((s, t) => s + t.etfCount, 0)} ETFs scored ·
          Refreshed {timeAgo(data.builtAt)}
        </p>
      </div>

      {/* Top 10 overall by composite score */}
      {topByScore.length > 0 && (
        <div className="rounded-2xl border border-blue-500/30 bg-blue-500/5 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-base">🏆</span>
              <h3 className="text-sm font-semibold text-blue-300">Top 10 Overall — by composite score</h3>
            </div>
            <span className="text-[11px] text-blue-400/70">momentum × conviction × liquidity × TER</span>
          </div>
          <div className="overflow-hidden rounded-lg border border-blue-500/20">
            <table className="w-full text-sm">
              <thead className="bg-blue-900/20 text-[10px] uppercase tracking-wider text-blue-300/80">
                <tr>
                  <th className="px-2 py-1.5 text-left w-8">#</th>
                  <th className="px-2 py-1.5 text-left">ETF</th>
                  <th className="px-2 py-1.5 text-left hidden md:table-cell">Type</th>
                  <th className="px-2 py-1.5 text-right">1W</th>
                  <th className="px-2 py-1.5 text-right">1M</th>
                  <th className="px-2 py-1.5 text-right hidden md:table-cell">1Y</th>
                  <th className="px-2 py-1.5 text-center">Verdict</th>
                  <th className="px-2 py-1.5 text-right">Score</th>
                </tr>
              </thead>
              <tbody>
                {topByScore.map((etf) => (
                  <tr key={`top-${etf.ticker}`} className="border-t border-blue-500/10 hover:bg-blue-900/20 transition">
                    <td className="px-2 py-1.5 text-xs font-bold text-blue-400">{etf.overallRank}</td>
                    <td className="px-2 py-1.5">
                      <button
                        onClick={() => setDrawer({ type: "ETF", id: etf.ticker })}
                        className="text-left"
                      >
                        <div className="text-xs font-semibold text-blue-300 hover:underline">{etf.ticker}</div>
                        <div className="text-[10px] text-gray-500 truncate max-w-[180px]" title={etf.label}>{etf.label}</div>
                      </button>
                    </td>
                    <td className="px-2 py-1.5 text-[10px] text-gray-400 hidden md:table-cell">{etf.type}</td>
                    <td className={`px-2 py-1.5 text-right text-xs tabular-nums ${(etf.ret1w ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtPct(etf.ret1w, 1)}</td>
                    <td className={`px-2 py-1.5 text-right text-xs tabular-nums ${(etf.ret1m ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtPct(etf.ret1m, 1)}</td>
                    <td className={`px-2 py-1.5 text-right text-xs tabular-nums hidden md:table-cell ${(etf.ret1y ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtPct(etf.ret1y, 1)}</td>
                    <td className="px-2 py-1.5 text-center">
                      <span className={`rounded border px-1.5 py-0.5 text-[9px] font-bold ${verdictChipClass(etf.verdict)}`}>{etf.verdict}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <ScorePill score={etf.compositeScore} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Hottest 5 by 1W */}
      {topByRet1w.length > 0 && (
        <div className="rounded-2xl border border-orange-500/30 bg-orange-500/5 p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-base">🔥</span>
            <h3 className="text-sm font-semibold text-orange-300">Hottest 5 right now (by 1W return)</h3>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {topByRet1w.map((etf) => (
              <button
                key={etf.ticker}
                onClick={() => setDrawer({ type: "ETF", id: etf.ticker })}
                className="rounded-lg bg-gray-900/60 px-3 py-2 text-left hover:bg-gray-800 transition"
              >
                <div className="truncate text-sm font-semibold text-gray-100">{etf.ticker}</div>
                <div className="truncate text-xs text-gray-500">{etf.label.split(" ").slice(0, 3).join(" ")}</div>
                <div className={`mt-1 text-sm font-bold tabular-nums ${(etf.ret1w ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {fmtPct(etf.ret1w)}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Category Momentum Radar */}
      <MomentumRadar types={types} />

      {/* Signal Hotspots */}
      <SignalHotspots allEtfs={scored.overallRanked} onOpenDrawer={setDrawer} />

      {/* Type filter chips */}
      <div className="flex flex-wrap gap-2">
        {allTypes.map((t) => (
          <button
            key={t}
            onClick={() => setActiveType(t)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
              activeType === t
                ? "border-blue-500 bg-blue-500/20 text-blue-300"
                : "border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600 hover:text-gray-200"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Types */}
      <div className="space-y-8">
        {filtered.map((typeBlock) => (
          <TypeBlock key={typeBlock.type} block={typeBlock} onOpenDrawer={setDrawer} />
        ))}
      </div>

      {data.warnings && data.warnings.length > 0 && (
        <details className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
          <summary className="cursor-pointer text-xs font-semibold text-gray-400">
            Data quality warnings ({data.warnings.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-gray-500">
            {data.warnings.slice(0, 20).map((w, i) => <li key={i}>· {w}</li>)}
          </ul>
        </details>
      )}

      <PageFooter sections={[
        {
          title: "Data Sources",
          items: [
            '<span class="text-gray-400">Yahoo Finance (NSE)</span> — primary source for all ETF momentum; exchange price is the authoritative signal for ETFs (real-time vs once-daily NAV)',
            '<span class="text-gray-400">mfapi.in</span> — best-effort NAV lookup for premium/discount calculation only; momentum is unaffected if NAV is unavailable',
            '<span class="text-gray-400">Curated universe</span> — 30 ETFs across Equity (Broad / Sector / Smart Beta), Commodity (Gold / Silver), International (Nasdaq / FANG / Hang Seng / S&amp;P 500)',
            "GitHub Actions refreshes ETF data daily at 5 AM IST as part of the 'all' target",
          ],
        },
        {
          title: "Composite Score",
          items: [
            'Multi-window momentum: <span class="text-blue-300">ret1w×0.30 + ret1m×0.25 + ret3m×0.20 + ret6m×0.15 + ret1y×0.10</span>',
            '× <span class="text-yellow-300">conviction multiplier</span> 0.55–1.00 based on type-level z-score',
            'Blended 65% momentum + 35% verdict signal (Strong Buy / Buy / Hold / Watch / Avoid)',
            '<span class="text-orange-300">ETF-specific adjustments:</span> liquidity penalty (tiny −5, thin −3, small −1), premium-to-NAV penalty (|p|&gt;1% −3, |p|&gt;0.5% −1), TER penalty (&gt;1% −1.5, &lt;0.2% +0.5 bonus)',
            'Top 10 Overall surfaces only <span class="text-green-400">recommendable</span> ETFs (excludes Avoid / Watch / Low-conf Buy / weak-type)',
          ],
        },
        {
          title: "Signal Key",
          items: [
            '<span class="text-green-300">Liquid</span> — ≥₹50L/day volume + ≥₹500Cr AUM · safe to enter/exit',
            '<span class="text-yellow-300">Small AUM</span> — AUM ₹100–500Cr · trading cost may bite',
            '<span class="text-orange-300">Thin Vol</span> — &lt;₹50L/day · wide bid-ask spread likely',
            '<span class="text-red-300">Tiny</span> — &lt;₹100Cr AUM · risk of winding down, avoid',
            '<span class="text-blue-300">Premium chip</span> — green if within 0.3% of NAV (fair), red if &gt;1% off (paying tax to enter)',
            '<span class="text-purple-300">z-score</span> — fund\'s 1W return vs trailing 90d weekly distribution',
          ],
        },
        {
          title: "Momentum Radar & Hotspots",
          items: [
            '<span class="text-purple-300">Category Momentum Radar</span> — 6 ETF type cards sorted by 1W z-score; color intensity = heat level (orange=Hot → indigo=Cold)',
            '<span class="text-green-300">⚡ Momentum Cluster</span> — ETFs with z1w ≥ 1.0 AND both 1W & 1M positive — multi-timeframe confirmation, not just noise',
            '<span class="text-yellow-300">⚠️ Premium/Discount Alerts</span> — ETFs trading &gt;0.5% off NAV; buying at premium means paying above fair value on entry',
            '<span class="text-blue-300">🔭 Contrarian Watch</span> — ETFs with z1w ≤ −1.0; statistically oversold vs recent history — watch for mean-reversion setups',
          ],
        },
      ]} note="ETF momentum can drift from underlying index — premium to NAV indicates exchange-side mispricing, not fund quality. Not financial advice." />

      <InstrumentDrawer
        open={drawer != null}
        type={drawer?.type}
        id={drawer?.id}
        onClose={() => setDrawer(null)}
      />
    </div>
  );
}

// ─── Momentum Radar ───────────────────────────────────────────────────────────

function MomentumRadar({ types }) {
  const sorted = [...types].sort(
    (a, b) => (b.median?.z1w ?? -Infinity) - (a.median?.z1w ?? -Infinity)
  );

  function cardStyle(z) {
    if (z == null) return "border-gray-700/50 bg-gray-900/40";
    if (z >= 1.5)  return "border-orange-500/50 bg-orange-500/10";
    if (z >= 0.5)  return "border-yellow-500/40 bg-yellow-500/8";
    if (z >= -0.5) return "border-gray-600/40 bg-gray-900/40";
    if (z >= -1.5) return "border-blue-500/30 bg-blue-500/5";
    return               "border-indigo-500/40 bg-indigo-500/10";
  }

  return (
    <div className="rounded-2xl border border-purple-500/30 bg-purple-500/5 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base">📡</span>
          <h3 className="text-sm font-semibold text-purple-300">ETF Category Momentum Radar</h3>
        </div>
        <span className="text-[11px] text-purple-400/60">median z-score · sorted hottest first</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {sorted.map((tb) => {
          const z = tb.median?.z1w;
          const zl = zLabel(z);
          const r1w = tb.median?.ret1w;
          const r1m = tb.median?.ret1m;
          const r1y = tb.median?.ret1y;
          return (
            <div key={tb.type} className={`rounded-xl border p-2.5 ${cardStyle(z)}`}>
              <div className="text-[11px] font-semibold text-gray-200 leading-tight truncate" title={tb.type}>
                {tb.type}
              </div>
              {zl && (
                <span className={`mt-1 inline-block rounded-full border px-1.5 py-px text-[10px] font-bold ${zl.bg}`}>
                  {zl.text}
                </span>
              )}
              <div className="mt-2 space-y-px">
                {[["1W", r1w], ["1M", r1m], ["1Y", r1y]].map(([lbl, val]) => (
                  <div key={lbl} className="flex justify-between text-[10px]">
                    <span className="text-gray-500">{lbl}</span>
                    <span className={`font-semibold tabular-nums ${(val ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {fmtPct(val, 1)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 text-[9px] text-gray-600">
                {tb.etfCount} ETFs · z {z != null ? z.toFixed(2) : "—"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Signal Hotspots ──────────────────────────────────────────────────────────

function SignalHotspots({ allEtfs, onOpenDrawer }) {
  const momentumLeaders = allEtfs
    .filter((e) => (e.z1w ?? 0) >= 1.0 && (e.ret1w ?? 0) > 0 && (e.ret1m ?? 0) > 0)
    .sort((a, b) => (b.z1w ?? 0) - (a.z1w ?? 0))
    .slice(0, 5);

  const premiumAlerts = allEtfs
    .filter((e) => e.premiumPct != null && Math.abs(e.premiumPct) > 0.5)
    .sort((a, b) => Math.abs(b.premiumPct) - Math.abs(a.premiumPct))
    .slice(0, 5);

  const contrarian = allEtfs
    .filter((e) => (e.z1w ?? 0) <= -1.0)
    .sort((a, b) => (a.z1w ?? 0) - (b.z1w ?? 0))
    .slice(0, 5);

  function HotspotCard({ etf, left, right }) {
    return (
      <button
        onClick={() => onOpenDrawer({ type: "ETF", id: etf.ticker })}
        className="w-full flex items-center justify-between rounded-lg bg-gray-900/60 px-2.5 py-2 hover:bg-gray-800/80 transition text-left"
      >
        <div className="min-w-0">
          <div className="text-xs font-semibold text-gray-100">{etf.ticker}</div>
          <div className="text-[10px] text-gray-500 truncate">{etf.type}</div>
        </div>
        <div className="text-right ml-2 shrink-0">{right}</div>
      </button>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-base">💡</span>
        <h3 className="text-sm font-semibold text-gray-200">Signal Hotspots</h3>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

        {/* Momentum Cluster */}
        <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-sm">⚡</span>
            <h4 className="text-xs font-semibold text-green-300">Momentum Cluster</h4>
          </div>
          <p className="text-[10px] text-gray-500 mb-2.5">z1w ≥ 1.0 confirmed across 1W + 1M</p>
          {momentumLeaders.length === 0 ? (
            <p className="text-xs text-gray-600 italic">No ETF in momentum cluster right now</p>
          ) : (
            <div className="space-y-1.5">
              {momentumLeaders.map((etf) => (
                <HotspotCard
                  key={etf.ticker}
                  etf={etf}
                  right={
                    <>
                      <div className="text-xs font-bold text-green-400 tabular-nums">{fmtPct(etf.ret1w, 1)}</div>
                      <div className="text-[10px] text-orange-400 tabular-nums">z {etf.z1w?.toFixed(2)}</div>
                    </>
                  }
                />
              ))}
            </div>
          )}
        </div>

        {/* Premium / Discount Alerts */}
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-sm">⚠️</span>
            <h4 className="text-xs font-semibold text-yellow-300">Premium / Discount Alerts</h4>
          </div>
          <p className="text-[10px] text-gray-500 mb-2.5">ETFs trading &gt;0.5% off NAV · avoid paying price tax</p>
          {premiumAlerts.length === 0 ? (
            <p className="text-xs text-green-600 italic">All ETFs near NAV ✓</p>
          ) : (
            <div className="space-y-1.5">
              {premiumAlerts.map((etf) => {
                const chip = premiumChip(etf.premiumPct);
                return (
                  <HotspotCard
                    key={etf.ticker}
                    etf={etf}
                    right={
                      chip ? (
                        <span className={`text-[10px] font-bold rounded border px-1.5 py-0.5 ${chip.cls}`}>
                          {chip.text}
                        </span>
                      ) : null
                    }
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Contrarian Watch */}
        <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-sm">🔭</span>
            <h4 className="text-xs font-semibold text-blue-300">Contrarian Watch</h4>
          </div>
          <p className="text-[10px] text-gray-500 mb-2.5">z1w ≤ −1.0 — oversold, watch for mean-reversion</p>
          {contrarian.length === 0 ? (
            <p className="text-xs text-gray-600 italic">No oversold ETFs right now</p>
          ) : (
            <div className="space-y-1.5">
              {contrarian.map((etf) => (
                <HotspotCard
                  key={etf.ticker}
                  etf={etf}
                  right={
                    <>
                      <div className="text-xs font-bold text-red-400 tabular-nums">{fmtPct(etf.ret1w, 1)}</div>
                      <div className="text-[10px] text-blue-400 tabular-nums">z {etf.z1w?.toFixed(2)}</div>
                    </>
                  }
                />
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

// ─── Score pill ───────────────────────────────────────────────────────────────

function ScorePill({ score }) {
  if (score == null) return <span className="text-xs text-gray-500">—</span>;
  const grad = scoreGradient(score);
  return (
    <span
      className={`inline-block rounded-md bg-gradient-to-br ${grad} px-2 py-0.5 text-xs font-bold text-white tabular-nums shadow-sm min-w-[42px] text-center`}
      title={`Composite score: ${score.toFixed(2)}`}
    >
      {score.toFixed(1)}
    </span>
  );
}

// ─── Type block ───────────────────────────────────────────────────────────────

function TypeBlock({ block, onOpenDrawer }) {
  const z = block.median?.z1w;
  const zl = zLabel(z);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between border-b border-gray-800 pb-2">
        <div>
          <h2 className="text-lg font-bold text-gray-100">{block.type}</h2>
          <p className="mt-0.5 text-xs text-gray-500">{block.etfCount} ETFs · median 1Y {fmtPct(block.median?.ret1y, 1)} · sorted by composite score</p>
        </div>
        {zl && <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-bold ${zl.bg}`}>{zl.text}</span>}
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-800">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-gray-800/80 text-xs uppercase tracking-wider text-gray-400">
            <tr>
              <th className="px-2 py-2.5 text-left w-6">#</th>
              <th className="px-3 py-2.5 text-left">ETF</th>
              {RETURN_WINDOWS.map((w) => (
                <th key={w.key} className="px-2 py-2.5 text-right">{w.label}</th>
              ))}
              <th className="px-2 py-2.5 text-right">z</th>
              <th className="px-2 py-2.5 text-right hidden md:table-cell">Prem</th>
              <th className="px-2 py-2.5 text-right hidden md:table-cell">Vol/day</th>
              <th className="px-2 py-2.5 text-center">Verdict</th>
              <th className="px-2 py-2.5 text-right">Score</th>
            </tr>
          </thead>
          <tbody>
            {block.etfs.map((etf) => (
              <EtfRow key={etf.ticker} etf={etf} onOpenDrawer={onOpenDrawer} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── ETF row ──────────────────────────────────────────────────────────────────

function EtfRow({ etf, onOpenDrawer }) {
  const prem = premiumChip(etf.premiumPct);
  const liq = liquidityChip(etf.liquidityFlag);
  const isNotRec = !etf.recommendable;

  return (
    <tr className={`border-t border-gray-800 transition-colors hover:bg-gray-800/40 ${isNotRec ? "opacity-65" : ""}`}>
      <td className="px-2 py-2.5 text-xs font-bold text-gray-500 align-top pt-3">{etf.typeRank}</td>
      <td className="px-3 py-2.5">
        <button
          onClick={() => onOpenDrawer({ type: "ETF", id: etf.ticker })}
          className="text-left"
        >
          <div className="text-sm font-semibold text-blue-400 hover:text-blue-300 hover:underline">{etf.ticker}</div>
          <div className="text-[11px] text-gray-500 truncate max-w-[200px]" title={etf.label}>{etf.label}</div>
          <div className="text-[10px] text-gray-600 flex items-center gap-2 flex-wrap mt-0.5">
            <span>AUM {etf.aumCr ? `₹${(etf.aumCr / 1000).toFixed(1)}kCr` : "—"}</span>
            <span>·</span>
            <span>TER {etf.ter != null ? `${etf.ter.toFixed(2)}%` : "—"}</span>
            <span className={`rounded border px-1 py-px text-[9px] font-bold ${liq.cls}`}>{liq.text}</span>
            <span className="text-gray-700 hidden lg:inline">· #{etf.overallRank} overall</span>
          </div>
        </button>
      </td>
      {RETURN_WINDOWS.map((w) => {
        const v = etf[w.key];
        return (
          <td key={w.key} className={`px-2 py-2.5 text-right tabular-nums text-xs ${(v ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
            {fmtPct(v, 1)}
          </td>
        );
      })}
      <td className="px-2 py-2.5 text-right tabular-nums text-xs font-semibold text-gray-200">
        {etf.z1w != null ? etf.z1w.toFixed(2) : "—"}
      </td>
      <td className="px-2 py-2.5 text-right hidden md:table-cell">
        {prem ? <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${prem.cls}`}>{prem.text}</span> : <span className="text-xs text-gray-600">—</span>}
      </td>
      <td className="px-2 py-2.5 text-right hidden md:table-cell tabular-nums text-xs text-gray-400">
        {fmtInr(etf.avgDailyVolume)}
      </td>
      <td className="px-2 py-2.5 text-center">
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${verdictChipClass(etf.verdict)}`}>{etf.verdict}</span>
        {etf.confidence && (
          <div className="mt-0.5 text-[9px] text-gray-500">{etf.confidence}</div>
        )}
      </td>
      <td className="px-2 py-2.5 text-right">
        <ScorePill score={etf.compositeScore} />
      </td>
    </tr>
  );
}
