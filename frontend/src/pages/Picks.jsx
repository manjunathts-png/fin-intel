import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const WINDOWS     = ["1W", "1M", "3M", "6M", "1Y"];
const WINDOW_KEYS = ["ret1w", "ret1m", "ret3m", "ret6m", "ret1y"];

function fmt(v) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function zLabel(z) {
  if (z == null) return null;
  if (z >= 1.5)  return { text: "🔥 Hot",     bg: "bg-orange-500/20 text-orange-300 border-orange-600/40" };
  if (z >= 0.5)  return { text: "↑ Warm",    bg: "bg-yellow-500/20 text-yellow-300 border-yellow-600/40" };
  if (z >= -0.5) return { text: "→ Neutral",  bg: "bg-gray-600/30  text-gray-400   border-gray-600/40"   };
  if (z >= -1.5) return { text: "↓ Cool",    bg: "bg-blue-500/20  text-blue-300   border-blue-600/40"   };
  return                 { text: "❄ Cold",    bg: "bg-indigo-500/20 text-indigo-300 border-indigo-600/40" };
}

function RetVal({ val, bold }) {
  const color = (val ?? 0) >= 0 ? "text-green-400" : "text-red-400";
  return (
    <span className={`tabular-nums ${color} ${bold ? "font-bold" : "font-medium"}`}>
      {fmt(val)}
    </span>
  );
}

function score(fund, catZ) {
  return (fund.ret1w ?? 0) * 0.4
       + (fund.ret1m ?? 0) * 0.3
       + (fund.ret3m ?? 0) * 0.2
       + (catZ       ?? 0) * 5 * 0.1;
}

function buildMfPicks(mfData) {
  return mfData.categories
    .map((cat) => {
      const catZ = cat.median.z1w ?? 0;
      const top  = [...cat.funds]
        .map((f) => ({ ...f, score: score(f, catZ), catZ, category: cat.category }))
        .sort((a, b) => b.score - a.score)[0];
      return top ?? null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

function buildStockPicks(stockData) {
  return stockData.sectors
    .filter((s) => (s.median.z1w ?? 0) >= 0.5)
    .sort((a, b) => (b.median.z1w ?? 0) - (a.median.z1w ?? 0))
    .map((sec) => ({
      sector:      sec.sector,
      sectorZ:     sec.median.z1w,
      sectorMedian: sec.median,
      top:         sec.stocks.slice(0, 3),
    }));
}

function MfPickCard({ fund, rank }) {
  const zl = zLabel(fund.catZ);
  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-blue-400">#{rank}</span>
            <span className="font-semibold leading-snug text-gray-100">{fund.label}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400">
              {fund.category}
            </span>
            {zl && (
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${zl.bg}`}>
                {zl.text}
              </span>
            )}
          </div>
        </div>
        {fund.latestNav && (
          <div className="shrink-0 text-right">
            <div className="text-xs text-gray-500">NAV</div>
            <div className="text-sm font-semibold text-gray-200">₹{fund.latestNav.toFixed(2)}</div>
          </div>
        )}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-0.5">
        {WINDOWS.map((w, i) => (
          <div key={w} className="min-w-[36px] shrink-0 text-center">
            <div className="mb-0.5 text-[10px] text-gray-600">{w}</div>
            <RetVal val={fund[WINDOW_KEYS[i]]} bold={i === 0} />
          </div>
        ))}
      </div>
    </div>
  );
}

function StockPickGroup({ group }) {
  const zl = zLabel(group.sectorZ);
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900">
      <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
        <div className="flex items-center gap-2">
          {zl && (
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${zl.bg}`}>
              {zl.text}
            </span>
          )}
          <span className="font-semibold text-gray-100">{group.sector}</span>
        </div>
        <div className="flex shrink-0 gap-3">
          <div className="text-right">
            <div className="text-[10px] text-gray-600">1W</div>
            <RetVal val={group.sectorMedian.ret1w} />
          </div>
          <div className="text-right">
            <div className="text-[10px] text-gray-600">1M</div>
            <RetVal val={group.sectorMedian.ret1m} />
          </div>
        </div>
      </div>
      <div className="divide-y divide-gray-800/50">
        {group.top.map((stock) => (
          <div key={stock.symbol} className="px-4 py-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <div>
                <span className="text-sm font-medium text-gray-200">{stock.label}</span>
                <span className="ml-2 text-xs text-gray-600">{stock.symbol.replace(".NS", "")}</span>
              </div>
              {stock.price && (
                <span className="tabular-nums text-xs text-gray-400">
                  ₹{stock.price.toLocaleString("en-IN")}
                </span>
              )}
            </div>
            <div className="flex gap-3 overflow-x-auto">
              {WINDOWS.map((w, i) => (
                <div key={w} className="min-w-[36px] shrink-0 text-center">
                  <div className="text-[10px] text-gray-600">{w}</div>
                  <RetVal val={stock[WINDOW_KEYS[i]]} bold={i === 0} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Picks() {
  const [mfData,    setMfData]    = useState(null);
  const [stockData, setStockData] = useState(null);
  const [builtAt,   setBuiltAt]   = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [tab,       setTab]       = useState("mf");

  useEffect(() => {
    Promise.all([
      supabase.from("radar_cache").select("data,built_at").eq("key", "mf_radar").single(),
      supabase.from("radar_cache").select("data,built_at").eq("key", "stock_radar").single(),
    ]).then(([mf, st]) => {
      if (mf.error) { setError(mf.error.message); return; }
      if (st.error) { setError(st.error.message); return; }
      setMfData(mf.data.data);
      setStockData(st.data.data);
      setBuiltAt(mf.data.built_at);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner />;
  if (error)   return <ErrorBox msg={error} />;
  if (!mfData || !stockData) return <ErrorBox msg="No data yet — the first GitHub Actions run hasn't completed." />;

  const mfPicks    = buildMfPicks(mfData);
  const stockPicks = buildStockPicks(stockData);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Picks</h1>
        <p className="mt-0.5 text-xs text-gray-500">
          Best per category · updated {builtAt ? timeAgo(builtAt) : "—"}
        </p>
      </div>

      <div className="flex gap-1 rounded-xl bg-gray-900 p-1">
        {[
          { key: "mf",     label: `📊 MF (${mfPicks.length})` },
          { key: "stocks", label: `📈 Stocks (${stockPicks.length} sectors)` },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
              tab === t.key ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "mf" && (
        <div className="space-y-3">
          <p className="text-xs text-gray-600">
            One fund per category · ranked by weighted momentum (40% 1W · 30% 1M · 20% 3M · 10% z-score)
          </p>
          {mfPicks.map((fund, i) => (
            <MfPickCard key={fund.code} fund={fund} rank={i + 1} />
          ))}
        </div>
      )}

      {tab === "stocks" && (
        <div className="space-y-3">
          <p className="text-xs text-gray-600">
            Top 3 stocks per sector · only sectors with positive momentum shown
          </p>
          {stockPicks.length === 0 && (
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6 text-center text-sm text-gray-500">
              No sectors in positive momentum right now.
            </div>
          )}
          {stockPicks.map((g) => (
            <StockPickGroup key={g.sector} group={g} />
          ))}
        </div>
      )}

      <p className="pt-2 text-[10px] text-gray-700">
        Momentum signals only — not financial advice. Past performance does not guarantee future returns.
      </p>
    </div>
  );
}

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
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
