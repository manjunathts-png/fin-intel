import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import PageFooter from "../components/PageFooter";
import InstrumentDrawer from "../components/InstrumentDrawer";

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
  if (Math.abs(pct) <= 0.3)  return { text: `${fmtPct(pct, 2)} at NAV`,   cls: "bg-green-500/20 text-green-300 border-green-600/40" };
  if (Math.abs(pct) <= 1.0)  return { text: `${fmtPct(pct, 2)}`,          cls: "bg-yellow-500/20 text-yellow-300 border-yellow-600/40" };
  return                            { text: `${fmtPct(pct, 2)}`,          cls: "bg-red-500/20 text-red-300 border-red-600/40" };
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
  const [drawer, setDrawer] = useState(null); // { type, id }

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
          Run the workflow manually: GitHub Actions → Refresh Radar Cache → target=etf
        </p>
      </div>
    );
  }

  if (!data) return null;

  const types = data.types || [];
  const allTypes = ["All", ...types.map((t) => t.type)];
  const filtered = activeType === "All" ? types : types.filter((t) => t.type === activeType);

  // Flatten all ETFs and rank by 1W return for top-5 quick overview
  const topOverall = types
    .flatMap((t) => t.etfs)
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
          {types.reduce((s, t) => s + t.etfCount, 0)} ETFs tracked ·
          Refreshed {timeAgo(data.builtAt)}
        </p>
      </div>

      {/* Hot 5 strip */}
      {topOverall.length > 0 && (
        <div className="rounded-2xl border border-orange-500/30 bg-orange-500/5 p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-base">🔥</span>
            <h3 className="text-sm font-semibold text-orange-300">Hottest 5 right now (by 1W)</h3>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {topOverall.map((etf) => (
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

      <PageFooter />

      <InstrumentDrawer
        open={drawer != null}
        type={drawer?.type}
        id={drawer?.id}
        onClose={() => setDrawer(null)}
      />
    </div>
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
          <p className="mt-0.5 text-xs text-gray-500">{block.etfCount} ETFs · median 1Y {fmtPct(block.median?.ret1y, 1)}</p>
        </div>
        {zl && <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-bold ${zl.bg}`}>{zl.text}</span>}
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-800">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-gray-800/80 text-xs uppercase tracking-wider text-gray-400">
            <tr>
              <th className="px-3 py-2.5 text-left">ETF</th>
              {RETURN_WINDOWS.map((w) => (
                <th key={w.key} className="px-3 py-2.5 text-right">{w.label}</th>
              ))}
              <th className="px-3 py-2.5 text-right">z</th>
              <th className="px-3 py-2.5 text-right hidden md:table-cell">Premium</th>
              <th className="px-3 py-2.5 text-right hidden md:table-cell">Vol/day</th>
              <th className="px-3 py-2.5 text-left">Status</th>
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

  return (
    <tr className="border-t border-gray-800 transition-colors hover:bg-gray-800/40">
      <td className="px-3 py-2.5">
        <button
          onClick={() => onOpenDrawer({ type: "ETF", id: etf.ticker })}
          className="text-left"
        >
          <div className="text-sm font-semibold text-blue-400 hover:text-blue-300 hover:underline">{etf.ticker}</div>
          <div className="text-[11px] text-gray-500 truncate max-w-[200px]" title={etf.label}>{etf.label}</div>
          <div className="text-[10px] text-gray-600">AUM {etf.aumCr ? `₹${(etf.aumCr / 1000).toFixed(1)}kCr` : "—"} · TER {etf.ter != null ? `${etf.ter.toFixed(2)}%` : "—"}</div>
        </button>
      </td>
      {RETURN_WINDOWS.map((w) => {
        const v = etf[w.key];
        return (
          <td key={w.key} className={`px-3 py-2.5 text-right tabular-nums text-xs ${(v ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
            {fmtPct(v, 1)}
          </td>
        );
      })}
      <td className="px-3 py-2.5 text-right tabular-nums text-xs font-semibold text-gray-200">
        {etf.z1w != null ? etf.z1w.toFixed(2) : "—"}
      </td>
      <td className="px-3 py-2.5 text-right hidden md:table-cell">
        {prem ? <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${prem.cls}`}>{prem.text}</span> : <span className="text-xs text-gray-600">—</span>}
      </td>
      <td className="px-3 py-2.5 text-right hidden md:table-cell tabular-nums text-xs text-gray-400">
        {fmtInr(etf.avgDailyVolume)}
      </td>
      <td className="px-3 py-2.5">
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${liq.cls}`}>{liq.text}</span>
      </td>
    </tr>
  );
}
