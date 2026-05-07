import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

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

function zLabel(z) {
  if (z == null) return null;
  if (z >= 1.5)  return { text: "🔥 Hot",    bg: "bg-orange-500/20 text-orange-300 border-orange-600/40" };
  if (z >= 0.5)  return { text: "↑ Warm",    bg: "bg-yellow-500/20 text-yellow-300 border-yellow-600/40" };
  if (z >= -0.5) return { text: "→ Neutral", bg: "bg-gray-600/30  text-gray-400   border-gray-600/40"   };
  if (z >= -1.5) return { text: "↓ Cool",    bg: "bg-blue-500/20  text-blue-300   border-blue-600/40"   };
  return                 { text: "❄ Cold",    bg: "bg-indigo-500/20 text-indigo-300 border-indigo-600/40" };
}

function fmt(v) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const WINDOWS = [
  { key: "ret1w", label: "1W",  range: 5  },
  { key: "ret1m", label: "1M",  range: 15 },
  { key: "ret3m", label: "3M",  range: 25 },
  { key: "ret6m", label: "6M",  range: 40 },
  { key: "ret1y", label: "1Y",  range: 60 },
];

// ─── Desktop components ───────────────────────────────────────────────────────

function RetCell({ value, range }) {
  return (
    <td className={`px-3 py-2.5 text-center tabular-nums text-sm font-medium ${heatColor(value, range)}`}>
      {fmt(value)}
    </td>
  );
}

function DesktopFundRow({ fund }) {
  return (
    <tr className="border-t border-gray-800/60 bg-gray-900/30 hover:bg-gray-800/40">
      <td className="py-2 pl-10 pr-3 text-xs text-gray-300">{fund.label}</td>
      {WINDOWS.map(({ key, range }) => (
        <RetCell key={key} value={fund[key]} range={range} />
      ))}
      <td className="px-3 py-2 text-center text-xs text-gray-500">—</td>
    </tr>
  );
}

