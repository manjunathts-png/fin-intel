import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RANGE_DAYS = {
  "1M":  30,
  "3M":  90,
  "6M":  180,
  "1Y":  365,
  "3Y":  365 * 3,
  "5Y":  365 * 5,
  "All": 9999,
};

function fmtPct(v, digits = 2) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function fmtNum(v) {
  if (v == null) return "—";
  return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function fmtInrCr(v) {
  if (v == null) return "—";
  if (v >= 100000) return `₹${(v / 100000).toFixed(2)}LCr`;
  if (v >= 1000)   return `₹${(v / 1000).toFixed(1)}kCr`;
  return `₹${v.toLocaleString("en-IN")}Cr`;
}

function timeAgo(iso) {
  if (!iso) return "—";
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function InstrumentDrawer({ open, type, id, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [range, setRange] = useState("1Y");

  useEffect(() => {
    if (!open || !type || !id) {
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    const key = `instrument_details.${type}.${id}`;
    supabase
      .from("radar_cache")
      .select("data, built_at")
      .eq("key", key)
      .single()
      .then(({ data: row, error: err }) => {
        if (err) { setError(`No detail cached yet for ${type}:${id}. It'll be available after the next refresh-cache run.`); setLoading(false); return; }
        setData({ ...row.data, _cachedAt: row.built_at });
        setLoading(false);
      });
  }, [open, type, id]);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel — slides from right on desktop, full-screen on mobile */}
      <aside className="w-full sm:max-w-2xl overflow-y-auto bg-gray-950 text-white shadow-2xl border-l border-gray-800">
        {loading && (
          <div className="flex h-full flex-col items-center justify-center gap-3 py-24">
            <div className="h-9 w-9 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
            <p className="animate-pulse text-sm text-gray-400">Loading {type} detail…</p>
          </div>
        )}

        {error && (
          <div className="p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-100">{type} · {id}</h2>
              <button onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-white">✕</button>
            </div>
            <div className="mt-6 rounded-xl border border-yellow-500/40 bg-yellow-500/10 p-4 text-sm text-yellow-300">
              {error}
            </div>
          </div>
        )}

        {data && <DrawerContent data={data} range={range} setRange={setRange} onClose={onClose} />}
      </aside>
    </div>
  );
}

// ─── Drawer content ───────────────────────────────────────────────────────────

function DrawerContent({ data, range, setRange, onClose }) {
  const { type, id, name, subtitle, keyStats = {}, chart = [], returns = {}, vsBenchmark, news = [], _cachedAt } = data;

  // Filter chart by selected range
  const cutoff = new Date(Date.now() - RANGE_DAYS[range] * 86400 * 1000);
  const chartData = range === "All"
    ? chart
    : chart.filter((p) => new Date(p.date) >= cutoff);

  const first = chartData[0];
  const last  = chartData[chartData.length - 1];
  const rangeReturn = first && last ? ((last.val - first.val) / first.val) * 100 : null;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="rounded bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white">{type}</span>
            <span className="text-xs text-gray-500">{id}</span>
          </div>
          <h2 className="mt-1 truncate text-xl font-semibold text-gray-100" title={name}>{name}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-gray-400">{subtitle}</p>}
        </div>
        <button onClick={onClose} className="shrink-0 rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-white">✕</button>
      </div>

      {/* Range tabs */}
      <div className="flex flex-wrap gap-1.5">
        {Object.keys(RANGE_DAYS).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
              range === r
                ? "bg-blue-600 text-white"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
            }`}
          >
            {r}
          </button>
        ))}
        {rangeReturn != null && (
          <span className={`ml-auto rounded-lg px-2.5 py-1 text-xs font-semibold ${rangeReturn >= 0 ? "bg-green-500/20 text-green-300" : "bg-red-500/20 text-red-300"}`}>
            {fmtPct(rangeReturn, 1)} in {range}
          </span>
        )}
      </div>

      {/* Chart */}
      <div className="h-64 w-full rounded-xl border border-gray-800 bg-gray-900/40 p-3">
        {chartData.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis
                dataKey="date"
                tick={{ fill: "#6b7280", fontSize: 10 }}
                tickFormatter={(d) => {
                  const date = new Date(d);
                  return RANGE_DAYS[range] <= 90
                    ? date.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
                    : date.toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
                }}
                minTickGap={40}
              />
              <YAxis
                tick={{ fill: "#6b7280", fontSize: 10 }}
                domain={["auto", "auto"]}
                tickFormatter={(v) => v.toFixed(0)}
              />
              <Tooltip
                contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: "#9ca3af" }}
                formatter={(v) => [v.toFixed(2), type === "MF" ? "NAV" : "Price"]}
              />
              <Line type="monotone" dataKey="val" stroke="#3b82f6" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">No data in this range</div>
        )}
      </div>

      {/* Returns table */}
      <ReturnsSection returns={returns} vsBenchmark={vsBenchmark} />

      {/* Key stats */}
      <KeyStatsSection type={type} keyStats={keyStats} />

      {/* News (stocks only — MF/ETF have empty news arrays) */}
      {news.length > 0 && <NewsSection news={news} />}

      {/* Footer */}
      <div className="pt-2 text-center text-[10px] text-gray-600">
        Cached {timeAgo(_cachedAt)} · Data from Yahoo Finance & mfapi.in · Not financial advice
      </div>
    </div>
  );
}

// ─── Returns section ──────────────────────────────────────────────────────────

const RETURN_LABELS = [
  { key: "ret1w", label: "1W" },
  { key: "ret1m", label: "1M" },
  { key: "ret3m", label: "3M" },
  { key: "ret6m", label: "6M" },
  { key: "ret1y", label: "1Y" },
  { key: "ret3y", label: "3Y" },
  { key: "ret5y", label: "5Y" },
];

function ReturnsSection({ returns, vsBenchmark }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 overflow-hidden">
      <div className="border-b border-gray-800 bg-gray-900/60 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
        Returns
      </div>
      <div className="grid grid-cols-7 divide-x divide-gray-800">
        {RETURN_LABELS.map(({ key, label }) => {
          const v = returns[key];
          return (
            <div key={key} className="p-2.5 text-center">
              <div className="text-[10px] text-gray-500 uppercase">{label}</div>
              <div className={`mt-1 text-sm font-bold tabular-nums ${(v ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                {fmtPct(v, 1)}
              </div>
            </div>
          );
        })}
      </div>
      {vsBenchmark && (
        <div className="border-t border-gray-800 bg-gray-900/30 px-4 py-2 text-xs text-gray-500">
          vs Nifty 50:&nbsp;
          {["1m", "3m", "1y"].map((k) => {
            const v = vsBenchmark[k];
            if (v == null) return null;
            return (
              <span key={k} className="mr-3">
                {k.toUpperCase()}:&nbsp;
                <span className={v >= 0 ? "text-green-400" : "text-red-400"}>{fmtPct(v, 1)}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Key stats section ────────────────────────────────────────────────────────

function KeyStatsSection({ type, keyStats }) {
  const rows = type === "STOCK"
    ? [
        ["Sector",         keyStats.sector],
        ["Industry",       keyStats.industry],
        ["Market Cap",     fmtInrCr(keyStats.marketCapCr)],
        ["P/E",            fmtNum(keyStats.peRatio)],
        ["P/B",            fmtNum(keyStats.pbRatio)],
        ["EPS",            fmtNum(keyStats.eps)],
        ["Div Yield",      keyStats.dividendYield != null ? `${keyStats.dividendYield.toFixed(2)}%` : "—"],
        ["Beta",           fmtNum(keyStats.beta)],
        ["52W High",       keyStats.fiftyTwoWeekHigh ? `₹${fmtNum(keyStats.fiftyTwoWeekHigh)}` : "—"],
        ["52W Low",        keyStats.fiftyTwoWeekLow  ? `₹${fmtNum(keyStats.fiftyTwoWeekLow)}`  : "—"],
        ["RoE",            keyStats.returnOnEquity != null ? `${keyStats.returnOnEquity.toFixed(1)}%` : "—"],
        ["Earnings Growth",keyStats.earningsGrowth != null ? `${keyStats.earningsGrowth.toFixed(1)}%` : "—"],
      ]
    : type === "MF"
    ? [
        ["Scheme Code",    keyStats.schemeCode],
        ["Scheme Type",    keyStats.schemeType],
        ["Fund House",     keyStats.fundHouse],
        ["Latest NAV",     keyStats.latestNav ? `₹${fmtNum(keyStats.latestNav)}` : "—"],
        ["NAV Date",       keyStats.latestNavDate],
      ]
    : [
        ["Ticker",         keyStats.ticker],
        ["Benchmark",      keyStats.benchmark],
        ["AUM",            keyStats.aumCr != null ? `₹${(keyStats.aumCr / 1000).toFixed(2)}kCr` : "—"],
        ["TER",            keyStats.ter != null ? `${keyStats.ter.toFixed(2)}%` : "—"],
        ["Latest Price",   keyStats.latestPrice ? `₹${fmtNum(keyStats.latestPrice)}` : "—"],
        ["52W High",       keyStats.fiftyTwoWeekHigh ? `₹${fmtNum(keyStats.fiftyTwoWeekHigh)}` : "—"],
        ["52W Low",        keyStats.fiftyTwoWeekLow  ? `₹${fmtNum(keyStats.fiftyTwoWeekLow)}`  : "—"],
      ];

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 overflow-hidden">
      <div className="border-b border-gray-800 bg-gray-900/60 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
        Key stats
      </div>
      <div className="grid grid-cols-2 divide-x divide-y divide-gray-800">
        {rows.filter(([_, v]) => v != null && v !== "—").map(([k, v]) => (
          <div key={k} className="flex items-center justify-between px-4 py-2 text-sm">
            <span className="text-gray-500">{k}</span>
            <span className="font-medium text-gray-200 text-right truncate ml-2" title={String(v)}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── News section ─────────────────────────────────────────────────────────────

function NewsSection({ news }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 overflow-hidden">
      <div className="border-b border-gray-800 bg-gray-900/60 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
        📰 Recent news
      </div>
      <ul className="divide-y divide-gray-800">
        {news.map((n, i) => (
          <li key={i}>
            <a
              href={n.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block px-4 py-3 text-sm hover:bg-gray-800/40 transition"
            >
              <div className="font-medium text-gray-200 line-clamp-2">{n.title}</div>
              <div className="mt-0.5 text-xs text-gray-500">
                {n.source} · {n.date ? new Date(n.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : ""}
              </div>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
