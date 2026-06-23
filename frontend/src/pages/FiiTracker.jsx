import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import PageFooter from "../components/PageFooter";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  Legend,
} from "recharts";

// ─── Constants (mirrors regime.js thresholds) ─────────────────────────────────
const FII_BULL_5D =  4000;   // ₹ cr net buying over 5d = bullish
const FII_BEAR_5D = -8000;   // ₹ cr net selling over 5d = bearish

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtCr(v, forceSign = false) {
  if (v == null) return "—";
  const sign = forceSign && v > 0 ? "+" : "";
  const abs  = Math.abs(v);
  if (abs >= 10000) return `${sign}${(v / 1000).toFixed(1)}k Cr`;
  return `${sign}${Math.round(v).toLocaleString("en-IN")} Cr`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function regimeInfo(fii5d) {
  if (fii5d == null) return { label: "Unknown", cls: "bg-gray-700/40 text-gray-300 border-gray-600/40", desc: "No recent data" };
  if (fii5d >= FII_BULL_5D)  return { label: "Risk On",  cls: "bg-green-500/20 text-green-300 border-green-600/40",  desc: "FIIs net buyers — bullish flow" };
  if (fii5d <= FII_BEAR_5D)  return { label: "Risk Off", cls: "bg-red-500/20 text-red-300 border-red-600/40",        desc: "FIIs net sellers — defensive stance" };
  return                            { label: "Neutral",  cls: "bg-yellow-500/20 text-yellow-300 border-yellow-600/40", desc: "FII flow within neutral band" };
}

// ─── Custom bar fill based on sign ───────────────────────────────────────────
function FiiBar(props) {
  const { x, y, width, height, value } = props;
  if (!height || height === 0) return null;
  const fill = value >= 0 ? "#22c55e" : "#ef4444";
  return <rect x={x} y={y} width={width} height={Math.abs(height)} fill={fill} fillOpacity={0.75} rx={1} />;
}

function DiiBar(props) {
  const { x, y, width, height, value } = props;
  if (!height || height === 0) return null;
  const fill = value >= 0 ? "#60a5fa" : "#f97316";
  return <rect x={x} y={y} width={width} height={Math.abs(height)} fill={fill} fillOpacity={0.60} rx={1} />;
}

// ─── Custom tooltip ───────────────────────────────────────────────────────────
function FlowTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const d = {};
  payload.forEach((p) => { d[p.dataKey] = p.value; });
  return (
    <div className="rounded-xl border border-gray-700 bg-gray-900 px-3 py-2.5 text-xs shadow-xl">
      <p className="mb-1.5 font-semibold text-gray-300">{label}</p>
      {d.fii_net_cr != null && (
        <p className={d.fii_net_cr >= 0 ? "text-green-400" : "text-red-400"}>
          FII daily: {fmtCr(d.fii_net_cr, true)}
        </p>
      )}
      {d.dii_net_cr != null && (
        <p className={d.dii_net_cr >= 0 ? "text-blue-400" : "text-orange-400"}>
          DII daily: {fmtCr(d.dii_net_cr, true)}
        </p>
      )}
      {d.fii_net_20d != null && (
        <p className="text-purple-300 mt-1">FII 20d rolling: {fmtCr(d.fii_net_20d, true)}</p>
      )}
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, positive }) {
  const color = positive == null ? "text-gray-100"
    : positive ? "text-green-400" : "text-red-400";
  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900/60 p-4 space-y-0.5">
      <p className="text-[11px] text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function FiiTracker() {
  const [rows, setRows]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const { data, error: err } = await supabase
        .from("macro_flows")
        .select("trade_date,fii_net_cr,dii_net_cr,fii_net_5d,fii_net_20d,dii_net_5d,dii_net_20d")
        .gte("trade_date", cutoff)
        .order("trade_date", { ascending: true });
      if (err) { setError(err.message); setLoading(false); return; }
      setRows(data ?? []);
      setLoading(false);
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-20 text-center text-red-400">
        Failed to load: {error}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="mt-20 text-center space-y-2">
        <p className="text-gray-400 text-lg">No FII/DII flow data yet.</p>
        <p className="text-gray-600 text-sm">
          Run the migration (<code className="text-gray-400">ml/migrate_016_macro_flows.sql</code>) in Supabase,
          then trigger <code className="text-gray-400">workflow_dispatch target=all</code> to populate.
        </p>
      </div>
    );
  }

  // Latest row for summary stats
  const latest     = rows[rows.length - 1];
  const latestDate = fmtDate(latest.trade_date);
  const regime     = regimeInfo(latest.fii_net_5d);

  // Chart data
  const chartData = rows.map((r) => ({
    date:        fmtDate(r.trade_date),
    fii_net_cr:  r.fii_net_cr,
    dii_net_cr:  r.dii_net_cr,
    fii_net_20d: r.fii_net_20d,
  }));

  // Count buying vs selling days in view
  const buyDays  = rows.filter((r) => r.fii_net_cr > 0).length;
  const sellDays = rows.filter((r) => r.fii_net_cr < 0).length;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">FII &amp; DII Flows</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            NSE equity cash-segment net flows · last 90 trading days · as of {latestDate}
          </p>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${regime.cls}`}>
          {regime.label}
        </span>
      </div>

      {/* ── Summary cards ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="FII 5-Day Net"
          value={fmtCr(latest.fii_net_5d, true)}
          sub="rolling 5 trading days"
          positive={latest.fii_net_5d > 0}
        />
        <StatCard
          label="FII 20-Day Net"
          value={fmtCr(latest.fii_net_20d, true)}
          sub="rolling 20 trading days"
          positive={latest.fii_net_20d > 0}
        />
        <StatCard
          label="DII 5-Day Net"
          value={fmtCr(latest.dii_net_5d, true)}
          sub="rolling 5 trading days"
          positive={latest.dii_net_5d > 0}
        />
        <StatCard
          label="Buy / Sell Days"
          value={`${buyDays} / ${sellDays}`}
          sub="FII in 90-day window"
          positive={buyDays > sellDays}
        />
      </div>

      {/* ── Regime context ─────────────────────────────────────────────────── */}
      <div className={`rounded-2xl border px-4 py-3 text-sm ${regime.cls}`}>
        <span className="font-semibold">Regime: {regime.label} —</span>{" "}
        {regime.desc}. Thresholds: FII 5d &gt; ₹4,000 Cr = Risk On; &lt; −₹8,000 Cr = Risk Off.
        Current: FII 5d = {fmtCr(latest.fii_net_5d, true)}.
      </div>

      {/* ── Daily flow chart ───────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-800 bg-gray-900/60 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-200">Daily Net Flows (₹ Crore)</h2>
          <div className="flex gap-3 text-[11px] text-gray-500">
            <span><span className="inline-block h-2 w-3 rounded-sm bg-green-500 mr-1" />FII buy</span>
            <span><span className="inline-block h-2 w-3 rounded-sm bg-red-500 mr-1" />FII sell</span>
            <span><span className="inline-block h-2 w-3 rounded-sm bg-blue-400 mr-1" />DII buy</span>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "#6b7280" }}
              tickLine={false}
              axisLine={false}
              interval={Math.floor(chartData.length / 8)}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "#6b7280" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => v >= 1000 || v <= -1000 ? `${(v/1000).toFixed(0)}k` : v}
              width={42}
            />
            <Tooltip content={<FlowTooltip />} />
            <ReferenceLine y={0} stroke="#374151" strokeWidth={1} />
            <Bar dataKey="dii_net_cr" name="DII daily" shape={<DiiBar />} maxBarSize={8} />
            <Bar dataKey="fii_net_cr" name="FII daily" shape={<FiiBar />} maxBarSize={8} />
            <Line
              dataKey="fii_net_20d"
              name="FII 20d rolling"
              stroke="#a855f7"
              strokeWidth={2}
              dot={false}
              strokeDasharray="4 2"
            />
          </ComposedChart>
        </ResponsiveContainer>
        <p className="text-[10px] text-gray-600">
          Bars = daily net (green/red = FII buy/sell, blue = DII). Purple dashed = FII 20-day rolling sum.
        </p>
      </div>

      {/* ── Recent flow table ──────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-800 bg-gray-900/60 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500">
              <th className="px-4 py-2.5 text-left font-medium">Date</th>
              <th className="px-4 py-2.5 text-right font-medium">FII Net (₹ Cr)</th>
              <th className="px-4 py-2.5 text-right font-medium">DII Net (₹ Cr)</th>
              <th className="px-4 py-2.5 text-right font-medium">FII 5d Sum</th>
              <th className="px-4 py-2.5 text-right font-medium">FII 20d Sum</th>
            </tr>
          </thead>
          <tbody>
            {[...rows].reverse().slice(0, 20).map((r) => (
              <tr key={r.trade_date} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                <td className="px-4 py-2 text-gray-400">{fmtDate(r.trade_date)}</td>
                <td className={`px-4 py-2 text-right font-medium tabular-nums ${
                  r.fii_net_cr >= 0 ? "text-green-400" : "text-red-400"
                }`}>
                  {fmtCr(r.fii_net_cr, true)}
                </td>
                <td className={`px-4 py-2 text-right tabular-nums ${
                  r.dii_net_cr >= 0 ? "text-blue-400" : "text-orange-400"
                }`}>
                  {fmtCr(r.dii_net_cr, true)}
                </td>
                <td className={`px-4 py-2 text-right tabular-nums ${
                  (r.fii_net_5d ?? 0) >= 0 ? "text-green-300" : "text-red-300"
                }`}>
                  {fmtCr(r.fii_net_5d, true)}
                </td>
                <td className={`px-4 py-2 text-right tabular-nums ${
                  (r.fii_net_20d ?? 0) >= 0 ? "text-purple-300" : "text-red-300"
                }`}>
                  {fmtCr(r.fii_net_20d, true)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PageFooter
        sections={[
          {
            title: "Data Source",
            items: [
              "NSE equity cash-segment FII/DII data via nseindia.com/api/fiidiiTradeReact",
              "Updated nightly by the macro_features.py pipeline",
              "FII = Foreign Institutional Investors · DII = Domestic Institutional Investors (MFs, insurance, banks)",
            ],
          },
          {
            title: "Regime Thresholds",
            items: [
              "Risk On: FII 5-day rolling net > +₹4,000 Cr — net buying pressure",
              "Risk Off: FII 5-day rolling net < −₹8,000 Cr — net selling pressure",
              "Neutral: in between; DII often counter-buys during FII selloffs",
            ],
          },
        ]}
        note="FII flows reflect institutional sentiment, not individual stock direction. Large selloffs by FIIs are often absorbed by DIIs (mutual funds, LIC). Not investment advice."
      />
    </div>
  );
}