function DesktopCategoryRow({ cat, isExpanded, onToggle }) {
  const { category, median: m, funds, fundCount } = cat;
  const badge = zBadge(m.z1w);

  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-t border-gray-700 bg-gray-900 hover:bg-gray-800/70 transition-colors"
      >
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <span className={`text-xs transition-transform ${isExpanded ? "rotate-90" : ""}`}>▶</span>
            <span className="font-semibold text-gray-100">{category}</span>
            {badge && (
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${badge.cls}`}>
                {badge.label}
              </span>
            )}
            <span className="text-xs text-gray-600">({fundCount ?? funds?.length} funds)</span>
          </div>
        </td>
        {WINDOWS.map(({ key, range }) => (
          <RetCell key={key} value={m[key]} range={range} />
        ))}
        <td className="px-3 py-3 text-center tabular-nums text-xs text-gray-400">
          {m.z1w != null ? m.z1w.toFixed(2) : "—"}
        </td>
      </tr>
      {isExpanded && funds.map((f) => (
        <DesktopFundRow key={f.code} fund={f} />
      ))}
    </>
  );
}

function HotColdStrip({ categories }) {
  const sorted = [...categories].sort((a, b) => (b.median.z1w ?? -Infinity) - (a.median.z1w ?? -Infinity));
  const hot  = sorted.slice(0, 3).filter((c) => (c.median.z1w ?? 0) > 0);
  const cold = sorted.slice(-3).filter((c) => (c.median.z1w ?? 0) < 0).reverse();
  if (hot.length === 0 && cold.length === 0) return null;

  return (
    <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {hot.length > 0 && (
        <div className="rounded-xl border border-green-800/50 bg-green-900/20 p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-green-400">
            🔥 Strongest momentum this week
          </div>
          {hot.map((c) => (
            <div key={c.category} className="flex items-center justify-between py-1">
              <span className="text-sm text-gray-200">{c.category}</span>
              <div className="flex items-center gap-3">
                <span className="tabular-nums text-sm font-semibold text-green-400">{fmt(c.median.ret1w)} 1W</span>
                <span className="text-xs text-gray-500">z={c.median.z1w?.toFixed(1)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {cold.length > 0 && (
        <div className="rounded-xl border border-red-900/50 bg-red-900/20 p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-red-400">
            ❄ Weakest momentum this week
          </div>
          {cold.map((c) => (
            <div key={c.category} className="flex items-center justify-between py-1">
              <span className="text-sm text-gray-200">{c.category}</span>
              <div className="flex items-center gap-3">
                <span className="tabular-nums text-sm font-semibold text-red-400">{fmt(c.median.ret1w)} 1W</span>
                <span className="text-xs text-gray-500">z={c.median.z1w?.toFixed(1)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-4 text-xs text-gray-500">
      <span className="font-semibold text-gray-400">Legend:</span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-6 rounded bg-green-700" /> Strong +ve
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-6 rounded bg-red-700" /> Strong -ve
      </span>
      <span>z-score = how unusual is this week vs trailing 90d (≥2 = hot, ≤-2 = cold)</span>
      <span>Click a row to see individual fund breakdown</span>
    </div>
  );
}

function DesktopView({ data, builtAt }) {
  const [expanded, setExpanded] = useState(new Set());
  const [sort, setSort] = useState({ key: "z1w", dir: "desc" });

  const sorted = [...data.categories].sort((a, b) => {
    const av = a.median[sort.key] ?? -Infinity;
    const bv = b.median[sort.key] ?? -Infinity;
    return sort.dir === "desc" ? bv - av : av - bv;
  });

  const toggleExpand = (cat) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
  };

  const handleSort = (key) => {
    setSort((prev) => ({
      key,
      dir: prev.key === key && prev.dir === "desc" ? "asc" : "desc",
    }));
  };

  const SortArrow = ({ col }) => {
    if (sort.key !== col) return <span className="ml-0.5 text-gray-600">⇅</span>;
    return <span className="ml-0.5 text-blue-400">{sort.dir === "desc" ? "↓" : "↑"}</span>;
  };

  return (
    <>
      <div className="mb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold">MF Momentum Radar</h1>
            <p className="mt-1 text-sm text-gray-400">
              Median returns across {data.categories.length} categories · updated {builtAt ? timeAgo(builtAt) : "—"}
            </p>
          </div>
        </div>
      </div>

      <HotColdStrip categories={data.categories} />
      <Legend />

      <div className="overflow-x-auto rounded-xl border border-gray-800 shadow-xl">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-gray-800/80">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
                Category
              </th>
              {WINDOWS.map(({ key, label }) => (
                <th
                  key={key}
                  onClick={() => handleSort(key)}
                  className="cursor-pointer px-3 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-white"
                >
                  {label}<SortArrow col={key} />
                </th>
              ))}
              <th
                onClick={() => handleSort("z1w")}
                className="cursor-pointer px-3 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-white"
                title="1-week z-score vs trailing 90-day weekly returns"
              >
                Momentum z<SortArrow col="z1w" />
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((cat) => (
              <DesktopCategoryRow
                key={cat.category}
                cat={cat}
                isExpanded={expanded.has(cat.category)}
                onToggle={() => toggleExpand(cat.category)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {data.warnings?.length > 0 && (
        <details className="mt-6 text-xs text-gray-600">
          <summary className="cursor-pointer hover:text-gray-400">
            {data.warnings.length} fund(s) skipped
          </summary>
          <ul className="mt-2 list-disc pl-5">
            {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </details>
      )}
    </>
  );
}

// ─── Mobile components ────────────────────────────────────────────────────────

function RetVal({ val }) {
  const color = (val ?? 0) >= 0 ? "text-green-400" : "text-red-400";
  return <span className={`tabular-nums font-medium ${color}`}>{fmt(val)}</span>;
}

const MOBILE_WINDOWS     = ["1W", "1M", "3M", "6M", "1Y"];
const MOBILE_WINDOW_KEYS = ["ret1w", "ret1m", "ret3m", "ret6m", "ret1y"];

function MobileFundRow({ fund }) {
  return (
    <div className="border-b border-gray-800/50 py-2.5 last:border-0">
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <span className="text-sm leading-snug text-gray-200">{fund.label}</span>
        {fund.latestNav && (
          <span className="shrink-0 text-xs text-gray-500">₹{fund.latestNav.toFixed(2)}</span>
        )}
      </div>
      <div className="flex gap-3 overflow-x-auto">
        {MOBILE_WINDOWS.map((w, i) => (
          <div key={w} className="shrink-0 text-center">
            <div className="text-[10px] text-gray-600">{w}</div>
            <RetVal val={fund[MOBILE_WINDOW_KEYS[i]]} />
          </div>
        ))}
      </div>
    </div>
  );
}

function MobileCategoryCard({ cat }) {
  const [open, setOpen] = useState(false);
  const zl = zLabel(cat.median.z1w);

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900">
      <button
        className="w-full px-4 py-3.5 text-left active:bg-gray-800/50"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              {zl && (
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${zl.bg}`}>
                  {zl.text}
                </span>
              )}
              <span className="font-semibold text-gray-100">{cat.category}</span>
            </div>
            {cat.funds[0] && (
              <span className="block truncate text-xs text-gray-500">
                Top: {cat.funds[0].label}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <div className="text-right">
              <div className="text-xs text-gray-600">1W</div>
              <RetVal val={cat.median.ret1w} />
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-600">1M</div>
              <RetVal val={cat.median.ret1m} />
            </div>
            <span className="text-sm text-gray-600">{open ? "▲" : "▼"}</span>
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-800">
          <div className="flex gap-3 overflow-x-auto bg-gray-800/40 px-4 py-2">
            <span className="shrink-0 self-center text-[10px] text-gray-500">Median</span>
            {MOBILE_WINDOWS.map((w, i) => (
              <div key={w} className="shrink-0 text-center">
                <div className="text-[10px] text-gray-600">{w}</div>
                <RetVal val={cat.median[MOBILE_WINDOW_KEYS[i]]} />
              </div>
            ))}
          </div>
          <div className="px-4">
            {cat.funds.map((f) => <MobileFundRow key={f.code} fund={f} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function MobileView({ data, builtAt }) {
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold">MF Momentum Radar</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            {data.categories.length} categories · updated {builtAt ? timeAgo(builtAt) : "—"}
          </p>
        </div>
      </div>
      {data.categories.map((cat) => (
        <MobileCategoryCard key={cat.category} cat={cat} />
      ))}
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function MfRadar() {
  const [data,    setData]    = useState(null);
  const [builtAt, setBuiltAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    supabase
      .from("radar_cache")
      .select("data, built_at")
      .eq("key", "mf_radar")
      .single()
      .then(({ data: row, error: err }) => {
        if (err) { setError(err.message); return; }
        setData(row.data);
        setBuiltAt(row.built_at);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner />;
  if (error)   return <ErrorBox msg={error} />;
  if (!data)   return <ErrorBox msg="No data yet — the first GitHub Actions run hasn't completed." />;

  return (
    <>
      <div className="hidden md:block">
        <DesktopView data={data} builtAt={builtAt} />
      </div>
      <div className="md:hidden">
        <MobileView data={data} builtAt={builtAt} />
      </div>
    </>
  );
}

function Spinner() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      <p className="animate-pulse text-center text-sm text-gray-400">Loading…</p>
    </div>
  );
}

function ErrorBox({ msg }) {
  return (
    <div className="rounded-2xl border border-red-800/40 bg-red-900/20 px-5 py-4 text-sm text-red-300">
      <strong>Error:</strong> {msg}
    </div>
  );
}
